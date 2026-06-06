import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import app from '../src/app.js';
import { resetDatabaseForTests } from '../src/services/db.js';
import { getUserSettings, resetUserSettings } from '../src/services/userSettingsService.js';
import {
  getStorageStatus,
  migrateToSqliteTrial,
  preflightSqlite,
  rebuildSqliteTrialIndexes,
  verifySqliteTrial
} from '../src/services/storageTrialService.js';
import { resetStoreForTests } from '../src/storage/index.js';
import { SqliteStore } from '../src/storage/sqliteStore.js';

const SQLITE_MODE_JSON_NOT_SYNCED_MESSAGE = '当前已在 SQLite 模式运行，db.json 不再同步，迁移一致性验证不再适用。';

function rememberEnv(names) {
  const previous = {};
  for (const name of names) previous[name] = process.env[name];
  return () => {
    for (const name of names) {
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    }
  };
}

async function seedJsonDb(jsonDbPath) {
  await fs.mkdir(path.dirname(jsonDbPath), { recursive: true });
  await fs.writeFile(jsonDbPath, JSON.stringify({
    tasks: [{ id: 'trial-task-1', status: 'uploaded', sku: 'SKU-T' }],
    batchTasks: [{
      id: 'trial-batch-1',
      name: 'Trial Batch',
      status: 'imported',
      skuTasks: [{ skuId: 'SKU-T', taskId: 'trial-task-1', status: 'uploaded' }]
    }],
    importedFolders: [],
    workflowTemplates: [],
    userSettings: null
  }, null, 2));
}

test('storage status API returns JSON and SQLite readiness without leaking env secrets', async () => {
  const restoreEnv = rememberEnv(['STORAGE_DRIVER', 'SQLITE_DB_PATH', 'OPENAI_API_KEY']);
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cia-storage-status-'));
  try {
    process.env.STORAGE_DRIVER = 'json';
    process.env.SQLITE_DB_PATH = path.join(tmpDir, 'app.sqlite');
    process.env.OPENAI_API_KEY = 'do-not-leak';
    resetStoreForTests();
    await resetDatabaseForTests();

    await request(app).get('/api/storage/status').expect(200).expect((res) => {
      assert.equal(res.body.storageDriver, 'json');
      assert.equal(res.body.jsonDbExists, true);
      assert.equal(res.body.sqliteDbExists, false);
      assert.equal(res.body.sqliteTrial.status, 'not_started');
      assert.doesNotMatch(JSON.stringify(res.body), /do-not-leak|OPENAI_API_KEY/i);
    });
  } finally {
    restoreEnv();
    resetStoreForTests();
  }
});

test('preflight detects missing db.json before migration', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cia-storage-preflight-'));
  const report = await preflightSqlite({
    jsonDbPath: path.join(tmpDir, 'missing-db.json'),
    sqliteDbPath: path.join(tmpDir, 'app.sqlite'),
    backupsDir: path.join(tmpDir, 'backups'),
    dataDir: tmpDir
  });
  assert.equal(report.ready, false);
  assert.ok(report.checks.some((check) => check.id === 'json-db-valid' && check.status === 'error'));
});

test('migrate API refuses to overwrite existing SQLite unless explicitly confirmed', async () => {
  const restoreEnv = rememberEnv(['STORAGE_DRIVER', 'SQLITE_DB_PATH']);
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cia-storage-migrate-existing-'));
  const sqlitePath = path.join(tmpDir, 'app.sqlite');
  try {
    process.env.STORAGE_DRIVER = 'json';
    process.env.SQLITE_DB_PATH = sqlitePath;
    resetStoreForTests();
    await resetDatabaseForTests();
    await fs.writeFile(sqlitePath, 'existing');
    await request(app)
      .post('/api/storage/migrate-to-sqlite')
      .send({ confirm: true, createSnapshotBeforeMigrate: false, overwriteExistingSqlite: false })
      .expect(409)
      .expect((res) => {
        assert.match(JSON.stringify(res.body), /SQLITE_ALREADY_EXISTS/);
      });
  } finally {
    restoreEnv();
    resetStoreForTests();
  }
});

test('migrate verify and rebuild trial update sqliteTrial reports', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cia-storage-trial-'));
  const jsonDbPath = path.join(tmpDir, 'db.json');
  const sqliteDbPath = path.join(tmpDir, 'app.sqlite');
  const backupDir = path.join(tmpDir, 'backups');
  await seedJsonDb(jsonDbPath);

  const migrateReport = await migrateToSqliteTrial({
    jsonDbPath,
    sqliteDbPath,
    backupsDir: backupDir,
    createSnapshotBeforeMigrate: false,
    overwriteExistingSqlite: false,
    confirm: true
  });
  assert.equal(migrateReport.success, true);
  assert.equal(migrateReport.schemaVersion, 2);

  const verifyReport = await verifySqliteTrial({ jsonDbPath, sqliteDbPath });
  assert.equal(verifyReport.success, true);
  assert.equal(verifyReport.schemaVersion, 2);

  const rebuildReport = await rebuildSqliteTrialIndexes({ sqliteDbPath });
  assert.equal(rebuildReport.batchCount, 1);
  assert.equal(rebuildReport.batchSkuIndexRows, 1);

  const settings = await getUserSettings();
  assert.equal(settings.sqliteTrial.status, 'ready');
  assert.ok(settings.sqliteTrial.lastMigrationReport);
  assert.ok(settings.sqliteTrial.lastVerificationReport);
  await resetUserSettings();
});

test('verify sqlite trial treats db.json divergence as warning after sqlite mode is active', async () => {
  const restoreEnv = rememberEnv(['STORAGE_DRIVER', 'SQLITE_DB_PATH']);
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cia-storage-sqlite-runtime-'));
  const jsonDbPath = path.join(tmpDir, 'db.json');
  const sqliteDbPath = path.join(tmpDir, 'app.sqlite');
  const now = new Date().toISOString();
  try {
    process.env.STORAGE_DRIVER = 'sqlite';
    process.env.SQLITE_DB_PATH = sqliteDbPath;
    resetStoreForTests();

    await fs.writeFile(jsonDbPath, JSON.stringify({
      tasks: [],
      batchTasks: [],
      importedFolders: [],
      workflowTemplates: [],
      userSettings: null
    }, null, 2));

    const store = new SqliteStore({ dbPath: sqliteDbPath });
    await store.init();
    await store.saveDb({
      tasks: [{ id: 'sqlite-runtime-task-1', status: 'uploaded', sku: 'SKU-SQLITE', createdAt: now, updatedAt: now }],
      batchTasks: [{
        id: 'sqlite-runtime-batch-1',
        name: 'SQLite Runtime Batch',
        status: 'imported',
        createdAt: now,
        updatedAt: now,
        skuTasks: [{ skuId: 'SKU-SQLITE', taskId: 'sqlite-runtime-task-1', status: 'uploaded' }]
      }],
      importedFolders: [],
      workflowTemplates: [],
      userSettings: null
    });
    store.close();

    const report = await verifySqliteTrial({ jsonDbPath, sqliteDbPath });

    assert.equal(report.success, true);
    assert.equal(report.runtimeReady, true);
    assert.equal(report.sqliteTrial.status, 'ready');
    assert.ok(report.warnings.some((warning) => warning.message === SQLITE_MODE_JSON_NOT_SYNCED_MESSAGE));
  } finally {
    restoreEnv();
    resetStoreForTests();
    await resetUserSettings();
  }
});

test('storage APIs can migrate verify and rebuild with temp SQLite path', async () => {
  const restoreEnv = rememberEnv(['STORAGE_DRIVER', 'SQLITE_DB_PATH']);
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cia-storage-api-flow-'));
  try {
    process.env.STORAGE_DRIVER = 'json';
    process.env.SQLITE_DB_PATH = path.join(tmpDir, 'app.sqlite');
    resetStoreForTests();
    await resetDatabaseForTests();
    await request(app)
      .post('/api/storage/migrate-to-sqlite')
      .send({ confirm: true, createSnapshotBeforeMigrate: false, overwriteExistingSqlite: true })
      .expect(200)
      .expect((res) => {
        assert.equal(res.body.report.success, true);
      });
    await request(app).post('/api/storage/verify-sqlite').expect(200).expect((res) => {
      assert.equal(res.body.report.success, true);
      assert.equal(res.body.sqliteTrial.status, 'ready');
    });
    await request(app).post('/api/storage/rebuild-sqlite-indexes').expect(200).expect((res) => {
      assert.equal(res.body.report.status, 'success');
    });
  } finally {
    restoreEnv();
    resetStoreForTests();
    await resetUserSettings();
  }
});
