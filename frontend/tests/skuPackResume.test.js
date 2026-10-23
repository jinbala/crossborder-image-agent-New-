import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { approveSkuResume, skuFinalizationHint } from '../src/utils/skuPackResume.js';
test('ZIP-only recovery confirms a sealed zero-image scope without a matting preflight or fee grant', async () => {
  assert.equal(skuFinalizationHint({ type: 'sku-pack', status: 'paused', summary: { unprocessedCount: 0 }, error: { code: 'EPERM' } }), true);
  assert.equal(skuFinalizationHint({ type: 'sku-pack', recovery: { finalizePending: 'true' } }), false);
  assert.equal(skuFinalizationHint({ type: 'other', recovery: { finalizePending: true } }), false);
  assert.equal(skuFinalizationHint({ type: 'sku-pack', status: 'paused', recovery: { available: true }, summary: { unprocessedCount: 0 } }), true);
  assert.equal(skuFinalizationHint({ type: 'sku-pack', status: 'paused', recovery: { available: 'true' }, summary: { unprocessedCount: 0 } }), false);
  assert.equal(skuFinalizationHint({ type: 'sku-pack', status: 'completed_with_errors', recovery: { available: true }, summary: { unprocessedCount: 0 } }), false);
  const preview = { canResume: true, onlyFinalize: true, imageCount: 0, skuCount: 0, remote: false, previewHash: 'a'.repeat(64), options: { matteImages: true, mattingProvider: 'external' } };
  let calls = 0; const api = { previewSkuPackResume: async () => preview, getMattingConfig: async () => assert.fail('no provider needed') }, t = value => value;
  assert.equal(await approveSkuResume(api, 'id', false, t, () => { calls++; return false; }), null);
  const payload = await approveSkuResume(api, 'id', false, t, message => { assert.match(message, /仅重新生成结果 ZIP/); return true; });
  assert.equal(calls, 1); assert.equal(payload.confirmPaidMatting, false); assert.equal(payload.confirm, true); assert.equal(payload.previewHash, preview.previewHash);
});
test('ZIP-only previews fail closed for nonzero scope, remote calls or nonboolean finalization flags', async () => {
  const preview = { canResume: true, onlyFinalize: true, imageCount: 0, skuCount: 0, remote: false, previewHash: 'a'.repeat(64) };
  for (const patch of [{ imageCount: 1 }, { skuCount: 1 }, { remote: true }, { onlyFinalize: 'true' }, { onlyFinalize: false }]) await assert.rejects(approveSkuResume({ previewSkuPackResume: async () => ({ ...preview, ...patch }) }, 'id', false, value => value, () => assert.fail('invalid scope cannot be approved')));
});
const preview = { canResume: true, previewHash: 'b'.repeat(64), remote: false, imageCount: 7, skuCount: 2, options: { matteImages: false } };
const t = (text, values = {}) => text.replace(/\{(\w+)\}/g, (_match, key) => String(values[key] ?? ''));
test('local recovery reads its actual scope and cancellation produces no mutation or paid grant', async () => {
  const api = { previewSkuPackResume: async () => preview, getMattingConfig() { throw new Error('local needs no remote config'); } }; let text;
  assert.equal(await approveSkuResume(api, 'sku-pack-x', false, t, value => { text = value; return false; }), null); assert.ok(text.includes('2')); assert.ok(text.includes('7'));
  assert.deepEqual(await approveSkuResume(api, 'sku-pack-x', false, t, () => true), { confirm: true, retryFailed: false, previewHash: preview.previewHash, confirmPaidMatting: false });
});
test('remote recovery freshly checks destination and cancelled approval never yields a POST payload', async () => {
  let reads = 0; const dialogs = [];
  const api = { previewSkuPackResume: async () => ({ ...preview, remote: true, options: { matteImages: true, mattingProvider: 'external' } }), getMattingConfig: async () => { reads++; return { dataDestinations: [{ provider: 'external', origin: 'https://resume-approved.invalid' }] }; } };
  assert.equal(await approveSkuResume(api, 'sku-pack-x', true, t, text => { dialogs.push(text); return !text.includes('批准本次图包抠图'); }), null); assert.equal(reads, 1); assert.equal(dialogs.length, 2); assert.ok(dialogs[1].includes('https://resume-approved.invalid')); assert.ok(dialogs[1].includes('7'));
  assert.equal((await approveSkuResume(api, 'sku-pack-x', true, t, () => true)).confirmPaidMatting, true);
});
test('invalid, empty, busy and loosely typed resume previews fail before confirmation', async () => {
  for (const value of [{ ...preview, canResume: 'false' }, { ...preview, imageCount: 0 }, { ...preview, skuCount: 8 }, { ...preview, previewHash: 'bad' }, { ...preview, busy: true, canResume: false }, { ...preview, remote: true }]) await assert.rejects(approveSkuResume({ previewSkuPackResume: async () => value }, 'sku-pack-x', false, t, () => { throw new Error('dialog must not run'); }));
});
test('recovery API failures preserve the original error and do not produce approval', async () => {
  await assert.rejects(approveSkuResume({ previewSkuPackResume: async () => { throw new Error('RAW_FAILURE'); } }, 'sku-pack-x', false, t, () => true), /RAW_FAILURE/);
});
test('result UI guards duplicate resume and late responses after route changes', () => {
  const page = fs.readFileSync(new URL('../src/pages/JobResultPage.jsx', import.meta.url), 'utf8');
  assert.ok(page.includes('approveSkuResume(api, id, retryFailed')); assert.ok(page.includes('resuming.current')); assert.ok(page.includes('activeId.current !== id')); assert.ok(!page.includes('confirmPaidMatting: Boolean(remote)'));
  assert.ok(page.includes("finalizeHint ? '下载上次保存的结果包' : '下载结果'"));
  assert.ok(page.includes('await load(); if (activeId.current === id) setError(err.message)'));
  assert.ok(page.includes('Number.isSafeInteger(data.archiveGeneration)'));
});
