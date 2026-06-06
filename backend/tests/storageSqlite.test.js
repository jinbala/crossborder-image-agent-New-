import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { JsonStore } from '../src/storage/jsonStore.js';
import { SqliteStore } from '../src/storage/sqliteStore.js';
import { migrateJsonToSqlite } from '../src/storage/migrations.js';
import { createTask, getTask, resetDatabaseForTests } from '../src/services/db.js';
import { resetStoreForTests } from '../src/storage/index.js';
import { rebuildAllIndexes } from '../src/storage/sqliteIndexSync.js';
import { getAllBatchAnalyticsSummary } from '../src/services/batchAnalyticsService.js';

async function tempDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'cia-storage-'));
}

test('jsonStore preserves whole-db read and write behavior', async () => {
  const dir = await tempDir();
  const dbPath = path.join(dir, 'db.json');
  const store = new JsonStore({ dbPath, dataDir: dir, uploadDir: path.join(dir, 'uploads'), outputDir: path.join(dir, 'outputs') });
  await store.saveDb({
    tasks: [{ id: 'task-json', status: 'uploaded' }],
    batchTasks: [],
    importedFolders: [],
    workflowTemplates: [],
    userSettings: { version: 'test' }
  });
  const db = await store.getDb();
  assert.equal(db.tasks[0].id, 'task-json');
  assert.equal(db.userSettings.version, 'test');
});

test('sqliteStore initializes schema and stores task batch and settings records', async () => {
  const dir = await tempDir();
  const sqlitePath = path.join(dir, 'app.sqlite');
  const store = new SqliteStore({ dbPath: sqlitePath });
  await store.init();
  await store.saveTask({ id: 'task-sqlite', sku: 'SKU-1', status: 'uploaded', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-02T00:00:00.000Z' });
  await store.saveBatchTask({ id: 'batch-sqlite', name: 'Batch', status: 'imported', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-02T00:00:00.000Z' });
  await store.saveUserSettings({ version: 'v4.3', updatedAt: '2026-01-02T00:00:00.000Z' });
  await store.saveWorkflowTemplates([{ id: 'template-1', name: 'Template', isSystemTemplate: false, updatedAt: '2026-01-02T00:00:00.000Z' }]);
  await store.saveImportedFolders([{ folderPath: 'D:/imports/sku1', importedAt: '2026-01-02T00:00:00.000Z' }]);

  assert.equal((await store.getTask('task-sqlite')).sku, 'SKU-1');
  assert.equal((await store.getBatchTask('batch-sqlite')).name, 'Batch');
  assert.equal((await store.getUserSettings()).version, 'v4.3');
  assert.equal((await store.getWorkflowTemplates())[0].id, 'template-1');
  assert.equal((await store.getImportedFolders())[0].folderPath, 'D:/imports/sku1');
  assert.equal((await store.getDb()).tasks.length, 1);
  assert.equal(await store.getSchemaVersion(), 2);
});

test('sqlite schema v2 creates structured index tables and upgrades idempotently', async () => {
  const dir = await tempDir();
  const sqlitePath = path.join(dir, 'schema-v2.sqlite');
  const store = new SqliteStore({ dbPath: sqlitePath });
  await store.init();
  await store.init();
  const schema = await store.validateSchema();
  assert.equal(schema.schemaVersion, 2);
  for (const table of [
    'batch_sku_index',
    'batch_queue_index',
    'batch_analytics_index',
    'provider_usage_index',
    'review_risk_index'
  ]) {
    assert.ok(schema.tableNames.includes(table), `${table} should exist`);
  }
  store.close();
});

test('sqliteStore syncs batch queue sku analytics provider and review indexes', async () => {
  const dir = await tempDir();
  const sqlitePath = path.join(dir, 'indexes.sqlite');
  const store = new SqliteStore({ dbPath: sqlitePath });
  await store.init();
  const task = {
    id: 'task-index-1',
    batchId: 'batch-index-1',
    status: 'reviewed',
    sku: 'SKU-I',
    recognitionMeta: { provider: 'gemini', model: 'gemini-2.5-flash', durationMs: 1200 },
    generatedImages: [
      { id: 'img-1', planId: 'plan-1', provider: 'openai', model: 'gpt-image-2', durationMs: 3000, isRealGenerated: true, imageType: 'lifestyle_image', mattingProvider: 'sharp' }
    ],
    reviewResults: [
      { imageId: 'img-1', planId: 'plan-1', provider: 'gemini', model: 'gemini-2.5-flash', riskLevel: 'high', pass: false, issues: [{ level: 'high' }, { level: 'medium' }], imageType: 'lifestyle_image', platformId: 'amazon' }
    ],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:10:00.000Z'
  };
  const batchTask = {
    id: 'batch-index-1',
    name: 'Index Batch',
    status: 'partial_failed',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:10:00.000Z',
    queue: { status: 'partial_failed', action: 'review', concurrency: 2, pendingJobs: 0, runningJobs: 0, completedJobs: 1, failedJobs: 1, skippedJobs: 0 },
    locks: { isRunning: false, lockedAt: null },
    skuTasks: [
      { skuId: 'SKU-I', taskId: 'task-index-1', folderName: 'sku-i', status: 'failed', currentStep: 'review', queueStatus: 'failed', lastErrorCode: 'JOB_TIMEOUT', lastErrorCategory: 'timeout', retryable: true, requiresUserAction: false, updatedAt: '2026-01-01T00:10:00.000Z' }
    ],
    analytics: {
      sku: { total: 1, completed: 0, failed: 1, waitingConfirm: 0, skipped: 0 },
      images: { totalGenerated: 1, realGeneratedCount: 1, mockPreviewCount: 0 },
      review: { highRiskCount: 1, mediumRiskCount: 0, lowRiskCount: 0 },
      cost: { estimatedTotal: 1.23 }
    }
  };
  await store.saveTask(task);
  await store.saveBatchTask(batchTask);

  const db = store.getDatabase();
  assert.equal(db.prepare('SELECT status FROM batch_sku_index WHERE batch_id = ? AND task_id = ?').get('batch-index-1', 'task-index-1').status, 'failed');
  assert.equal(db.prepare('SELECT queue_status FROM batch_queue_index WHERE batch_id = ?').get('batch-index-1').queue_status, 'partial_failed');
  assert.equal(db.prepare('SELECT failed_sku FROM batch_analytics_index WHERE batch_id = ?').get('batch-index-1').failed_sku, 1);
  assert.equal(db.prepare("SELECT call_count FROM provider_usage_index WHERE batch_id = ? AND provider_type = 'vision' AND provider = 'gemini'").get('batch-index-1').call_count, 1);
  assert.equal(db.prepare('SELECT risk_level FROM review_risk_index WHERE batch_id = ? AND image_id = ?').get('batch-index-1', 'img-1').risk_level, 'high');
  store.close();
});

test('migrateJsonToSqlite imports JSON metadata without deleting source JSON', async () => {
  const dir = await tempDir();
  const jsonPath = path.join(dir, 'db.json');
  const sqlitePath = path.join(dir, 'app.sqlite');
  await fs.writeFile(jsonPath, JSON.stringify({
    tasks: [{ id: 'task-migrate', status: 'uploaded', sku: 'SKU-M' }],
    batchTasks: [{ id: 'batch-migrate', status: 'imported', name: 'Batch M' }],
    importedFolders: [{ folderPath: 'D:/imports/sku-m', importedAt: '2026-01-01T00:00:00.000Z' }],
    workflowTemplates: [{ id: 'template-migrate', name: 'Template M' }],
    userSettings: { version: 'v4.3' }
  }, null, 2));

  const report = await migrateJsonToSqlite({
    jsonDbPath: jsonPath,
    sqliteDbPath: sqlitePath,
    backupJsonBeforeMigrate: true
  });
  assert.equal(report.success, true);
  assert.equal(report.counts.tasks, 1);
  assert.ok(await fs.stat(jsonPath));
  assert.ok(report.backupJsonPath);

  const store = new SqliteStore({ dbPath: sqlitePath });
  await store.init();
  assert.equal((await store.getTask('task-migrate')).sku, 'SKU-M');
  assert.equal((await store.getBatchTask('batch-migrate')).name, 'Batch M');
});

test('db compatibility layer can use sqlite when STORAGE_DRIVER=sqlite', async () => {
  const previousDriver = process.env.STORAGE_DRIVER;
  const previousSqlitePath = process.env.SQLITE_DB_PATH;
  const dir = await tempDir();
  try {
    process.env.STORAGE_DRIVER = 'sqlite';
    process.env.SQLITE_DB_PATH = path.join(dir, 'compat.sqlite');
    resetStoreForTests();
    await resetDatabaseForTests();
    await createTask({ id: 'task-compat-sqlite', status: 'uploaded', sku: 'SKU-C', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' });
    const task = await getTask('task-compat-sqlite');
    assert.equal(task.sku, 'SKU-C');
  } finally {
    if (previousDriver === undefined) delete process.env.STORAGE_DRIVER;
    else process.env.STORAGE_DRIVER = previousDriver;
    if (previousSqlitePath === undefined) delete process.env.SQLITE_DB_PATH;
    else process.env.SQLITE_DB_PATH = previousSqlitePath;
    resetStoreForTests();
  }
});

test('rebuildAllIndexes recreates structured indexes from stored JSON objects', async () => {
  const dir = await tempDir();
  const sqlitePath = path.join(dir, 'rebuild.sqlite');
  const store = new SqliteStore({ dbPath: sqlitePath });
  await store.init();
  await store.saveDb({
    tasks: [{ id: 'task-rebuild', batchId: 'batch-rebuild', status: 'reviewed', reviewResults: [{ imageId: 'img-rebuild', riskLevel: 'medium', pass: true }] }],
    batchTasks: [{ id: 'batch-rebuild', status: 'reviewed', skuTasks: [{ skuId: 'SKU-R', taskId: 'task-rebuild', status: 'reviewed' }] }],
    importedFolders: [],
    workflowTemplates: [],
    userSettings: null
  });
  store.getDatabase().prepare('DELETE FROM batch_sku_index').run();
  const report = await rebuildAllIndexes({ store });
  assert.equal(report.batchCount, 1);
  assert.equal(report.taskCount, 1);
  assert.equal(report.batchSkuIndexRows, 1);
  assert.equal(store.getDatabase().prepare('SELECT COUNT(*) AS count FROM batch_sku_index').get().count, 1);
  store.close();
});

test('SQLite analytics summary can use index and falls back to object scan', async () => {
  const previousDriver = process.env.STORAGE_DRIVER;
  const previousSqlitePath = process.env.SQLITE_DB_PATH;
  const dir = await tempDir();
  try {
    process.env.STORAGE_DRIVER = 'sqlite';
    process.env.SQLITE_DB_PATH = path.join(dir, 'analytics-index.sqlite');
    resetStoreForTests();
    await resetDatabaseForTests();
    const store = new SqliteStore({ dbPath: process.env.SQLITE_DB_PATH });
    await store.init();
    await store.saveDb({
      tasks: [],
      batchTasks: [{
        id: 'batch-analytics-index',
        name: 'Analytics Index',
        status: 'completed',
        updatedAt: '2026-01-01T00:00:00.000Z',
        skuTasks: [{ skuId: 'SKU-A', taskId: 'task-a', status: 'completed' }],
        analytics: {
          sku: { total: 1, completed: 1, failed: 0, waitingConfirm: 0, skipped: 0 },
          images: { totalGenerated: 2, realGeneratedCount: 1, mockPreviewCount: 1 },
          review: { highRiskCount: 0, mediumRiskCount: 1, lowRiskCount: 1 },
          cost: { estimatedTotal: 2.5 }
        }
      }],
      importedFolders: [],
      workflowTemplates: [],
      userSettings: null
    });
    store.close();
    resetStoreForTests();
    const indexed = await getAllBatchAnalyticsSummary();
    assert.equal(indexed.analyticsSource, 'sqlite_index');
    assert.equal(indexed.totalSku, 1);

    const brokenStore = new SqliteStore({ dbPath: process.env.SQLITE_DB_PATH });
    await brokenStore.init();
    brokenStore.getDatabase().prepare('DROP TABLE batch_analytics_index').run();
    brokenStore.close();
    resetStoreForTests();
    const fallback = await getAllBatchAnalyticsSummary();
    assert.equal(fallback.analyticsSource, 'object_scan');
    assert.equal(fallback.totalSku, 1);
  } finally {
    if (previousDriver === undefined) delete process.env.STORAGE_DRIVER;
    else process.env.STORAGE_DRIVER = previousDriver;
    if (previousSqlitePath === undefined) delete process.env.SQLITE_DB_PATH;
    else process.env.SQLITE_DB_PATH = previousSqlitePath;
    resetStoreForTests();
  }
});
