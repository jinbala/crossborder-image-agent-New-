import { ensureBaseStoragePaths, paths } from './dbPaths.js';
import { getSqliteDbPath, getStorageDriver, getStore, resetStoreForTests as resetActiveStoreForTests } from '../storage/index.js';
import { migrateJsonToSqlite } from '../storage/migrations.js';
import fs from 'node:fs/promises';
let mutationQueue = Promise.resolve();

export { paths };

export async function ensureStorage() {
  await ensureBaseStoragePaths();
  if (
    getStorageDriver() === 'sqlite' &&
    ['1', 'true', 'yes', 'on'].includes(String(process.env.SQLITE_AUTO_MIGRATE || 'false').toLowerCase())
  ) {
    try {
      await fs.access(getSqliteDbPath());
    } catch {
      await migrateJsonToSqlite({
        jsonDbPath: paths.dbPath,
        sqliteDbPath: getSqliteDbPath(),
        backupJsonBeforeMigrate: String(process.env.SQLITE_BACKUP_JSON_BEFORE_MIGRATE || 'true').toLowerCase() !== 'false'
      });
      resetActiveStoreForTests();
    }
  }
  await getStore().init();
}

export async function readDb() {
  await ensureStorage();
  return getStore().getDb();
}

export async function writeDb(db) {
  await ensureStorage();
  return getStore().saveDb(db);
}

async function withDbMutation(mutator) {
  const run = mutationQueue.then(mutator, mutator);
  mutationQueue = run.catch(() => {});
  return run;
}

export async function resetDatabaseForTests() {
  return withDbMutation(async () => {
    resetActiveStoreForTests();
    await ensureStorage();
    await writeDb({ tasks: [], batchTasks: [], importedFolders: [], workflowTemplates: [], userSettings: null });
  });
}

export async function listTasks() {
  const db = await readDb();
  return db.tasks.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
}

export async function getTask(taskId) {
  const db = await readDb();
  return db.tasks.find((task) => task.id === taskId) || null;
}

export async function createTask(task) {
  return withDbMutation(async () => {
    const db = await readDb();
    db.tasks.push(task);
    await writeDb(db);
    return task;
  });
}

export async function updateTask(taskId, updater) {
  return withDbMutation(async () => {
    const db = await readDb();
    const index = db.tasks.findIndex((task) => task.id === taskId);
    if (index === -1) {
      const error = new Error('Task not found');
      error.statusCode = 404;
      throw error;
    }
    const now = new Date().toISOString();
    const updated = {
      ...db.tasks[index],
      ...updater(db.tasks[index]),
      updatedAt: now
    };
    db.tasks[index] = updated;
    await writeDb(db);
    return updated;
  });
}

export async function listBatchTasks() {
  const db = await readDb();
  return db.batchTasks.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
}

export async function getBatchTask(batchId) {
  const db = await readDb();
  return db.batchTasks.find((batchTask) => batchTask.id === batchId) || null;
}

export async function createBatchTask(batchTask) {
  return withDbMutation(async () => {
    const db = await readDb();
    db.batchTasks.push(batchTask);
    await writeDb(db);
    return batchTask;
  });
}

export async function updateBatchTask(batchId, updater) {
  return withDbMutation(async () => {
    const db = await readDb();
    const index = db.batchTasks.findIndex((batchTask) => batchTask.id === batchId);
    if (index === -1) {
      const error = new Error('Batch task not found');
      error.statusCode = 404;
      throw error;
    }
    const now = new Date().toISOString();
    const updated = {
      ...db.batchTasks[index],
      ...updater(db.batchTasks[index], db),
      updatedAt: now
    };
    db.batchTasks[index] = updated;
    await writeDb(db);
    return updated;
  });
}

export async function deleteBatchTaskRecord(batchId, { deleteTasks = true, resetImportedFolders = true } = {}) {
  return withDbMutation(async () => {
    const db = await readDb();
    const batch = db.batchTasks.find((batchTask) => batchTask.id === batchId);
    if (!batch) {
      const error = new Error('Batch task not found');
      error.statusCode = 404;
      throw error;
    }
    const taskIds = new Set((batch.skuTasks || []).map((sku) => sku.taskId).filter(Boolean));
    db.batchTasks = db.batchTasks.filter((batchTask) => batchTask.id !== batchId);
    if (deleteTasks) {
      db.tasks = db.tasks.filter((task) => !taskIds.has(task.id));
    }
    if (resetImportedFolders) {
      db.importedFolders = (db.importedFolders || []).filter((record) => record.batchId !== batchId);
    }
    await writeDb(db);
    return {
      batch,
      deletedTaskCount: deleteTasks ? taskIds.size : 0,
      resetImportedFolderCount: resetImportedFolders
        ? (batch.skuTasks || []).filter((sku) => sku.sourceFolderPath).length
        : 0
    };
  });
}

export async function listImportedFolders() {
  const db = await readDb();
  return db.importedFolders || [];
}

export async function markImportedFolders(records = []) {
  return withDbMutation(async () => {
    const db = await readDb();
    const importedFolders = Array.isArray(db.importedFolders) ? db.importedFolders : [];
    const byPath = new Map(importedFolders.map((record) => [record.folderPath, record]));
    for (const record of records) {
      if (!record?.folderPath) continue;
      byPath.set(record.folderPath, {
        ...(byPath.get(record.folderPath) || {}),
        ...record
      });
    }
    db.importedFolders = [...byPath.values()].sort((a, b) => new Date(b.importedAt || 0) - new Date(a.importedAt || 0));
    await writeDb(db);
    return db.importedFolders;
  });
}

export async function removeImportedFoldersForBatch(batchId) {
  return withDbMutation(async () => {
    const db = await readDb();
    const before = Array.isArray(db.importedFolders) ? db.importedFolders : [];
    db.importedFolders = before.filter((record) => record.batchId !== batchId);
    await writeDb(db);
    return before.length - db.importedFolders.length;
  });
}

export async function listWorkflowTemplates() {
  const db = await readDb();
  return Array.isArray(db.workflowTemplates) ? db.workflowTemplates : [];
}

export async function createWorkflowTemplate(template) {
  return withDbMutation(async () => {
    const db = await readDb();
    db.workflowTemplates = Array.isArray(db.workflowTemplates) ? db.workflowTemplates : [];
    db.workflowTemplates.push(template);
    await writeDb(db);
    return template;
  });
}

export async function updateWorkflowTemplate(templateId, updater) {
  return withDbMutation(async () => {
    const db = await readDb();
    db.workflowTemplates = Array.isArray(db.workflowTemplates) ? db.workflowTemplates : [];
    const index = db.workflowTemplates.findIndex((template) => template.id === templateId);
    if (index === -1) {
      const error = new Error('Workflow template not found');
      error.statusCode = 404;
      throw error;
    }
    const now = new Date().toISOString();
    const updated = {
      ...db.workflowTemplates[index],
      ...updater(db.workflowTemplates[index]),
      isSystemTemplate: false,
      updatedAt: now
    };
    db.workflowTemplates[index] = updated;
    await writeDb(db);
    return updated;
  });
}

export async function deleteWorkflowTemplate(templateId) {
  return withDbMutation(async () => {
    const db = await readDb();
    db.workflowTemplates = Array.isArray(db.workflowTemplates) ? db.workflowTemplates : [];
    const before = db.workflowTemplates.length;
    db.workflowTemplates = db.workflowTemplates.filter((template) => template.id !== templateId);
    if (db.workflowTemplates.length === before) {
      const error = new Error('Workflow template not found');
      error.statusCode = 404;
      throw error;
    }
    await writeDb(db);
    return true;
  });
}

export async function getUserSettingsRecord() {
  const db = await readDb();
  return db.userSettings || null;
}

export async function setUserSettingsRecord(userSettings) {
  return withDbMutation(async () => {
    const db = await readDb();
    db.userSettings = userSettings;
    await writeDb(db);
    return db.userSettings;
  });
}
