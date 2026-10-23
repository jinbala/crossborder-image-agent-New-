import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import { approveWorkbenchManifestRepair, canRepairWorkbenchManifest } from '../src/utils/workbenchManifestRecovery.js';
import { api } from '../src/services/api.js';
const data = { id: 'collect-fixture', type: 'collection-plan', manifestRead: { canRepair: true, readOnly: true, primaryUnchanged: true, sourceHash: 'a'.repeat(64) } };
const preview = { id: data.id, canRepair: true, source: 'backup', onlyManifest: true, imageCount: 0, remote: false, sourceHash: data.manifestRead.sourceHash, previewHash: 'b'.repeat(64) };
const t = text => text;
test('generic repair only permits supported types and operator/admin roles with strict recovery flags', () => {
  for (const type of ['image-pack', 'collection-plan', 'studio', 'listing-dry-run', 'pricing-preview', 'template-fill']) {
    for (const role of ['admin', 'operator']) assert.equal(canRepairWorkbenchManifest({ ...data, type }, role), true);
    for (const role of ['designer', 'viewer', 'support', undefined]) assert.equal(canRepairWorkbenchManifest({ ...data, type }, role), false);
  }
  for (const type of ['sku-pack', 'collection-job', 'commerce-sandbox', 'constructor']) assert.equal(canRepairWorkbenchManifest({ ...data, type }, 'admin'), false);
  for (const patch of [{ canRepair: 'true' }, { readOnly: 'true' }, { primaryUnchanged: false }]) assert.equal(canRepairWorkbenchManifest({ ...data, manifestRead: { ...data.manifestRead, ...patch } }, 'admin'), false);
});
test('generic cancellation has no mutation payload and approval binds displayed identity and exact bytes', async () => {
  const api = { previewWorkbenchManifestRepair: async id => { assert.equal(id, data.id); return preview; } };
  assert.equal(await approveWorkbenchManifestRepair(api, data, t, () => false), null);
  assert.deepEqual(await approveWorkbenchManifestRepair(api, data, t, () => true), { confirm: true, sourceHash: preview.sourceHash, previewHash: preview.previewHash });
  for (const patch of [{ id: 'foreign' }, { sourceHash: 'c'.repeat(64) }, { remote: true }, { imageCount: 1 }]) await assert.rejects(approveWorkbenchManifestRepair({ previewWorkbenchManifestRepair: async () => ({ ...preview, ...patch }) }, data, t, () => assert.fail('Unsafe preview cannot be confirmed')));
});
test('generic result repair is separate from continuation and recovered template execution is disabled', () => {
  const source = fs.readFileSync(new URL('../src/pages/JobResultPage.jsx', import.meta.url), 'utf8');
  assert.ok(source.includes('approveWorkbenchManifestRepair(api, data, t, confirm)'));
  assert.ok(source.includes('await api.repairWorkbenchManifest(id, payload)'));
  assert.ok(source.includes('!canOperate || data.manifestRead?.readOnly === true'));
  const repair = source.slice(source.indexOf('async function repairManifest()'), source.indexOf('async function executeTemplate()'));
  assert.equal(repair.includes('executeWorkbookFill'), false); assert.equal(repair.includes('resumeSkuPack'), false);
  assert.equal(typeof api.previewWorkbenchManifestRepair, 'function'); assert.equal(typeof api.repairWorkbenchManifest, 'function');
});
