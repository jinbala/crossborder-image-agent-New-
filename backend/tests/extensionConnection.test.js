import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import { localAccess } from '../src/middleware/localAccess.js';
import { getConnection, pairClient, publicConnection, backendFetch, checkClientConnection, useDevelopmentClient } from '../../browser-extension/temu-deep-collector/connection.js';

const saved = { chrome: globalThis.chrome, fetch: globalThis.fetch, token: process.env.LOCAL_API_TOKEN };
afterEach(() => { globalThis.chrome = saved.chrome; globalThis.fetch = saved.fetch; if (saved.token === undefined) delete process.env.LOCAL_API_TOKEN; else process.env.LOCAL_API_TOKEN = saved.token; });
function fixture(value, fetcher) {
  const store = value ? { workbenchConnection: value } : {}, calls = [];
  globalThis.chrome = { storage: { session: { get: async (key) => ({ [key]: store[key] }), set: async (data) => Object.assign(store, data) } } };
  globalThis.fetch = async (url, options) => { calls.push({ url, options }); return fetcher(url, options); };
  return { store, calls };
}
const paired = () => ({ mode: 'desktop', paired: true, serviceUrl: 'http://127.0.0.1:60011', accessToken: 'private-fixture-token', expiresAt: new Date(Date.now() + 600000).toISOString() });
const health = () => Response.json({ ok: true, service: 'crossborder-image-agent-backend' });
test('unpaired extension never silently calls port 4000 and keeps its clear recovery instructions', async () => {
  const data = fixture(null, () => { throw new Error('must not fetch'); });
  assert.equal((await getConnection()).mode, 'unconfigured');
  await assert.rejects(checkClientConnection(), (error) => error.code === 'CLIENT_NOT_PAIRED' && error.message.includes('不要清空'));
  await assert.rejects(backendFetch('/workbench/collection-jobs/rows'), /尚未连接/); assert.equal(data.calls.length, 0);
  await assert.rejects(pairClient('', 'fixture'), /不会默认连接 4000/);
  await assert.rejects(useDevelopmentClient(''), /不会默认连接 4000/); assert.equal(data.calls.length, 0);
});
test('network failure names the configured local endpoint without exposing credentials', async () => {
  fixture(paired(), () => { throw new TypeError('Failed to fetch private-fixture-token'); });
  await assert.rejects(checkClientConnection(), (error) => error.code === 'LOCAL_SERVICE_UNREACHABLE' && error.message.includes('60011') && !error.message.includes('private-fixture-token'));
});
test('locally expired pairing is revoked before any network request', async () => {
  const data = fixture({ ...paired(), expiresAt: new Date(0).toISOString() }, health);
  await assert.rejects(backendFetch('/workbench/collection-jobs/rows'), (error) => error.code === 'CLIENT_PAIRING_EXPIRED');
  assert.equal(data.calls.length, 0); assert.equal(data.store.workbenchConnection.accessToken, undefined);
});
test('server authentication failure revokes the token and never retries or creates duplicate jobs', async () => {
  const data = fixture(paired(), () => Response.json({ error: 'expired' }, { status: 401 }));
  await assert.rejects(backendFetch('/workbench/collection-jobs/rows', { method: 'POST' }), /不会自动创建重复任务/);
  assert.equal(data.calls.length, 1); assert.equal((await publicConnection()).paired, false); assert.equal(data.store.workbenchConnection.accessToken, undefined);
});
test('health diagnostics verify service identity but do not claim token validity or send credentials', async () => {
  const data = fixture(paired(), health); const result = await checkClientConnection();
  assert.equal(result.reachable, true); assert.equal(result.authorizationVerified, false); assert.equal(result.accessToken, undefined);
  assert.equal(data.calls[0].options.credentials, 'omit'); assert.equal(data.calls[0].options.redirect, 'error'); assert.equal(data.calls[0].options.headers, undefined);
  globalThis.fetch = async () => Response.json({ ok: true, service: 'another-service' }); await assert.rejects(checkClientConnection(), (error) => error.code === 'WRONG_LOCAL_SERVICE');
});
test('pairing validates responses, uses the supplied port, and public status never contains the token', async () => {
  const data = fixture(null, () => Response.json({ accessToken: 'new-private-fixture', expiresAt: paired().expiresAt }));
  const result = await pairClient('http://127.0.0.1:60011', 'not-a-real-code');
  assert.equal(result.paired, true); assert.equal(result.accessToken, undefined); assert.equal(data.calls[0].url, 'http://127.0.0.1:60011/api/desktop/pair');
  globalThis.fetch = async () => Response.json({ ok: true }); await assert.rejects(pairClient('http://127.0.0.1:60011', 'fixture'), /无效配对信息/);
});
test('standalone mode must be explicitly selected and verifies local service identity', async () => {
  fixture(null, health); const result = await useDevelopmentClient('http://127.0.0.1:4000'); assert.equal(result.mode, 'standalone'); assert.equal(result.paired, false);
});
test('scoped extension auth errors expose readable CORS but never grant business access', async () => {
  process.env.LOCAL_API_TOKEN = 'test-only-local-secret';
  const app = express(); app.use(localAccess); app.use((_req, res) => res.json({ private: true }));
  const origin = `chrome-extension://${'a'.repeat(32)}`;
  const response = await request(app).post('/api/workbench/collection-jobs/rows').set('Host', '127.0.0.1:60011').set('Origin', origin);
  assert.equal(response.status, 401); assert.equal(response.headers['access-control-allow-origin'], origin); assert.equal(response.body.private, undefined);
  const forbidden = await request(app).get('/api/tasks').set('Host', '127.0.0.1:60011').set('Origin', origin);
  assert.equal(forbidden.status, 403); assert.equal(forbidden.headers['access-control-allow-origin'], undefined);
  const website = await request(app).post('/api/workbench/collection-jobs/rows').set('Host', '127.0.0.1:60011').set('Origin', 'https://example.org');
  assert.equal(website.status, 403); assert.equal(website.headers['access-control-allow-origin'], undefined);
});
