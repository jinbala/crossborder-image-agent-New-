import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import app from '../src/app.js';
import { resetDatabaseForTests } from '../src/services/db.js';
import { getUserSettings, resetUserSettings } from '../src/services/userSettingsService.js';
import { SqliteStore } from '../src/storage/sqliteStore.js';
import {
  getSqliteTrialChecklist,
  runSqliteTrialChecklist
} from '../src/services/sqliteTrialChecklistService.js';
import { runTrialCheckCli } from '../scripts/runSqliteTrialCheck.js';
import { resetStoreForTests } from '../src/storage/index.js';

function rememberEnv(names) {
  const previous = {};
  for (const name of names) previous[name] = process.env[name];
  return () => {
    for (const name of names) {
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    }
  };
}

test('getSqliteTrialChecklist returns the full v4.9 checklist', () => {
  const checklist = getSqliteTrialChecklist();
  assert.ok(checklist.items.length >= 14);
  assert.ok(checklist.items.some((item) => item.id === 'snapshot_created'));
  assert.ok(checklist.items.some((item) => item.id === 'single_sku_mock_flow'));
  assert.ok(checklist.items.some((item) => item.id === 'json_rollback_documented'));
});

test('runSqliteTrialChecklist does not call real AI and recommends migration when sqlite is missing', async () => {
  const restoreEnv = rememberEnv(['STORAGE_DRIVER', 'SQLITE_DB_PATH', 'OPENAI_API_KEY']);
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cia-sqlite-check-missing-'));
  try {
    process.env.STORAGE_DRIVER = 'json';
    process.env.SQLITE_DB_PATH = path.join(tmpDir, 'missing.sqlite');
    process.env.OPENAI_API_KEY = 'must-not-leak';
    resetStoreForTests();
    await resetDatabaseForTests();
    const report = await runSqliteTrialChecklist();
    assert.equal(report.storageDriver, 'json');
    assert.equal(report.items.find((item) => item.id === 'sqlite_exists').status, 'failed');
    assert.equal(report.recommendedAction.code, 'MIGRATE_SQLITE');
    assert.doesNotMatch(JSON.stringify(report), /must-not-leak|OPENAI_API_KEY/i);
  } finally {
    restoreEnv();
    resetStoreForTests();
  }
});

test('runSqliteTrialChecklist flags non-v2 schema and missing index tables', async () => {
  const restoreEnv = rememberEnv(['STORAGE_DRIVER', 'SQLITE_DB_PATH']);
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cia-sqlite-check-index-'));
  const sqlitePath = path.join(tmpDir, 'app.sqlite');
  try {
    process.env.STORAGE_DRIVER = 'sqlite';
    process.env.SQLITE_DB_PATH = sqlitePath;
    const store = new SqliteStore({ dbPath: sqlitePath });
    await store.init();
    store.getDatabase().prepare('UPDATE app_meta SET value = ? WHERE key = ?').run('1', 'schemaVersion');
    store.getDatabase().prepare('DROP TABLE batch_sku_index').run();
    store.close();
    const report = await runSqliteTrialChecklist();
    assert.equal(report.items.find((item) => item.id === 'schema_v2').status, 'failed');
    assert.equal(report.items.find((item) => item.id === 'index_ready').status, 'failed');
    assert.equal(report.recommendedAction.code, 'UPGRADE_OR_REBUILD_SQLITE');
  } finally {
    restoreEnv();
    resetStoreForTests();
  }
});

test('trial checklist API records sanitized result in sqliteTrial', async () => {
  await resetDatabaseForTests();
  await request(app).post('/api/storage/run-trial-check').expect(200).expect((res) => {
    assert.ok(res.body.report);
    assert.ok(Array.isArray(res.body.report.items));
  });
  const settings = await getUserSettings();
  assert.ok(settings.sqliteTrial.lastTrialCheckAt);
  assert.ok(settings.sqliteTrial.lastTrialCheckReport);
  assert.doesNotMatch(JSON.stringify(settings.sqliteTrial.lastTrialCheckReport), /api[_-]?key|secret|token/i);
  await resetUserSettings();
});

test('runSqliteTrialCheck script outputs a sanitized recommendation report', async () => {
  const restoreEnv = rememberEnv(['OPENAI_API_KEY']);
  try {
    process.env.OPENAI_API_KEY = 'script-secret-key';
    const report = await runTrialCheckCli({ silent: true });
    assert.ok(report.recommendedAction);
    assert.ok(report.items.length >= 14);
    assert.doesNotMatch(JSON.stringify(report), /script-secret-key|OPENAI_API_KEY/i);
  } finally {
    restoreEnv();
  }
});
