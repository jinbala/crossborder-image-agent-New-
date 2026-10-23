import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { manifestRecoveryLabel, approveManifestRepair, canRepairManifest } from '../src/utils/skuManifestRecovery.js';
import { api } from '../src/services/api.js';

const preview = { canRepair: true, onlyManifest: true, imageCount: 0, remote: false, source: 'archive', previewHash: 'a'.repeat(64), sourceHash: 'b'.repeat(64) };
const t = value => `translated:${value}`;

test('only writable SKU results can offer explicit manifest repair, not generic read-only snapshots', () => {
  const data = { type: 'sku-pack', manifestRead: { readOnly: true, primaryUnchanged: true } };
  assert.equal(canRepairManifest(data, true), true);
  for (const type of ['image-pack', 'collection-job', 'studio', 'pricing-preview', 'template-fill']) assert.equal(canRepairManifest({ ...data, type }, true), false);
  for (const permission of [false, 'true', 1, undefined]) assert.equal(canRepairManifest(data, permission), false);
  assert.equal(canRepairManifest({ ...data, manifestRead: { readOnly: true, primaryUnchanged: false } }, true), false);
  assert.equal(api.workbenchManifestUrl('a/b?c'), '/api/workbench/jobs/a%2Fb%3Fc/manifest');
});

test('snapshot labels map only strict controlled provenance and never translate file names', () => {
  const source = { source: 'backup', sourceName: '已完成 $& {unknown}', readOnly: true, primaryUnchanged: true }, original = JSON.stringify(source);
  assert.match(manifestRecoveryLabel(source, t), /^translated:当前展示备份/);
  assert.match(manifestRecoveryLabel({ ...source, source: 'archive' }, t), /^translated:当前展示已发布 ZIP/);
  for (const patch of [{ source: 'constructor' }, { source: '__proto__' }, { readOnly: 'true' }, { primaryUnchanged: false }]) assert.equal(manifestRecoveryLabel({ ...source, ...patch }, t), '');
  assert.equal(JSON.stringify(source), original);
});

test('repair cancellation is a read-only preflight and never yields a mutation payload', async () => {
  let reads = 0, dialogs = 0;
  const result = await approveManifestRepair({ previewSkuManifestRepair: async () => { reads++; return preview; } }, 'id', t, message => { dialogs++; assert.match(message, /不修改图片/); return false; }, preview.sourceHash);
  assert.equal(result, null); assert.equal(reads, 1); assert.equal(dialogs, 1);
});

test('valid repair approval contains only explicit confirmation and the current bound hashes', async () => {
  const result = await approveManifestRepair({ previewSkuManifestRepair: async () => preview }, 'id', t, () => true, preview.sourceHash);
  assert.deepEqual(result, { confirm: true, previewHash: preview.previewHash, sourceHash: preview.sourceHash });
  assert.equal('confirmPaidMatting' in result, false);
});

test('loose, changed, remote and nonzero repair scopes fail before any confirmation', async () => {
  for (const patch of [{ canRepair: 'true' }, { onlyManifest: false }, { imageCount: 1 }, { remote: true }, { source: 'primary' }, { previewHash: '' }, { sourceHash: 'bad' }]) await assert.rejects(approveManifestRepair({ previewSkuManifestRepair: async () => ({ ...preview, ...patch }) }, 'id', t, () => assert.fail('invalid scope cannot be confirmed'), preview.sourceHash));
  await assert.rejects(approveManifestRepair({ previewSkuManifestRepair: async () => { throw new Error('RAW_READ_FAILURE'); } }, 'id', t, () => true), /RAW_READ_FAILURE/);
});

test('result pages wire explicit repair and API-origin manifest download without changing task data automatically', () => {
  const source = fs.readFileSync(new URL('../src/pages/JobResultPage.jsx', import.meta.url), 'utf8');
  assert.ok(source.includes('approveManifestRepair(api, id, t'));
  assert.ok(source.includes('data-manifest-recovery')); assert.ok(source.includes('data-manifest-repair'));
  assert.ok(source.includes('api.skuPackManifestUrl(id)')); assert.ok(source.includes('if (!payload || activeId.current !== id) return'));
  assert.equal(api.skuPackManifestUrl('a/b?c'), '/api/workbench/sku-packs/a%2Fb%3Fc/manifest');
});

test('repair approval cannot silently switch away from the snapshot currently displayed', async () => {
  for (const displayed of [undefined, '', 'c'.repeat(64)]) await assert.rejects(approveManifestRepair({ previewSkuManifestRepair: async () => preview }, 'id', t, () => assert.fail('changed or missing displayed snapshot cannot be confirmed'), displayed));
});
