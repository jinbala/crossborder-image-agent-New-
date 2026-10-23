import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import { randomUUID } from 'node:crypto';

// Pure MV3 state-machine fixtures. No real browser, session or site is accessed.
async function extensionFixture({ disconnected = false, legacy = false, loseReply = false, persisted = {}, shared = null, imageFetch, uploadFailure, imageSignal, jsonReply } = {}) {
  const store = persisted, listeners = {}, remote = shared || { jobs: new Map(), replyDropped: false, stats: { createdJobs: 0, creationAttempts: 0, imageFetches: 0, uploads: 0, bodies: [] } }, stats = remote.stats;
  let savedJob = remote.lastJob;
  const context = vm.createContext({ URL, Date, Math, Number, String, Boolean, Set, JSON, Blob, FormData, Uint8Array, AbortSignal: imageSignal || AbortSignal, console, crypto: { randomUUID },
    fetch: async (...args) => { stats.imageFetches++; return imageFetch ? imageFetch(...args) : new Response(new Blob(['fixture bytes'], { type: 'image/png' }), { headers: { 'content-type': 'image/png' } }); },
    backendFetch: async (route, options = {}) => {
      if (route.endsWith('/rows')) {
        stats.creationAttempts++; const body = JSON.parse(options.body); stats.bodies.push(body);
        assert.equal(store.temuDeepCollectorStateV1.creationRequest.id, body.clientRequestId); // Identity was durable before transport.
        const existing = remote.jobs.get(body.clientRequestId);
        if (!existing) { stats.createdJobs++; remote.jobs.set(body.clientRequestId, { id: `collect-job-fixture-${stats.createdJobs}`, creation: { durable: true, replayed: false }, items: body.rows.map((row, index) => ({ id: `item-${index}`, imageUrls: row.imageUrls, images: [], status: 'pending' })) }); }
        savedJob = remote.jobs.get(body.clientRequestId); savedJob.creation.replayed = Boolean(existing); remote.lastJob = savedJob;
        if (loseReply && !remote.replyDropped) { remote.replyDropped = true; throw new TypeError('simulated response lost after commit'); }
      }
      if (route.endsWith('/browser-images')) { stats.uploads++; if (uploadFailure) uploadFailure(stats.uploads); const item = savedJob.items.find((item) => item.id === options.body.get('itemId')); item.images.push({ sourceUrl: options.body.get('sourceUrl'), status: 'success' }); }
      return { ok: true, json: async () => jsonReply ? jsonReply(structuredClone(savedJob), route) : structuredClone(savedJob) };
    }, pairClient: async () => ({}), publicConnection: async () => ({}), checkClientConnection: async () => { if (disconnected) throw new Error('尚未连接本地工作台，清单保留'); return { capabilities: legacy ? {} : { collectionRequestIdempotency: 1, collectionCreationEpoch: '11111111-1111-4111-8111-111111111111' } }; }, useDevelopmentClient: async () => ({}),
    chrome: { runtime: { id: 'fixture', onStartup: { addListener(fn) { listeners.startup = fn; } }, onMessage: { addListener(fn) { listeners.message = fn; } } },
      storage: { local: { get: async (key) => ({ [key]: structuredClone(store[key]) }), set: async (data) => Object.assign(store, structuredClone(data)), remove: async (key) => delete store[key] } },
      alarms: { onAlarm: { addListener(fn) { listeners.alarm = fn; } }, create: async () => {}, clear: async () => {} },
      tabs: { remove: async () => {} }, permissions: { contains: async () => true, request: async () => true } }
  });
  const source = (await fs.readFile(new URL('../../browser-extension/temu-deep-collector/background.js', import.meta.url), 'utf8')).replace(/^import[^\n]+\n/, '');
  vm.runInContext(source + '\nglobalThis.fixtureApi = { readState, writeState, runStep, setCollector(fn) { collectOne = fn; } };', context);
  return { api: context.fixtureApi, stats, startup: () => listeners.startup(), send: (message) => new Promise((resolve) => listeners.message(message, { id: 'fixture' }, resolve)), restart: () => extensionFixture({ disconnected, legacy, loseReply, persisted: store, shared: remote, imageFetch, uploadFailure, imageSignal, jsonReply }) };
}
const product = (number) => ({ productUrl: `https://www.temu.com/goods.html?goods_id=${number}`, title: `Fixture ${number}`, imageUrls: [`https://img.example/${number}.png`], collectorTabId: 1 });

test('interrupted response body after job creation is classified and restart finds the same persisted task', async () => {
  let dropped = false;
  const fixture = await extensionFixture({ jsonReply: (job, route) => { if (route.endsWith('/rows') && !dropped) { dropped = true; throw new TypeError('Failed to fetch private-response-detail'); } return job; } });
  await fixture.api.writeState({ status: 'manual', rows: [product(1)] });
  const failed = await fixture.send({ type: 'finish-manual' });
  assert.equal(failed.ok, false); assert.match(failed.error, /回执读取中断/); assert.doesNotMatch(failed.error, /private-response-detail|Failed to fetch/);
  const pending = await fixture.api.readState(); assert.ok(pending.creationRequest.payload); assert.equal(pending.backendJob, null);
  const restarted = await fixture.restart(), resumed = await restarted.send({ type: 'finish-manual' });
  assert.equal(resumed.result.status, 'completed'); assert.equal(restarted.stats.createdJobs, 1); assert.equal(restarted.stats.uploads, 1);
});

for (const [label, wrongReply] of [['wrong job identity', (job) => ({ ...job, id: 'other-job' })], ['missing item list', (job) => ({ ...job, items: undefined })]]) {
  test(`${label} in existing job response never triggers an image download or a replacement task`, async () => {
    const fixture = await extensionFixture({ jsonReply: (job, route) => route.endsWith('/rows') || route.endsWith('/browser-images') ? job : wrongReply(job) });
    await fixture.api.writeState({ status: 'manual', rows: [product(1)] }); await fixture.send({ type: 'finish-manual' });
    const count = fixture.stats.imageFetches, original = (await fixture.api.readState()).backendJob.id;
    const failed = await fixture.send({ type: 'finish-manual' });
    assert.equal(failed.ok, false); assert.match(failed.error, /身份或商品清单不符/);
    assert.equal(fixture.stats.imageFetches, count); assert.equal(fixture.stats.createdJobs, 1); assert.equal((await fixture.api.readState()).backendJob.id, original);
  });
}

test('image network errors identify the download stage without leaking URL credentials or raw fetch errors', async () => {
  const fixture = await extensionFixture({ imageFetch: async () => { throw new TypeError('Failed to fetch private-network-detail'); } });
  await fixture.api.writeState({ status: 'manual', rows: [product(1)] });
  const result = await fixture.send({ type: 'finish-manual' });
  assert.equal(result.ok, true); assert.equal(result.result.status, 'awaiting_transfer');
  const failure = result.result.browserTransfer.failures[0];
  assert.equal(failure.code, 'IMAGE_DOWNLOAD_UNREACHABLE'); assert.equal(failure.stage, 'image-download');
  assert.match(failure.message, /img.example/); assert.doesNotMatch(failure.message, /private-network-detail|Failed to fetch|https:\/\//);
  assert.match(result.result.lastError, /img.example/); assert.equal(fixture.stats.uploads, 0);
});

test('local upload failure stops the round, preserves unprocessed images, and restart skips already saved bytes', async () => {
  const fixture = await extensionFixture({ uploadFailure: (attempt) => { if (attempt === 2) throw Object.assign(new Error('本机服务已断开'), { code: 'LOCAL_SERVICE_UNREACHABLE' }); } });
  await fixture.api.writeState({ status: 'manual', rows: [product(1), product(2), product(3)] });
  const first = await fixture.send({ type: 'finish-manual' });
  assert.equal(first.result.status, 'awaiting_transfer');
  assert.equal(first.result.browserTransfer.success, 1); assert.equal(first.result.browserTransfer.failed, 1); assert.equal(first.result.browserTransfer.pending, 1);
  assert.equal(first.result.browserTransfer.failures[0].stage, 'local-upload'); assert.equal(fixture.stats.imageFetches, 2);
  const restarted = await fixture.restart(), resumed = await restarted.send({ type: 'finish-manual' });
  assert.equal(resumed.result.status, 'completed'); assert.equal(resumed.result.browserTransfer.success, 2);
  assert.equal(restarted.stats.imageFetches, 4); assert.equal(restarted.stats.createdJobs, 1);
  assert.equal(resumed.result.rows.length, 3);
});

test('download timeout covers the image body, keeps a bounded stream and does not try uploading', async () => {
  const signal = AbortSignal.abort(new DOMException('timeout', 'TimeoutError'));
  const fixture = await extensionFixture({ imageSignal: { timeout: (ms) => { assert.equal(ms, 25000); return signal; } }, imageFetch: async (_url, options) => {
    assert.equal(options.signal, signal);
    return { ok: true, headers: new Headers({ 'content-type': 'image/png' }), body: { getReader: () => ({ read: async () => { throw signal.reason; }, cancel: async () => {} }) } };
  } });
  await fixture.api.writeState({ status: 'manual', rows: [product(1)] });
  const result = await fixture.send({ type: 'finish-manual' });
  assert.equal(result.result.browserTransfer.failures[0].code, 'IMAGE_DOWNLOAD_TIMEOUT'); assert.equal(fixture.stats.uploads, 0);
});

test('stream size is checked while reading, without trusting content-length or buffering an oversized whole blob', async () => {
  let reads = 0, cancelled = false;
  const fixture = await extensionFixture({ imageFetch: async () => ({ ok: true, headers: new Headers({ 'content-type': 'image/png', 'content-length': '1' }),
    body: { getReader: () => ({ read: async () => { reads++; return { done: false, value: new Uint8Array(13 * 1024 * 1024) }; }, cancel: async () => { cancelled = true; } }) }
  }) });
  await fixture.api.writeState({ status: 'manual', rows: [product(1)] });
  const result = await fixture.send({ type: 'finish-manual' });
  assert.equal(result.result.browserTransfer.failures[0].code, 'IMAGE_TOO_LARGE'); assert.equal(reads, 2); assert.equal(cancelled, true); assert.equal(fixture.stats.uploads, 0);
});

test('one image HTTP refusal does not block other images, and retry downloads only the refused image', async () => {
  let blocked = true;
  const fixture = await extensionFixture({ imageFetch: async (url) => blocked && url.endsWith('/1.png') ? new Response('refused', { status: 403 }) : new Response('image', { headers: { 'content-type': 'image/png' } }) });
  await fixture.api.writeState({ status: 'manual', rows: [product(1), product(2)] });
  const first = await fixture.send({ type: 'finish-manual' });
  assert.equal(first.result.browserTransfer.failures[0].code, 'IMAGE_HTTP_ERROR');
  assert.match(first.result.lastError, /HTTP 403/); assert.equal(first.result.browserTransfer.success, 1); assert.equal(first.result.browserTransfer.pending, 0);
  blocked = false;
  const second = await fixture.send({ type: 'finish-manual' });
  assert.equal(second.result.status, 'completed'); assert.equal(second.result.browserTransfer.total, 1);
  assert.equal(fixture.stats.imageFetches, 3); assert.equal(fixture.stats.createdJobs, 1);
});

for (const [label, response, code] of [
  ['HTML login page', () => new Response('<html>private login page</html>', { headers: { 'content-type': 'text/html' } }), 'IMAGE_CONTENT_TYPE'],
  ['empty response', () => new Response('', { headers: { 'content-type': 'image/png' } }), 'IMAGE_EMPTY'],
  ['excessive content-length', () => new Response('small', { headers: { 'content-type': 'image/png', 'content-length': String(26 * 1024 * 1024) } }), 'IMAGE_TOO_LARGE']
]) test(`invalid download: ${label} stays retryable and is never uploaded`, async () => {
  const fixture = await extensionFixture({ imageFetch: async () => response() });
  await fixture.api.writeState({ status: 'manual', rows: [product(1)] });
  const result = await fixture.send({ type: 'finish-manual' });
  assert.equal(result.result.status, 'awaiting_transfer'); assert.equal(result.result.browserTransfer.failures[0].code, code);
  assert.equal(fixture.stats.uploads, 0); assert.doesNotMatch(result.result.lastError, /private login page/);
});

test('credential-bearing image links are refused before fetch and never copied into the visible error', async () => {
  const fixture = await extensionFixture(), row = { ...product(1), imageUrls: ['https://private-user:private-password@img.example/a.png?secret=private-value'] };
  await fixture.api.writeState({ status: 'manual', rows: [row] });
  const result = await fixture.send({ type: 'finish-manual' });
  assert.equal(result.result.browserTransfer.failures[0].code, 'IMAGE_URL_INVALID'); assert.equal(fixture.stats.imageFetches, 0);
  assert.doesNotMatch(result.result.lastError, /private-user|private-password|private-value/);
});

test('pairing revoked during upload halts the round without losing the remaining products', async () => {
  const fixture = await extensionFixture({ uploadFailure: () => { throw Object.assign(new Error('请重新配对'), { code: 'CLIENT_PAIRING_EXPIRED' }); } });
  await fixture.api.writeState({ status: 'manual', rows: [product(1), product(2), product(3)] });
  const result = await fixture.send({ type: 'finish-manual' });
  assert.equal(result.result.browserTransfer.failures[0].code, 'CLIENT_PAIRING_EXPIRED');
  assert.equal(result.result.browserTransfer.pending, 2); assert.equal(fixture.stats.imageFetches, 1);
  assert.equal(result.result.rows.length, 3); assert.equal(fixture.stats.createdJobs, 1);
});

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
