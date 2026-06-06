import assert from 'node:assert/strict';
import { after, beforeEach, test } from 'node:test';
import { readDb, resetDatabaseForTests } from '../src/services/db.js';
import { getUploadCredentialStatus } from '../src/services/uploadCredentialService.js';

const UPLOAD_ENV_KEYS = [
  'TEMU_SANDBOX_ENABLED',
  'TEMU_CLIENT_ID',
  'TEMU_CLIENT_SECRET',
  'TEMU_ACCESS_TOKEN',
  'TEMU_REFRESH_TOKEN',
  'TEMU_API_BASE_URL',
  'MIAOSHOU_SANDBOX_ENABLED',
  'MIAOSHOU_APP_KEY',
  'MIAOSHOU_APP_SECRET',
  'MIAOSHOU_ACCESS_TOKEN',
  'MIAOSHOU_API_BASE_URL',
  'AMAZON_SANDBOX_ENABLED',
  'AMAZON_SELLER_ID',
  'AMAZON_REFRESH_TOKEN',
  'AMAZON_CLIENT_ID',
  'AMAZON_CLIENT_SECRET',
  'AMAZON_MARKETPLACE_ID'
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

test('getUploadCredentialStatus returns platform variable names with upload disabled and no secret values', async () => {
  process.env.TEMU_CLIENT_ID = 'temu-client-id sk-secret D:\\Code\\.env';
  process.env.TEMU_CLIENT_SECRET = 'temu-client-secret';
  process.env.TEMU_ACCESS_TOKEN = 'temu-token';
  process.env.TEMU_API_BASE_URL = 'https://sandbox.temu.example';
  process.env.MIAOSHOU_APP_KEY = 'miaoshou-key';

  const beforeDb = await readDb();
  const status = getUploadCredentialStatus();

  assert.equal(status.realUploadEnabled, false);
  assert.equal(Array.isArray(status.platforms), true);
  assert.equal(status.platforms.some((platform) => platform.platformId === 'temu'), true);
  assert.equal(status.platforms.some((platform) => platform.platformId === 'miaoshou'), true);
  assert.equal(status.platforms.some((platform) => platform.platformId === 'amazon'), true);
  assert.equal(status.platforms.some((platform) => platform.platformId === 'rakuten'), true);

  const temu = status.platforms.find((platform) => platform.platformId === 'temu');
  const miaoshou = status.platforms.find((platform) => platform.platformId === 'miaoshou');
  const amazon = status.platforms.find((platform) => platform.platformId === 'amazon');

  assert.equal(temu.sandboxSupported, true);
  assert.equal(temu.realUploadSupported, false);
  assert.equal(temu.configured, true);
  assert.deepEqual(temu.requiredVariables, [
    'TEMU_CLIENT_ID',
    'TEMU_CLIENT_SECRET',
    'TEMU_ACCESS_TOKEN',
    'TEMU_API_BASE_URL'
  ]);
  assert.equal(temu.configuredVariables.includes('TEMU_CLIENT_ID'), true);
  assert.equal(temu.missingVariables.length, 0);
  assert.equal(temu.maskedPreview.TEMU_CLIENT_ID, '****configured****');

  assert.equal(miaoshou.configured, false);
  assert.equal(miaoshou.configuredVariables.includes('MIAOSHOU_APP_KEY'), true);
  assert.equal(miaoshou.missingVariables.includes('MIAOSHOU_APP_SECRET'), true);
  assert.equal(amazon.realUploadSupported, false);
  assert.equal(amazon.configured, false);

  const serialized = JSON.stringify(status);
  assert.doesNotMatch(serialized, /temu-client-id|temu-client-secret|temu-token|miaoshou-key/i);
  assert.doesNotMatch(serialized, /\.env|sk-|[A-Z]:\\|API Key|app\.sqlite|node_modules/i);
  assert.equal(JSON.stringify(await readDb()), JSON.stringify(beforeDb));
});
