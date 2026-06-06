import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { paths } from './db.js';
import { backupsDir, createSnapshot } from './snapshotService.js';
import { getUserSettings, updateUserSettings } from './userSettingsService.js';
import { getSqliteDbPath, getStorageDriver } from '../storage/index.js';
import { migrateJsonToSqlite, verifySqliteMigration } from '../storage/migrations.js';
import { SqliteStore } from '../storage/sqliteStore.js';
import { rebuildAllIndexes } from '../storage/sqliteIndexSync.js';
import { normalizeDbShape, SQLITE_INDEX_TABLES, SQLITE_SCHEMA_VERSION } from '../storage/schema.js';

export const SQLITE_MODE_JSON_NOT_SYNCED_WARNING = '当前已在 SQLite 模式运行，db.json 不再同步，迁移一致性验证不再适用。';

function nowIso() {
  return new Date().toISOString();
}

async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function statusCheck(id, status, message, details = {}) {
  return { id, status, message, details };
}

async function readJsonDb(jsonDbPath) {
  const raw = await fs.readFile(jsonDbPath, 'utf8');
  return JSON.parse(raw);
}

async function writableDir(dirPath) {
  await fs.mkdir(dirPath, { recursive: true });
  const probe = path.join(dirPath, `.storage-trial-${process.pid}-${Date.now()}.tmp`);
  await fs.writeFile(probe, 'ok');
  await fs.rm(probe, { force: true });
}

function inspectSqlite(sqliteDbPath) {
  if (!fsSync.existsSync(sqliteDbPath)) {
    return {
      exists: false,
      schemaVersion: null,
      indexTablesReady: false,
      indexCounts: {}
    };
  }
  const store = new SqliteStore({ dbPath: sqliteDbPath });
  try {
    const db = store.getDatabase();
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name);
    const schemaVersion = tables.includes('app_meta')
      ? Number(db.prepare('SELECT value FROM app_meta WHERE key = ?').get('schemaVersion')?.value || 0)
      : 0;
    const indexCounts = {};
    for (const table of SQLITE_INDEX_TABLES) {
      indexCounts[table] = tables.includes(table)
        ? Number(db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count || 0)
        : null;
    }
    return {
      exists: true,
      schemaVersion,
      indexTablesReady: SQLITE_INDEX_TABLES.every((table) => tables.includes(table)),
      indexCounts
    };
  } finally {
    store.close();
  }
}

function compactReport(report) {
  if (!report || typeof report !== 'object') return report;
  return JSON.parse(JSON.stringify(report));
}

function dbCounts(db) {
  const normalized = normalizeDbShape(db);
  return {
    tasks: normalized.tasks.length,
    batchTasks: normalized.batchTasks.length,
    importedFolders: normalized.importedFolders.length,
    workflowTemplates: normalized.workflowTemplates.length,
    userSettings: normalized.userSettings ? 1 : 0
  };
}

function countsMatch(left = {}, right = {}) {
  return ['tasks', 'batchTasks', 'importedFolders', 'workflowTemplates', 'userSettings']
    .every((key) => Number(left[key] || 0) === Number(right[key] || 0));
}

function readSqliteCountsWithoutInit(sqliteDbPath) {
  const store = new SqliteStore({ dbPath: sqliteDbPath });
  try {
    const db = store.getDatabase();
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name);
    const requiredTables = {
      tasks: 'tasks',
      batchTasks: 'batch_tasks',
      importedFolders: 'imported_folders',
      workflowTemplates: 'workflow_templates',
      userSettings: 'user_settings'
    };
    if (!Object.values(requiredTables).every((table) => tables.includes(table))) return null;
    return {
      tasks: Number(db.prepare('SELECT COUNT(*) AS count FROM tasks').get().count || 0),
      batchTasks: Number(db.prepare('SELECT COUNT(*) AS count FROM batch_tasks').get().count || 0),
      importedFolders: Number(db.prepare('SELECT COUNT(*) AS count FROM imported_folders').get().count || 0),
      workflowTemplates: Number(db.prepare('SELECT COUNT(*) AS count FROM workflow_templates').get().count || 0),
      userSettings: Number(db.prepare('SELECT COUNT(*) AS count FROM user_settings').get().count || 0)
    };
  } finally {
    store.close();
  }
}

async function getSqliteModeJsonSyncWarning({ jsonDbPath, sqliteDbPath }) {
  if (getStorageDriver() !== 'sqlite') return null;
  if (!(await pathExists(jsonDbPath)) || !(await pathExists(sqliteDbPath))) return null;
  try {
    const jsonCounts = dbCounts(await readJsonDb(jsonDbPath));
    const sqliteCounts = readSqliteCountsWithoutInit(sqliteDbPath);
    if (!sqliteCounts) return null;
    if (countsMatch(jsonCounts, sqliteCounts)) return null;
    return {
      code: 'SQLITE_MODE_JSON_NOT_SYNCED',
      message: SQLITE_MODE_JSON_NOT_SYNCED_WARNING,
      details: { jsonCounts, sqliteCounts }
    };
  } catch {
    return null;
  }
}

async function verifyActiveSqliteRuntime({ jsonDbPath, sqliteDbPath }) {
  const store = new SqliteStore({ dbPath: sqliteDbPath });
  const warnings = [];
  try {
    await store.init();
    const schema = await store.validateSchema();
    const sqliteDb = normalizeDbShape(await store.getDb());
    const db = store.getDatabase();
    const indexCounts = {};
    let indexTablesReady = true;
    for (const table of SQLITE_INDEX_TABLES) {
      try {
        indexCounts[table] = Number(db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count || 0);
      } catch {
        indexCounts[table] = null;
        indexTablesReady = false;
      }
    }
    db.prepare('CREATE TEMP TABLE IF NOT EXISTS storage_trial_write_test (ok INTEGER)').run();
    db.prepare('DROP TABLE IF EXISTS storage_trial_write_test').run();
    const jsonSyncWarning = await getSqliteModeJsonSyncWarning({ jsonDbPath, sqliteDbPath });
    if (jsonSyncWarning) warnings.push(jsonSyncWarning);
    const missingIndexTables = SQLITE_INDEX_TABLES.filter((table) => !schema.tableNames.includes(table));
    const schemaReady = schema.schemaVersion === SQLITE_SCHEMA_VERSION && schema.missingTables.length === 0;
    const success = schemaReady && indexTablesReady && missingIndexTables.length === 0;
    return {
      success,
      runtimeReady: success,
      schemaVersion: schema.schemaVersion,
      indexesPresent: indexTablesReady && missingIndexTables.length === 0,
      indexTablesReady: indexTablesReady && missingIndexTables.length === 0,
      missingTables: schema.missingTables,
      missingIndexTables,
      indexCounts,
      counts: { sqlite: dbCounts(sqliteDb) },
      warnings,
      jsonDbPath,
      sqliteDbPath
    };
  } catch (err) {
    return {
      success: false,
      runtimeReady: false,
      schemaVersion: 0,
      indexesPresent: false,
      indexTablesReady: false,
      missingTables: [],
      missingIndexTables: SQLITE_INDEX_TABLES,
      indexCounts: {},
      counts: { sqlite: {} },
      warnings,
      jsonDbPath,
      sqliteDbPath,
      errorMessage: err.message
    };
  } finally {
    store.close();
  }
}

async function patchSqliteTrial(patch = {}) {
  const current = await getUserSettings();
  const nextTrial = {
    ...current.sqliteTrial,
    ...patch,
    notes: Array.isArray(patch.notes)
      ? patch.notes.slice(-20)
      : (current.sqliteTrial?.notes || []).slice(-20)
  };
  const updated = await updateUserSettings({ sqliteTrial: nextTrial });
  return updated.sqliteTrial;
}

async function syncSettingsToSqlite(sqliteDbPath) {
  if (!(await pathExists(sqliteDbPath))) return;
  const store = new SqliteStore({ dbPath: sqliteDbPath });
  try {
    await store.init();
    await store.saveUserSettings(await getUserSettings());
  } finally {
    store.close();
  }
}

async function syncSettingsToJson(jsonDbPath) {
  if (path.resolve(jsonDbPath) === path.resolve(paths.dbPath) || !(await pathExists(jsonDbPath))) return;
  const raw = await fs.readFile(jsonDbPath, 'utf8');
  const db = JSON.parse(raw);
  db.userSettings = await getUserSettings();
  await fs.writeFile(jsonDbPath, JSON.stringify(db, null, 2));
}

export async function getStorageStatus({ jsonDbPath = paths.dbPath, sqliteDbPath = getSqliteDbPath() } = {}) {
  const sqliteInfo = inspectSqlite(sqliteDbPath);
  const settings = await getUserSettings();
  const jsonDbExists = await pathExists(jsonDbPath);
  const warnings = [];
  if (!jsonDbExists) warnings.push({ code: 'JSON_DB_MISSING', message: 'db.json does not exist.' });
  if (getStorageDriver() === 'sqlite' && !sqliteInfo.exists) warnings.push({ code: 'SQLITE_DB_MISSING', message: 'STORAGE_DRIVER=sqlite but app.sqlite does not exist.' });
  if (sqliteInfo.exists && !sqliteInfo.indexTablesReady) warnings.push({ code: 'SQLITE_INDEX_NOT_READY', message: 'SQLite v2 index tables are missing or incomplete.' });
  if (getStorageDriver() === 'json' && settings.sqliteTrial?.status === 'ready' && sqliteInfo.indexTablesReady) {
    warnings.push({ code: 'SQLITE_READY_NOT_ENABLED', message: 'SQLite is verified and ready. Switch .env manually when you are ready.' });
  }
  const sqliteModeJsonSyncWarning = await getSqliteModeJsonSyncWarning({ jsonDbPath, sqliteDbPath });
  if (sqliteModeJsonSyncWarning) warnings.push(sqliteModeJsonSyncWarning);
  return {
    storageDriver: getStorageDriver(),
    jsonDbExists,
    sqliteDbExists: sqliteInfo.exists,
    sqlitePath: sqliteDbPath,
    schemaVersion: sqliteInfo.schemaVersion,
    indexTablesReady: sqliteInfo.indexTablesReady,
    indexCounts: sqliteInfo.indexCounts,
    sqliteTrial: settings.sqliteTrial,
    warnings
  };
}

export async function preflightSqlite({
  jsonDbPath = paths.dbPath,
  sqliteDbPath = getSqliteDbPath(),
  dataDir = paths.dataDir,
  backupsDir: backupDir = backupsDir
} = {}) {
  const checks = [];
  let parsedDb = null;
  try {
    parsedDb = await readJsonDb(jsonDbPath);
    checks.push(statusCheck('json-db-valid', 'healthy', 'db.json exists and is valid JSON.', { jsonDbPath }));
  } catch (err) {
    checks.push(statusCheck('json-db-valid', 'error', 'db.json is missing or invalid.', { jsonDbPath, errorCode: err.code || 'INVALID_JSON' }));
  }
  try {
    await writableDir(dataDir);
    checks.push(statusCheck('data-dir-writable', 'healthy', 'backend/data is writable.', { dataDir }));
  } catch (err) {
    checks.push(statusCheck('data-dir-writable', 'error', 'backend/data is not writable.', { dataDir, errorCode: err.code || 'UNKNOWN' }));
  }
  try {
    await writableDir(backupDir);
    checks.push(statusCheck('backups-dir-writable', 'healthy', 'backups directory is writable.', { backupsDir: backupDir }));
  } catch (err) {
    checks.push(statusCheck('backups-dir-writable', 'error', 'backups directory is not writable.', { backupsDir: backupDir, errorCode: err.code || 'UNKNOWN' }));
  }
  const sqliteExists = await pathExists(sqliteDbPath);
  checks.push(statusCheck(
    'sqlite-existing-file',
    sqliteExists ? 'warning' : 'healthy',
    sqliteExists ? 'app.sqlite already exists. Migration will not overwrite it unless explicitly allowed.' : 'No existing app.sqlite file blocks migration.',
    { sqliteDbPath, exists: sqliteExists }
  ));
  const runningLocks = (parsedDb?.batchTasks || []).filter((batch) => batch?.locks?.isRunning || batch?.queue?.status === 'running');
  checks.push(statusCheck(
    'batch-running-locks',
    runningLocks.length ? 'warning' : 'healthy',
    runningLocks.length ? 'There are running batch queues. Stop or finish them before migration.' : 'No running batch queue locks were found.',
    { runningBatchCount: runningLocks.length }
  ));
  checks.push(statusCheck('snapshot-recommended', 'warning', 'Create a project snapshot before SQLite migration.', { recommended: true }));
  let diskFreeBytes = null;
  try {
    if (fs.statfs) {
      const stat = await fs.statfs(dataDir);
      diskFreeBytes = Number(stat.bavail) * Number(stat.bsize);
    }
  } catch {
    diskFreeBytes = null;
  }
  checks.push(statusCheck('disk-space', diskFreeBytes !== null && diskFreeBytes < 1024 * 1024 * 100 ? 'warning' : 'healthy', 'Disk space check completed.', { diskFreeBytes }));
  return {
    checkedAt: nowIso(),
    ready: !checks.some((check) => check.status === 'error'),
    checks
  };
}

export async function migrateToSqliteTrial({
  jsonDbPath = paths.dbPath,
  sqliteDbPath = getSqliteDbPath(),
  backupsDir: _backupDir = backupsDir,
  createSnapshotBeforeMigrate = true,
  overwriteExistingSqlite = false,
  skipSnapshot = false,
  confirm = false
} = {}) {
  if (!confirm) {
    const error = new Error('SQLite migration requires confirm=true.');
    error.statusCode = 400;
    error.code = 'CONFIRM_REQUIRED';
    throw error;
  }
  if ((await pathExists(sqliteDbPath)) && !overwriteExistingSqlite) {
    const error = new Error('SQLite database already exists.');
    error.statusCode = 409;
    error.code = 'SQLITE_ALREADY_EXISTS';
    throw error;
  }
  let snapshotId = null;
  if (createSnapshotBeforeMigrate && !skipSnapshot) {
    const snapshot = await createSnapshot({ includeUploads: false, includeOutputs: false, includeDocs: false, note: 'Before SQLite migration' });
    snapshotId = snapshot.snapshotId;
  }
  if (overwriteExistingSqlite) {
    await fs.rm(sqliteDbPath, { force: true });
    await fs.rm(`${sqliteDbPath}-wal`, { force: true });
    await fs.rm(`${sqliteDbPath}-shm`, { force: true });
  }
  const report = await migrateJsonToSqlite({
    jsonDbPath,
    sqliteDbPath,
    backupJsonBeforeMigrate: true
  });
  const store = new SqliteStore({ dbPath: sqliteDbPath });
  await store.init();
  const rebuildReport = await rebuildAllIndexes({ store });
  store.close();
  const finalReport = {
    ...report,
    snapshotId,
    rebuildReport,
    storageDriver: getStorageDriver(),
    nextSteps: [
      'Run SQLite verification.',
      'If verification passes, manually set STORAGE_DRIVER=sqlite in .env.',
      'Restart the backend and run Health Check.'
    ]
  };
  const trial = await patchSqliteTrial({
    enabled: false,
    startedAt: nowIso(),
    status: 'running',
    jsonBackupCreated: Boolean(report.backupJsonPath || snapshotId),
    sqlitePath: sqliteDbPath,
    schemaVersion: report.schemaVersion || 2,
    lastMigrationReport: compactReport(finalReport),
    notes: ['Migration finished. Verify SQLite before switching STORAGE_DRIVER.']
  });
  await syncSettingsToJson(jsonDbPath);
  await syncSettingsToSqlite(sqliteDbPath);
  return finalReport;
}

export async function verifySqliteTrial({ jsonDbPath = paths.dbPath, sqliteDbPath = getSqliteDbPath() } = {}) {
  if (getStorageDriver() === 'sqlite') {
    const report = await verifyActiveSqliteRuntime({ jsonDbPath, sqliteDbPath });
    const trial = await patchSqliteTrial({
      enabled: report.success,
      lastVerifiedAt: nowIso(),
      status: report.success ? 'ready' : 'failed',
      sqlitePath: sqliteDbPath,
      schemaVersion: report.schemaVersion || 0,
      lastVerificationReport: compactReport(report),
      notes: report.success
        ? ['SQLite runtime verification passed. db.json migration consistency is no longer applicable in SQLite mode.']
        : ['SQLite runtime verification failed. Inspect schema, index tables, and SQLite read/write status.']
    });
    await syncSettingsToSqlite(sqliteDbPath);
    return { ...report, sqliteTrial: trial };
  }
  const report = await verifySqliteMigration({ jsonDbPath, sqliteDbPath });
  const trial = await patchSqliteTrial({
    enabled: report.success,
    lastVerifiedAt: nowIso(),
    status: report.success ? 'ready' : 'failed',
    sqlitePath: sqliteDbPath,
    schemaVersion: report.schemaVersion || 0,
    lastVerificationReport: compactReport(report),
    notes: report.success
      ? ['SQLite verification passed. You can manually switch STORAGE_DRIVER=sqlite and restart the backend.']
      : ['SQLite verification failed. Keep STORAGE_DRIVER=json and inspect the verification report.']
  });
  await syncSettingsToJson(jsonDbPath);
  await syncSettingsToSqlite(sqliteDbPath);
  return { ...report, sqliteTrial: trial };
}

export async function rebuildSqliteTrialIndexes({ sqliteDbPath = getSqliteDbPath() } = {}) {
  const store = new SqliteStore({ dbPath: sqliteDbPath });
  await store.init();
  const report = await rebuildAllIndexes({ store });
  store.close();
  return {
    status: 'success',
    sqliteDbPath,
    storageDriver: getStorageDriver(),
    ...report,
    nextSteps: ['Run verify-sqlite after rebuilding indexes.']
  };
}
