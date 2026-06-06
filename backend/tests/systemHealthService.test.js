import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import app from '../src/app.js';
import { createBatchTask, paths, resetDatabaseForTests } from '../src/services/db.js';
import { resetUserSettings, updateUserSettings } from '../src/services/userSettingsService.js';
import {
  checkDatabaseHealth,
  checkImportScanHealth,
  checkProviderConfig,
  renderHealthReportMarkdown,
  runSystemHealthCheck
} from '../src/services/systemHealthService.js';
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

test('runSystemHealthCheck returns full structure without provider secrets', async () => {
  const restoreEnv = rememberEnv(['OPENAI_API_KEY']);
  try {
    process.env.OPENAI_API_KEY = 'health-secret-openai-key';
    const result = await runSystemHealthCheck();
    assert.ok(result.checkedAt);
    assert.ok(['healthy', 'warning', 'error'].includes(result.overallStatus));
    assert.ok(result.summary.healthyCount + result.summary.warningCount + result.summary.errorCount > 0);
    assert.ok(result.checks.some((check) => check.category === 'provider'));
    assert.doesNotMatch(JSON.stringify(result), /health-secret-openai-key/);
  } finally {
    restoreEnv();
  }
});

test('provider config check warns when selected provider key is missing', async () => {
  const restoreEnv = rememberEnv(['VISION_PROVIDER', 'GEMINI_API_KEY']);
  try {
    process.env.VISION_PROVIDER = 'gemini';
    delete process.env.GEMINI_API_KEY;
    const checks = await checkProviderConfig();
    assert.ok(checks.some((check) => check.status !== 'healthy' && /Gemini/.test(check.message)));
    assert.doesNotMatch(JSON.stringify(checks), /GEMINI_API_KEY|secret-token/i);
  } finally {
    restoreEnv();
  }
});

test('database health reports invalid JSON without touching real database', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cia-health-db-'));
  const dbPath = path.join(tmpDir, 'db.json');
  await fs.writeFile(dbPath, '{ invalid json');
  const checks = await checkDatabaseHealth({ dbPathOverride: dbPath, dataDirOverride: tmpDir });
  assert.ok(checks.some((check) => check.id === 'database-json-valid' && check.status === 'error'));
});

test('import scan health rejects traversal style root config', async () => {
  const restoreEnv = rememberEnv(['IMPORT_SCAN_ENABLED', 'IMPORT_ROOT_DIR']);
  try {
    process.env.IMPORT_SCAN_ENABLED = 'true';
    process.env.IMPORT_ROOT_DIR = '..\\..';
    const checks = await checkImportScanHealth();
    assert.ok(checks.some((check) => check.status === 'error' && /目录/.test(check.title)));
  } finally {
    restoreEnv();
  }
});

test('batch queue health detects expired running lock', async () => {
  await resetDatabaseForTests();
  await createBatchTask({
    id: 'health-batch-expired-lock',
    name: 'Expired lock batch',
    status: 'imported',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    skuTasks: [],
    queue: { status: 'running', action: 'recognize' },
    locks: {
      isRunning: true,
      lockedBy: 'test',
      lockedAt: new Date(Date.now() - 120000).toISOString(),
      expiresAt: new Date(Date.now() - 60000).toISOString()
    },
    executionLogs: []
  });
  const result = await runSystemHealthCheck();
  assert.ok(result.checks.some((check) => check.id === 'queue-expired-lock' && check.status === 'warning'));
});

test('health report markdown is sanitized', () => {
  const markdown = renderHealthReportMarkdown({
    checkedAt: new Date().toISOString(),
    overallStatus: 'warning',
    summary: { healthyCount: 0, warningCount: 1, errorCount: 0 },
    checks: [
      {
        id: 'secret-check',
        title: 'Provider',
        category: 'provider',
        status: 'warning',
        message: '配置需要检查',
        details: { OPENAI_API_KEY: 'super-secret-value', nested: { token: 'hidden-token' } },
        fixSuggestion: '请检查本地环境变量。'
      }
    ]
  });
  assert.doesNotMatch(markdown, /super-secret-value|hidden-token|OPENAI_API_KEY|token|secret/i);
});

test('health check reports missing sqlite database when sqlite driver is selected', async () => {
  const restoreEnv = rememberEnv(['STORAGE_DRIVER', 'SQLITE_DB_PATH']);
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cia-health-sqlite-'));
  try {
    process.env.STORAGE_DRIVER = 'sqlite';
    process.env.SQLITE_DB_PATH = path.join(tmpDir, 'missing.sqlite');
    const result = await runSystemHealthCheck();
    assert.ok(result.checks.some((check) => check.id === 'database-sqlite-file' && check.status === 'error'));
    assert.ok(result.checks.some((check) => /migrateJsonToSqlite/.test(check.fixSuggestion || '')));
  } finally {
    restoreEnv();
  }
});

test('health check reports missing sqlite v2 index tables', async () => {
  const restoreEnv = rememberEnv(['STORAGE_DRIVER', 'SQLITE_DB_PATH']);
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cia-health-sqlite-v1-'));
  const sqlitePath = path.join(tmpDir, 'app.sqlite');
  try {
    process.env.STORAGE_DRIVER = 'sqlite';
    process.env.SQLITE_DB_PATH = sqlitePath;
    const { SqliteStore } = await import('../src/storage/sqliteStore.js');
    const store = new SqliteStore({ dbPath: sqlitePath });
    await store.init();
    store.getDatabase().prepare('DROP TABLE batch_sku_index').run();
    store.close();
    const result = await runSystemHealthCheck();
    assert.ok(result.checks.some((check) => check.id === 'database-sqlite-index-tables' && check.status === 'warning'));
  } finally {
    restoreEnv();
  }
});

test('sqlite database health stays operational when db.json no longer matches active sqlite data', async () => {
  const restoreEnv = rememberEnv(['STORAGE_DRIVER', 'SQLITE_DB_PATH']);
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cia-health-sqlite-runtime-'));
  const sqlitePath = path.join(tmpDir, 'app.sqlite');
  const now = new Date().toISOString();
  try {
    process.env.STORAGE_DRIVER = 'sqlite';
    process.env.SQLITE_DB_PATH = sqlitePath;
    resetStoreForTests();

    const store = new SqliteStore({ dbPath: sqlitePath });
    await store.init();
    await store.saveDb({
      tasks: [{ id: 'health-sqlite-task-1', status: 'uploaded', sku: 'SKU-H', createdAt: now, updatedAt: now }],
      batchTasks: [{
        id: 'health-sqlite-batch-1',
        name: 'SQLite Health Batch',
        status: 'imported',
        createdAt: now,
        updatedAt: now,
        skuTasks: [{ skuId: 'SKU-H', taskId: 'health-sqlite-task-1', status: 'uploaded' }]
      }],
      importedFolders: [],
      workflowTemplates: [],
      userSettings: null
    });
    store.close();

    await updateUserSettings({
      sqliteTrial: {
        status: 'failed',
        lastVerifiedAt: now,
        lastVerificationReport: {
          success: false,
          countsMatch: { tasks: false, batchTasks: false }
        }
      }
    });

    const checks = await checkDatabaseHealth();

    assert.ok(checks.some((check) => check.id === 'database-sqlite-readable-data' && check.status === 'healthy'));
    assert.ok(checks.some((check) => check.id === 'database-sqlite-trial-status' && check.status === 'warning' && check.message === SQLITE_MODE_JSON_NOT_SYNCED_MESSAGE));
    assert.equal(checks.some((check) => check.status === 'error'), false);
  } finally {
    restoreEnv();
    resetStoreForTests();
    await resetUserSettings();
  }
});

test('health APIs return scoped diagnostics', async () => {
  await request(app).get('/api/health/full').expect(200).expect((res) => {
    assert.ok(res.body.health);
    assert.ok(res.body.markdown);
  });
  await request(app).get('/api/health/providers').expect(200).expect((res) => {
    assert.ok(res.body.health.checks.every((check) => check.category === 'provider' || check.category === 'env'));
  });
  await request(app).get('/api/health/storage').expect(200);
  await request(app).get('/api/health/database').expect(200);
});
