#!/usr/bin/env node
import '../src/config/env.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SqliteStore } from '../src/storage/sqliteStore.js';
import { rebuildAllIndexes } from '../src/storage/sqliteIndexSync.js';

const backendDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const rootDir = path.resolve(backendDir, '..');

function resolveProjectPath(input, fallback) {
  const value = input || fallback;
  return path.isAbsolute(value) ? value : path.resolve(rootDir, value);
}

export function parseRebuildArgs(argv = process.argv.slice(2)) {
  const args = {
    sqliteDbPath: process.env.SQLITE_DB_PATH || 'backend/data/app.sqlite',
    forceSqlite: false
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--sqlite') args.forceSqlite = true;
    else if (arg === '--db') args.sqliteDbPath = argv[++index];
  }
  return args;
}

export async function runRebuildCli(options = {}) {
  const parsed = options.sqliteDbPath ? options : parseRebuildArgs();
  const storageDriver = String(process.env.STORAGE_DRIVER || 'json').toLowerCase();
  if (storageDriver !== 'sqlite' && !parsed.forceSqlite && !options.forceSqlite) {
    const error = new Error('rebuildSqliteIndexes requires STORAGE_DRIVER=sqlite or --sqlite');
    error.code = 'SQLITE_REBUILD_REQUIRES_SQLITE';
    throw error;
  }
  const store = new SqliteStore({
    dbPath: resolveProjectPath(parsed.sqliteDbPath, 'backend/data/app.sqlite')
  });
  await store.init();
  const report = await rebuildAllIndexes({ store });
  report.storageDriver = process.env.STORAGE_DRIVER || 'json';
  report.sqliteDbPath = store.dbPath;
  report.schemaVersion = await store.getSchemaVersion();
  report.nextSteps = ['Run node scripts/verifySqliteMigration.js to confirm index consistency.'];
  store.close();
  if (!options.silent) console.log(JSON.stringify(report, null, 2));
  return report;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runRebuildCli().catch((err) => {
    console.error(JSON.stringify({
      status: 'failed',
      error: {
        code: err.code || 'SQLITE_INDEX_REBUILD_FAILED',
        message: err.message
      }
    }, null, 2));
    process.exitCode = 1;
  });
}
