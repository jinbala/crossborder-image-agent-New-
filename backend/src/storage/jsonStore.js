import fs from 'node:fs/promises';
import path from 'node:path';
import { EMPTY_DB, normalizeDbShape } from './schema.js';

export class JsonStore {
  constructor({ dbPath, dataDir, uploadDir, outputDir }) {
    this.dbPath = dbPath;
    this.dataDir = dataDir;
    this.uploadDir = uploadDir;
    this.outputDir = outputDir;
  }

  async init() {
    await fs.mkdir(this.dataDir, { recursive: true });
    if (this.uploadDir) await fs.mkdir(this.uploadDir, { recursive: true });
    if (this.outputDir) await fs.mkdir(this.outputDir, { recursive: true });
    try {
      await fs.access(this.dbPath);
    } catch {
      await fs.writeFile(this.dbPath, JSON.stringify(EMPTY_DB, null, 2));
    }
  }

  async getDb() {
    await this.init();
    const raw = await fs.readFile(this.dbPath, 'utf8');
    return normalizeDbShape(JSON.parse(raw));
  }

  async saveDb(db) {
    await this.init();
    const normalized = normalizeDbShape(db);
    const tempPath = `${this.dbPath}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(tempPath, JSON.stringify(normalized, null, 2));
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        await fs.rename(tempPath, this.dbPath);
        return normalized;
      } catch (err) {
        if (!['EPERM', 'EACCES', 'EBUSY'].includes(err.code) || attempt === 4) throw err;
        await new Promise((resolve) => setTimeout(resolve, 25 * (attempt + 1)));
      }
    }
    return normalized;
  }

  async getTasks() {
    return (await this.getDb()).tasks;
  }

  async getTask(taskId) {
    return (await this.getTasks()).find((task) => task.id === taskId) || null;
  }

  async saveTask(task) {
    const db = await this.getDb();
    const index = db.tasks.findIndex((item) => item.id === task.id);
    if (index === -1) db.tasks.push(task);
    else db.tasks[index] = task;
    await this.saveDb(db);
    return task;
  }

  async deleteTask(taskId) {
    const db = await this.getDb();
    db.tasks = db.tasks.filter((task) => task.id !== taskId);
    await this.saveDb(db);
  }

  async getBatchTasks() {
    return (await this.getDb()).batchTasks;
  }

  async getBatchTask(batchId) {
    return (await this.getBatchTasks()).find((batchTask) => batchTask.id === batchId) || null;
  }

  async saveBatchTask(batchTask) {
    const db = await this.getDb();
    const index = db.batchTasks.findIndex((item) => item.id === batchTask.id);
    if (index === -1) db.batchTasks.push(batchTask);
    else db.batchTasks[index] = batchTask;
    await this.saveDb(db);
    return batchTask;
  }

  async getUserSettings() {
    return (await this.getDb()).userSettings;
  }

  async saveUserSettings(settings) {
    const db = await this.getDb();
    db.userSettings = settings;
    await this.saveDb(db);
    return settings;
  }

  async getWorkflowTemplates() {
    return (await this.getDb()).workflowTemplates;
  }

  async saveWorkflowTemplates(templates) {
    const db = await this.getDb();
    db.workflowTemplates = Array.isArray(templates) ? templates : [];
    await this.saveDb(db);
    return db.workflowTemplates;
  }

  async getImportedFolders() {
    return (await this.getDb()).importedFolders;
  }

  async saveImportedFolders(folders) {
    const db = await this.getDb();
    db.importedFolders = Array.isArray(folders) ? folders : [];
    await this.saveDb(db);
    return db.importedFolders;
  }
}

export function defaultJsonDbPath({ dataDir }) {
  return path.join(dataDir, 'db.json');
}
