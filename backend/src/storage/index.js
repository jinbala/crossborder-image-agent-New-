import path from 'node:path';
import { paths } from '../services/dbPaths.js';
import { JsonStore } from './jsonStore.js';
import { SqliteStore } from './sqliteStore.js';

let storeInstance = null;
let storeKey = null;

export function getStorageDriver() {
  return String(process.env.STORAGE_DRIVER || 'json').toLowerCase() === 'sqlite' ? 'sqlite' : 'json';
}

export function getSqliteDbPath() {
  const configured = process.env.SQLITE_DB_PATH || 'backend/data/app.sqlite';
  return path.isAbsolute(configured) ? configured : path.resolve(paths.rootDir, configured);
}

export function getStore({ forceNew = false } = {}) {
  const driver = getStorageDriver();
  const key = driver === 'sqlite' ? `${driver}:${getSqliteDbPath()}` : `${driver}:${paths.dbPath}`;
  if (!forceNew && storeInstance && storeKey === key) return storeInstance;
  if (storeInstance?.close) storeInstance.close();
  storeInstance = driver === 'sqlite'
    ? new SqliteStore({ dbPath: getSqliteDbPath() })
    : new JsonStore({
      dbPath: paths.dbPath,
      dataDir: paths.dataDir,
      uploadDir: paths.uploadDir,
      outputDir: paths.outputDir
    });
  storeKey = key;
  return storeInstance;
}

export function resetStoreForTests() {
  if (storeInstance?.close) storeInstance.close();
  storeInstance = null;
  storeKey = null;
}
