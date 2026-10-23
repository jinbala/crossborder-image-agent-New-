import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { atomicRename } from '../src/utils/atomicRename.js';

test('atomic rename retries only transient Windows locks with bounded backoff', async () => {
  let calls = 0; const delays = [];
  await atomicRename('prepared', 'published', { rename: async () => { if (calls++ < 3) throw Object.assign(new Error('locked'), { code: ['EPERM', 'EACCES', 'EBUSY'][calls - 1] }); }, wait: async ms => delays.push(ms) });
  assert.equal(calls, 4); assert.deepEqual(delays, [100, 200, 400]);
});
test('atomic rename does not retry missing, cross-device or full-disk errors', async () => {
  for (const code of ['ENOENT', 'EXDEV', 'ENOSPC']) { let calls = 0; await assert.rejects(atomicRename('prepared', 'published', { rename: async () => { calls++; throw Object.assign(new Error(code), { code }); }, wait: async () => assert.fail('not transient') }), { code }); assert.equal(calls, 1); }
});
test('permanent replacement failure retains old and prepared bytes without deletion', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'atomic-rename-'));
  try {
    const source = path.join(root, 'prepared'), target = path.join(root, 'published'); await fs.writeFile(source, 'new'); await fs.writeFile(target, 'old'); let calls = 0; const delays = [];
    await assert.rejects(atomicRename(source, target, { rename: async () => { calls++; throw Object.assign(new Error('locked'), { code: 'EPERM' }); }, wait: async ms => delays.push(ms) }), { code: 'EPERM' });
    assert.equal(delays.reduce((sum, ms) => sum + ms, 0), 4500);
    assert.equal(calls, 8); assert.equal(await fs.readFile(source, 'utf8'), 'new'); assert.equal(await fs.readFile(target, 'utf8'), 'old');
    await atomicRename(source, target); assert.equal(await fs.readFile(target, 'utf8'), 'new'); await assert.rejects(fs.stat(source), { code: 'ENOENT' });
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
