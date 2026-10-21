import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import express from 'express';
import request from 'supertest';
import app from '../src/app.js';
import { getCollectionDraftContext, stageCollectionDraft, submitCollectionDraft, clearCollectionDraft } from '../src/services/collectionDraftService.js';
import { platformDb, platformBackup, restorePlatformBackup } from '../src/services/platformStore.js';
import { collectionCreationEpoch } from '../src/services/platformStore.js';
import { withActor } from '../src/services/ownershipService.js';
import { paths } from '../src/services/db.js';

const base = '/api/workbench/collection-drafts';
const jobs = new Set(), actors = new Set(), backups = new Set();
const input = (name = '原规则') => ({ rows: [{ sku: '商品原文', imageUrls: ['https://images.example/item.png'], sales: 12 }], options: { name, minSales: 10 } });
const fixtureActor = () => { const actor = { id: `draft-${randomUUID()}`, role: 'operator' }; actors.add(actor.id); return actor; };
const fields = (context) => ({ expectedActorId: context.actorId, generation: context.generation });
async function submit(context, deps) { const result = await submitCollectionDraft(context.draft.id, context.actorId, deps); jobs.add(result.id); return result; }
afterEach(async () => {
  const db = platformDb();
  for (const owner of actors) {
    for (const row of db.prepare('SELECT job_id FROM collection_requests WHERE owner_id=?').all(owner)) jobs.add(row.job_id);
    db.prepare('DELETE FROM collection_drafts WHERE owner_id=?').run(owner);
    db.prepare('DELETE FROM collection_requests WHERE owner_id=?').run(owner);
  }
  for (const id of jobs) {
    assert.match(id, /^collect-job-[A-Za-z0-9_-]+$/);
    await fs.rm(path.join(paths.outputDir, 'workbench', id), { recursive: true, force: true });
    db.prepare('DELETE FROM task_index WHERE id=?').run(id);
    db.prepare("DELETE FROM resource_assets WHERE kind='job' AND resource_id=?").run(id);
    db.prepare("DELETE FROM resource_owners WHERE kind='job' AND resource_id=?").run(id);
  }
  for (const file of backups) await fs.rm(file, { force: true });
  actors.clear(); jobs.clear(); backups.clear();
});

test('staging freezes input, repeated staging reuses it and acknowledgement releases the slot', async () => {
  const actor = fixtureActor();
  await withActor(actor, async () => {
    const context = getCollectionDraftContext(), staged = stageCollectionDraft(input(), fields(context));
    assert.equal(staged.draft.rowCount, 1);
    const repeated = stageCollectionDraft(input('不能覆盖原规则'), fields(context));
    assert.equal(repeated.draft.id, staged.draft.id); assert.equal(repeated.reused, true); assert.equal(repeated.draft.name, '原规则');
    const job = await submit(staged), again = await submit(staged);
    assert.equal(again.id, job.id); assert.equal(again.creation.replayed, true); assert.equal(job.options.name, '原规则');
    assert.equal(getCollectionDraftContext().draft.jobId, job.id);
    assert.throws(() => clearCollectionDraft(staged.draft.id, { expectedActorId: actor.id, jobId: 'wrong' }), (err) => err.statusCode === 409);
    clearCollectionDraft(staged.draft.id, { expectedActorId: actor.id, jobId: job.id });
    assert.equal(getCollectionDraftContext().draft, null);
    assert.throws(() => stageCollectionDraft(input(), fields(context)), (err) => err.code === 'COLLECTION_DRAFT_CONTEXT_CHANGED');
  });
});

test('parallel submits have one task and a delayed acknowledgement cannot clear a newer draft', async () => {
  const actor = fixtureActor();
  await withActor(actor, async () => {
    const staged = stageCollectionDraft(input(), fields(getCollectionDraftContext()));
    const results = await Promise.all(Array.from({ length: 8 }, () => submit(staged)));
    assert.equal(new Set(results.map((job) => job.id)).size, 1);
    clearCollectionDraft(staged.draft.id, { expectedActorId: actor.id, jobId: results[0].id });
    const next = stageCollectionDraft(input('新轮次'), fields(getCollectionDraftContext()));
    assert.equal(clearCollectionDraft(staged.draft.id, { expectedActorId: actor.id, jobId: results[0].id }).cleared, false);
    assert.equal(getCollectionDraftContext().draft.id, next.draft.id);
  });
});

test('member isolation, expected actor and role checks apply before creating or releasing a slot', async () => {
  const alice = fixtureActor(), bob = fixtureActor();
  const staged = await withActor(alice, () => stageCollectionDraft(input(), fields(getCollectionDraftContext())));
  await withActor(bob, async () => {
    assert.equal(getCollectionDraftContext().draft, null);
    await assert.rejects(submitCollectionDraft(staged.draft.id, bob.id), (err) => err.statusCode === 404);
    assert.equal(clearCollectionDraft(staged.draft.id, { expectedActorId: bob.id, confirm: true, discard: true }).cleared, false);
    assert.throws(() => stageCollectionDraft(input(), { ...fields(getCollectionDraftContext()), expectedActorId: alice.id }), (err) => err.code === 'COLLECTION_ACTOR_CHANGED');
    assert.throws(() => stageCollectionDraft(input(), {}), (err) => err.code === 'COLLECTION_ACTOR_REQUIRED');
  });
  for (const role of ['support', 'viewer', 'designer']) await withActor({ id: bob.id, role }, async () => {
    assert.throws(() => getCollectionDraftContext(), (err) => err.statusCode === 403);
    await assert.rejects(submitCollectionDraft(staged.draft.id, bob.id), (err) => err.statusCode === 403);
  });
});

test('ownership changes redact confirmed draft details, forbid replay and still permit explicit discard', async () => {
  const alice = fixtureActor(), bob = fixtureActor();
  await withActor(alice, async () => {
    const staged = stageCollectionDraft(input(), fields(getCollectionDraftContext())), job = await submit(staged);
    platformDb().prepare("UPDATE resource_owners SET owner_id=? WHERE kind='job' AND resource_id=?").run(bob.id, job.id);
    assert.deepEqual(getCollectionDraftContext().draft, { id: staged.draft.id, state: 'unavailable', jobId: null });
    await assert.rejects(submit(staged), (err) => err.statusCode === 404);
    assert.throws(() => clearCollectionDraft(staged.draft.id, { expectedActorId: alice.id, jobId: job.id }), (err) => err.statusCode === 404);
    assert.throws(() => clearCollectionDraft(staged.draft.id, { expectedActorId: alice.id, discard: true }), (err) => err.statusCode === 400);
    clearCollectionDraft(staged.draft.id, { expectedActorId: alice.id, discard: true, confirm: true });
    assert.equal((await fs.stat(path.join(paths.outputDir, 'workbench', job.id, 'manifest.json'))).isFile(), true);
  });
});

test('corrupt payload stays recoverable as an explicit discard, never a fresh task', async () => {
  const actor = fixtureActor();
  await withActor(actor, async () => {
    const staged = stageCollectionDraft(input(), fields(getCollectionDraftContext()));
    platformDb().prepare("UPDATE collection_drafts SET payload='bad JSON' WHERE owner_id=?").run(actor.id);
    assert.equal(getCollectionDraftContext().draft.state, 'corrupt');
    await assert.rejects(submit(staged), (err) => err.code === 'COLLECTION_DRAFT_CORRUPT');
    clearCollectionDraft(staged.draft.id, { expectedActorId: actor.id, discard: true, confirm: true });
    assert.equal(getCollectionDraftContext().draft, null);
  });
});

test('HTTP responses lost after stage and submit preserve one recoverable request and task', async () => {
  actors.add('local'); let dropRoute = `${base}/rows`; const wrapper = express();
  wrapper.use((req, res, next) => { if (req.path === dropRoute) res.end = () => { dropRoute = ''; req.socket.destroy(); }; next(); }); wrapper.use(app);
  const server = wrapper.listen(0, '127.0.0.1'); await new Promise((resolve) => server.once('listening', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  const post = (route, body) => fetch(url + route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  try {
    const context = await (await fetch(url + base)).json();
    await assert.rejects(post(`${base}/rows`, { ...input(), ...fields(context) }));
    const recovered = await (await fetch(url + base)).json(); assert.ok(recovered.draft.id); assert.equal(recovered.draft.jobId, null);
    const repeated = await (await post(`${base}/rows`, { ...input('后来修改'), ...fields(context) })).json(); assert.equal(repeated.draft.id, recovered.draft.id);
    dropRoute = `${base}/${recovered.draft.id}/submit`;
    await assert.rejects(post(dropRoute, { expectedActorId: 'local' }));
    const committed = await (await fetch(url + base)).json(); assert.ok(committed.draft.jobId); jobs.add(committed.draft.jobId);
    const response = await post(`${base}/${recovered.draft.id}/submit`, { expectedActorId: 'local' }), job = await response.json();
    assert.equal(response.status, 200); assert.equal(job.id, committed.draft.jobId); assert.equal(job.options.name, '原规则');
    await request(app).post(`${base}/${recovered.draft.id}/ack`).send({ expectedActorId: 'local', jobId: job.id }).expect(200);
    assert.equal((await request(app).get(base).expect(200)).body.draft, null);
  } finally { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
});

test('spreadsheet input survives without the original upload and retains its original rules', async () => {
  actors.add('local'); const context = (await request(app).get(base).expect(200)).body;
  const sheet = Buffer.from('SKU,销量,图片链接\n保留,20,https://images.example/ok.png\n过滤,1,https://images.example/skip.png');
  const staged = (await request(app).post(`${base}/sheet`).field('expectedActorId', 'local').field('generation', context.generation)
    .field('options', JSON.stringify({ name: '原表格', minSales: 10 })).attach('sheet', sheet, '中文原表.csv').expect(201)).body;
  assert.equal(staged.draft.fileName, '中文原表.csv');
  const repeated = (await request(app).post(`${base}/rows`).send({ ...input('不能改'), ...fields(context) }).expect(200)).body;
  assert.equal(repeated.draft.id, staged.draft.id); assert.equal(repeated.draft.name, '原表格');
  const job = (await request(app).post(`${base}/${staged.draft.id}/submit`).send({ expectedActorId: 'local' }).expect(201)).body; jobs.add(job.id);
  assert.equal(job.source.type, 'spreadsheet'); assert.equal(job.summary.skippedCount, 1); assert.equal(job.summary.inputCount, 2);
  assert.equal(job.items[0].sku, '保留'); assert.equal(job.options.minSales, 10);
  const stagingFiles = await fs.readdir(path.join(paths.uploadDir, 'workbench-staging'));
  assert.ok(!stagingFiles.some((name) => name.endsWith('.csv')));
});

test('real process exit during submit is recoverable from server draft without any browser payload', async () => {
  actors.add('local'); const staged = stageCollectionDraft(input(), fields(getCollectionDraftContext()));
  const code = `import {submitCollectionDraft} from './src/services/collectionDraftService.js';await submitCollectionDraft(${JSON.stringify(staged.draft.id)},'local',{afterReservation(row){process.stdout.write(JSON.stringify({id:row.job_id}));process.exit(0)}});`;
  const result = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', code], { cwd: fileURLToPath(new URL('..', import.meta.url)), env: process.env, encoding: 'utf8' })); jobs.add(result.id);
  const loaded = getCollectionDraftContext(), job = await submit(loaded);
  assert.equal(loaded.draft.id, staged.draft.id); assert.equal(job.id, result.id);
});

test('direct multipart callers can opt into durable request IDs and preserved Unicode source names', async () => {
  actors.add('local'); const clientRequestId = randomUUID(), creationEpoch = collectionCreationEpoch();
  const sheet = Buffer.from('SKU,图片链接\n原文,https://images.example/one.png');
  const post = (name = '相同规则') => request(app).post('/api/workbench/collection-jobs')
    .field('clientRequestId', clientRequestId).field('creationEpoch', creationEpoch).field('options', JSON.stringify({ name }))
    .attach('sheet', sheet, '原始上传.csv');
  const first = await post().expect(201); jobs.add(first.body.id);
  const again = await post().expect(200); assert.equal(again.body.id, first.body.id); assert.equal(again.headers['x-workbench-creation'], 'replayed');
  assert.equal(again.body.source.fileName, '原始上传.csv');
  await post('改变规则').expect(409);
});

test('backup restores receipts but rejects pre-restore form generations and unsubmitted epochs', async () => {
  const actor = fixtureActor();
  await withActor(actor, async () => {
    const context = getCollectionDraftContext(), staged = stageCollectionDraft(input(), fields(context));
    const file = path.join(paths.rootDir, `draft-${randomUUID()}.sqlite`); backups.add(file); await fs.writeFile(file, platformBackup());
    restorePlatformBackup(file);
    assert.throws(() => stageCollectionDraft(input(), fields(context)), (err) => err.code === 'COLLECTION_DRAFT_CONTEXT_CHANGED');
    await assert.rejects(submit(getCollectionDraftContext()), (err) => err.code === 'COLLECTION_WORKSPACE_CHANGED');
    clearCollectionDraft(staged.draft.id, { expectedActorId: actor.id, discard: true, confirm: true });
    const next = stageCollectionDraft(input(), fields(getCollectionDraftContext())), job = await submit(next);
    await fs.writeFile(file, platformBackup()); restorePlatformBackup(file);
    assert.equal((await submit(getCollectionDraftContext())).id, job.id);
  });
});
