import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import AdmZip from 'adm-zip';
import request from 'supertest';
import app from '../src/app.js';
import { paths } from '../src/services/dbPaths.js';
import { readWorkbenchSnapshot, writeWorkbenchManifest } from '../src/services/workbenchSnapshotService.js';
import { previewWorkbenchManifestRepair, repairWorkbenchManifest } from '../src/services/workbenchManifestRepairService.js';
import { withWorkbenchMutation } from '../src/services/workbenchMutationService.js';
import { withActor, claimResource } from '../src/services/ownershipService.js';
import { collectionCreationEpoch, setMeta } from '../src/services/platformStore.js';
import { beginWorkspaceRestore } from '../src/services/workspaceLifecycle.js';

const root = path.join(paths.outputDir, 'workbench'), jobs = [];
afterEach(async () => { for (const id of jobs.splice(0)) { const dir = path.join(root, id); assert.equal(path.dirname(dir), root); await fs.rm(dir, { recursive: true, force: true }); } });
async function fixture(prefix = 'pack-', type = 'image-pack', field = 'items') {
  const id = `${prefix}repair-${randomUUID()}`, directory = path.join(root, id); jobs.push(id);
  await fs.mkdir(directory, { recursive: true }); claimResource('job', id);
  const state = { id, type, status: 'waiting_user', createdAt: new Date().toISOString(), summary: { count: 45 }, [field]: Array.from({ length: 45 }, (_, index) => ({ sku: `literal-${index}` })) };
  await writeWorkbenchManifest(state);
  const main = path.join(directory, 'manifest.json'), backup = `${main}.backup`, bytes = await fs.readFile(backup);
  await fs.writeFile(main, '{interrupted');
  return { id, directory, state, main, backup, bytes };
}
async function approve(id) { const p = await previewWorkbenchManifestRepair(id); return { confirm: true, previewHash: p.previewHash, sourceHash: p.sourceHash }; }

for (const [prefix, type, field] of [['pack-', 'image-pack', 'items'], ['collect-', 'collection-plan', 'items'], ['studio-', 'studio', 'items'], ['listing-', 'listing-dry-run', 'rows'], ['pricing-', 'pricing-preview', 'items'], ['template-fill-', 'template-fill', 'changes']]) {
  test(`${type} explicit repair preserves damaged bytes, full backup and waiting state without execution`, async () => {
    const v = await fixture(prefix, type, field), names = await fs.readdir(v.directory);
    const p = await previewWorkbenchManifestRepair(v.id);
    assert.equal(p.canRepair, true); assert.equal(p.onlyManifest, true); assert.equal(p.imageCount, 0); assert.equal(p.remote, false);
    assert.deepEqual(await fs.readdir(v.directory), names); assert.equal(await fs.readFile(v.main, 'utf8'), '{interrupted');
    const payload = await approve(v.id), result = await repairWorkbenchManifest(v.id, payload);
    assert.equal(result.repaired, true); assert.equal(result.imagesProcessed, 0);
    assert.equal(await fs.readFile(path.join(v.directory, result.preservedDamaged), 'utf8'), '{interrupted');
    assert.deepEqual(await fs.readFile(v.main), v.bytes); assert.deepEqual(await fs.readFile(v.backup), v.bytes);
    const snapshot = await readWorkbenchSnapshot(v.id); assert.equal(snapshot.source, 'primary'); assert.equal(snapshot.state.status, 'waiting_user'); assert.equal(snapshot.state[field].length, 45);
    assert.deepEqual(await repairWorkbenchManifest(v.id, payload), { id: v.id, repaired: false, alreadyCurrent: true });
    assert.equal((await fs.readdir(v.directory)).some(name => name.endsWith('.lock') || name.endsWith('.tmp')), false);
  });
}
test('archive repair copies exact manifest bytes without modifying ZIP or images', async () => {
  const v = await fixture(), zip = new AdmZip(), bytes = Buffer.from(JSON.stringify(v.state, null, 1));
  zip.addFile('manifest.json', bytes); zip.addFile('image.png', Buffer.from('immutable fixture'));
  const archive = path.join(v.directory, `${v.id}.zip`), original = zip.toBuffer(); await fs.writeFile(archive, original); const time = (await fs.stat(archive)).mtimeMs;
  assert.equal((await previewWorkbenchManifestRepair(v.id)).source, 'archive');
  await repairWorkbenchManifest(v.id, await approve(v.id));
  assert.deepEqual(await fs.readFile(v.main), bytes); assert.deepEqual(await fs.readFile(archive), original); assert.equal((await fs.stat(archive)).mtimeMs, time);
});
test('missing primary repair does not invent a damaged file', async () => {
  const v = await fixture(); await fs.unlink(v.main);
  const result = await repairWorkbenchManifest(v.id, await approve(v.id)); assert.equal(result.preservedDamaged, null); assert.deepEqual(await fs.readFile(v.main), v.bytes);
});
test('strict confirmation, changing primary, changing source and workspace epoch reject without overwrites', async () => {
  const v = await fixture(), original = await approve(v.id);
  for (const patch of [{ confirm: false }, { confirm: 'true' }, { sourceHash: '' }, { previewHash: '' }]) await assert.rejects(repairWorkbenchManifest(v.id, { ...original, ...patch }), { code: 'WORKBENCH_REPAIR_CONFIRM' });
  await fs.writeFile(v.main, '{changed'); await assert.rejects(repairWorkbenchManifest(v.id, original), { code: 'WORKBENCH_REPAIR_CHANGED' });
  const sourceApproval = await approve(v.id); await fs.appendFile(v.backup, '\n'); await assert.rejects(repairWorkbenchManifest(v.id, sourceApproval), { code: 'WORKBENCH_REPAIR_CHANGED' });
  const epochApproval = await approve(v.id), epoch = collectionCreationEpoch();
  try { setMeta('collection-creation-epoch', 'different-repair-epoch'); await assert.rejects(repairWorkbenchManifest(v.id, epochApproval), { code: 'WORKBENCH_REPAIR_CHANGED' }); }
  finally { setMeta('collection-creation-epoch', epoch); }
  assert.equal(await fs.readFile(v.main, 'utf8'), '{changed');
});
test('commit recheck detects uncooperative external file changes and removes only its own temporary file', async () => {
  const v = await fixture();
  await assert.rejects(repairWorkbenchManifest(v.id, await approve(v.id), { beforeCommit: () => fs.writeFile(v.main, '{external-change') }), { code: 'WORKBENCH_REPAIR_CHANGED' });
  assert.equal(await fs.readFile(v.main, 'utf8'), '{external-change');
  assert.deepEqual((await fs.readdir(v.directory)).sort(), ['manifest.json', 'manifest.json.backup']);
});
test('repair serializes with writers and workspace restore, and nested producer write can complete', async () => {
  const v = await fixture(), approved = await approve(v.id);
  await repairWorkbenchManifest(v.id, approved, { beforeCommit: async () => {
    assert.equal((await previewWorkbenchManifestRepair(v.id)).canRepair, false);
    await assert.rejects(writeWorkbenchManifest(v.state), { code: 'WORKBENCH_STATE_BUSY' });
    await assert.rejects(repairWorkbenchManifest(v.id, approved), { code: 'WORKBENCH_STATE_BUSY' });
    assert.throws(beginWorkspaceRestore, { code: 'WORKSPACE_BUSY' });
  } });
  await withWorkbenchMutation(v.id, v.directory, () => writeWorkbenchManifest({ ...v.state, status: 'completed' }), { allowManifestWrite: true });
  assert.equal((await readWorkbenchSnapshot(v.id)).state.status, 'completed');
  const release = beginWorkspaceRestore();
  try { await assert.rejects(repairWorkbenchManifest(v.id, approved), { code: 'WORKSPACE_BUSY' }); }
  finally { release(); }
});
test('interrupted lock is retained and prevents writes rather than being deleted as stale', async () => {
  const v = await fixture(), approved = await approve(v.id), lock = path.join(v.directory, 'manifest-operation.lock');
  await fs.writeFile(lock, 'interrupted lock');
  assert.equal((await previewWorkbenchManifestRepair(v.id)).canRepair, false);
  await assert.rejects(repairWorkbenchManifest(v.id, approved), { code: 'WORKBENCH_STATE_BUSY' });
  assert.equal(await fs.readFile(lock, 'utf8'), 'interrupted lock'); assert.equal(await fs.readFile(v.main, 'utf8'), '{interrupted');
});
test('role and ownership checks precede any task mutation, and approval is actor-bound', async () => {
  const owner = { id: 'generic-repair-owner', role: 'operator' }, v = await withActor(owner, () => fixture());
  const approved = await withActor(owner, () => approve(v.id));
  await assert.rejects(withActor({ id: 'other', role: 'operator' }, () => previewWorkbenchManifestRepair(v.id)), error => error.statusCode === 404);
  for (const role of ['designer', 'viewer']) await assert.rejects(withActor({ ...owner, role }, () => repairWorkbenchManifest(v.id, approved)), error => error.statusCode === 403);
  await assert.rejects(withActor({ id: 'another-admin', role: 'admin' }, () => repairWorkbenchManifest(v.id, approved)), { code: 'WORKBENCH_REPAIR_CHANGED' });
  assert.equal(await fs.readFile(v.main, 'utf8'), '{interrupted');
});
test('generic API offers no-store scoped preview and explicit repair only', async () => {
  const v = await fixture();
  const p = await request(app).get(`/api/workbench/jobs/${v.id}/manifest-repair-preview`).expect(200);
  assert.equal(p.headers['cache-control'], 'no-store'); assert.equal(p.body.id, v.id);
  await request(app).post(`/api/workbench/jobs/${v.id}/repair-manifest`).send({}).expect(400);
  await request(app).post(`/api/workbench/jobs/${v.id}/repair-manifest`).send({ confirm: true, sourceHash: p.body.sourceHash, previewHash: p.body.previewHash }).expect(200);
  assert.equal((await readWorkbenchSnapshot(v.id)).source, 'primary');
  for (const id of ['collect-job-foreign', 'sku-pack-foreign', 'sandbox-foreign']) await assert.rejects(previewWorkbenchManifestRepair(id), { code: 'WORKBENCH_REPAIR_TYPE' });
});
