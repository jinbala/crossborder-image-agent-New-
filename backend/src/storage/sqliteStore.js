import fs from 'node:fs/promises';
import path from 'node:path';
import Database from 'better-sqlite3';
import {
  CREATE_SCHEMA_SQL,
  EMPTY_DB,
  REQUIRED_SQLITE_TABLES,
  SQLITE_SCHEMA_VERSION,
  normalizeDbShape
} from './schema.js';
import { syncBatchIndexes, syncTaskIndexes } from './sqliteIndexSync.js';

function toJson(value) {
  return JSON.stringify(value || {});
}

function fromJson(value) {
  return value ? JSON.parse(value) : null;
}

function rowToData(row) {
  return row ? fromJson(row.data_json) : null;
}

export class SqliteStore {
  constructor({ dbPath }) {
    this.dbPath = path.resolve(dbPath);
    this.db = null;
  }

  async init() {
    await fs.mkdir(path.dirname(this.dbPath), { recursive: true });
    if (!this.db) this.db = new Database(this.dbPath);
    this.db.pragma('journal_mode = WAL');
    for (const sql of CREATE_SCHEMA_SQL) this.db.exec(sql);
    this.db.prepare('INSERT OR REPLACE INTO app_meta (key, value) VALUES (?, ?)').run('schemaVersion', String(SQLITE_SCHEMA_VERSION));
  }

  getDatabase() {
    if (!this.db) this.db = new Database(this.dbPath);
    return this.db;
  }

  close() {
    if (this.db) this.db.close();
    this.db = null;
  }

  async getSchemaVersion() {
    await this.init();
    const row = this.db.prepare('SELECT value FROM app_meta WHERE key = ?').get('schemaVersion');
    return Number(row?.value || 0);
  }

  async getTableNames() {
    await this.init();
    return this.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((row) => row.name);
  }

  async validateSchema() {
    const tableNames = await this.getTableNames();
    const missingTables = REQUIRED_SQLITE_TABLES.filter((table) => !tableNames.includes(table));
    return {
      schemaVersion: await this.getSchemaVersion(),
      tableNames,
      missingTables
    };
  }

  async getDb() {
    await this.init();
    return normalizeDbShape({
      tasks: await this.getTasks(),
      batchTasks: await this.getBatchTasks(),
      importedFolders: await this.getImportedFolders(),
      workflowTemplates: await this.getWorkflowTemplates(),
      userSettings: await this.getUserSettings()
    });
  }

  async saveDb(dbInput) {
    await this.init();
    const db = normalizeDbShape(dbInput || EMPTY_DB);
    const transaction = this.db.transaction(() => {
      this.db.prepare('DELETE FROM tasks').run();
      this.db.prepare('DELETE FROM batch_tasks').run();
      this.db.prepare('DELETE FROM imported_folders').run();
      this.db.prepare('DELETE FROM workflow_templates').run();
      this.db.prepare('DELETE FROM user_settings').run();
      for (const task of db.tasks) this.saveTaskSync(task);
      for (const batchTask of db.batchTasks) this.saveBatchTaskSync(batchTask);
      for (const template of db.workflowTemplates) this.saveWorkflowTemplateSync(template);
      for (const folder of db.importedFolders) this.saveImportedFolderSync(folder);
      if (db.userSettings) this.saveUserSettingsSync(db.userSettings);
    });
    transaction();
    await this.syncAllIndexesSafely();
    return db;
  }

  async getTasks() {
    await this.init();
    return this.db.prepare('SELECT data_json FROM tasks ORDER BY updated_at DESC').all().map(rowToData);
  }

  async getTask(taskId) {
    await this.init();
    return rowToData(this.db.prepare('SELECT data_json FROM tasks WHERE id = ?').get(taskId));
  }

  saveTaskSync(task) {
    this.db.prepare(`
      INSERT OR REPLACE INTO tasks (id, status, sku, created_at, updated_at, data_json)
      VALUES (@id, @status, @sku, @created_at, @updated_at, @data_json)
    `).run({
      id: task.id,
      status: task.status || null,
      sku: task.sku || task.productInfo?.sku || null,
      created_at: task.createdAt || null,
      updated_at: task.updatedAt || null,
      data_json: toJson(task)
    });
  }

  async saveTask(task) {
    await this.init();
    this.saveTaskSync(task);
    await this.syncTaskIndexesSafely(task);
    return task;
  }

  async deleteTask(taskId) {
    await this.init();
    this.db.prepare('DELETE FROM tasks WHERE id = ?').run(taskId);
  }

  async getBatchTasks() {
    await this.init();
    return this.db.prepare('SELECT data_json FROM batch_tasks ORDER BY updated_at DESC').all().map(rowToData);
  }

  async getBatchTask(batchId) {
    await this.init();
    return rowToData(this.db.prepare('SELECT data_json FROM batch_tasks WHERE id = ?').get(batchId));
  }

  saveBatchTaskSync(batchTask) {
    this.db.prepare(`
      INSERT OR REPLACE INTO batch_tasks (id, status, name, created_at, updated_at, data_json)
      VALUES (@id, @status, @name, @created_at, @updated_at, @data_json)
    `).run({
      id: batchTask.id,
      status: batchTask.status || null,
      name: batchTask.name || null,
      created_at: batchTask.createdAt || null,
      updated_at: batchTask.updatedAt || null,
      data_json: toJson(batchTask)
    });
  }

  async saveBatchTask(batchTask) {
    await this.init();
    this.saveBatchTaskSync(batchTask);
    await this.syncBatchIndexesSafely(batchTask);
    return batchTask;
  }

  async getUserSettings() {
    await this.init();
    return rowToData(this.db.prepare('SELECT data_json FROM user_settings WHERE id = ?').get('default'));
  }

  saveUserSettingsSync(settings) {
    this.db.prepare(`
      INSERT OR REPLACE INTO user_settings (id, updated_at, data_json)
      VALUES ('default', ?, ?)
    `).run(settings?.updatedAt || null, toJson(settings));
  }

  async saveUserSettings(settings) {
    await this.init();
    this.saveUserSettingsSync(settings);
    return settings;
  }

  async getWorkflowTemplates() {
    await this.init();
    return this.db.prepare('SELECT data_json FROM workflow_templates ORDER BY updated_at DESC').all().map(rowToData);
  }

  saveWorkflowTemplateSync(template) {
    this.db.prepare(`
      INSERT OR REPLACE INTO workflow_templates (id, type, name, updated_at, data_json)
      VALUES (@id, @type, @name, @updated_at, @data_json)
    `).run({
      id: template.id,
      type: template.isSystemTemplate ? 'system' : 'user',
      name: template.name || null,
      updated_at: template.updatedAt || template.createdAt || null,
      data_json: toJson(template)
    });
  }

  async saveWorkflowTemplates(templates) {
    await this.init();
    const transaction = this.db.transaction(() => {
      this.db.prepare('DELETE FROM workflow_templates').run();
      for (const template of templates || []) this.saveWorkflowTemplateSync(template);
    });
    transaction();
    return templates || [];
  }

  async getImportedFolders() {
    await this.init();
    return this.db.prepare('SELECT data_json FROM imported_folders ORDER BY imported_at DESC').all().map(rowToData);
  }

  saveImportedFolderSync(folder) {
    this.db.prepare(`
      INSERT OR REPLACE INTO imported_folders (folder_path, imported_at, data_json)
      VALUES (@folder_path, @imported_at, @data_json)
    `).run({
      folder_path: folder.folderPath,
      imported_at: folder.importedAt || null,
      data_json: toJson(folder)
    });
  }

  async saveImportedFolders(folders) {
    await this.init();
    const transaction = this.db.transaction(() => {
      this.db.prepare('DELETE FROM imported_folders').run();
      for (const folder of folders || []) this.saveImportedFolderSync(folder);
    });
    transaction();
    return folders || [];
  }

  async syncTaskIndexesSafely(task) {
    try {
      await syncTaskIndexes(task, this);
    } catch (err) {
      this.lastIndexSyncWarning = { code: err.code || 'SQLITE_INDEX_SYNC_FAILED', message: err.message };
    }
  }

  async syncBatchIndexesSafely(batchTask) {
    try {
      await syncBatchIndexes(batchTask, this);
    } catch (err) {
      this.lastIndexSyncWarning = { code: err.code || 'SQLITE_INDEX_SYNC_FAILED', message: err.message };
    }
  }

  async syncAllIndexesSafely() {
    try {
      const batches = await this.getBatchTasks();
      for (const batch of batches) await syncBatchIndexes(batch, this);
    } catch (err) {
      this.lastIndexSyncWarning = { code: err.code || 'SQLITE_INDEX_SYNC_FAILED', message: err.message };
    }
  }
}
