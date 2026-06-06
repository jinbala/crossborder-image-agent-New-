import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import request from 'supertest';
import AdmZip from 'adm-zip';
import app from '../src/app.js';
import { createTask, paths, readDb, resetDatabaseForTests } from '../src/services/db.js';
import {
  backupsDir,
  createSnapshot,
  deleteSnapshot,
  listSnapshots,
  restoreSnapshot,
  validateSnapshot
} from '../src/services/snapshotService.js';
import { SqliteStore } from '../src/storage/sqliteStore.js';

async function cleanBackups() {
  await fs.rm(path.join(paths.rootDir, 'backups'), { recursive: true, force: true });
}

async function readOptionalText(filePath) {
  try {
    return await fs.readFile(filePath, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

async function seedSnapshotData() {
  await resetDatabaseForTests();
  await createTask({
    id: 'snapshot-task-1',
    status: 'uploaded',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    sourceImages: []
  });
  await fs.mkdir(paths.uploadDir, { recursive: true });
  await fs.mkdir(paths.outputDir, { recursive: true });
  await fs.writeFile(path.join(paths.uploadDir, 'snapshot-upload.txt'), 'upload-data');
  await fs.writeFile(path.join(paths.outputDir, 'snapshot-output.txt'), 'output-data');
}

test('createSnapshot writes zip metadata and excludes secrets and node_modules', async () => {
  await cleanBackups();
  await seedSnapshotData();
  const snapshot = await createSnapshot({ includeUploads: true, includeOutputs: true, includeDocs: true, note: 'daily backup' });
  assert.match(snapshot.snapshotId, /^snapshot-/);
  assert.ok(snapshot.filePath.endsWith('.zip'));
  assert.equal(snapshot.metadata.dbSummary.taskCount, 1);
  assert.equal(snapshot.metadata.safety.envIncluded, false);
  assert.equal(snapshot.metadata.safety.apiKeysIncluded, false);

  const zip = new AdmZip(snapshot.filePath);
  const names = zip.getEntries().map((entry) => entry.entryName);
  assert.ok(names.includes('snapshot/db.json'));
  assert.ok(names.includes('snapshot/snapshot-metadata.json'));
  assert.ok(names.some((name) => name.startsWith('snapshot/uploads/')));
  assert.ok(names.some((name) => name.startsWith('snapshot/outputs/')));
  assert.ok(names.includes('snapshot/README.md'));
  assert.ok(names.includes('snapshot/.env.example'));
  assert.ok(!names.some((name) => name.includes('.env') && !name.endsWith('.env.example')));
  assert.ok(!names.some((name) => name.includes('node_modules')));
  assert.ok(!names.some((name) => name.includes('backups/')));
});

test('snapshot metadata records storage driver and includes sqlite file when present', async () => {
  await cleanBackups();
  await seedSnapshotData();
  const previousStorageDriver = process.env.STORAGE_DRIVER;
  const previousSqlitePath = process.env.SQLITE_DB_PATH;
  try {
    process.env.STORAGE_DRIVER = 'sqlite';
    const tempDir = await fs.mkdtemp(path.join(paths.dataDir, 'snapshot-sqlite-test-'));
    const sqlitePath = path.join(tempDir, 'app.sqlite');
    process.env.SQLITE_DB_PATH = sqlitePath;
    const sqliteStore = new SqliteStore({ dbPath: sqlitePath });
    await sqliteStore.init();
    await sqliteStore.saveDb({
      tasks: [],
      batchTasks: [],
      importedFolders: [],
      workflowTemplates: [],
      userSettings: null
    });
    sqliteStore.close();
    const snapshot = await createSnapshot({ includeUploads: false, includeOutputs: false, includeDocs: false });
    assert.equal(snapshot.metadata.storage.storageDriver, 'sqlite');
    assert.equal(snapshot.metadata.storage.sqliteIncluded, true);
    assert.equal(snapshot.metadata.storage.jsonIncluded, true);
    const zip = new AdmZip(snapshot.filePath);
    const names = zip.getEntries().map((entry) => entry.entryName);
    assert.ok(names.includes('snapshot/app.sqlite'));
  } finally {
    if (previousStorageDriver === undefined) delete process.env.STORAGE_DRIVER;
    else process.env.STORAGE_DRIVER = previousStorageDriver;
    if (previousSqlitePath === undefined) delete process.env.SQLITE_DB_PATH;
    else process.env.SQLITE_DB_PATH = previousSqlitePath;
  }
});

test('listSnapshots and deleteSnapshot require confirmation', async () => {
  await cleanBackups();
  await seedSnapshotData();
  const snapshot = await createSnapshot({ includeUploads: false, includeOutputs: false, includeDocs: false });
  const list = await listSnapshots();
  assert.ok(list.some((item) => item.snapshotId === snapshot.snapshotId));
  await assert.rejects(() => deleteSnapshot(snapshot.snapshotId, { confirm: false }), /confirm/);
  await deleteSnapshot(snapshot.snapshotId, { confirm: true });
  const afterDelete = await listSnapshots();
  assert.ok(!afterDelete.some((item) => item.snapshotId === snapshot.snapshotId));
});

test('restoreSnapshot creates pre-restore backup and restores db without touching env', async () => {
  const previousStorageDriver = process.env.STORAGE_DRIVER;
  try {
    process.env.STORAGE_DRIVER = 'json';
    await cleanBackups();
    await seedSnapshotData();
    const envPath = path.join(paths.rootDir, '.env');
    const originalEnv = await readOptionalText(envPath);

    const snapshot = await createSnapshot({ includeUploads: true, includeOutputs: true, includeDocs: false });
    await resetDatabaseForTests();
    let db = await readDb();
    assert.equal(db.tasks.length, 0);

    const report = await restoreSnapshot(snapshot.snapshotId, {
      confirm: true,
      restoreDb: true,
      restoreUploads: true,
      restoreOutputs: true,
      restoreDocs: false,
      createBackupBeforeRestore: true
    });
    assert.equal(report.restored.db, true);
    assert.equal(report.skipped.env, true);
    assert.ok(report.warnings.some((warning) => warning.includes('.env was not restored for security')));
    assert.ok(report.preRestoreSnapshotId);
    db = await readDb();
    assert.equal(db.tasks.length, 1);
    assert.equal(await readOptionalText(envPath), originalEnv);
    assert.equal(await fs.readFile(path.join(paths.uploadDir, 'snapshot-upload.txt'), 'utf8'), 'upload-data');
  } finally {
    if (previousStorageDriver === undefined) delete process.env.STORAGE_DRIVER;
    else process.env.STORAGE_DRIVER = previousStorageDriver;
  }
});

test('restoreSnapshot rejects snapshots containing .env and does not change existing env', async () => {
  await cleanBackups();
  await fs.mkdir(backupsDir, { recursive: true });
  const envPath = path.join(paths.rootDir, '.env');
  const originalEnv = await readOptionalText(envPath);
  const snapshotId = 'snapshot-forbidden-env-test';
  const zipPath = path.join(backupsDir, `${snapshotId}.zip`);
  const zip = new AdmZip();
  zip.addFile('snapshot/.env', Buffer.from('GEMINI_API_KEY=xxx\n'));
  zip.addFile('snapshot/db.json', Buffer.from(JSON.stringify({
    tasks: [],
    batchTasks: [],
    importedFolders: [],
    workflowTemplates: [],
    userSettings: null
  })));
  zip.addFile('snapshot/snapshot-metadata.json', Buffer.from(JSON.stringify({
    snapshotId,
    safety: {
      envIncluded: false,
      apiKeysIncluded: false,
      nodeModulesIncluded: false
    }
  })));
  zip.writeZip(zipPath);

  await assert.rejects(
    () => restoreSnapshot(snapshotId, { confirm: true, createBackupBeforeRestore: false }),
    /forbidden env file/
  );
  assert.equal(await readOptionalText(envPath), originalEnv);
});

test('snapshot APIs create download and reject unsafe operations without confirmation', async () => {
  await cleanBackups();
  await seedSnapshotData();
  const createResponse = await request(app)
    .post('/api/snapshots')
    .send({ includeUploads: true, includeOutputs: false, includeDocs: false, note: 'api snapshot' })
    .expect(201);
  const snapshotId = createResponse.body.snapshot.snapshotId;
  await request(app).get('/api/snapshots').expect(200).expect((res) => {
    assert.ok(res.body.snapshots.some((item) => item.snapshotId === snapshotId));
  });
  await request(app).get(`/api/snapshots/${snapshotId}/download`).expect(200).expect('Content-Type', /zip/);
  await request(app).delete(`/api/snapshots/${snapshotId}`).send({ confirm: false }).expect(400);
  await request(app).post(`/api/snapshots/${snapshotId}/restore`).send({ confirm: false }).expect(400);
});

test('validateSnapshot rejects path traversal identifiers', async () => {
  await assert.rejects(() => validateSnapshot('../db.json'), /Invalid snapshotId/);
});
