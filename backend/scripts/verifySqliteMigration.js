#!/usr/bin/env node
import '../src/config/env.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifySqliteMigration } from '../src/storage/migrations.js';

export { verifySqliteMigration };

const backendDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const rootDir = path.resolve(backendDir, '..');

function resolveProjectPath(input, fallback) {
  const value = input || fallback;
  return path.isAbsolute(value) ? value : path.resolve(rootDir, value);
}

export function parseVerifyArgs(argv = process.argv.slice(2)) {
  const args = {
    jsonDbPath: process.env.JSON_DB_PATH || 'backend/data/db.json',
    sqliteDbPath: process.env.SQLITE_DB_PATH || 'backend/data/app.sqlite'
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--json') args.jsonDbPath = argv[++index];
    else if (arg === '--sqlite') args.sqliteDbPath = argv[++index];
  }
  return args;
}

export async function runVerifyCli(options = {}) {
  const parsed = options.jsonDbPath ? options : parseVerifyArgs();
  const jsonDbPath = resolveProjectPath(parsed.jsonDbPath, 'backend/data/db.json');
  const sqliteDbPath = resolveProjectPath(parsed.sqliteDbPath, 'backend/data/app.sqlite');
  const report = await verifySqliteMigration({
    jsonDbPath,
    sqliteDbPath
  });
  report.storageDriver = process.env.STORAGE_DRIVER || 'json';
  report.jsonDbPath = jsonDbPath;
  report.sqliteDbPath = sqliteDbPath;
  report.nextSteps = report.success
    ? ['SQLite verification passed. Manually set STORAGE_DRIVER=sqlite in .env, then restart the backend.']
    : ['Keep STORAGE_DRIVER=json. Inspect countsMatch, samplesMatch, and indexCounts before switching.'];
  if (!options.silent) console.log(JSON.stringify(report, null, 2));
  if (!report.success && !options.silent) process.exitCode = 1;
  return report;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runVerifyCli().catch((err) => {
    console.error(JSON.stringify({
      status: 'failed',
      error: {
        code: err.code || 'SQLITE_VERIFY_FAILED',
        message: err.message
      }
    }, null, 2));
    process.exitCode = 1;
  });
}
