import assert from 'node:assert/strict';
import { after, beforeEach, test } from 'node:test';
import { readDb, resetDatabaseForTests } from '../src/services/db.js';
import { buildUploadSafetyReport } from '../src/services/uploadSafetyCheckService.js';

const UPLOAD_ENV_KEYS = [
  'TEMU_CLIENT_ID',
  'TEMU_CLIENT_SECRET',
  'TEMU_ACCESS_TOKEN',
  'TEMU_API_BASE_URL',
  'MIAOSHOU_APP_KEY',
  'MIAOSHOU_APP_SECRET',
  'MIAOSHOU_ACCESS_TOKEN',
  'MIAOSHOU_API_BASE_URL'
];

const originalEnv = Object.fromEntries(UPLOAD_ENV_KEYS.map((key) => [key, process.env[key]]));

function restoreUploadEnv() {
  for (const key of UPLOAD_ENV_KEYS) {
    if (originalEnv[key] === undefined) delete process.env[key];
    else process.env[key] = originalEnv[key];
  }
}

beforeEach(async () => {
  restoreUploadEnv();
  for (const key of UPLOAD_ENV_KEYS) delete process.env[key];
  await resetDatabaseForTests();
});

after(() => {
  restoreUploadEnv();
});

test('buildUploadSafetyReport summarizes credential readiness and localStorage risk without writing db', async () => {
  process.env.TEMU_CLIENT_ID = 'client-id';
  process.env.TEMU_CLIENT_SECRET = 'secret-value';
  process.env.TEMU_ACCESS_TOKEN = 'token-value';
  process.env.TEMU_API_BASE_URL = 'https://sandbox.temu.example';

  const beforeDb = await readDb();
  const report = buildUploadSafetyReport();

  assert.equal(report.meta.mode, 'credential-safety-dry-run');
  assert.equal(report.meta.realUploadEnabled, false);
  assert.equal(report.summary.readyForSandboxApi, true);
  assert.equal(report.summary.readyForRealUpload, false);
  assert.equal(report.summary.platformsChecked >= 6, true);
  assert.equal(report.summary.criticalIssues >= 1, true);
  assert.equal(report.credentialStatus.realUploadEnabled, false);
  assert.equal(report.credentialStatus.platforms.some((platform) => platform.platformId === 'temu' && platform.configured === true), true);
  assert.equal(report.securityFindings.some((finding) => finding.code === 'REAL_UPLOAD_DISABLED'), true);
  assert.equal(report.securityFindings.some((finding) => finding.code === 'LOCAL_STORAGE_NOT_CREDENTIAL_STORE'), true);
  assert.equal(report.recommendations.some((item) => /localStorage/i.test(item)), true);
  assert.match(report.nextSuggestedAction, /dry-run|sandbox/i);

  const serialized = JSON.stringify(report);
  assert.doesNotMatch(serialized, /secret-value|token-value|client-id|https:\/\/sandbox\.temu\.example/i);
  assert.doesNotMatch(serialized, /\.env|API Key|sk-|Provider secret|[A-Z]:\\|app\.sqlite|node_modules/i);
  assert.equal(JSON.stringify(await readDb()), JSON.stringify(beforeDb));
});
