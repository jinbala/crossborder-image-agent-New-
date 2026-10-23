import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { collectionPackLink, collectionPackFiles, collectionPackPayload, approveSkuPackMatting } from '../src/utils/collectionPack.js';
import { english } from '../src/i18n/messages.js';
const preview = { jobId: 'collect-job-original', previewHash: 'a'.repeat(64), images: [{ relativePath: '原文/主图.png', size: 1234 }], metadata: { 原文: { title: '$& {sku}' } } };

test('direct collection links validate job identities and only navigate to the rule editor', () => {
  assert.equal(collectionPackLink('collect-job-original'), '/workbench/sku-pack?collectionJobId=collect-job-original');
  for (const id of [null, '../outside', 'job-1', 'collect-job-a?token=private', 'https://example.org']) assert.equal(collectionPackLink(id), '');
});
test('collection descriptors preserve local names without downloading or exposing server paths', () => {
  const before = JSON.stringify(preview), files = collectionPackFiles(preview);
  assert.deepEqual(files, [{ name: '主图.png', webkitRelativePath: '原文/主图.png', size: 1234, lastModified: 0 }]);
  assert.equal(JSON.stringify(preview), before);
  for (const value of [null, { ...preview, previewHash: 'invalid' }, { ...preview, images: [] }, { ...preview, images: Array(301).fill(preview.images[0]) }]) assert.throws(() => collectionPackFiles(value));
});
test('confirmation payload carries rules and an approved source snapshot, not file paths or implicit partial approval', () => {
  const options = Object.freeze({ format: 'png', matteImages: false }), payload = collectionPackPayload(preview, options, 'true');
  assert.deepEqual(payload, { previewHash: preview.previewHash, confirm: true, confirmPartial: false, options });
  assert.equal(collectionPackPayload(preview, options, true).confirmPartial, true);
  assert.ok(!JSON.stringify(payload).includes('relativePath'));
});
test('source loading is read-only and explicit generation confirms before submitting the direct route', () => {
  const page = fs.readFileSync(new URL('../src/pages/SkuPackPage.jsx', import.meta.url), 'utf8');
  assert.ok(page.includes('api.previewCollectionPack(collectionJobId)')); assert.ok(page.includes('api.createCollectionPack(collectionJobId, collectionPackPayload('));
  assert.ok(page.includes('window.confirm(t(')); assert.ok(page.includes('submitting.current')); assert.ok(page.includes('data-collection-pack-partial')); assert.ok(page.includes('data-sku-pack-provenance'));
  assert.ok(page.includes('sourcePreview?.metadata')); assert.ok(page.includes('data-sku-pack-submit'));
  assert.ok(Object.hasOwn(english, '使用本任务图片整理图包'));
});

test('local matting grants no remote approval and does not request provider configuration', async () => {
  const forbidden = () => { throw new Error('must not be called'); };
  for (const options of [{ matteImages: false, mattingProvider: 'external' }, { matteImages: true, mattingProvider: 'sharp' }, { matteImages: true, mattingProvider: 'rembg' }]) assert.equal(await approveSkuPackMatting({ getMattingConfig: forbidden }, options, {}, forbidden, forbidden), true);
});
test('remote pack matting requires strict approval and exposes only the provider origin before submission', async () => {
  let reads = 0, dialog = '';
  const api = { async getMattingConfig() { reads++; return { dataDestinations: [{ provider: 'external', origin: 'https://approved.invalid' }] }; } };
  const t = (text, values = {}) => text.replace(/\{(\w+)\}/g, (_match, key) => String(values[key] ?? ''));
  const options = { matteImages: true, mattingProvider: 'external', confirmPaidMatting: true };
  for (const value of [undefined, false, 1, 'true']) await assert.rejects(approveSkuPackMatting(api, { ...options, confirmPaidMatting: value }, {}, t, () => true));
  assert.equal(reads, 0);
  assert.equal(await approveSkuPackMatting(api, options, { target: '原文 $& {sku}', count: 13 }, t, text => { dialog = text; return false; }), false);
  assert.ok(dialog.includes('https://approved.invalid')); assert.ok(dialog.includes('原文 $& {sku}')); assert.ok(dialog.includes('13')); assert.ok(dialog.includes('失败或重试'));
  assert.equal(reads, 1);
});
test('missing, malformed or credential-bearing remote destinations fail before any approval dialog', async () => {
  const options = { matteImages: true, mattingProvider: 'image2', confirmPaidMatting: true };
  for (const origin of [undefined, '配置地址无效', 'https://user:secret@example.org', 'https://example.org/v1?token=secret', 'file:///private']) {
    await assert.rejects(approveSkuPackMatting({ getMattingConfig: async () => ({ dataDestinations: [{ provider: 'image2', origin }] }) }, options, {}, text => text, () => { throw new Error('dialog must not run'); }), /无法读取/);
  }
});
