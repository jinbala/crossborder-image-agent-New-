import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import sharp from 'sharp';
import AdmZip from 'adm-zip';
import request from 'supertest';
import app from '../src/app.js';
import { paths } from '../src/services/dbPaths.js';
import { createImagePack, normalizeImagePackOptions, transformImage, workbenchJobDetail } from '../src/services/workbenchService.js';
import { createDurableImagePack, previewImagePackResume, resumeImagePack, controlImagePack } from '../src/services/imagePackRecoveryService.js';
import { withActor } from '../src/services/ownershipService.js';
import { collectionCreationEpoch, setMeta } from '../src/services/platformStore.js';
import { beginWorkspaceRestore } from '../src/services/workspaceLifecycle.js';

async function files() {
  await fs.mkdir(paths.uploadDir, { recursive: true });
  const dir = await fs.mkdtemp(path.join(paths.uploadDir, 'pack-test-'));
  await fs.writeFile(path.join(dir, 'good.png'), await sharp({ create: { width: 50, height: 30, channels: 3, background: '#456789' } }).png().toBuffer());
  await fs.writeFile(path.join(dir, 'bad.png'), 'not an image');
  return ['good.png', 'bad.png', 'good.png'].map(name => ({ path: path.join(dir, name), originalname: name, size: 100 }));
}
const directory = id => path.join(paths.outputDir, 'workbench', id);
const payload = p => ({ confirm: true, retryFailed: p.retryFailed, previewHash: p.previewHash });
async function paused() {
  const input = await files();
  const state = await createDurableImagePack(input, normalizeImagePackOptions({ format: 'png' }), transformImage, { afterCheckpoint: async (_state, item) => { if (item.index === 1) throw new Error('fixture interrupted'); } });
  const staging = path.dirname(input[0].path); assert.equal(path.dirname(staging), paths.uploadDir); assert.ok(path.basename(staging).startsWith('pack-test-'));
  await fs.rm(staging, { recursive: true }); return state;
}
test('one bad image does not abort the batch; only completed files enter a consistent ZIP', async () => {
  const state = await createImagePack(await files(), { format: 'png' });
  assert.equal(state.status, 'partial'); assert.equal(state.summary.successCount, 2); assert.equal(state.summary.failedCount, 1); assert.equal(state.summary.pendingCount, 0);
  const zip = new AdmZip(await fs.readFile(path.join(directory(state.id), `${state.id}.zip`)));
  const manifest = JSON.parse(zip.readAsText('manifest.json'));
  assert.equal(manifest.status, 'partial'); assert.deepEqual(manifest.summary, state.summary); assert.equal(zip.getEntries().filter(x => x.entryName.startsWith('images/')).length, 2);
  assert.equal(zip.getEntries().some(x => x.entryName.startsWith('inputs/')), false);
  assert.equal((await workbenchJobDetail(state.id)).recovery.active, false);
  assert.equal(manifest.updatedAt, state.updatedAt); assert.equal(manifest.checkpointRevision, state.checkpointRevision);
  await fs.writeFile(path.join(directory(state.id), 'manifest.json'), '{damaged');
  assert.equal((await workbenchJobDetail(state.id)).manifestRead.source, 'archive');
});
test('checkpoint resumes only pending images after staging files disappear; completed outputs never change', async () => {
  const state = await paused(), first = path.join(directory(state.id), 'images', state.items[0].fileName), bytes = await fs.readFile(first), mtime = (await fs.stat(first)).mtimeMs;
  // The producer cached each multipart input before returning; the caller's staging directory is disposable.
  const inputs = await fs.readdir(path.join(directory(state.id), 'inputs')); assert.equal(inputs.length, 3);
  const p = await previewImagePackResume(state.id); assert.equal(p.imageCount, 2); assert.equal(p.remote, false); assert.equal(p.canResume, true);
  let calls = 0;
  const resumed = await resumeImagePack(state.id, payload(p), { transform: async (...args) => { calls++; return transformImage(...args); } });
  assert.equal(calls, 2); assert.equal(resumed.status, 'partial'); assert.deepEqual(await fs.readFile(first), bytes); assert.equal((await fs.stat(first)).mtimeMs, mtime); assert.equal(resumed.items[0].attempt, 1);
  const retry = await previewImagePackResume(state.id, { retryFailed: true }); assert.equal(retry.imageCount, 1);
  const oldZip = await fs.readFile(path.join(directory(state.id), `${state.id}.zip`));
  const again = await resumeImagePack(state.id, payload(retry)); assert.equal(again.items[0].attempt, 1); assert.equal(again.items[1].attempt, 2); assert.equal(again.items[2].attempt, 1);
  assert.notEqual(again.downloadUrl, resumed.downloadUrl); assert.deepEqual(await fs.readFile(path.join(directory(state.id), `${state.id}.zip`)), oldZip);
});

test('Chinese and spaced image prefixes remain valid across checkpoint resume and publication', async () => {
  const state = await createDurableImagePack(await files(), normalizeImagePackOptions({ prefix: '商品 图片', format: 'png' }), transformImage, { afterCheckpoint: (_s, item) => { if (item.index === 1) throw new Error('stop'); } });
  const p = await previewImagePackResume(state.id), result = await resumeImagePack(state.id, payload(p));
  assert.equal(result.status, 'partial'); assert.equal(result.summary.successCount, 2);
  const zip = new AdmZip(await fs.readFile(path.join(directory(state.id), path.basename(result.downloadUrl))));
  assert.ok(zip.getEntry(`images/${state.items[0].fileName}`)); assert.match(state.items[0].fileName, /商品/);
});

test('active operations exclude duplicate continuation and workspace restore, and global pause settles checkpoints', async () => {
  const { pauseRunningImagePacks } = await import('../src/services/imagePackRecoveryService.js');
  let release, started; const held = new Promise(resolve => { release = resolve; }), ready = new Promise(resolve => { started = resolve; });
  const running = createDurableImagePack(await files(), normalizeImagePackOptions(), transformImage, { afterCheckpoint: async (state, item) => { if (item.index === 1) { started(state); await held; } } });
  const state = await ready;
  try {
    const p = await previewImagePackResume(state.id); assert.equal(p.busy, true); assert.equal(p.canResume, false);
    await assert.rejects(resumeImagePack(state.id, payload(p)), { code: 'IMAGE_PACK_CHANGED' });
    assert.throws(() => beginWorkspaceRestore(), { code: 'WORKSPACE_BUSY' });
    assert.equal(pauseRunningImagePacks(), 1);
  } finally { release(); }
  const result = await running; assert.equal(result.status, 'paused'); assert.equal(result.summary.successCount, 1); assert.equal(result.summary.pendingCount, 2);
});

test('publication rechecks completed output integrity and never publishes a changed image', async () => {
  const result = await createDurableImagePack((await files()).slice(0, 1), normalizeImagePackOptions(), transformImage, { beforePublish: async state => { await fs.writeFile(path.join(directory(state.id), 'images', state.items[0].fileName), 'tampered'); } });
  assert.equal(result.status, 'paused'); assert.equal(result.error.code, 'IMAGE_PACK_OUTPUT_CHANGED');
  assert.equal((await fs.readdir(directory(result.id))).some(name => name.endsWith('.zip') || name.endsWith('.tmp')), false);
});

test('an all-pending checkpoint cannot redirect image writes through a directory junction', async () => {
  const state = await paused(), dir = directory(state.id), images = path.join(dir, 'images'), held = path.join(dir, 'images-original');
  const target = await fs.mkdtemp(path.join(paths.uploadDir, 'pack-test-junction-'));
  state.items.forEach(item => { item.status = 'pending'; });
  state.summary = { ...state.summary, successCount: 0, outputCount: 0, pendingCount: 3, unprocessedCount: 3 };
  await fs.writeFile(path.join(dir, 'manifest.json'), JSON.stringify(state));
  await fs.rename(images, held); await fs.symlink(target, images, process.platform === 'win32' ? 'junction' : 'dir');
  try {
    await assert.rejects(previewImagePackResume(state.id), { code: 'IMAGE_PACK_PATH' });
    assert.deepEqual(await fs.readdir(target), []);
  } finally { await fs.unlink(images); await fs.rename(held, images); }
});
test('real child process exit leaves an approved recoverable lock and preserves completed output across restart', async () => {
  const input = await files(), moduleUrl = pathToFileURL(path.resolve('src/services/imagePackRecoveryService.js')).href, workbench = pathToFileURL(path.resolve('src/services/workbenchService.js')).href;
  const code = `import {createDurableImagePack} from ${JSON.stringify(moduleUrl)}; import {normalizeImagePackOptions,transformImage} from ${JSON.stringify(workbench)}; await createDurableImagePack(${JSON.stringify(input)},normalizeImagePackOptions({format:'png'}),transformImage,{afterCheckpoint:async(s,i)=>{if(i.index===1){console.log(JSON.stringify({id:s.id}));process.exit(78);}}});`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', code], { env: process.env, windowsHide: true }); let stdout = '', stderr = '';
  child.stdout.on('data', x => { stdout += x; }); child.stderr.on('data', x => { stderr += x; });
  const exit = await new Promise((resolve, reject) => { child.on('error', reject); child.on('exit', resolve); }); assert.equal(exit, 78, stderr);
  const { id } = JSON.parse(stdout.trim().split('\n').at(-1)), dir = directory(id), state = JSON.parse(await fs.readFile(path.join(dir, 'manifest.json'))), first = path.join(dir, 'images', state.items[0].fileName), before = await fs.readFile(first), mtime = (await fs.stat(first)).mtimeMs;
  const p = await previewImagePackResume(id); assert.equal(p.interruptedLock, true); assert.equal(p.canResume, true); assert.equal(p.imageCount, 2);
  const lockBytes = await fs.readFile(path.join(dir, 'manifest-operation.lock'));
  assert.equal((await resumeImagePack(id, payload(p))).status, 'partial');
  assert.deepEqual(await fs.readFile(first), before); assert.equal((await fs.stat(first)).mtimeMs, mtime);
  const retained = (await fs.readdir(dir)).filter(x => x.startsWith('manifest-operation.lock.interrupted-')); assert.equal(retained.length, 1); assert.deepEqual(await fs.readFile(path.join(dir, retained[0])), lockBytes);
});
test('explicit pause/cancel completes the current image and cancellation cannot be weakened to pause', async () => {
  let id;
  const state = await createDurableImagePack(await files(), normalizeImagePackOptions(), transformImage, { afterCheckpoint: async (s, item) => { id = s.id; if (item.index === 1) { await controlImagePack(id, { confirm: true, action: 'cancel' }); await controlImagePack(id, { confirm: true, action: 'pause' }); } } });
  assert.equal(state.status, 'cancelled'); assert.equal(state.summary.successCount, 1); assert.equal(state.summary.pendingCount, 2);
  assert.equal((await previewImagePackResume(id)).canResume, true);
});
test('approval, actor and workspace epoch changes fail closed without touching outputs', async () => {
  const state = await paused(), p = await previewImagePackResume(state.id), before = await fs.readFile(path.join(directory(state.id), 'manifest.json'));
  await assert.rejects(resumeImagePack(state.id, { ...payload(p), confirm: 'true' }), { code: 'IMAGE_PACK_CONFIRM' });
  await assert.rejects(withActor({ id: 'other', role: 'operator' }, () => previewImagePackResume(state.id)), { statusCode: 404 });
  await assert.rejects(withActor({ id: 'admin-other', role: 'admin' }, () => resumeImagePack(state.id, payload(p))), { code: 'IMAGE_PACK_CHANGED' });
  const epoch = collectionCreationEpoch(); setMeta('collection-creation-epoch', 'changed-pack-test');
  try { await assert.rejects(resumeImagePack(state.id, payload(p)), { code: 'IMAGE_PACK_CHANGED' }); } finally { setMeta('collection-creation-epoch', epoch); }
  assert.deepEqual(await fs.readFile(path.join(directory(state.id), 'manifest.json')), before);
});
test('changed inputs and completed outputs are rejected without repeating completed processing', async () => {
  const state = await paused(), dir = directory(state.id), input = path.join(dir, state.items[1].inputFile), original = await fs.readFile(input);
  const p = await previewImagePackResume(state.id); await fs.writeFile(input, 'changed');
  await assert.rejects(resumeImagePack(state.id, payload(p)), { code: 'IMAGE_PACK_INPUT_CHANGED' }); await fs.writeFile(input, original);
  await fs.writeFile(path.join(dir, 'images', state.items[0].fileName), 'changed completed');
  await assert.rejects(previewImagePackResume(state.id), { code: 'IMAGE_PACK_OUTPUT_CHANGED' });
});
test('ZIP finalization failure needs zero-image approval and preserves a lost-receipt package', async () => {
  const state = await createDurableImagePack((await files()).slice(0, 1), normalizeImagePackOptions(), transformImage, { beforePublish: () => { throw new Error('archive unavailable'); } });
  assert.equal(state.status, 'paused'); assert.equal(state.finalizePending, true);
  const dir = directory(state.id), oldZip = path.join(dir, `${state.id}.zip`); await fs.writeFile(oldZip, 'lost receipt archive');
  for (const item of state.items) await fs.unlink(path.join(dir, item.inputFile)); await fs.rmdir(path.join(dir, 'inputs'));
  const p = await previewImagePackResume(state.id); assert.equal(p.onlyFinalize, true); assert.equal(p.imageCount, 0);
  const result = await resumeImagePack(state.id, payload(p), { transform: () => assert.fail('completed image must not be repeated') });
  assert.equal(result.status, 'completed'); assert.match(result.downloadUrl, /-r1\.zip$/); assert.equal(await fs.readFile(oldZip, 'utf8'), 'lost receipt archive');
  assert.equal(JSON.parse(new AdmZip(await fs.readFile(path.join(dir, path.basename(result.downloadUrl)))).readAsText('manifest.json')).error, undefined);
});
test('live and unknown locks are never removed and workspace restore prevents continuation', async () => {
  const state = await paused(), file = path.join(directory(state.id), 'manifest-operation.lock');
  for (const record of [JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }), 'unrecognized lock']) {
    await fs.writeFile(file, record); const p = await previewImagePackResume(state.id); assert.equal(p.busy, true); assert.equal(p.canResume, false);
    await assert.rejects(resumeImagePack(state.id, payload(p))); assert.equal(await fs.readFile(file, 'utf8'), record);
  }
  await fs.unlink(file); const p = await previewImagePackResume(state.id), release = beginWorkspaceRestore();
  try { await assert.rejects(resumeImagePack(state.id, payload(p)), { code: 'WORKSPACE_BUSY' }); } finally { release(); }
});
test('read-only fallback must be explicitly repaired before any continuation', async () => {
  const state = await paused(), main = path.join(directory(state.id), 'manifest.json'); await fs.writeFile(main, '{interrupted');
  const p = await previewImagePackResume(state.id); assert.equal(p.readOnly, true); assert.equal(p.canResume, false);
  await assert.rejects(resumeImagePack(state.id, payload(p))); assert.equal(await fs.readFile(main, 'utf8'), '{interrupted');
});
test('HTTP scope APIs reject loose approval and old image packs without recovery inputs', async () => {
  const state = await paused();
  const p = (await request(app).get(`/api/workbench/image-packs/${state.id}/resume-preview`).expect(200)).body;
  await request(app).post(`/api/workbench/image-packs/${state.id}/resume`).send({ ...payload(p), confirm: 'true' }).expect(400);
  const result = (await request(app).post(`/api/workbench/image-packs/${state.id}/resume`).send(payload(p)).expect(200)).body; assert.equal(result.status, 'partial');
  await request(app).post(`/api/workbench/image-packs/${state.id}/control`).send({ confirm: true, action: 'pause' }).expect(409);
  const legacy = JSON.parse(await fs.readFile(path.join(directory(state.id), 'manifest.json'))); delete legacy.recoveryVersion;
  await fs.writeFile(path.join(directory(state.id), 'manifest.json'), JSON.stringify(legacy));
  await request(app).get(`/api/workbench/image-packs/${state.id}/resume-preview`).expect(409);
});
