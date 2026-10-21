const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createCloudSync, cloudOrigin } = require('../src/cloud-sync.cjs');

test('sync URL forbids credentials, insecure remote endpoints and path injection', () => {
  for (const url of ['http://example.com', 'https://user:pass@example.com', 'https://example.com/wrong', 'file:///tmp/x']) assert.throws(() => cloudOrigin(url));
  assert.equal(cloudOrigin('https://workspace.example'), 'https://workspace.example');
});

test('desktop persists offline outbox, replays once, resolves conflicts and recovers backup', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'crossborder-sync-'));
  const secureStorage = { isEncryptionAvailable: () => true, encryptString: (value) => Buffer.from(`encrypted:${value}`), decryptString: (value) => value.toString().slice(10) };
  let online = true, conflict = false, version = 0;
  let data = { id: 'task-1', title: 'Product', state: 'completed', updatedAt: '2026-10-20T01:00:00Z' };
  const seen = new Map();
  const sync = createCloudSync({ directory, secureStorage, exportLocal: async () => ({ records: [data] }), fetchImpl: async (url, options) => {
    if (!online) throw new Error('offline');
    if (url.endsWith('/redeem')) return Response.json({ deviceId: 'device-1', deviceToken: 'secret-device-token' });
    const { operations } = JSON.parse(options.body);
    const results = operations.map((op) => {
      if (seen.has(op.operationId)) return seen.get(op.operationId);
      const result = conflict ? { id: op.data.id, operationId: op.operationId, status: 'conflict', local: op.data, remote: { version: 8, data: { ...data, title: 'Remote' } } } : { id: op.data.id, operationId: op.operationId, status: 'applied', version: ++version };
      seen.set(op.operationId, result); return result;
    });
    return Response.json({ results, records: [], synchronizedAt: new Date().toISOString() });
  } });
  try {
    await sync.connect({ serviceUrl: 'https://workspace.example', code: 'one-time' });
    assert.equal(JSON.stringify(await sync.info()).includes('secret-device-token'), false);
    online = false; await assert.rejects(sync.synchronize(), /offline/);
    assert.equal((await sync.info()).pendingCount, 1);
    online = true; await sync.synchronize(); await sync.synchronize(); assert.equal(version, 1);
    conflict = true; data = { ...data, title: 'Changed' }; await sync.synchronize();
    assert.equal((await sync.info()).conflicts.length, 1);
    await sync.resolve('task-1', 'remote'); await sync.synchronize(); assert.equal((await sync.info()).conflicts.length, 0);
    await fs.writeFile(path.join(directory, 'sync-outbox.json'), 'damaged');
    assert.equal((await sync.info()).connected, true);
    await sync.disconnect(); assert.equal((await sync.info()).connected, false);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});
