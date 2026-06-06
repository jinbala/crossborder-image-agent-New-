import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseMigrationArgs, runMigrationCli } from '../scripts/migrateJsonToSqlite.js';
import { runVerifyCli, verifySqliteMigration } from '../scripts/verifySqliteMigration.js';
import { runRebuildCli } from '../scripts/rebuildSqliteIndexes.js';

async function tempDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'cia-migration-'));
}

async function seedJsonDb(dir) {
  const jsonDbPath = path.join(dir, 'db.json');
  await fs.writeFile(jsonDbPath, JSON.stringify({
    tasks: [{ id: 'task-verify', status: 'uploaded', sku: 'SKU-V' }],
    batchTasks: [{ id: 'batch-verify', status: 'imported', name: 'Batch V', skuTasks: [{ skuId: 'SKU-V', taskId: 'task-verify', status: 'uploaded' }] }],
    importedFolders: [{ folderPath: 'D:/imports/verify', importedAt: '2026-01-01T00:00:00.000Z' }],
    workflowTemplates: [{ id: 'template-verify', name: 'Template V' }],
    userSettings: { version: 'v4.3' }
  }, null, 2));
  return jsonDbPath;
}

test('migration CLI parses custom source and target paths', () => {
  const args = parseMigrationArgs(['--json', 'data/db.json', '--sqlite', 'data/app.sqlite', '--no-backup']);
  assert.equal(args.jsonDbPath, 'data/db.json');
  assert.equal(args.sqliteDbPath, 'data/app.sqlite');
  assert.equal(args.backupJsonBeforeMigrate, false);
});

test('verifySqliteMigration confirms counts and sample objects match', async () => {
  const dir = await tempDir();
  const jsonDbPath = await seedJsonDb(dir);
  const sqliteDbPath = path.join(dir, 'app.sqlite');
  await runMigrationCli({ jsonDbPath, sqliteDbPath, backupJsonBeforeMigrate: false, silent: true });
  const report = await verifySqliteMigration({ jsonDbPath, sqliteDbPath });
  assert.equal(report.success, true);
  assert.equal(report.schemaVersion, 2);
  assert.equal(report.indexesPresent, true);
  assert.equal(report.indexCounts.batchSkuIndex, 1);
  assert.deepEqual(report.countsMatch, {
    tasks: true,
    batchTasks: true,
    importedFolders: true,
    workflowTemplates: true,
    userSettings: true
  });
});

test('rebuildSqliteIndexes script rebuilds v2 index rows', async () => {
  const dir = await tempDir();
  const jsonDbPath = await seedJsonDb(dir);
  const sqliteDbPath = path.join(dir, 'app.sqlite');
  await runMigrationCli({ jsonDbPath, sqliteDbPath, backupJsonBeforeMigrate: false, silent: true });
  const report = await runRebuildCli({ sqliteDbPath, silent: true, forceSqlite: true });
  assert.equal(report.batchCount, 1);
  assert.equal(report.taskCount, 1);
  assert.equal(report.batchSkuIndexRows, 1);
});

test('verify CLI returns non-zero style report when counts differ', async () => {
  const dir = await tempDir();
  const jsonDbPath = await seedJsonDb(dir);
  const sqliteDbPath = path.join(dir, 'app.sqlite');
  await runMigrationCli({ jsonDbPath, sqliteDbPath, backupJsonBeforeMigrate: false, silent: true });
  const json = JSON.parse(await fs.readFile(jsonDbPath, 'utf8'));
  json.tasks.push({ id: 'missing-in-sqlite', status: 'uploaded' });
  await fs.writeFile(jsonDbPath, JSON.stringify(json, null, 2));
  const report = await runVerifyCli({ jsonDbPath, sqliteDbPath, silent: true });
  assert.equal(report.success, false);
  assert.equal(report.countsMatch.tasks, false);
});
