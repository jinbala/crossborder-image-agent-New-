import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { approveImagePackResume } from '../src/utils/imagePackResume.js';
const p = { id: 'pack-x', canResume: true, busy: false, readOnly: false, remote: false, retryFailed: false, onlyFinalize: false, interruptedLock: false, imageCount: 3, previewHash: 'a'.repeat(64) };
const t = (text, vars = {}) => text.replace(/\{(\w+)\}/g, (_, key) => vars[key]);
test('image recovery cancellation never returns a mutation payload; approval binds the exact local scope', async () => {
  const api = { previewImagePackResume: async () => p };
  assert.equal(await approveImagePackResume(api, p.id, false, t, () => false), null);
  assert.deepEqual(await approveImagePackResume(api, p.id, false, t, message => { assert.match(message, /3/); return true; }), { confirm: true, retryFailed: false, previewHash: p.previewHash });
});
test('image recovery rejects remote, loose, changed identity, unbounded and read-only scopes before approval', async () => {
  for (const change of [{ remote: true }, { canResume: 'true' }, { busy: true }, { readOnly: true }, { retryFailed: true }, { imageCount: 0 }, { imageCount: 101 }, { id: 'other' }, { previewHash: 'bad' }, { onlyFinalize: 'false' }, { interruptedLock: 'true' }]) await assert.rejects(approveImagePackResume({ previewImagePackResume: async () => ({ ...p, ...change }) }, p.id, false, t, () => assert.fail('invalid scope cannot be approved')));
});
test('known exited-process lock reclaim needs a separate confirmation, zero-image ZIP-only never implies transformation', async () => {
  const preview = { ...p, interruptedLock: true, onlyFinalize: true, imageCount: 0 }, api = { previewImagePackResume: async () => preview }; let calls = 0;
  assert.equal(await approveImagePackResume(api, p.id, false, t, () => { calls++; return false; }), null); assert.equal(calls, 1);
  await approveImagePackResume(api, p.id, false, t, () => { calls++; return true; }); assert.equal(calls, 3);
  const page = fs.readFileSync(new URL('../src/pages/JobResultPage.jsx', import.meta.url), 'utf8'); assert.ok(page.includes('approveImagePackResume')); assert.ok(page.includes('data-image-pack-resume')); assert.ok(page.includes('activeId.current !== id'));
});
