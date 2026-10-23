import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import sharp from 'sharp';
import AdmZip from 'adm-zip';
import request from 'supertest';
import { execFileSync } from 'node:child_process';
import app from '../src/app.js';
import { paths } from '../src/services/dbPaths.js';
import { createCollectionJob, importBrowserImage } from '../src/services/collectionJobService.js';
import { previewCollectionPack, createCollectionPack } from '../src/services/collectionPackService.js';
import { normalizeSkuPackOptions, resumeSkuPack } from '../src/services/skuPackService.js';
import { withActor } from '../src/services/ownershipService.js';
import { platformDb, platformBackup, restorePlatformBackup, collectionCreationEpoch, setMeta } from '../src/services/platformStore.js';
import { beginWorkspaceRestore } from '../src/services/workspaceLifecycle.js';
import { canAccess } from '../src/middleware/webAccess.js';

const jobs = new Set(), temporary = [], root = path.join(paths.outputDir, 'workbench');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const options = { format: 'png', squareSize: 320, generateSquare: true, preserveOriginals: true };
const payload = preview => ({ previewHash: preview.previewHash, confirm: true, options });
afterEach(async () => {
  for (const id of [...jobs]) {
    for (const record of platformDb().prepare('SELECT job_id FROM collection_pack_transfers WHERE source_job_id=?').all(id)) jobs.add(record.job_id);
    platformDb().prepare('DELETE FROM collection_pack_transfers WHERE source_job_id=?').run(id);
  }
  const entries = await fs.readdir(root).catch(() => []);
  for (const id of jobs) {
    assert.match(id, /^(?:collect-job|sku-pack)-[A-Za-z0-9_-]+$/);
    for (const name of entries.filter(name => name === id || name.startsWith(`${id}-part-`))) {
      await fs.rm(path.join(root, name), { recursive: true, force: true });
      platformDb().prepare('DELETE FROM task_index WHERE id=?').run(name);
      platformDb().prepare("DELETE FROM resource_assets WHERE kind='job' AND resource_id=?").run(name);
      platformDb().prepare("DELETE FROM resource_owners WHERE kind='job' AND resource_id=?").run(name);
    }
  }
  for (const folder of temporary) { assert.equal(path.dirname(folder), paths.rootDir); assert.ok(path.basename(folder).startsWith('pack-source-')); await fs.rm(folder, { recursive: true, force: true }); }
  jobs.clear(); temporary.length = 0;
});
async function fixture({ partial = false } = {}) {
  const folder = await fs.mkdtemp(path.join(paths.rootDir, 'pack-source-')); temporary.push(folder);
  const png = await sharp({ create: { width: 64, height: 32, channels: 3, background: '#537b90' } }).png().toBuffer();
  const image = path.join(folder, '原图.png'); await fs.writeFile(image, png);
  const job = await createCollectionJob({ rows: [1, 2].map(index => ({ sku: `来源-${index}`, title: '原文 $& {sku}', imageUrls: [`https://fixture.invalid/${index}.png`] })), options: { extraWaitMs: 0 } }); jobs.add(job.id);
  for (const item of job.items.slice(0, partial ? 1 : 2)) await importBrowserImage(job.id, { itemId: item.id, sourceUrl: item.imageUrls[0], filePath: image });
  return { job, png, image, folder, manifest: path.join(root, job.id, 'manifest.json') };
}
const actor = role => ({ id: `transfer-${randomUUID()}`, role });

test('preview is read-only and direct pack preserves bytes, source traceability and durable replay', async () => {
  const user = actor('operator');
  await withActor(user, async () => {
    const input = await fixture(), before = await fs.readFile(input.manifest), preview = await previewCollectionPack(input.job.id);
    assert.equal(preview.imageCount, 2); assert.equal(preview.partial, false); assert.equal(preview.skuCount, 2);
    assert.equal(preview.metadata['来源-1'].title, '原文 $& {sku}'); assert.ok(!JSON.stringify(preview).includes(paths.rootDir));
    const result = await createCollectionPack(input.job.id, payload(preview)); jobs.add(result.id);
    assert.equal(result.summary.skuCount, 2); assert.equal(result.summary.generatedSquareCount, 2); assert.equal(result.source.jobId, input.job.id);
    assert.equal(result.source.images[0].sha256, hash(input.png)); assert.equal(result.source.images[0].itemId, input.job.items[0].id);
    const zip = new AdmZip(path.join(root, result.id, `${result.id}.zip`));
    const originals = zip.getEntries().filter(entry => entry.entryName.includes('/originals/') && !entry.isDirectory);
    assert.equal(originals.length, 2); assert.ok(originals.every(entry => hash(entry.getData()) === hash(input.png)));
    assert.equal(JSON.parse(zip.getEntry('manifest.json').getData()).source.jobId, input.job.id);
    const mtime = (await fs.stat(path.join(root, result.id, `${result.id}.zip`))).mtimeMs;
    const replay = await createCollectionPack(input.job.id, payload(preview));
    assert.equal(replay.id, result.id); assert.equal(replay.transfer.replayed, true); assert.equal((await fs.stat(path.join(root, result.id, `${result.id}.zip`))).mtimeMs, mtime);
    assert.deepEqual(await fs.readFile(input.manifest), before);
  });
});

test('partial collection requires strict confirmation and never processes unfinished URLs', async () => {
  const input = await fixture({ partial: true }), preview = await previewCollectionPack(input.job.id);
  assert.equal(preview.partial, true); assert.equal(preview.imageCount, 1);
  for (const confirmPartial of [undefined, false, 'true', 1]) await assert.rejects(createCollectionPack(input.job.id, { ...payload(preview), confirmPartial }), error => error.code === 'COLLECTION_PACK_PARTIAL');
  const result = await createCollectionPack(input.job.id, { ...payload(preview), confirmPartial: true }); jobs.add(result.id);
  assert.equal(result.summary.inputCount, 1); assert.equal(result.source.images.length, 1);
});

test('missing confirmation, stale preview and changed source hash create no transfer receipts', async () => {
  const input = await fixture(), preview = await previewCollectionPack(input.job.id);
  for (const confirm of [undefined, false, 'true', 1]) await assert.rejects(createCollectionPack(input.job.id, { ...payload(preview), confirm }), error => error.statusCode === 400);
  await assert.rejects(createCollectionPack(input.job.id, { ...payload(preview), previewHash: 'a'.repeat(64) }), error => error.code === 'COLLECTION_SOURCE_CHANGED');
  const image = path.join(root, input.job.id, 'images', preview.images[0].relativePath); await fs.writeFile(image, 'changed');
  await assert.rejects(createCollectionPack(input.job.id, payload(preview)), error => error.code === 'COLLECTION_SOURCE_CHANGED');
  assert.equal(platformDb().prepare('SELECT count(*) AS n FROM collection_pack_transfers WHERE source_job_id=?').get(input.job.id).n, 0);
});

test('unsafe relative paths, junctions and unsupported images fail closed before allocating a result', async () => {
  const input = await fixture(), original = JSON.parse(await fs.readFile(input.manifest));
  for (const file of ['../secret.png', '/secret.png', 'C:/secret.png', 'SKU\\secret.png', './secret.png']) {
    const changed = structuredClone(original); changed.items[0].images[0].file = file; await fs.writeFile(input.manifest, JSON.stringify(changed));
    await assert.rejects(previewCollectionPack(input.job.id), error => error.code === 'COLLECTION_STATE_PATH');
  }
  await fs.symlink(input.folder, path.join(root, input.job.id, 'images', 'escape'), 'junction');
  const changed = structuredClone(original); changed.items[0].images[0].file = 'escape/原图.png'; changed.items[0].images[0].url = `/outputs/workbench/${input.job.id}/images/escape/原图.png`; await fs.writeFile(input.manifest, JSON.stringify(changed));
  await assert.rejects(previewCollectionPack(input.job.id), error => error.code === 'COLLECTION_PACK_PATH');
  await fs.writeFile(input.manifest, JSON.stringify(original));
  const image = path.join(root, input.job.id, 'images', original.items[0].images[0].file); await fs.writeFile(image, 'not a raster');
  delete original.items[0].images[0].sha256; await fs.writeFile(input.manifest, JSON.stringify(original));
  await assert.rejects(previewCollectionPack(input.job.id), error => error.code === 'COLLECTION_PACK_IMAGE');
});

test('same-source concurrent requests share one target and new rules create a separate immutable pack', async () => {
  const input = await fixture(), preview = await previewCollectionPack(input.job.id);
  const results = await Promise.all(Array.from({ length: 3 }, () => createCollectionPack(input.job.id, payload(preview))));
  assert.equal(new Set(results.map(result => result.id)).size, 1); jobs.add(results[0].id);
  assert.equal(platformDb().prepare('SELECT count(*) AS n FROM collection_pack_transfers WHERE source_job_id=?').get(input.job.id).n, 1);
  const result = await createCollectionPack(input.job.id, { ...payload(preview), options: { ...options, quality: 90 } }); jobs.add(result.id);
  assert.notEqual(result.id, results[0].id);
});

test('foreign and read-only actors cannot transfer; assigned designers can use their own images', async () => {
  const owner = actor('designer'), foreign = actor('operator'); let input, preview;
  await withActor(owner, async () => { input = await fixture(); preview = await previewCollectionPack(input.job.id); });
  await withActor(foreign, async () => {
    await assert.rejects(previewCollectionPack(input.job.id), error => error.statusCode === 404);
    await assert.rejects(createCollectionPack(input.job.id, payload(preview)), error => error.statusCode === 404);
  });
  await withActor({ ...owner, role: 'viewer' }, async () => { await assert.rejects(createCollectionPack(input.job.id, payload(preview)), error => error.statusCode === 403); });
  await withActor(owner, async () => { const result = await createCollectionPack(input.job.id, payload(preview)); jobs.add(result.id); });
  assert.equal(canAccess('designer', 'POST', `/api/workbench/collection-jobs/${input.job.id}/sku-pack`), true);
  assert.equal(canAccess('viewer', 'POST', `/api/workbench/collection-jobs/${input.job.id}/sku-pack`), false);
});

test('workspace epoch changes invalidate uncommitted previews and transfers block restore during execution', async () => {
  const input = await fixture(), preview = await previewCollectionPack(input.job.id), epoch = collectionCreationEpoch();
  setMeta('collection-creation-epoch', randomUUID());
  try { await assert.rejects(createCollectionPack(input.job.id, payload(preview)), error => error.code === 'COLLECTION_SOURCE_CHANGED'); }
  finally { setMeta('collection-creation-epoch', epoch); }
  const result = await createCollectionPack(input.job.id, payload(preview), { beforeCopy() { assert.throws(() => beginWorkspaceRestore(), error => error.code === 'WORKSPACE_BUSY'); } }); jobs.add(result.id);
});

test('handoff source trace survives an interrupted SKU and explicit recovery', async () => {
  const input = await fixture(), preview = await previewCollectionPack(input.job.id);
  await assert.rejects(createCollectionPack(input.job.id, payload(preview), { execution: { afterSku() { throw new Error('interruption'); } } }), /进度已保存/);
  const replay = await createCollectionPack(input.job.id, payload(preview)); jobs.add(replay.id);
  assert.equal(replay.status, 'paused'); assert.equal(replay.source.jobId, input.job.id); assert.equal(replay.summary.completedSkuCount, 1);
  const resumed = await resumeSkuPack(replay.id, { confirm: true }); assert.equal(resumed.status, 'completed'); assert.deepEqual(resumed.source, replay.source);
});

test('server rechecks copied bytes before image processing and rejects loose paid confirmations', async () => {
  const input = await fixture(), preview = await previewCollectionPack(input.job.id);
  for (const value of ['true', 1, 'yes']) {
    assert.equal(normalizeSkuPackOptions({ confirmPaidMatting: value }).confirmPaidMatting, false);
    await assert.rejects(createCollectionPack(input.job.id, { ...payload(preview), options: { ...options, matteImages: true, mattingProvider: 'external', confirmPaidMatting: value } }), error => error.statusCode === 400);
  }
  await assert.rejects(createCollectionPack(input.job.id, payload(preview), { async beforeCopy(data) { await fs.writeFile(data.inputs[0].path, 'changed between validation and copy'); } }), /来源图片在确认后变化/);
  const record = platformDb().prepare('SELECT * FROM collection_pack_transfers WHERE source_job_id=?').get(input.job.id);
  assert.equal(await fs.stat(path.join(root, record.job_id, 'inputs', '0.bin')).catch(() => null), null);
});

test('HTTP preview and confirmed transfer return a downloadable source-linked result', async () => {
  const input = await fixture();
  const preview = (await request(app).get(`/api/workbench/collection-jobs/${input.job.id}/sku-pack-preview`).expect(200)).body;
  const result = (await request(app).post(`/api/workbench/collection-jobs/${input.job.id}/sku-pack`).send(payload(preview)).expect(200)).body; jobs.add(result.id);
  assert.equal(result.source.jobId, input.job.id);
  await request(app).get(result.downloadUrl).expect(200);
});

test('a fresh backend process and restored backup replay the durable target without a second pack', async () => {
  const owner = actor('operator');
  await withActor(owner, async () => {
    const input = await fixture(), preview = await previewCollectionPack(input.job.id), body = payload(preview);
    const result = await createCollectionPack(input.job.id, body); jobs.add(result.id);
    const serialized = JSON.stringify({ owner, id: input.job.id, body });
    const script = `import{withActor}from'./src/services/ownershipService.js';import{createCollectionPack}from'./src/services/collectionPackService.js';const v=${serialized};const r=await withActor(v.owner,()=>createCollectionPack(v.id,v.body));console.log(JSON.stringify({id:r.id,replayed:r.transfer.replayed}));`;
    const child = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', script], { cwd: process.cwd(), env: process.env, encoding: 'utf8', windowsHide: true, timeout: 15000 }).trim());
    assert.equal(child.id, result.id); assert.equal(child.replayed, true);
    const file = path.join(input.folder, 'workspace.sqlite'); await fs.writeFile(file, platformBackup());
    restorePlatformBackup(file);
    const replay = await createCollectionPack(input.job.id, body);
    assert.equal(replay.id, result.id); assert.equal(replay.transfer.replayed, true);
    assert.equal(platformDb().prepare('SELECT count(*) AS n FROM collection_pack_transfers WHERE source_job_id=?').get(input.job.id).n, 1);
  });
});

test('transfer limits reject zero or over 300 downloaded images without silently truncating a collection', async () => {
  const input = await fixture(), manifest = JSON.parse(await fs.readFile(input.manifest));
  manifest.items.forEach(item => { item.images = []; }); await fs.writeFile(input.manifest, JSON.stringify(manifest));
  await assert.rejects(previewCollectionPack(input.job.id), /没有已下载图片/);
  manifest.items[0].images = Array.from({ length: 301 }, (_, index) => ({ status: 'success', sourceUrl: `https://fixture.invalid/${index}.png`, file: `SKU/${index}.png`, url: `/outputs/workbench/${input.job.id}/images/SKU/${index}.png` }));
  manifest.items[0].imageUrls = manifest.items[0].images.map(image => image.sourceUrl);
  await fs.writeFile(input.manifest, JSON.stringify(manifest));
  await assert.rejects(previewCollectionPack(input.job.id), error => error.code === 'COLLECTION_PACK_LIMIT' && error.message.includes('未截断'));
});

test('a published transfer whose result was removed never silently recreates its processing or costs', async () => {
  const input = await fixture(), preview = await previewCollectionPack(input.job.id), body = payload(preview);
  const result = await createCollectionPack(input.job.id, body); jobs.add(result.id);
  await fs.rename(path.join(root, result.id, 'manifest.json'), path.join(root, result.id, 'manifest.test-preserved'));
  await assert.rejects(createCollectionPack(input.job.id, body), error => error.code === 'COLLECTION_PACK_FILES_MISSING');
  assert.equal(await fs.stat(path.join(root, result.id, 'manifest.json')).catch(() => null), null);
});
