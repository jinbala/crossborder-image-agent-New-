import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import AdmZip from 'adm-zip';
import { createSkuPack, resumeSkuPack, controlSkuPack, pauseRunningSkuPacks } from '../src/services/skuPackService.js';
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
  const zip = new AdmZip(path.join(directory, `${id}.zip`));
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
