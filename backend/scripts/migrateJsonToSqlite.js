#!/usr/bin/env node
import '../src/config/env.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrateJsonToSqlite } from '../src/storage/migrations.js';

const backendDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const rootDir = path.resolve(backendDir, '..');

function resolveProjectPath(input, fallback) {
  const value = input || fallback;
  return path.isAbsolute(value) ? value : path.resolve(rootDir, value);
}

export function parseMigrationArgs(argv = process.argv.slice(2)) {
  const args = {
    jsonDbPath: process.env.JSON_DB_PATH || 'backend/data/db.json',
    sqliteDbPath: process.env.SQLITE_DB_PATH || 'backend/data/app.sqlite',
    backupJsonBeforeMigrate: String(process.env.SQLITE_BACKUP_JSON_BEFORE_MIGRATE || 'true').toLowerCase() !== 'false'
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--json') args.jsonDbPath = argv[++index];
    else if (arg === '--sqlite') args.sqliteDbPath = argv[++index];
    else if (arg === '--no-backup') args.backupJsonBeforeMigrate = false;
  }
  return args;
}

export async function runMigrationCli(options = {}) {
  const parsed = options.jsonDbPath ? options : parseMigrationArgs();
  const jsonDbPath = resolveProjectPath(parsed.jsonDbPath, 'backend/data/db.json');
  const sqliteDbPath = resolveProjectPath(parsed.sqliteDbPath, 'backend/data/app.sqlite');
  const report = await migrateJsonToSqlite({
    jsonDbPath,
    sqliteDbPath,
    backupJsonBeforeMigrate: parsed.backupJsonBeforeMigrate !== false
  });
  report.storageDriver = process.env.STORAGE_DRIVER || 'json';
  report.jsonDbPath = jsonDbPath;
  report.sqliteDbPath = sqliteDbPath;
  report.nextSteps = [
    'Run node scripts/verifySqliteMigration.js',
    'If verification passes, manually set STORAGE_DRIVER=sqlite in .env',
    'Restart the backend and open HealthPage'
  ];
  if (!options.silent) {
    console.log(JSON.stringify(report, null, 2));
  }
  return report;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runMigrationCli().catch((err) => {
    console.error(JSON.stringify({
      status: 'failed',
      error: {
        code: err.code || 'SQLITE_MIGRATION_FAILED',
        message: err.message
      }
    }, null, 2));
    process.exitCode = 1;
  });
}
