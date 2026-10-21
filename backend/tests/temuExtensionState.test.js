import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import { randomUUID } from 'node:crypto';

// Pure MV3 state-machine fixtures. No real browser, session or site is accessed.
async function extensionFixture({ disconnected = false, legacy = false, loseReply = false, persisted = {}, shared = null } = {}) {
  const store = persisted, listeners = {}, remote = shared || { jobs: new Map(), replyDropped: false, stats: { createdJobs: 0, creationAttempts: 0, imageFetches: 0, uploads: 0, bodies: [] } }, stats = remote.stats;
  let savedJob = remote.lastJob;
  const context = vm.createContext({ URL, Date, Math, Number, String, Boolean, Set, JSON, Blob, FormData, console, crypto: { randomUUID },
    fetch: async () => { stats.imageFetches++; return new Response(new Blob(['fixture bytes'], { type: 'image/png' }), { headers: { 'content-type': 'image/png' } }); },
    backendFetch: async (route, options = {}) => {
      if (route.endsWith('/rows')) {
        stats.creationAttempts++; const body = JSON.parse(options.body); stats.bodies.push(body);
        assert.equal(store.temuDeepCollectorStateV1.creationRequest.id, body.clientRequestId); // Identity was durable before transport.
        const existing = remote.jobs.get(body.clientRequestId);
        if (!existing) { stats.createdJobs++; remote.jobs.set(body.clientRequestId, { id: `collect-job-fixture-${stats.createdJobs}`, creation: { durable: true, replayed: false }, items: body.rows.map((row, index) => ({ id: `item-${index}`, imageUrls: row.imageUrls, images: [], status: 'pending' })) }); }
        savedJob = remote.jobs.get(body.clientRequestId); savedJob.creation.replayed = Boolean(existing); remote.lastJob = savedJob;
        if (loseReply && !remote.replyDropped) { remote.replyDropped = true; throw new TypeError('simulated response lost after commit'); }
      }
      if (route.endsWith('/browser-images')) { stats.uploads++; const item = savedJob.items.find((item) => item.id === options.body.get('itemId')); item.images.push({ sourceUrl: options.body.get('sourceUrl'), status: 'success' }); }
      return { ok: true, json: async () => structuredClone(savedJob) };
    }, pairClient: async () => ({}), publicConnection: async () => ({}), checkClientConnection: async () => { if (disconnected) throw new Error('尚未连接本地工作台，清单保留'); return { capabilities: legacy ? {} : { collectionRequestIdempotency: 1, collectionCreationEpoch: '11111111-1111-4111-8111-111111111111' } }; }, useDevelopmentClient: async () => ({}),
    chrome: { runtime: { id: 'fixture', onStartup: { addListener(fn) { listeners.startup = fn; } }, onMessage: { addListener(fn) { listeners.message = fn; } } },
      storage: { local: { get: async (key) => ({ [key]: structuredClone(store[key]) }), set: async (data) => Object.assign(store, structuredClone(data)), remove: async (key) => delete store[key] } },
      alarms: { onAlarm: { addListener(fn) { listeners.alarm = fn; } }, create: async () => {}, clear: async () => {} },
      tabs: { remove: async () => {} }, permissions: { contains: async () => true, request: async () => true } }
  });
  const source = (await fs.readFile(new URL('../../browser-extension/temu-deep-collector/background.js', import.meta.url), 'utf8')).replace(/^import[^\n]+\n/, '');
  vm.runInContext(source + '\nglobalThis.fixtureApi = { readState, writeState, runStep, setCollector(fn) { collectOne = fn; } };', context);
  return { api: context.fixtureApi, stats, startup: () => listeners.startup(), send: (message) => new Promise((resolve) => listeners.message(message, { id: 'fixture' }, resolve)), restart: () => extensionFixture({ disconnected, legacy, loseReply, persisted: store, shared: remote }) };
}
const product = (number) => ({ productUrl: `https://www.temu.com/goods.html?goods_id=${number}`, title: `Fixture ${number}`, imageUrls: [`https://img.example/${number}.png`], collectorTabId: 1 });

test('lost creation reply and MV3 restart reuse the persisted identity and original rules', async () => {
  const fixture = await extensionFixture({ loseReply: true });
  await fixture.api.writeState({ status: 'manual', rows: [product(1)], cursor: 1, options: { minSales: 10 } });
  assert.equal((await fixture.send({ type: 'finish-manual' })).ok, false);
  const pending = await fixture.api.readState(); assert.ok(pending.creationRequest.payload); assert.equal(pending.backendJob, null); assert.equal(fixture.stats.createdJobs, 1);
  const restarted = await fixture.restart();
  const result = await restarted.send({ type: 'finish-manual', options: { minSales: 999, name: 'should not replace original' } });
  assert.equal(result.ok, true); assert.equal(result.result.backendJob.id, 'collect-job-fixture-1'); assert.match(result.result.lastError, /未重复建任务/);
  assert.equal(restarted.stats.createdJobs, 1); assert.equal(restarted.stats.creationAttempts, 2); assert.deepEqual(restarted.stats.bodies[0], restarted.stats.bodies[1]);
  assert.equal(result.result.creationRequest.payload, undefined); assert.equal(restarted.stats.uploads, 1);
});
test('a legacy server is rejected before any creation mutation and preserves the manual list', async () => {
  const fixture = await extensionFixture({ legacy: true }); await fixture.api.writeState({ status: 'manual', rows: [product(1)] });
  const result = await fixture.send({ type: 'finish-manual' }); assert.equal(result.ok, false); assert.match(result.error, /0.12.0/); assert.equal(fixture.stats.createdJobs, 0); assert.equal((await fixture.api.readState()).rows.length, 1);
});
test('an unconfirmed pending request cannot be discarded by list preparation or failed-only retry', async () => {
  const fixture = await extensionFixture({ loseReply: true }); await fixture.api.writeState({ status: 'manual', rows: [product(1)] }); await fixture.send({ type: 'finish-manual' });
  const original = (await fixture.api.readState()).creationRequest.id;
  for (const type of ['prepare', 'collect-current', 'retry-failed']) { assert.equal((await fixture.send({ type })).ok, false); assert.equal((await fixture.api.readState()).creationRequest.id, original); }
});

test('failed connection before transfer preserves manual rows and never creates a backend task', async () => {
  const fixture = await extensionFixture({ disconnected: true });
  await fixture.api.writeState({ status: 'manual', rows: [product(1)], cursor: 1 });
  const result = await fixture.send({ type: 'finish-manual' }); assert.equal(result.ok, false);
  const state = await fixture.api.readState(); assert.equal(state.status, 'awaiting_transfer'); assert.equal(state.rows.length, 1); assert.equal(state.cursor, 1);
  assert.equal(fixture.stats.createdJobs, 0); assert.equal(fixture.stats.imageFetches, 0);
});

test('Temu challenge preserves cursor and completed rows; manual resume does not revisit success', async () => {
  const fixture = await extensionFixture(), first = product(1), second = product(2);
  await fixture.api.writeState({ status: 'running', urls: [first.productUrl, second.productUrl], rows: [first], cursor: 1, options: {} });
  fixture.api.setCollector(async () => ({ challenge: true, challengeTabId: 1, collectorTabId: 1 }));
  await fixture.api.runStep();
  const challenge = await fixture.api.readState(); assert.equal(challenge.status, 'challenge'); assert.equal(challenge.cursor, 1); assert.equal(challenge.rows.length, 1);
  await fixture.send({ type: 'start' });
  fixture.api.setCollector(async (url) => { assert.equal(url, second.productUrl); return second; });
  await fixture.api.runStep(); await fixture.api.runStep();
  const completed = await fixture.api.readState(); assert.equal(completed.status, 'awaiting_transfer'); assert.equal(completed.rows.length, 2); assert.equal(fixture.stats.createdJobs, 1);
  assert.equal((await fixture.send({ type: 'finish-manual' })).ok, true);
  assert.equal(fixture.stats.uploads, 2); assert.equal(fixture.stats.imageFetches, 2); assert.equal(fixture.stats.createdJobs, 1);
  await fixture.send({ type: 'finish-manual' });
  assert.equal(fixture.stats.imageFetches, 2); assert.equal(fixture.stats.createdJobs, 1); // Local bytes and original job are reused.
});

test('Temu failed-only retry excludes completed products and pause persists even between alarms', async () => {
  const fixture = await extensionFixture();
  await fixture.api.writeState({ status: 'completed', rows: [product(1)], failures: [{ url: product(2).productUrl, code: 'PAGE_TIMEOUT' }], backendJob: { id: 'old-success-job' } });
  const retry = await fixture.send({ type: 'retry-failed' });
  assert.equal(retry.ok, true); assert.deepEqual(Array.from(retry.result.urls), [product(2).productUrl]); assert.equal(retry.result.rows.length, 0); assert.equal(retry.result.previousJobId, 'old-success-job');
  const paused = await fixture.send({ type: 'stop' }); assert.equal(paused.result.status, 'paused');
  await fixture.api.writeState({ status: 'uploading' }); await fixture.startup();
  assert.equal((await fixture.api.readState()).status, 'awaiting_transfer');
});
