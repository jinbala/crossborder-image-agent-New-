import assert from 'node:assert/strict';
import { after, beforeEach, test } from 'node:test';
import request from 'supertest';
import app from '../src/app.js';
import { readDb, resetDatabaseForTests } from '../src/services/db.js';

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

test('GET /api/upload/credentials/status returns read-only sanitized credential status', async () => {
  process.env.TEMU_CLIENT_ID = 'temu-client-id sk-secret D:\\Code\\.env';
  process.env.TEMU_CLIENT_SECRET = 'temu-client-secret';
  process.env.TEMU_ACCESS_TOKEN = 'temu-token';
  process.env.TEMU_API_BASE_URL = 'https://sandbox.temu.example';
  const beforeDb = await readDb();

  await request(app)
    .get('/api/upload/credentials/status')
    .expect(200)
    .expect((res) => {
      assert.equal(res.body.realUploadEnabled, false);
      assert.equal(Array.isArray(res.body.platforms), true);
      assert.equal(res.body.platforms.some((platform) => platform.platformId === 'temu'), true);
      assert.equal(res.body.platforms.every((platform) => platform.realUploadSupported === false), true);
      assert.doesNotMatch(JSON.stringify(res.body), /temu-client-id|temu-client-secret|temu-token|\.env|sk-|[A-Z]:\\|app\.sqlite|node_modules/i);
    });

  assert.equal(JSON.stringify(await readDb()), JSON.stringify(beforeDb));
});

test('GET /api/upload/safety-report returns read-only sanitized safety report', async () => {
  process.env.MIAOSHOU_APP_KEY = 'miaoshou-key';
  process.env.MIAOSHOU_APP_SECRET = 'miaoshou-secret';
  process.env.MIAOSHOU_ACCESS_TOKEN = 'miaoshou-token';
  process.env.MIAOSHOU_API_BASE_URL = 'https://sandbox.miaoshou.example';
  const beforeDb = await readDb();

  await request(app)
    .get('/api/upload/safety-report')
    .expect(200)
    .expect((res) => {
      assert.equal(res.body.meta.mode, 'credential-safety-dry-run');
      assert.equal(res.body.meta.realUploadEnabled, false);
      assert.equal(res.body.summary.readyForRealUpload, false);
      assert.equal(res.body.credentialStatus.realUploadEnabled, false);
      assert.equal(res.body.securityFindings.some((finding) => finding.code === 'LOCAL_STORAGE_NOT_CREDENTIAL_STORE'), true);
      assert.doesNotMatch(JSON.stringify(res.body), /miaoshou-key|miaoshou-secret|miaoshou-token|\.env|sk-|[A-Z]:\\|app\.sqlite|node_modules/i);
    });

  assert.equal(JSON.stringify(await readDb()), JSON.stringify(beforeDb));
});
