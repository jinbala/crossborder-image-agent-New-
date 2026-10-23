import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import sharp from 'sharp';
import app from '../src/app.js';
import { createSkuPack, previewSkuManifestRepair, repairSkuManifest, resumeSkuPack, previewSkuPackResume, pauseRunningSkuPacks, controlSkuPack } from '../src/services/skuPackService.js';
import { WORKBENCH_DIR, workbenchJobDetail } from '../src/services/workbenchService.js';
import { withActor, claimResource } from '../src/services/ownershipService.js';
import { platformDb } from '../src/services/platformStore.js';
import AdmZip from 'adm-zip';

const roots = [], jobs = [];
afterEach(async () => {
  for (const id of jobs.splice(0)) for (const name of await fs.readdir(WORKBENCH_DIR)) {
    if (name !== id && !name.startsWith(`${id}-part-`)) continue;
    const target = path.join(WORKBENCH_DIR, name);
    assert.equal(path.dirname(await fs.realpath(target)), await fs.realpath(WORKBENCH_DIR));
    await fs.rm(target, { recursive: true, force: true });
  }
  for (const root of roots.splice(0)) {
    assert.equal(path.dirname(await fs.realpath(root)), await fs.realpath(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('sku-detail-'));
    await fs.rm(root, { recursive: true, force: true });
  }
});
async function fixture({ count = 1, execution = {} } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sku-detail-')); roots.push(root);
  const file = path.join(root, 'fixture.png'); await sharp({ create: { width: 48, height: 32, channels: 3, background: '#507090' } }).png().toFile(file);
  const result = await createSkuPack(Array.from({ length: count }, () => ({ path: file, originalname: 'fixture.png' })), Array.from({ length: count }, (_, index) => `root/SKU-${index}/main.png`), { generateSquare: false, preserveOriginals: false, format: 'png' }, execution);
  jobs.push(result.id); return { result, directory: path.join(WORKBENCH_DIR, result.id) };
}

test('corrupt SKU manifests remain viewable through a read-only archive snapshot and a valid full-manifest download', async () => {
  const { result, directory } = await fixture(), main = path.join(directory, 'manifest.json');
  await fs.writeFile(main, '{broken main');
  const detail = (await request(app).get(`/api/workbench/jobs/${result.id}`).expect(200)).body;
  assert.equal(detail.manifestRead.source, 'archive'); assert.equal(detail.manifestRead.readOnly, true); assert.equal(detail.summary.outputCount, 1);
  assert.match(detail.manifestRead.sourceHash, /^[a-f0-9]{64}$/);
  const download = await request(app).get(`/api/workbench/sku-packs/${result.id}/manifest`).expect(200);
  assert.equal(JSON.parse(download.text).id, result.id); assert.match(download.headers['content-disposition'], /attachment/);
  assert.equal(await fs.readFile(main, 'utf8'), '{broken main');
});

async function corruptFixture({ backupOnly = false, missing = false } = {}) {
  const value = await fixture(), main = path.join(value.directory, 'manifest.json'), original = await fs.readFile(main);
  if (backupOnly) { await fs.copyFile(main, `${main}.backup`); await fs.unlink(path.join(value.directory, `${value.result.id}.zip`)); }
  if (missing) await fs.unlink(main); else await fs.writeFile(main, '{damaged original');
  return { ...value, main, original };
}

test('missing main manifests can use a backup without creating a new primary or changing any checkpoint', async () => {
  const { result, directory, main, original } = await corruptFixture({ backupOnly: true, missing: true });
  const before = await fs.readdir(directory);
  const detail = await workbenchJobDetail(result.id);
  assert.equal(detail.manifestRead.source, 'backup'); assert.equal(detail.manifestRead.reason, 'missing');
  const preview = await previewSkuManifestRepair(result.id); assert.equal(preview.canRepair, true); assert.equal(preview.imageCount, 0); assert.equal(preview.remote, false);
  const downloaded = await request(app).get(detail.manifestUrl).expect(200);
  assert.equal(downloaded.text, original.toString()); assert.equal(downloaded.headers['cache-control'], 'no-store');
  assert.deepEqual(await fs.readdir(directory), before); await assert.rejects(fs.stat(main), { code: 'ENOENT' });
});

test('approved repair preserves damaged bytes and all image/ZIP bytes, and a lost reply is replayed without another write', async () => {
  const { result, directory, main } = await corruptFixture();
  const zip = path.join(directory, `${result.id}.zip`), zipBytes = await fs.readFile(zip), preview = await previewSkuManifestRepair(result.id);
  const item = result.skuResults[0].items[0], image = path.join(directory, 'package', item.outputFile), imageBytes = await fs.readFile(image), modified = (await fs.stat(image)).mtimeMs;
  const input = { confirm: true, previewHash: preview.previewHash, sourceHash: preview.sourceHash };
  const repaired = (await request(app).post(`/api/workbench/sku-packs/${result.id}/repair-manifest`).send(input).expect(200)).body;
  assert.equal(repaired.repaired, true); assert.equal(repaired.imagesProcessed, 0); assert.match(repaired.preservedDamaged, /^manifest\.json\.damaged-/);
  assert.equal(await fs.readFile(path.join(directory, repaired.preservedDamaged), 'utf8'), '{damaged original');
  assert.equal(JSON.parse(await fs.readFile(main)).status, 'completed'); assert.deepEqual(await fs.readFile(zip), zipBytes); assert.deepEqual(await fs.readFile(image), imageBytes); assert.equal((await fs.stat(image)).mtimeMs, modified);
  assert.equal((await workbenchJobDetail(result.id)).manifestRead, undefined);
  const repairedTime = (await fs.stat(main)).mtimeMs, names = await fs.readdir(directory);
  const replay = await repairSkuManifest(result.id, input); assert.equal(replay.alreadyCurrent, true); assert.equal(replay.repaired, false);
  assert.equal((await fs.stat(main)).mtimeMs, repairedTime); assert.deepEqual(await fs.readdir(directory), names);
  assert.equal(platformDb().prepare("SELECT COUNT(*) AS count FROM audit_events WHERE target=? AND action='sku-manifest-repair-complete'").get(result.id).count, 1);
});

test('repair refuses loose confirmations and stale previews before replacing the original', async () => {
  const { result, main } = await corruptFixture(), preview = await previewSkuManifestRepair(result.id);
  for (const confirm of [undefined, false, 'true', 1]) await assert.rejects(repairSkuManifest(result.id, { confirm, previewHash: preview.previewHash, sourceHash: preview.sourceHash }), error => error.statusCode === 400);
  await fs.writeFile(main, '{new damage');
  await assert.rejects(repairSkuManifest(result.id, { confirm: true, previewHash: preview.previewHash, sourceHash: preview.sourceHash }), error => error.code === 'SKU_REPAIR_CHANGED');
  assert.equal(await fs.readFile(main, 'utf8'), '{new damage');
});

test('under-lock recheck rejects recovery-source changes after preparing the replacement', async () => {
  const { result, directory, main } = await corruptFixture({ backupOnly: true }), preview = await previewSkuManifestRepair(result.id);
  await assert.rejects(repairSkuManifest(result.id, { confirm: true, previewHash: preview.previewHash, sourceHash: preview.sourceHash }, { beforeCommit: async () => { const backup = JSON.parse(await fs.readFile(`${main}.backup`)); backup.name = 'changed after approval'; await fs.writeFile(`${main}.backup`, JSON.stringify(backup)); } }), error => error.code === 'SKU_REPAIR_CHANGED');
  assert.equal(await fs.readFile(main, 'utf8'), '{damaged original'); assert.equal((await fs.readdir(directory)).some(name => name.includes('.repair-') || name.includes('.damaged-')), false);
});

test('repair is denied while another live process owns the SKU lock', async () => {
  const { result, directory, main } = await corruptFixture(), preview = await previewSkuManifestRepair(result.id);
  const lock = path.join(directory, 'run.lock'); await fs.writeFile(lock, JSON.stringify({ pid: process.pid, token: 'other-owned-run' }));
  try { await assert.rejects(repairSkuManifest(result.id, { confirm: true, previewHash: preview.previewHash, sourceHash: preview.sourceHash }), /正在执行/); assert.equal(await fs.readFile(main, 'utf8'), '{damaged original'); }
  finally { await fs.unlink(lock); }
});

test('missing-primary repair does not manufacture a damaged copy or regenerate completed images', async () => {
  const { result, directory, main } = await corruptFixture({ missing: true }), preview = await previewSkuManifestRepair(result.id);
  const repaired = await repairSkuManifest(result.id, { confirm: true, previewHash: preview.previewHash, sourceHash: preview.sourceHash });
  assert.equal(repaired.preservedDamaged, null); assert.equal(repaired.imagesProcessed, 0); assert.equal(JSON.parse(await fs.readFile(main)).id, result.id); assert.equal((await fs.readdir(directory)).some(name => name.includes('.damaged-')), false);
});

test('a corrupt latest ZIP stops detail, download and repair preview instead of rolling back completed work', async () => {
  const { result, directory } = await corruptFixture();
  await fs.writeFile(path.join(directory, `${result.id}-archive-1-broken.zip`), 'damaged newest archive');
  await request(app).get(`/api/workbench/jobs/${result.id}`).expect(409);
  await request(app).get(`/api/workbench/sku-packs/${result.id}/manifest`).expect(409);
  await assert.rejects(previewSkuManifestRepair(result.id), error => error.code === 'SKU_ARCHIVE_INVALID');
});

test('directory aliases and non-file manifest entries cannot redirect any recovery read outside the task', async () => {
  const { result, directory, main } = await corruptFixture(), outside = await fs.mkdtemp(path.join(os.tmpdir(), 'sku-detail-')); roots.push(outside);
  const alias = path.join(WORKBENCH_DIR, `${result.id}-alias`);
  await fs.symlink(outside, alias, process.platform === 'win32' ? 'junction' : 'dir');
  try { await assert.rejects(workbenchJobDetail(`${result.id}-alias`), error => error.statusCode === 403); }
  finally { await fs.unlink(alias); }
  await fs.unlink(main); await fs.mkdir(main);
  await assert.rejects(workbenchJobDetail(result.id), error => error.statusCode === 403);
  await fs.rmdir(main); await fs.writeFile(main, '{bad');
  await fs.unlink(`${main}.backup`); await fs.symlink(outside, `${main}.backup`, process.platform === 'win32' ? 'junction' : 'dir');
  try { await assert.rejects(workbenchJobDetail(result.id), error => error.statusCode === 403); }
  finally { await fs.unlink(`${main}.backup`); }
  assert.ok((await fs.readdir(directory)).includes(`${result.id}.zip`));
});

test('identity mismatches, oversized manifests and executable download addresses are refused without exposing their contents', async () => {
  const { result, directory, main } = await fixture(); const file = path.join(directory, 'manifest.json');
  const original = JSON.parse(await fs.readFile(file));
  await fs.writeFile(file, JSON.stringify({ ...original, id: 'sku-pack-foreign', name: 'FOREIGN-PRIVATE-NAME' }));
  const response = await request(app).get(`/api/workbench/jobs/${result.id}`).expect(409); assert.ok(!JSON.stringify(response.body).includes('FOREIGN-PRIVATE-NAME'));
  await fs.writeFile(file, JSON.stringify({ ...original, downloadUrl: 'javascript:alert(1)' })); await request(app).get(`/api/workbench/jobs/${result.id}`).expect(403);
  const handle = await fs.open(file, 'w'); await handle.truncate(128 * 1024 * 1024 + 1); await handle.close();
  await request(app).get(`/api/workbench/jobs/${result.id}`).expect(409);
});

test('foreign members cannot inspect snapshots, downloads or repair previews, and read-only owners cannot repair', async () => {
  const { result, directory } = await corruptFixture(), owner = { id: `owner-${result.id}`, role: 'operator' };
  claimResource('job', result.id, owner.id);
  const before = await fs.readFile(path.join(directory, 'manifest.json'));
  await withActor({ id: `foreign-${result.id}`, role: 'operator' }, async () => { await assert.rejects(workbenchJobDetail(result.id), error => error.statusCode === 404); await assert.rejects(previewSkuManifestRepair(result.id), error => error.statusCode === 404); });
  const preview = await withActor(owner, () => previewSkuManifestRepair(result.id));
  await withActor({ ...owner, role: 'viewer' }, () => assert.rejects(repairSkuManifest(result.id, { confirm: true, previewHash: preview.previewHash, sourceHash: preview.sourceHash }), error => error.statusCode === 403));
  assert.deepEqual(await fs.readFile(path.join(directory, 'manifest.json')), before);
});

test('archive manifest integrity errors do not bypass CRC checks or silently use a backup', async () => {
  const { result, directory } = await corruptFixture(), file = path.join(directory, `${result.id}.zip`);
  const original = await fs.readFile(file), archive = new AdmZip(original), entry = archive.getEntry('manifest.json');
  entry.header.crc = (entry.header.crc ^ 1) >>> 0; await fs.writeFile(file, archive.toBuffer());
  await assert.rejects(workbenchJobDetail(result.id), error => error.code === 'SKU_ARCHIVE_INVALID');
  let central = original.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  while (central >= 0 && original.subarray(central + 46, central + 46 + original.readUInt16LE(central + 28)).toString() !== 'manifest.json') central = original.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]), central + 4);
  assert.ok(central >= 0); original.writeUInt32LE((original.readUInt32LE(central + 16) ^ 1) >>> 0, central + 16);
  await fs.writeFile(file, original);
  await assert.rejects(workbenchJobDetail(result.id), error => error.code === 'SKU_ARCHIVE_INVALID');
});

test('a newer interrupted backup remains authoritative in detail, repair and zero-image finalization', async () => {
  const { result, directory } = await fixture({ count: 2, execution: { afterSku() { pauseRunningSkuPacks(); } } });
  await assert.rejects(resumeSkuPack(result.id, { confirm: true }, { afterSku() { throw new Error('interrupted after final SKU'); } }), /interrupted after final SKU/);
  const main = path.join(directory, 'manifest.json'); await fs.writeFile(main, '{damaged');
  const detail = await workbenchJobDetail(result.id); assert.equal(detail.manifestRead.source, 'backup'); assert.equal(detail.summary.outputCount, 2);
  await assert.rejects(controlSkuPack(result.id, 'cancel'), error => error.statusCode === 409);
  const preview = await previewSkuManifestRepair(result.id); await repairSkuManifest(result.id, { confirm: true, previewHash: preview.previewHash, sourceHash: preview.sourceHash });
  const processing = await previewSkuPackResume(result.id); assert.equal(processing.onlyFinalize, true); assert.equal(processing.imageCount, 0);
  const finished = await resumeSkuPack(result.id, { confirm: true, previewHash: processing.previewHash }); assert.equal(finished.status, 'completed'); assert.equal(finished.summary.outputCount, 2);
});
