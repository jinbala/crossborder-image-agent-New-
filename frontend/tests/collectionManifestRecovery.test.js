import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { collectionSnapshotReadOnly, canRepairCollectionManifest, approveCollectionManifestRepair } from '../src/utils/collectionManifestRecovery.js';
import { collectionResultGuide } from '../src/utils/collectionResults.js';

const job = { id: 'collect-job-fixture', type: 'collection-job', manifestRead: { readOnly: true, primaryUnchanged: true, canRepair: true, sourceHash: 'a'.repeat(64) } };
const preview = { id: job.id, canRepair: true, source: 'backup', onlyManifest: true, imageCount: 0, remote: false, sourceHash: job.manifestRead.sourceHash, previewHash: 'b'.repeat(64) };
const t = text => text;

test('collection recovery is strictly read-only and repair is restricted to operators and administrators', () => {
  assert.equal(collectionSnapshotReadOnly(job), true);
  for (const role of ['admin', 'operator']) assert.equal(canRepairCollectionManifest(job, role), true);
  for (const role of ['viewer', 'designer', 'support', undefined, 'constructor']) assert.equal(canRepairCollectionManifest(job, role), false);
  for (const patch of [{ readOnly: 'true' }, { primaryUnchanged: false }, { canRepair: 'true' }]) assert.equal(canRepairCollectionManifest({ ...job, manifestRead: { ...job.manifestRead, ...patch } }, 'admin'), false);
  assert.equal(collectionSnapshotReadOnly({ ...job, type: 'sku-pack' }), false);
  assert.equal(collectionResultGuide({ ...job, status: 'cancelled', summary: { pendingCount: 1 } }).kind, 'recovery');
});

test('collection repair cancellation only reads its preview and cannot produce a mutation payload', async () => {
  let reads = 0, confirms = 0;
  const result = await approveCollectionManifestRepair({ previewCollectionManifestRepair: async id => { assert.equal(id, job.id); reads++; return preview; } }, job, t, message => { assert.match(message, /不修改图片/); confirms++; return false; });
  assert.equal(result, null); assert.equal(reads, 1); assert.equal(confirms, 1);
});

test('collection approval contains only explicit confirmation and bound snapshot hashes', async () => {
  const result = await approveCollectionManifestRepair({ previewCollectionManifestRepair: async () => preview }, job, t, () => true);
  assert.deepEqual(result, { confirm: true, sourceHash: preview.sourceHash, previewHash: preview.previewHash });
});

test('changed identity, displayed source and unsafe repair scopes are refused before confirmation', async () => {
  for (const patch of [{ id: 'foreign' }, { sourceHash: 'c'.repeat(64) }, { canRepair: false }, { remote: true }, { imageCount: 1 }, { onlyManifest: false }, { source: 'primary' }, { previewHash: '' }]) {
    await assert.rejects(approveCollectionManifestRepair({ previewCollectionManifestRepair: async () => ({ ...preview, ...patch }) }, job, t, () => assert.fail('Invalid scope cannot be approved')));
  }
  await assert.rejects(approveCollectionManifestRepair({}, { ...job, manifestRead: null }, t, () => true));
});

test('collection UI disables continuation for recovery snapshots and separates repair from run', () => {
  const source = fs.readFileSync(new URL('../src/pages/CollectionWorkbenchPage.jsx', import.meta.url), 'utf8');
  assert.ok(source.includes('data-collection-manifest-recovery')); assert.ok(source.includes('data-collection-manifest-repair'));
  assert.equal((source.match(/disabled=\{Boolean\(busy\) \|\| readOnly\}/g) || []).length, 3);
  const repair = source.slice(source.indexOf('async function repairManifest()'), source.indexOf('const summary = job?.summary'));
  assert.ok(repair.includes('approveCollectionManifestRepair(api, job, t'));
  assert.ok(repair.includes('if (!payload) return'));
  assert.ok(repair.includes('await api.repairCollectionManifest(job.id, payload)'));
  assert.ok(!repair.includes('runCollectionJob'));
  assert.ok(fs.readFileSync(new URL('../src/pages/JobResultPage.jsx', import.meta.url), 'utf8').includes('data-open-collection-recovery'));
});
