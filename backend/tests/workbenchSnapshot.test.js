import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import AdmZip from 'adm-zip';
import request from 'supertest';
import app from '../src/app.js';
import { WORKBENCH_DIR, createCollectionPlan, createPricingPreview, workbenchJobDetail } from '../src/services/workbenchService.js';
import { readWorkbenchSnapshot, writeWorkbenchManifest } from '../src/services/workbenchSnapshotService.js';
import { withActor, claimResource } from '../src/services/ownershipService.js';
import { normalizeCollectionOptions, normalizeCollectionRows } from '../src/services/collectionJobService.js';

const jobs = [];
afterEach(async () => {
  for (const id of jobs.splice(0)) {
    const directory = path.join(WORKBENCH_DIR, id);
    assert.equal(path.dirname(directory), WORKBENCH_DIR);
    await fs.rm(directory, { recursive: true, force: true });
  }
});
async function fixture({ prefix = 'pack-', type = 'image-pack', field = 'items', count = 45 } = {}) {
  const id = `${prefix}snapshot-${randomUUID()}`, directory = path.join(WORKBENCH_DIR, id); jobs.push(id);
  await fs.mkdir(directory, { recursive: true });
  const state = { id, type, name: 'literal $& {unknown}', status: 'completed', updatedAt: '2026-10-23T00:00:00Z', summary: { outputCount: count },
    [field]: Array.from({ length: count }, (_, index) => ({ sku: `SKU-${index}`, sourceUrl: 'https://example.com/literal?value=%E5%AE%8C%E6%88%90' })), manifestUrl: `/outputs/workbench/${id}/manifest.json` };
  if (type === 'collection-job') { state.options = normalizeCollectionOptions(); state.items = normalizeCollectionRows(state.items.map(item => ({ ...item, imageUrls: [item.sourceUrl] }))); }
  await writeWorkbenchManifest(state);
  return { state, directory, main: path.join(directory, 'manifest.json'), backup: path.join(directory, prefix === 'collect-job-' ? 'manifest.backup.json' : 'manifest.json.backup') };
}
async function archive(value, state = value.state) {
  const zip = new AdmZip(), bytes = Buffer.from(JSON.stringify(state, null, 1));
  zip.addFile('manifest.json', bytes); zip.addFile('fixture.txt', Buffer.from('unchanged result'));
  const file = path.join(value.directory, `${value.state.id}.zip`); await fs.writeFile(file, zip.toBuffer());
  return { bytes, file };
}

test('generic result archive fallback paginates display but downloads exact full immutable bytes', async () => {
  const value = await fixture(), { state, main } = value, zip = await archive(value);
  await fs.writeFile(main, '{broken primary'); const before = await fs.stat(zip.file), zipBytes = await fs.readFile(zip.file), names = await fs.readdir(value.directory);
  const detail = (await request(app).get(`/api/workbench/jobs/${state.id}?page=2&pageSize=30`).expect(200)).body;
  assert.equal(detail.pagination.total, 45); assert.equal(detail.entries.length, 15); assert.equal(detail.entries[0].sku, 'SKU-30');
  assert.equal(detail.manifestRead.source, 'archive'); assert.equal(detail.manifestRead.canRepair, true); assert.equal(detail.manifestRead.primaryUnchanged, true);
  const download = await request(app).get(detail.manifestUrl).expect(200);
  assert.equal(download.text, zip.bytes.toString()); assert.equal(JSON.parse(download.text).items.length, 45);
  assert.equal(download.headers['cache-control'], 'no-store'); assert.match(download.headers['content-disposition'], /attachment/);
  assert.equal(await fs.readFile(main, 'utf8'), '{broken primary'); assert.deepEqual(await fs.readFile(zip.file), zipBytes); assert.equal((await fs.stat(zip.file)).mtimeMs, before.mtimeMs); assert.deepEqual(await fs.readdir(value.directory), names);
});

for (const [prefix, type, field] of [['pack-', 'image-pack', 'items'], ['collect-', 'collection-plan', 'items'], ['studio-', 'studio', 'items'], ['listing-', 'listing-dry-run', 'rows'], ['pricing-', 'pricing-preview', 'items'], ['template-fill-', 'template-fill', 'changes']]) {
  test(`${type} missing primary uses atomic backup without writing or processing`, async () => {
    const { state, main, backup, directory } = await fixture({ prefix, type, field });
    const original = await fs.readFile(backup); await fs.unlink(main); const names = await fs.readdir(directory);
    const snapshot = await readWorkbenchSnapshot(state.id), detail = await workbenchJobDetail(state.id);
    assert.equal(snapshot.source, 'backup'); assert.equal(snapshot.reason, 'missing'); assert.deepEqual(snapshot.bytes, original);
    assert.equal(snapshot.state[field][0].sourceUrl, state[field][0].sourceUrl); assert.equal(detail.pagination.total, 45);
    assert.equal((await request(app).get(detail.manifestUrl).expect(200)).text, original.toString());
    await assert.rejects(fs.stat(main), { code: 'ENOENT' }); assert.deepEqual(await fs.readdir(directory), names);
  });
}

test('real plan and pricing producers both persist their current complete backup', async () => {
  const plan = await createCollectionPlan({ urls: ['https://example.com/item'] }); jobs.push(plan.id);
  const pricing = await createPricingPreview({ items: [{ sku: 'P1', price: 10 }], rules: [{ type: 'fixed', value: 2 }] }); jobs.push(pricing.id);
  for (const result of [plan, pricing]) {
    const directory = path.join(WORKBENCH_DIR, result.id), main = path.join(directory, 'manifest.json');
    assert.deepEqual(await fs.readFile(main), await fs.readFile(`${main}.backup`));
    await fs.writeFile(main, '{interrupted'); assert.equal((await readWorkbenchSnapshot(result.id)).state.type, result.type);
  }
});

test('collection checkpoints select a newer valid backup, and never rewrite a stale archive', async () => {
  const value = await fixture({ prefix: 'collect-job-', type: 'collection-job' });
  const zip = await archive(value, { ...value.state, checkpointRevision: 1 });
  const backup = { ...value.state, checkpointRevision: 2, status: 'awaiting_transfer', updatedAt: '2026-10-23T01:00:00Z' };
  await fs.writeFile(value.backup, JSON.stringify(backup)); await fs.writeFile(value.main, '{broken');
  assert.equal((await readWorkbenchSnapshot(value.state.id)).state.status, 'awaiting_transfer');
  await fs.writeFile(value.backup, JSON.stringify({ ...backup, checkpointRevision: 0, updatedAt: '2026-10-22T00:00:00Z' }));
  assert.equal((await readWorkbenchSnapshot(value.state.id)).source, 'archive'); assert.equal(new AdmZip(await fs.readFile(zip.file)).readAsText('manifest.json'), zip.bytes.toString());
});

test('identity and schema violations in primary never trigger guessed recovery', async () => {
  const value = await fixture();
  for (const [patch, code] of [[{ id: 'pack-FOREIGN-NAME' }, 'WORKBENCH_STATE_IDENTITY'], [{ type: 'studio' }, 'WORKBENCH_STATE_IDENTITY'], [{ items: {} }, 'WORKBENCH_STATE_SCHEMA'], [{ summary: [] }, 'WORKBENCH_STATE_SCHEMA']]) {
    await fs.writeFile(value.main, JSON.stringify({ ...value.state, ...patch }));
    await assert.rejects(readWorkbenchSnapshot(value.state.id), error => error.code === code && !error.message.includes('FOREIGN-NAME'));
  }
});

test('published archive corruption and foreign backup identity fail closed instead of rolling back', async () => {
  const value = await fixture(), zip = await archive(value); await fs.writeFile(value.main, '{broken');
  await fs.writeFile(zip.file, 'not zip'); await assert.rejects(readWorkbenchSnapshot(value.state.id), error => error.code === 'WORKBENCH_ARCHIVE_INVALID');
  await fs.unlink(zip.file); await fs.writeFile(value.backup, JSON.stringify({ ...value.state, id: 'pack-FOREIGN-NAME' }));
  await assert.rejects(readWorkbenchSnapshot(value.state.id), error => error.code === 'WORKBENCH_STATE_IDENTITY' && !error.message.includes('FOREIGN-NAME'));
});

test('archive manifest CRC corruption is rejected despite an intact backup', async () => {
  const value = await fixture(), zip = await archive(value), bytes = await fs.readFile(zip.file);
  let central = bytes.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  while (central >= 0 && bytes.subarray(central + 46, central + 46 + bytes.readUInt16LE(central + 28)).toString() !== 'manifest.json') central = bytes.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]), central + 4);
  assert.ok(central >= 0);
  bytes.writeUInt32LE((bytes.readUInt32LE(central + 16) ^ 0xff) >>> 0, central + 16);
  await fs.writeFile(zip.file, bytes); await fs.writeFile(value.main, '{broken');
  await assert.rejects(readWorkbenchSnapshot(value.state.id), error => error.code === 'WORKBENCH_ARCHIVE_INVALID');
  assert.equal(await fs.readFile(value.main, 'utf8'), '{broken');
});

test('oversized primary is refused before allocating or falling back', async () => {
  const value = await fixture(), handle = await fs.open(value.main, 'w');
  try { await handle.truncate(128 * 1024 * 1024 + 1); } finally { await handle.close(); }
  await assert.rejects(readWorkbenchSnapshot(value.state.id), error => error.code === 'WORKBENCH_STATE_SIZE');
});

test('invalid links and linked files are refused, leaving business URLs literal', async () => {
  const value = await fixture();
  for (const downloadUrl of ['https://example.com/secret', `/outputs/workbench/${value.state.id}/../other`, `/outputs/workbench/${value.state.id}/%252e%252e/other`]) {
    await fs.writeFile(value.main, JSON.stringify({ ...value.state, downloadUrl }));
    await assert.rejects(readWorkbenchSnapshot(value.state.id), error => error.code === 'WORKBENCH_STATE_PATH');
  }
  await fs.unlink(value.main); await fs.mkdir(value.main);
  await assert.rejects(readWorkbenchSnapshot(value.state.id), error => error.code === 'WORKBENCH_STATE_PATH');
});

test('unreadable or unavailable snapshots give stable errors without creating task state', async () => {
  const value = await fixture(); await fs.writeFile(value.main, '{broken'); await fs.writeFile(value.backup, '{broken too');
  await assert.rejects(readWorkbenchSnapshot(value.state.id), error => error.code === 'WORKBENCH_STATE_UNAVAILABLE');
  await fs.unlink(value.backup); await assert.rejects(readWorkbenchSnapshot(value.state.id), error => error.code === 'WORKBENCH_STATE_UNAVAILABLE');
  await assert.rejects(readWorkbenchSnapshot('../escape'), error => error.statusCode === 400);
  await assert.rejects(readWorkbenchSnapshot('unknown-123'), error => error.code === 'WORKBENCH_STATE_TYPE');
});

test('writer validates both destinations before publication and never replaces a linked/directory backup', async () => {
  const value = await fixture(), original = await fs.readFile(value.main);
  await fs.unlink(value.backup); await fs.mkdir(value.backup);
  await assert.rejects(writeWorkbenchManifest({ ...value.state, name: 'must not publish' }), error => error.code === 'WORKBENCH_STATE_PATH');
  assert.deepEqual(await fs.readFile(value.main), original); assert.equal((await fs.readdir(value.directory)).some(name => name.endsWith('.tmp')), false);
});

test('ownership is checked before loading another member recovery state', async () => {
  const value = await fixture(); claimResource('job', value.state.id, 'snapshot-owner-a'); await fs.writeFile(value.main, '{broken');
  await withActor({ id: 'snapshot-owner-a', role: 'operator' }, async () => assert.equal((await readWorkbenchSnapshot(value.state.id)).source, 'backup'));
  for (const actor of [{ id: 'snapshot-owner-b', role: 'operator' }, { id: 'snapshot-support', role: 'support' }]) await withActor(actor, async () => {
    await assert.rejects(readWorkbenchSnapshot(value.state.id), error => error.statusCode === 404 && !error.message.includes(value.state.name));
  });
});
