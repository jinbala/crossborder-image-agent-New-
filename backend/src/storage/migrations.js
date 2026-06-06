import fs from 'node:fs/promises';
import path from 'node:path';
import { JsonStore } from './jsonStore.js';
import { SqliteStore } from './sqliteStore.js';
import { normalizeDbShape } from './schema.js';

function timestampSlug(date = new Date()) {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, '');
}

export async function migrateJsonToSqlite({
  jsonDbPath,
  sqliteDbPath,
  backupJsonBeforeMigrate = true
}) {
  if (!jsonDbPath) throw new Error('jsonDbPath is required');
  if (!sqliteDbPath) throw new Error('sqliteDbPath is required');
  const jsonStore = new JsonStore({
    dbPath: jsonDbPath,
    dataDir: path.dirname(jsonDbPath)
  });
  const db = normalizeDbShape(await jsonStore.getDb());
  let backupJsonPath = null;
  if (backupJsonBeforeMigrate) {
    backupJsonPath = path.join(path.dirname(jsonDbPath), `db-before-sqlite-migration-${timestampSlug()}.json`);
    await fs.copyFile(jsonDbPath, backupJsonPath);
  }
  const sqliteStore = new SqliteStore({ dbPath: sqliteDbPath });
  await sqliteStore.init();
  await sqliteStore.saveDb(db);
  const schemaVersion = await sqliteStore.getSchemaVersion();
  const counts = {
    tasks: db.tasks.length,
    batchTasks: db.batchTasks.length,
    workflowTemplates: db.workflowTemplates.length,
    importedFolders: db.importedFolders.length,
    userSettings: db.userSettings ? 1 : 0
  };
  sqliteStore.close();
  return {
    success: true,
    jsonDbPath,
    sqliteDbPath,
    backupJsonPath,
    schemaVersion,
    counts
  };
}

function compareSample(jsonItems, sqliteItems, key = 'id') {
  const jsonItem = jsonItems[0];
  if (!jsonItem) return true;
  const sqliteItem = sqliteItems.find((item) => item?.[key] === jsonItem[key]);
  return JSON.stringify(jsonItem) === JSON.stringify(sqliteItem);
}

export async function verifySqliteMigration({ jsonDbPath, sqliteDbPath }) {
  if (!jsonDbPath) throw new Error('jsonDbPath is required');
  if (!sqliteDbPath) throw new Error('sqliteDbPath is required');
  const jsonStore = new JsonStore({ dbPath: jsonDbPath, dataDir: path.dirname(jsonDbPath) });
  const sqliteStore = new SqliteStore({ dbPath: sqliteDbPath });
  await sqliteStore.init();
  const jsonDb = normalizeDbShape(await jsonStore.getDb());
  const sqliteDb = normalizeDbShape(await sqliteStore.getDb());
  const schema = await sqliteStore.validateSchema();
  const indexCounts = {
    batchSkuIndex: 0,
    providerUsageIndex: 0,
    reviewRiskIndex: 0
  };
  let indexesPresent = true;
  try {
    indexCounts.batchSkuIndex = sqliteStore.getDatabase().prepare('SELECT COUNT(*) AS count FROM batch_sku_index').get().count;
    indexCounts.providerUsageIndex = sqliteStore.getDatabase().prepare('SELECT COUNT(*) AS count FROM provider_usage_index').get().count;
    indexCounts.reviewRiskIndex = sqliteStore.getDatabase().prepare('SELECT COUNT(*) AS count FROM review_risk_index').get().count;
  } catch {
    indexesPresent = false;
  }
  const counts = {
    json: {
      tasks: jsonDb.tasks.length,
      batchTasks: jsonDb.batchTasks.length,
      importedFolders: jsonDb.importedFolders.length,
      workflowTemplates: jsonDb.workflowTemplates.length,
      userSettings: jsonDb.userSettings ? 1 : 0
    },
    sqlite: {
      tasks: sqliteDb.tasks.length,
      batchTasks: sqliteDb.batchTasks.length,
      importedFolders: sqliteDb.importedFolders.length,
      workflowTemplates: sqliteDb.workflowTemplates.length,
      userSettings: sqliteDb.userSettings ? 1 : 0
    }
  };
  const countsMatch = {
    tasks: counts.json.tasks === counts.sqlite.tasks,
    batchTasks: counts.json.batchTasks === counts.sqlite.batchTasks,
    importedFolders: counts.json.importedFolders === counts.sqlite.importedFolders,
    workflowTemplates: counts.json.workflowTemplates === counts.sqlite.workflowTemplates,
    userSettings: counts.json.userSettings === counts.sqlite.userSettings
  };
  const samplesMatch = {
    task: compareSample(jsonDb.tasks, sqliteDb.tasks),
    batchTask: compareSample(jsonDb.batchTasks, sqliteDb.batchTasks),
    importedFolder: compareSample(jsonDb.importedFolders, sqliteDb.importedFolders, 'folderPath'),
    workflowTemplate: compareSample(jsonDb.workflowTemplates, sqliteDb.workflowTemplates),
    userSettings: JSON.stringify(jsonDb.userSettings) === JSON.stringify(sqliteDb.userSettings)
  };
  sqliteStore.close();
  const expectedBatchSkuRows = sqliteDb.batchTasks.reduce((sum, batch) => sum + (batch.skuTasks?.filter((sku) => sku.taskId).length || 0), 0);
  if (indexesPresent && indexCounts.batchSkuIndex !== expectedBatchSkuRows) indexesPresent = false;
  const success = Object.values(countsMatch).every(Boolean) && Object.values(samplesMatch).every(Boolean) && indexesPresent;
  return {
    success,
    schemaVersion: schema.schemaVersion,
    indexesPresent,
    indexCounts,
    counts,
    countsMatch,
    samplesMatch,
    jsonDbPath,
    sqliteDbPath
  };
}
