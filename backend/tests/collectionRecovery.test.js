import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import request from 'supertest';
import app from '../src/app.js';
import { createCollectionJob, getCollectionJob, runCollectionJob, pauseCollectionJob, importBrowserImage, previewCollectionManifestRepair, repairCollectionManifest } from '../src/services/collectionJobService.js';
import { WORKBENCH_DIR } from '../src/services/workbenchService.js';
import { withActor } from '../src/services/ownershipService.js';
import { collectionCreationEpoch, setMeta } from '../src/services/platformStore.js';
import sharp from 'sharp';
import { beginWorkspaceRestore } from '../src/services/workspaceLifecycle.js';

const jobs = [];
afterEach(async () => {
  for (const id of jobs.splice(0)) {
    const directory = path.join(WORKBENCH_DIR, id);
    assert.equal(path.dirname(directory), WORKBENCH_DIR);
    await fs.rm(directory, { recursive: true, force: true });
  }
});
async function fixture() {
  const job = await createCollectionJob({ rows: [1, 2].map(index => ({ sku: `RECOVERY-${index}`, title: 'Local recovery fixture', sales: 5, imageUrls: [`https://fixture.invalid/${index}.png`] })), options: { extraWaitMs: 0 } });
  jobs.push(job.id);
  return { job, directory: path.join(WORKBENCH_DIR, job.id), main: path.join(WORKBENCH_DIR, job.id, 'manifest.json') };
}
async function approve(id) {
  const preview = await previewCollectionManifestRepair(id);
  assert.equal(preview.canRepair, true); assert.equal(preview.onlyManifest, true); assert.equal(preview.imageCount, 0); assert.equal(preview.remote, false);
  return { confirm: true, previewHash: preview.previewHash, sourceHash: preview.sourceHash };
}

test('workspace restore and collection repair cannot race and release their barrier after errors', async () => {
  const { job, main } = await fixture(); await fs.writeFile(main, '{broken');
  const payload = await approve(job.id), finishRestore = beginWorkspaceRestore();
  try { await assert.rejects(repairCollectionManifest(job.id, payload), error => error.code === 'WORKSPACE_BUSY'); }
  finally { finishRestore(); }
  await repairCollectionManifest(job.id, payload, { beforeCommit: () => { assert.throws(beginWorkspaceRestore, error => error.code === 'WORKSPACE_BUSY'); } });
  beginWorkspaceRestore()();
});

test('collection dedicated and generic reads choose the same published snapshot without modifying output', async () => {
  const { job, directory, main } = await fixture();
  const png = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#123456' } }).png().toBuffer();
  await runCollectionJob(job.id, { limit: 1 }, { imageFetcher: async () => png });
  const zip = await fs.readFile(path.join(directory, `${job.id}.zip`));
  await fs.writeFile(main, '{broken'); const names = await fs.readdir(directory);
  const dedicated = await getCollectionJob(job.id), generic = (await request(app).get(`/api/workbench/jobs/${job.id}`).expect(200)).body;
  assert.equal(dedicated.manifestRead.sourceHash, generic.manifestRead.sourceHash);
  assert.deepEqual(dedicated.summary, generic.summary); assert.equal(dedicated.manifestRead.readOnly, true);
  assert.equal(await fs.readFile(main, 'utf8'), '{broken'); assert.deepEqual(await fs.readdir(directory), names);
  assert.deepEqual(await fs.readFile(path.join(directory, `${job.id}.zip`)), zip);
});

test('read-only recovery blocks run, upload and pause before writing any lock or calling remote fetchers', async () => {
  const { job, directory, main } = await fixture(); await fs.writeFile(main, '{broken');
  const names = await fs.readdir(directory), before = await fs.readFile(path.join(directory, 'manifest.backup.json'));
  for (const operation of [() => runCollectionJob(job.id, {}, { imageFetcher: () => assert.fail('no fetch before repair') }), () => importBrowserImage(job.id, {}), () => pauseCollectionJob(job.id)]) {
    await assert.rejects(operation(), error => error.code === 'COLLECTION_REPAIR_REQUIRED' && error.statusCode === 409);
    assert.equal(await fs.readFile(main, 'utf8'), '{broken'); assert.deepEqual(await fs.readdir(directory), names);
  }
  assert.deepEqual(await fs.readFile(path.join(directory, 'manifest.backup.json')), before);
});

test('confirmed collection repair preserves damaged bytes, keeps backup/images unchanged and is idempotent', async () => {
  const { job, directory, main } = await fixture(), backup = await fs.readFile(path.join(directory, 'manifest.backup.json'));
  await fs.writeFile(main, '{interrupted'); const payload = await approve(job.id);
  const repaired = await repairCollectionManifest(job.id, payload);
  assert.equal(repaired.repaired, true); assert.equal(repaired.imagesProcessed, 0);
  assert.equal(await fs.readFile(path.join(directory, repaired.preservedDamaged), 'utf8'), '{interrupted');
  assert.deepEqual(await fs.readFile(main), backup); assert.deepEqual(await fs.readFile(path.join(directory, 'manifest.backup.json')), backup);
  assert.deepEqual(await fs.readdir(path.join(directory, 'images')), []);
  assert.equal((await getCollectionJob(job.id)).manifestRead, undefined);
  assert.equal((await repairCollectionManifest(job.id, payload)).alreadyCurrent, true);
  assert.equal((await fs.readdir(directory)).filter(name => name.includes('.damaged-')).length, 1);
});

test('missing collection primary can be explicitly restored without fabricating damaged content', async () => {
  const { job, directory, main } = await fixture(); await fs.unlink(main);
  const result = await repairCollectionManifest(job.id, await approve(job.id));
  assert.equal(result.preservedDamaged, null); assert.equal((await getCollectionJob(job.id)).id, job.id);
  assert.equal((await fs.readdir(directory)).some(name => name.includes('.damaged-')), false);
});

test('collection repair rejects missing confirmation, changed source, changed primary and stale workspace epoch', async () => {
  const { job, directory, main } = await fixture(); await fs.writeFile(main, '{old'); const payload = await approve(job.id);
  await assert.rejects(repairCollectionManifest(job.id, { ...payload, confirm: 'true' }), error => error.statusCode === 400);
  await fs.writeFile(main, '{changed'); await assert.rejects(repairCollectionManifest(job.id, payload), error => error.code === 'COLLECTION_REPAIR_CHANGED');
  const next = await approve(job.id), backupFile = path.join(directory, 'manifest.backup.json'), original = await fs.readFile(backupFile);
  await fs.writeFile(backupFile, Buffer.concat([original, Buffer.from('\n')]));
  await assert.rejects(repairCollectionManifest(job.id, next), error => error.code === 'COLLECTION_REPAIR_CHANGED');
  const epochPayload = await approve(job.id), epoch = collectionCreationEpoch();
  try { setMeta('collection-creation-epoch', 'fixture-other-epoch'); await assert.rejects(repairCollectionManifest(job.id, epochPayload), error => error.code === 'COLLECTION_REPAIR_CHANGED'); }
  finally { setMeta('collection-creation-epoch', epoch); }
  assert.equal(await fs.readFile(main, 'utf8'), '{changed');
});

test('collection repair detects changes during confirmation commit and releases lock without replacing primary', async () => {
  const { job, directory, main } = await fixture(); await fs.writeFile(main, '{first');
  await assert.rejects(repairCollectionManifest(job.id, await approve(job.id), { beforeCommit: () => fs.writeFile(main, '{raced') }), error => error.code === 'COLLECTION_REPAIR_CHANGED');
  assert.equal(await fs.readFile(main, 'utf8'), '{raced');
  assert.equal((await fs.readdir(directory)).some(name => name.endsWith('.tmp') || name === 'run.lock' || name.includes('.damaged-')), false);
});

test('collection mutations and repair enforce ownership before touching task files', async () => {
  const owner = { id: 'collection-recovery-owner', role: 'operator' }, other = { id: 'collection-recovery-other', role: 'operator' };
  const { job, directory, main } = await withActor(owner, fixture); await fs.writeFile(main, '{owner');
  const payload = await withActor(owner, () => approve(job.id)), names = await fs.readdir(directory);
  for (const op of [() => getCollectionJob(job.id), () => previewCollectionManifestRepair(job.id), () => repairCollectionManifest(job.id, payload), () => runCollectionJob(job.id), () => importBrowserImage(job.id)]) await assert.rejects(withActor(other, op), error => error.statusCode === 404);
  for (const role of ['viewer', 'designer', 'support']) await assert.rejects(withActor({ ...owner, role }, () => repairCollectionManifest(job.id, payload)), error => error.statusCode === 403);
  assert.deepEqual(await fs.readdir(directory), names);
});

test('collection repair does not steal an old live-owner lock', async () => {
  const { job, directory, main } = await fixture(); await fs.writeFile(main, '{broken'); const payload = await approve(job.id);
  const lock = path.join(directory, 'run.lock'), bytes = JSON.stringify({ pid: process.pid }); await fs.writeFile(lock, bytes);
  await fs.utimes(lock, new Date(0), new Date(0));
  await assert.rejects(repairCollectionManifest(job.id, payload), error => error.statusCode === 409);
  assert.equal(await fs.readFile(lock, 'utf8'), bytes); assert.equal(await fs.readFile(main, 'utf8'), '{broken');
});

test('collection manifest schema and foreign identity failures do not silently fall back to old progress', async () => {
  const { job, main } = await fixture();
  for (const state of [{ ...job, id: 'collect-job-other' }, { ...job, options: null }, { ...job, items: [{ ...job.items[0], imageUrls: null }] }, { ...job, items: [job.items[0], job.items[0]] }, { ...job, items: [{ ...job.items[0], images: [{ status: 'success', file: '../escape.png' }] }] }]) {
    await fs.writeFile(main, JSON.stringify(state));
    await assert.rejects(getCollectionJob(job.id), error => ['WORKBENCH_STATE_IDENTITY', 'COLLECTION_STATE_SCHEMA', 'COLLECTION_STATE_PATH'].includes(error.code));
  }
});

test('collection HTTP repair requires explicit preview approval and then normal continuation remains separate', async () => {
  const { job, main } = await fixture(); await fs.writeFile(main, '{http fixture');
  const preview = (await request(app).get(`/api/workbench/collection-jobs/${job.id}/manifest-repair-preview`).expect(200)).body;
  await request(app).post(`/api/workbench/collection-jobs/${job.id}/repair-manifest`).send({ sourceHash: preview.sourceHash, previewHash: preview.previewHash }).expect(400);
  const response = await request(app).post(`/api/workbench/collection-jobs/${job.id}/repair-manifest`).send({ confirm: true, sourceHash: preview.sourceHash, previewHash: preview.previewHash }).expect(200);
  assert.equal(response.body.imagesProcessed, 0); assert.equal((await getCollectionJob(job.id)).status, 'queued');
});
