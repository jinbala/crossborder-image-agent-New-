import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createExtensionPairing } from '../src/services/extensionPairingService.js';
import { normalizeServiceUrl } from '../../browser-extension/temu-deep-collector/connection.js';

const origin = `chrome-extension://${'a'.repeat(32)}`;
test('collector connection accepts only explicit loopback endpoints', () => {
  assert.equal(normalizeServiceUrl('http://127.0.0.1:43123'), 'http://127.0.0.1:43123');
  for (const value of ['https://example.org', 'http://192.168.1.2:4000', 'http://user:password@127.0.0.1:4000', 'http://127.0.0.1:4000/other', 'http://127.0.0.1:4000/?token=x']) assert.throws(() => normalizeServiceUrl(value));
});
test('extension pairing is one-time, expires and grants only collection access to one extension', () => {
  let time = Date.now();
  const pairing = createExtensionPairing({ now: () => time });
  const code = pairing.issueCode().code;
  const session = pairing.redeem(code, origin);
  assert.throws(() => pairing.redeem(code, origin), /无效或已过期/);
  assert.equal(pairing.authorize(session.accessToken, origin, '/api/workbench/collection-jobs/rows', 'POST'), true);
  assert.equal(pairing.authorize(session.accessToken, origin, '/api/tasks', 'GET'), false);
  assert.equal(pairing.authorize(session.accessToken, origin, '/api/desktop/pairing-code', 'POST'), false);
  assert.equal(pairing.authorize(session.accessToken, origin, '/api/workbench/collection-jobs/collect-job-safe/browser-images', 'POST'), true);
  assert.equal(pairing.authorize(session.accessToken, origin.replaceAll('a', 'b'), '/api/workbench/collection-jobs/rows', 'POST'), false);
  time += 8 * 60 * 60_000 + 1;
  assert.equal(pairing.authorize(session.accessToken, origin, '/api/workbench/collection-jobs/rows', 'POST'), false);
  const expired = pairing.issueCode().code;
  time += 5 * 60_000 + 1;
  assert.throws(() => pairing.redeem(expired, origin), /无效或已过期/);
});

test('pairing rejects websites and rate-limits repeated guesses', () => {
  const pairing = createExtensionPairing();
  assert.throws(() => pairing.redeem('guess', 'https://example.org'), /浏览器扩展/);
  for (let i = 0; i < 10; i++) assert.throws(() => pairing.redeem('guess', origin), /无效或已过期/);
  assert.throws(() => pairing.redeem('guess', origin), /尝试过多/);
});
