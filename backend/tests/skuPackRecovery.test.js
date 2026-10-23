import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import AdmZip from 'adm-zip';
import { spawn } from 'node:child_process';
import { createSkuPack, resumeSkuPack, previewSkuPackResume, controlSkuPack, pauseRunningSkuPacks } from '../src/services/skuPackService.js';
import { withActor } from '../src/services/ownershipService.js';
import { WORKBENCH_DIR } from '../src/services/workbenchService.js';

const roots = [], jobIds = [];
afterEach(async () => {
  for (const id of jobIds.splice(0)) {
    for (const name of await fs.readdir(WORKBENCH_DIR)) if (name === id || name.startsWith(`${id}-part-`)) await fs.rm(path.join(WORKBENCH_DIR, name), { recursive: true, force: true });
  }
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});
async function fixture({ corrupt = false, duplicate = false } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sku-resume-')); roots.push(root);
  const first = await sharp({ create: { width: 400, height: 320, channels: 3, background: '#d83242' } }).png().toBuffer();
  const second = corrupt ? Buffer.from('not an image') : duplicate ? first : await sharp({ create: { width: 400, height: 320, channels: 3, background: '#2255ab' } }).png().toBuffer();
  const files = [];
  for (const [index, bytes] of [first, second].entries()) { const file = path.join(root, `${index}.png`); await fs.writeFile(file, bytes); files.push({ path: file, originalname: `${index}.png`, size: bytes.length }); }
  return { files, paths: duplicate ? ['根目录/SKU-A/main.png', '根目录/SKU-A/copy.png'] : ['根目录/SKU-A/main.png', '根目录/SKU-B/main.png'], options: { generateSquare: false, preserveOriginals: false, format: 'png' } };
}

test('SKU pause and cancel stop only at completed SKU boundaries and preserve recovery inputs', async () => {
  const input = await fixture();
  const paused = await createSkuPack(input.files, input.paths, input.options, { afterSku({ id }) { jobIds.push(id); assert.equal(pauseRunningSkuPacks(), 1); } });
  assert.equal(paused.status, 'paused'); assert.equal(paused.summary.completedSkuCount, 1); assert.equal(paused.summary.unprocessedCount, 1);
  const cancelled = await controlSkuPack(paused.id, 'cancel'); assert.equal(cancelled.status, 'cancelled');
  assert.equal((await resumeSkuPack(paused.id, { confirm: true })).status, 'completed');
});

test('SKU interruption persists each completed SKU and resumes without rewriting its outputs', async () => {
  const input = await fixture(); let id;
  await assert.rejects(createSkuPack(input.files, input.paths, input.options, { afterSku(info) { id = info.id; jobIds.push(id); throw new Error('simulated shutdown'); } }), /进度已保存/);
  const directory = path.join(WORKBENCH_DIR, id), state = JSON.parse(await fs.readFile(path.join(directory, 'manifest.json')));
  assert.equal(state.status, 'paused'); assert.equal(state.summary.completedSkuCount, 1); assert.equal(state.summary.unprocessedCount, 1);
  const output = path.join(directory, 'package', state.skuResults[0].items[0].outputFile), before = await fs.stat(output);
  await assert.rejects(resumeSkuPack(id), /请确认恢复/);
  await fs.rm(input.files[0].path); await fs.rm(input.files[1].path); // Recovery uses its own cache, not vanished browser uploads.
  await fs.writeFile(path.join(directory, 'run.lock'), JSON.stringify({ pid: 2147483647 }));
  const resumed = await resumeSkuPack(id, { confirm: true });
  assert.equal(resumed.status, 'completed'); assert.equal(resumed.summary.completedSkuCount, 2); assert.equal(resumed.summary.unprocessedCount, 0);
  assert.equal((await fs.stat(output)).mtimeMs, before.mtimeMs);
  assert.deepEqual((await resumeSkuPack(id, { confirm: true })).summary, resumed.summary);
  await assert.rejects(fs.stat(path.join(directory, 'inputs')), { code: 'ENOENT' });
  const zip = new AdmZip(path.join(directory, path.basename(resumed.downloadUrl)));
  assert.deepEqual(JSON.parse(zip.getEntry('manifest.json').getData()).summary, resumed.summary);
  await fs.writeFile(path.join(directory, 'manifest.json'), '{broken');
  assert.equal((await resumeSkuPack(id, { confirm: true })).status, 'completed'); // Final archive is also a recovery point.
});

test('SKU recovery refuses a live owner and retries only failed SKUs', async () => {
  const input = await fixture({ corrupt: true });
  const result = await createSkuPack(input.files, input.paths, input.options); jobIds.push(result.id);
  assert.equal(result.status, 'completed_with_errors'); assert.equal(result.summary.failedCount, 1);
  const directory = path.join(WORKBENCH_DIR, result.id), output = path.join(directory, 'package', result.skuResults[0].items[0].outputFile), before = await fs.stat(output);
  await fs.copyFile(input.files[0].path, path.join(directory, 'inputs', '1.bin'));
  await fs.writeFile(path.join(directory, 'run.lock'), JSON.stringify({ pid: process.pid, token: 'other-run' }));
  await assert.rejects(resumeSkuPack(result.id, { confirm: true, retryFailed: true }), /正在执行/);
  await fs.rm(path.join(directory, 'run.lock'));
  const retried = await resumeSkuPack(result.id, { confirm: true, retryFailed: true });
  assert.equal(retried.status, 'completed'); assert.equal(retried.summary.failedCount, 0); assert.equal(retried.summary.outputCount, 2);
  assert.equal((await fs.stat(output)).mtimeMs, before.mtimeMs);
});

test('SKU duplicate records distinguish exact hashes and allow a forced keep rerun', async () => {
  const input = await fixture({ duplicate: true });
  const skipped = await createSkuPack(input.files, input.paths, { ...input.options, deduplicateImages: true }); jobIds.push(skipped.id);
  const record = skipped.skuResults[0].items.find((item) => item.status === 'skipped');
  assert.equal(record.deduplicationMethod, 'exact-byte-hash'); assert.match(record.sha256, /^[a-f0-9]{64}$/);
  const kept = await createSkuPack(input.files, input.paths, { ...input.options, deduplicateImages: true, keepDuplicates: [record.sourceRelativePath] }); jobIds.push(kept.id);
  assert.equal(kept.summary.duplicateSkippedCount, 0); assert.equal(kept.summary.outputCount, 2);
});

async function pausedFixture(owner = null) {
  const input = await fixture();
  const run = () => createSkuPack(input.files, input.paths, input.options, { afterSku() { pauseRunningSkuPacks(); } });
  const result = owner ? await withActor(owner, run) : await run(); jobIds.push(result.id);
  return { input, result, directory: path.join(WORKBENCH_DIR, result.id) };
}

test('resume preflight is read-only, excludes completed SKUs and seals actual input hashes', async () => {
  const { result, directory } = await pausedFixture(), file = path.join(directory, 'manifest.json'), before = await fs.readFile(file);
  const preview = await previewSkuPackResume(result.id);
  assert.equal(preview.canResume, true); assert.equal(preview.imageCount, 1); assert.equal(preview.skuCount, 1); assert.deepEqual(preview.skus, ['SKU-B']);
  assert.equal(preview.remote, false); assert.equal(preview.options.confirmPaidMatting, false); assert.ok(/^[a-f0-9]{64}$/.test(preview.inputs[0].sha256)); assert.ok(!JSON.stringify(preview).includes(directory));
  assert.deepEqual(await fs.readFile(file), before);
  const resumed = await resumeSkuPack(result.id, { confirm: true, previewHash: preview.previewHash });
  assert.equal(resumed.status, 'completed'); assert.equal(resumed.resumeApproval.imageCount, 1); assert.equal(resumed.resumeApproval.previewHash, preview.previewHash);
  assert.equal(JSON.parse(new AdmZip(path.join(directory, path.basename(resumed.downloadUrl))).getEntry('manifest.json').getData()).resumeApproval.imageCount, 1);
});

test('changed recovery bytes invalidate approval before any state or completed output changes', async () => {
  const { result, directory, input } = await pausedFixture(), preview = await previewSkuPackResume(result.id);
  const file = path.join(directory, 'manifest.json'), before = await fs.readFile(file);
  const completed = path.join(directory, 'package', result.skuResults[0].items[0].outputFile), modified = (await fs.stat(completed)).mtimeMs;
  await fs.copyFile(input.files[0].path, path.join(directory, 'inputs', preview.inputs[0].key));
  await assert.rejects(resumeSkuPack(result.id, { confirm: true, previewHash: preview.previewHash }), error => error.code === 'SKU_RESUME_CHANGED');
  assert.deepEqual(await fs.readFile(file), before); assert.equal((await fs.stat(completed)).mtimeMs, modified);
});

test('changed rules invalidate a preview and retry scope includes the complete failed SKU only', async () => {
  const input = await fixture({ corrupt: true }), result = await createSkuPack(input.files, input.paths, input.options); jobIds.push(result.id);
  const preview = await previewSkuPackResume(result.id, { retryFailed: true }); assert.equal(preview.imageCount, 1); assert.deepEqual(preview.skus, ['SKU-B']);
  assert.equal((await previewSkuPackResume(result.id)).canResume, false);
  const planFile = path.join(WORKBENCH_DIR, result.id, 'resume-source.json'), plan = JSON.parse(await fs.readFile(planFile)); plan.options.quality = 77; await fs.writeFile(planFile, JSON.stringify(plan));
  await assert.rejects(resumeSkuPack(result.id, { confirm: true, retryFailed: true, previewHash: preview.previewHash }), error => error.code === 'SKU_RESUME_CHANGED');
});

test('foreign actors cannot inspect recovery previews or recover another member pack', async () => {
  const owner = { id: 'sku-resume-preview-owner', role: 'operator' }, foreign = { id: 'sku-resume-preview-foreign', role: 'operator' };
  const { result } = await pausedFixture(owner);
  await withActor(foreign, async () => {
    await assert.rejects(previewSkuPackResume(result.id), error => error.statusCode === 404);
    await assert.rejects(resumeSkuPack(result.id, { confirm: true }), error => error.statusCode === 404);
  });
});

test('remote recovery requires strict fresh approval and rejects changed provider destinations without a call', async () => {
  const { result, directory } = await pausedFixture(), planFile = path.join(directory, 'resume-source.json'), plan = JSON.parse(await fs.readFile(planFile));
  plan.options = { ...plan.options, matteImages: true, mattingProvider: 'external', confirmPaidMatting: true }; await fs.writeFile(planFile, JSON.stringify(plan));
  const keys = ['MATTING_EXTERNAL_API_KEY', 'MATTING_EXTERNAL_API_URL'], saved = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  process.env.MATTING_EXTERNAL_API_KEY = 'fixture-nonsecret'; process.env.MATTING_EXTERNAL_API_URL = 'https://resume-one.invalid/v1';
  try {
    const preview = await previewSkuPackResume(result.id); assert.equal(preview.remote, true); assert.equal(preview.destination.origin, 'https://resume-one.invalid'); assert.equal(preview.options.confirmPaidMatting, false);
    for (const confirmPaidMatting of [undefined, false, 'true', 1]) await assert.rejects(resumeSkuPack(result.id, { confirm: true, previewHash: preview.previewHash, confirmPaidMatting }), /明确费用确认/);
    await assert.rejects(resumeSkuPack(result.id, { confirm: true, confirmPaidMatting: true }), error => error.code === 'SKU_RESUME_CHANGED');
    process.env.MATTING_EXTERNAL_API_URL = 'https://resume-two.invalid/v1';
    await assert.rejects(resumeSkuPack(result.id, { confirm: true, previewHash: preview.previewHash, confirmPaidMatting: true }), error => error.code === 'SKU_RESUME_CHANGED');
    assert.equal(JSON.parse(await fs.readFile(path.join(directory, 'manifest.json'))).status, 'paused');
  } finally { for (const key of keys) if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key]; }
});

test('finished packs return an empty recovery preview without requiring their purged input cache', async () => {
  const input = await fixture(), result = await createSkuPack(input.files, input.paths, input.options); jobIds.push(result.id);
  const preview = await previewSkuPackResume(result.id); assert.equal(preview.complete, true); assert.equal(preview.canResume, false); assert.equal(preview.imageCount, 0);
  assert.equal((await resumeSkuPack(result.id, { confirm: true })).id, result.id);
});

test('completed input caches need not survive to resume pending SKUs, and their outputs remain untouched', async () => {
  const { result, directory } = await pausedFixture();
  await fs.rm(path.join(directory, 'inputs', '0.bin'));
  const completed = path.join(directory, 'package', result.skuResults[0].items[0].outputFile), modified = (await fs.stat(completed)).mtimeMs;
  const preview = await previewSkuPackResume(result.id); assert.equal(preview.imageCount, 1);
  assert.equal((await resumeSkuPack(result.id, { confirm: true, previewHash: preview.previewHash })).status, 'completed');
  assert.equal((await fs.stat(completed)).mtimeMs, modified);
});

test('nested image folders keep their SKU identity during creation and approved failed-SKU recovery', async () => {
  const input = await fixture({ corrupt: true });
  const relative = ['根目录/SKU-A/详情/main.png', '根目录/SKU-A/轮播/front.png'];
  const result = await createSkuPack(input.files, relative, input.options); jobIds.push(result.id);
  assert.equal(result.summary.skuCount, 1); assert.equal(result.skuResults.length, 1); assert.equal(result.skuResults[0].sku, 'SKU-A');
  const directory = path.join(WORKBENCH_DIR, result.id);
  await fs.copyFile(input.files[0].path, path.join(directory, 'inputs', '1.bin'));
  const preview = await previewSkuPackResume(result.id, { retryFailed: true });
  assert.deepEqual(preview.skus, ['SKU-A']); assert.equal(preview.imageCount, 2);
  const resumed = await resumeSkuPack(result.id, { confirm: true, retryFailed: true, previewHash: preview.previewHash });
  assert.equal(resumed.status, 'completed'); assert.equal(resumed.skuResults.length, 1); assert.equal(resumed.skuResults[0].sku, 'SKU-A');
  assert.equal(resumed.summary.inputCount, 2); assert.equal(resumed.summary.outputCount, 2);
});

test('transient ZIP promotion locks retry without redoing completed SKU outputs', async () => {
  const input = await fixture({ corrupt: true }), result = await createSkuPack(input.files, input.paths, input.options); jobIds.push(result.id);
  const directory = path.join(WORKBENCH_DIR, result.id), target = path.join(directory, `${result.id}.zip`), output = path.join(directory, 'package', result.skuResults[0].items[0].outputFile), before = await fs.stat(output);
  await fs.copyFile(input.files[0].path, path.join(directory, 'inputs', '1.bin'));
  const rename = fs.rename; let attempts = 0;
  fs.rename = async (source, destination) => { if (path.dirname(destination) === directory && destination.endsWith('.zip') && attempts++ < 3) throw Object.assign(new Error('simulated Windows ZIP lock'), { code: 'EPERM' }); return rename(source, destination); };
  try { const resumed = await resumeSkuPack(result.id, { confirm: true, retryFailed: true }); assert.equal(resumed.status, 'completed'); assert.equal(attempts, 4); assert.equal((await fs.stat(output)).mtimeMs, before.mtimeMs); assert.equal(JSON.parse(new AdmZip(path.join(directory, path.basename(resumed.downloadUrl))).getEntry('manifest.json').getData()).summary.outputCount, 2); assert.equal(JSON.parse(new AdmZip(target).getEntry('manifest.json').getData()).summary.outputCount, 1); }
  finally { fs.rename = rename; }
});

test('Windows readers of an earlier ZIP do not block a new immutable recovery archive', { skip: process.platform !== 'win32' }, async () => {
  const input = await fixture({ corrupt: true }), initial = await createSkuPack(input.files, input.paths, input.options); jobIds.push(initial.id);
  const directory = path.join(WORKBENCH_DIR, initial.id), oldZip = path.join(directory, `${initial.id}.zip`), oldBytes = await fs.readFile(oldZip);
  await fs.copyFile(input.files[0].path, path.join(directory, 'inputs', '1.bin'));
  const command = `$skuZipReader=[IO.File]::Open('${oldZip.replaceAll("'", "''")}',[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read);[Console]::WriteLine('held');[Console]::Out.Flush();[Console]::ReadLine()|Out-Null;$skuZipReader.Dispose()`;
  const holder = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { windowsHide: true }), exited = new Promise(resolve => holder.once('exit', resolve));
  try {
    await new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error('ZIP reader did not start')), 5000); holder.stdout.once('data', () => { clearTimeout(timer); resolve(); }); holder.once('error', reject); });
    const resumed = await resumeSkuPack(initial.id, { confirm: true, retryFailed: true });
    assert.equal(resumed.status, 'completed'); assert.notEqual(resumed.downloadUrl, initial.downloadUrl); assert.deepEqual(await fs.readFile(oldZip), oldBytes); assert.equal(holder.exitCode, null);
    assert.equal(JSON.parse(new AdmZip(path.join(directory, path.basename(resumed.downloadUrl))).getEntry('manifest.json').getData()).summary.outputCount, 2);
    await fs.writeFile(path.join(directory, 'manifest.json'), '{broken');
    assert.equal((await resumeSkuPack(initial.id, { confirm: true })).status, 'completed');
  } finally {
    holder.stdin.end('\n'); let timer;
    const clean = await Promise.race([exited.then(() => true), new Promise(resolve => { timer = setTimeout(() => resolve(false), 5000); })]); clearTimeout(timer);
    if (!clean) { holder.kill(); await exited; }
  }
});

async function failedFinalization() {
  const input = await fixture({ corrupt: true }), result = await createSkuPack(input.files, input.paths, input.options); jobIds.push(result.id);
  const directory = path.join(WORKBENCH_DIR, result.id), target = path.join(directory, `${result.id}.zip`), previous = await fs.readFile(target);
  await fs.copyFile(input.files[0].path, path.join(directory, 'inputs', '1.bin'));
  const rename = fs.rename; let attempts = 0;
  fs.rename = async (source, destination) => { if (path.dirname(destination) === directory && destination.endsWith('.zip')) { attempts++; throw Object.assign(new Error('persistent ZIP lock'), { code: 'EPERM' }); } return rename(source, destination); };
  try { await assert.rejects(resumeSkuPack(result.id, { confirm: true, retryFailed: true }), /persistent ZIP lock/); }
  finally { fs.rename = rename; }
  assert.equal(attempts, 8); assert.deepEqual(await fs.readFile(target), previous);
  const state = JSON.parse(await fs.readFile(path.join(directory, 'manifest.json')));
  assert.equal(state.downloadUrl, result.downloadUrl); // Never advertise the unpublished candidate.
  assert.equal(state.status, 'paused'); assert.equal(state.recovery.finalizePending, true); assert.equal(state.recovery.available, true); assert.equal(state.summary.unprocessedCount, 0); assert.equal(state.summary.failedCount, 0);
  return { id: result.id, directory, target, previous, state };
}

test('failed ZIP publication can finalize without cached inputs, image rewrites or remote approval', async () => {
  const { id, directory, target, state } = await failedFinalization();
  const outputs = await Promise.all(state.skuResults.flatMap(group => group.items).filter(item => item.status === 'success').map(async item => { const file = path.join(directory, 'package', item.outputFile); return { file, stat: await fs.stat(file), bytes: await fs.readFile(file) }; }));
  await fs.rm(path.join(directory, 'inputs'), { recursive: true, force: true });
  const source = JSON.parse(await fs.readFile(path.join(directory, 'resume-source.json'))); source.options.matteImages = true; source.options.mattingProvider = 'external'; await fs.writeFile(path.join(directory, 'resume-source.json'), JSON.stringify(source));
  const preview = await previewSkuPackResume(id); assert.equal(preview.onlyFinalize, true); assert.equal(preview.canResume, true); assert.equal(preview.remote, false); assert.equal(preview.imageCount, 0); assert.equal(preview.skuCount, 0); assert.equal(preview.packageFiles.length, 2);
  await assert.rejects(resumeSkuPack(id, { confirm: true }), error => error.code === 'SKU_RESUME_CHANGED');
  const finished = await resumeSkuPack(id, { confirm: true, previewHash: preview.previewHash });
  assert.equal(finished.status, 'completed'); assert.equal(finished.recovery.available, false); assert.equal(finished.resumeApproval.onlyFinalize, true); assert.equal(finished.resumeApproval.imageCount, 0); assert.equal(finished.options.confirmPaidMatting, false);
  for (const output of outputs) { assert.equal((await fs.stat(output.file)).mtimeMs, output.stat.mtimeMs); assert.deepEqual(await fs.readFile(output.file), output.bytes); }
  assert.equal(JSON.parse(new AdmZip(path.join(directory, path.basename(finished.downloadUrl))).getEntry('manifest.json').getData()).resumeApproval.onlyFinalize, true);
  assert.equal(JSON.parse(new AdmZip(target).getEntry('manifest.json').getData()).summary.outputCount, 1);
});

test('finalization previews reject changed output bytes and reject late changes before ZIP publication', async () => {
  const { id, directory, target, previous, state } = await failedFinalization(), preview = await previewSkuPackResume(id);
  const file = path.join(directory, 'package', state.skuResults[0].items[0].outputFile), bytes = await fs.readFile(file);
  await fs.writeFile(file, 'changed'); await assert.rejects(resumeSkuPack(id, { confirm: true, previewHash: preview.previewHash }), error => error.code === 'SKU_RESUME_CHANGED'); assert.deepEqual(await fs.readFile(target), previous);
  await fs.writeFile(file, bytes); const current = await previewSkuPackResume(id);
  await assert.rejects(resumeSkuPack(id, { confirm: true, previewHash: current.previewHash }, { validateResume: () => fs.writeFile(file, 'changed after lock') }), /打包期间输出图片发生变化/); assert.deepEqual(await fs.readFile(target), previous);
});

test('legacy ZIP-lock checkpoints remain recoverable and finalization rejects output junctions', async () => {
  const { id, directory, state } = await failedFinalization();
  const pending = (await fs.readdir(directory)).find(name => name.endsWith('.zip.tmp'));
  await fs.copyFile(path.join(directory, pending), path.join(directory, `${id}.zip.tmp`));
  state.recovery.available = false; delete state.recovery.finalizePending; delete state.error.stage;
  await fs.writeFile(path.join(directory, 'manifest.json'), JSON.stringify(state));
  assert.equal((await previewSkuPackResume(id)).onlyFinalize, true);
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'sku-output-outside-')); roots.push(outside);
  const link = path.join(directory, 'package', 'outside'); await fs.symlink(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
  try { await assert.rejects(previewSkuPackResume(id), error => error.statusCode === 403); }
  finally { await fs.unlink(link); }
});

test('a corrupt latest archive never falls back to an older result that could redo finished work', async () => {
  const { result, directory } = await pausedFixture(), preview = await previewSkuPackResume(result.id);
  const resumed = await resumeSkuPack(result.id, { confirm: true, previewHash: preview.previewHash });
  await fs.writeFile(path.join(directory, path.basename(resumed.downloadUrl)), 'corrupt newest archive'); await fs.writeFile(path.join(directory, 'manifest.json'), '{broken');
  await assert.rejects(previewSkuPackResume(result.id), error => error.code === 'SKU_ARCHIVE_INVALID');
});

test('lost ZIP publication acknowledgement retains versions and only finalizes on recovery', async () => {
  const input = await fixture({ corrupt: true }), result = await createSkuPack(input.files, input.paths, input.options); jobIds.push(result.id);
  const directory = path.join(WORKBENCH_DIR, result.id), original = await fs.readFile(path.join(directory, `${result.id}.zip`)); await fs.copyFile(input.files[0].path, path.join(directory, 'inputs', '1.bin'));
  const rename = fs.rename; let injected = false;
  fs.rename = async (source, destination) => { await rename(source, destination); if (!injected && path.dirname(destination) === directory && destination.endsWith('.zip')) { injected = true; throw Object.assign(new Error('lost publication acknowledgement'), { code: 'EIO' }); } };
  try { await assert.rejects(resumeSkuPack(result.id, { confirm: true, retryFailed: true }), /lost publication acknowledgement/); }
  finally { fs.rename = rename; }
  const state = JSON.parse(await fs.readFile(path.join(directory, 'manifest.json'))), snapshots = await Promise.all(state.skuResults.flatMap(group => group.items).filter(item => item.status === 'success').map(async item => { const file = path.join(directory, 'package', item.outputFile); return { file, modified: (await fs.stat(file)).mtimeMs }; }));
  const preview = await previewSkuPackResume(result.id); assert.equal(preview.onlyFinalize, true); assert.equal(preview.imageCount, 0);
  const finished = await resumeSkuPack(result.id, { confirm: true, previewHash: preview.previewHash });
  assert.equal(finished.status, 'completed'); assert.equal(finished.archiveGeneration, 2); assert.equal((await fs.readdir(directory)).filter(name => name.endsWith('.zip')).length, 3); assert.deepEqual(await fs.readFile(path.join(directory, `${result.id}.zip`)), original);
  for (const item of snapshots) assert.equal((await fs.stat(item.file)).mtimeMs, item.modified);
});

test('a newer backup checkpoint takes precedence over an older published ZIP after main-manifest damage', async () => {
  const { id, directory, state } = await failedFinalization();
  const snapshots = await Promise.all(state.skuResults.flatMap(group => group.items).filter(item => item.status === 'success').map(async item => { const file = path.join(directory, 'package', item.outputFile); return { file, modified: (await fs.stat(file)).mtimeMs }; }));
  await fs.writeFile(path.join(directory, 'manifest.json'), '{broken');
  const preview = await previewSkuPackResume(id);
  assert.equal(preview.onlyFinalize, true); assert.equal(preview.imageCount, 0);
  const finished = await resumeSkuPack(id, { confirm: true, previewHash: preview.previewHash });
  assert.equal(finished.status, 'completed'); assert.equal(finished.summary.outputCount, 2);
  for (const item of snapshots) assert.equal((await fs.stat(item.file)).mtimeMs, item.modified);
});

test('interruption after the last SKU checkpoint recovers by packaging only, even without an input cache', async () => {
  const input = await fixture(); let id;
  await assert.rejects(createSkuPack(input.files, input.paths, input.options, { afterSku(info) { if (info.completedSkuCount === 2) { id = info.id; jobIds.push(id); throw new Error('interrupted before ZIP preparation'); } } }), /interrupted before ZIP preparation/);
  const directory = path.join(WORKBENCH_DIR, id), state = JSON.parse(await fs.readFile(path.join(directory, 'manifest.json')));
  const files = state.skuResults.flatMap(group => group.items).filter(item => item.status === 'success').map(item => path.join(directory, 'package', item.outputFile));
  const times = await Promise.all(files.map(file => fs.stat(file).then(stat => stat.mtimeMs)));
  await fs.rm(path.join(directory, 'inputs'), { recursive: true, force: true });
  const preview = await previewSkuPackResume(id); assert.equal(preview.canResume, true); assert.equal(preview.onlyFinalize, true); assert.equal(preview.imageCount, 0);
  const finished = await resumeSkuPack(id, { confirm: true, previewHash: preview.previewHash }); assert.equal(finished.status, 'completed');
  assert.deepEqual(await Promise.all(files.map(file => fs.stat(file).then(stat => stat.mtimeMs))), times);
});
