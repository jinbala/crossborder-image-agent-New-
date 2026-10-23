import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import app from '../src/app.js';
import { createCollectionJob, getCollectionJob } from '../src/services/collectionJobService.js';
import { platformDb, platformBackup, restorePlatformBackup, collectionCreationEpoch } from '../src/services/platformStore.js';
import { paths } from '../src/services/db.js';
import { withActor } from '../src/services/ownershipService.js';
import { beginWorkspaceRestore } from '../src/services/workspaceLifecycle.js';

const jobs = new Set(), files = [];
const folder = (id) => path.join(paths.outputDir, 'workbench', id);
function payload(patch = {}) { return { clientRequestId: randomUUID(), creationEpoch: collectionCreationEpoch(), rows: [{ sku: '断点-SKU', title: '商品原文', sales: 15, imageUrls: ['https://images.example/item.png'] }], options: { name: '回传检查', mode: 'temu-deep' }, ...patch }; }
async function create(input, deps) { const result = await createCollectionJob(input, deps); jobs.add(result.id); return result; }
afterEach(async () => {
  for (const id of jobs) {
    assert.match(id, /^collect-job-[A-Za-z0-9_-]+$/);
    await fs.rm(folder(id), { recursive: true, force: true });
    for (const table of ['task_index', 'collection_requests']) platformDb().prepare(`DELETE FROM ${table} WHERE ${table === 'task_index' ? 'id' : 'job_id'}=?`).run(id);
    platformDb().prepare("DELETE FROM resource_assets WHERE kind='job' AND resource_id=?").run(id);
    platformDb().prepare("DELETE FROM resource_owners WHERE kind='job' AND resource_id=?").run(id);
  }
  jobs.clear(); for (const file of files.splice(0)) await fs.rm(file, { force: true });
});

test('same request returns its current manifest without rewriting files; different content conflicts', async () => {
  const input = payload(), first = await create(input);
  const file = path.join(folder(first.id), 'manifest.json'); const current = JSON.parse(await fs.readFile(file, 'utf8'));
  current.status = 'paused'; current.items[0].images = [{ status: 'success', sourceUrl: input.rows[0].imageUrls[0], file: 'retained.png', url: `/outputs/workbench/${first.id}/images/retained.png` }];
  await fs.writeFile(file, JSON.stringify(current)); const bytes = await fs.readFile(file);
  const second = await create(input); assert.equal(second.id, first.id); assert.equal(second.creation.replayed, true); assert.equal(second.status, 'paused'); assert.equal(second.items[0].images.length, 1);
  assert.deepEqual(await fs.readFile(file), bytes);
  await assert.rejects(create({ ...input, rows: [{ ...input.rows[0], title: 'changed' }] }), (error) => error.code === 'COLLECTION_REQUEST_CONFLICT');
  assert.deepEqual(await fs.readFile(file), bytes);
});
test('parallel same-key requests publish only one durable job', async () => {
  const input = payload(), results = await Promise.all(Array.from({ length: 8 }, () => create(input)));
  assert.equal(new Set(results.map((result) => result.id)).size, 1); assert.equal(results.filter((result) => !result.creation.replayed).length, 1);
  assert.equal(platformDb().prepare('SELECT state FROM collection_requests WHERE job_id=?').get(results[0].id).state, 'ready');
  assert.equal(platformDb().prepare('SELECT initial_manifest FROM collection_requests WHERE job_id=?').get(results[0].id).initial_manifest, '');
});
test('actor namespaces are isolated, and ownership transfer never lets a former owner replay it', async () => {
  const input = payload(), alice = { id: 'idempotency-alice', role: 'operator' }, bob = { id: 'idempotency-bob', role: 'operator' };
  const left = await withActor(alice, () => create(input)), right = await withActor(bob, () => create(input)); assert.notEqual(left.id, right.id);
  platformDb().prepare("UPDATE resource_owners SET owner_id=? WHERE kind='job' AND resource_id=?").run(bob.id, left.id);
  await assert.rejects(withActor(alice, () => create(input)), (error) => error.statusCode === 404);
  await assert.rejects(withActor({ id: 'support', role: 'support' }, () => create(payload())), (error) => error.statusCode === 403);
});
test('invalid request IDs or missing workspace epochs fail before a reservation is written', async () => {
  const before = platformDb().prepare('SELECT COUNT(*) AS n FROM collection_requests').get().n;
  for (const key of ['', null, '../escape', 'x'.repeat(129), {}]) await assert.rejects(create(payload({ clientRequestId: key })), (error) => error.statusCode === 400);
  await assert.rejects(create(payload({ creationEpoch: undefined })), (error) => error.code === 'INVALID_CREATION_EPOCH');
  assert.equal(platformDb().prepare('SELECT COUNT(*) AS n FROM collection_requests').get().n, before);
});
test('ready requests with missing files never silently start a replacement job', async () => {
  const input = payload(), first = await create(input);
  await fs.rm(folder(first.id), { recursive: true, force: true });
  await assert.rejects(create(input), (error) => error.code === 'COLLECTION_REQUEST_FILES_MISSING');
  assert.equal(platformDb().prepare('SELECT job_id FROM collection_requests WHERE job_id=?').get(first.id).job_id, first.id);
  await assert.rejects(fs.access(folder(first.id)));
});
test('an abandoned pending reservation cannot erase existing images or corrupt manifests', async () => {
  const input = payload(); let id;
  await assert.rejects(create(input, { afterReservation(row) { id = row.job_id; jobs.add(id); throw new Error('interrupted'); } }), /interrupted/);
  await fs.mkdir(path.join(folder(id), 'images'), { recursive: true }); await fs.writeFile(path.join(folder(id), 'images', 'keep.png'), 'keep');
  await assert.rejects(create(input), (error) => error.code === 'COLLECTION_REQUEST_FILES_MISSING');
  assert.equal(await fs.readFile(path.join(folder(id), 'images', 'keep.png'), 'utf8'), 'keep');
});
test('a corrupt backup or pending payload is never replaced with a fresh initial manifest', async () => {
  const input = payload(); let id;
  await assert.rejects(create(input, { afterReservation(row) { id = row.job_id; jobs.add(id); throw new Error('interrupted'); } }), /interrupted/);
  await fs.mkdir(folder(id), { recursive: true }); const backup = path.join(folder(id), 'manifest.backup.json'); await fs.writeFile(backup, '{corrupt');
  await assert.rejects(create(input), (error) => error.code === 'COLLECTION_REQUEST_FILES_MISSING'); assert.equal(await fs.readFile(backup, 'utf8'), '{corrupt');
  await fs.rm(backup); platformDb().prepare("UPDATE collection_requests SET initial_manifest='broken JSON' WHERE job_id=?").run(id);
  await assert.rejects(create(input), (error) => error.code === 'COLLECTION_REQUEST_CORRUPT');
});
test('a real process exit after reservation recovers the same ID after restart', async () => {
  const input = payload();
  const code = `import {createCollectionJob} from './src/services/collectionJobService.js'; await createCollectionJob(${JSON.stringify(input)}, {afterReservation(row){process.stdout.write(JSON.stringify({id:row.job_id}));process.exit(0)}});`;
  const result = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', code], { cwd: fileURLToPath(new URL('..', import.meta.url)), env: process.env, encoding: 'utf8' }));
  jobs.add(result.id); await assert.rejects(fs.access(folder(result.id)));
  const recovered = await create(input); assert.equal(recovered.id, result.id); assert.equal(recovered.creation.replayed, true);
});
test('a real process exit after filesystem checkpoint preserves the manifest and reclaims the dead lock', async () => {
  const input = payload();
  const code = `import {createCollectionJob} from './src/services/collectionJobService.js'; await createCollectionJob(${JSON.stringify(input)}, {afterCheckpoint(row){process.stdout.write(JSON.stringify({id:row.id}));process.exit(0)}});`;
  const result = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', code], { cwd: fileURLToPath(new URL('..', import.meta.url)), env: process.env, encoding: 'utf8' }));
  jobs.add(result.id); const file = path.join(folder(result.id), 'manifest.json'), bytes = await fs.readFile(file);
  assert.equal((await create(input)).id, result.id); assert.deepEqual(await fs.readFile(file), bytes); await assert.rejects(fs.access(path.join(folder(result.id), 'run.lock')));
});
test('dropped HTTP response after commit replays through the actual route without a second job', async () => {
  let drop = true; const wrapper = express();
  wrapper.use((req, res, next) => { if (drop && req.path === '/api/workbench/collection-jobs/rows') { res.end = () => { drop = false; req.socket.destroy(); }; } next(); }); wrapper.use(app);
  const server = wrapper.listen(0, '127.0.0.1'); await new Promise((resolve) => server.once('listening', resolve));
  const input = payload(), url = `http://127.0.0.1:${server.address().port}/api/workbench/collection-jobs/rows`;
  try {
    await assert.rejects(fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) }));
    const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) });
    const result = await response.json(); jobs.add(result.id); assert.equal(response.status, 200); assert.equal(response.headers.get('x-workbench-creation'), 'replayed'); assert.equal(result.creation.durable, true);
    await request(app).post('/api/workbench/collection-jobs/rows').send({ ...input, options: { minSales: 100 } }).expect(409);
  } finally { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
});
test('workspace backup preserves replay receipts; rollback without a receipt is fail-closed by epoch', async () => {
  const input = payload(), first = await create(input);
  const backup = path.join(paths.rootDir, `idempotency-${randomUUID()}.sqlite`); files.push(backup); await fs.writeFile(backup, platformBackup());
  restorePlatformBackup(backup); assert.equal((await create(input)).id, first.id); assert.notEqual(collectionCreationEpoch(), input.creationEpoch);
  platformDb().prepare('DELETE FROM collection_requests WHERE job_id=?').run(first.id);
  await assert.rejects(create(input), (error) => error.code === 'COLLECTION_WORKSPACE_CHANGED');
  assert.equal((await getCollectionJob(first.id)).id, first.id);
});
test('creation and restore barriers exclude each other and release after failure', async () => {
  const input = payload();
  await assert.rejects(create(input, { afterReservation(row) { jobs.add(row.job_id); assert.throws(() => beginWorkspaceRestore(), (error) => error.code === 'WORKSPACE_BUSY'); throw new Error('cancel fixture'); } }), /cancel fixture/);
  const release = beginWorkspaceRestore(); await assert.rejects(create(payload()), (error) => error.code === 'WORKSPACE_BUSY'); release(); release();
  assert.equal((await create(input)).creation.replayed, true);
});
