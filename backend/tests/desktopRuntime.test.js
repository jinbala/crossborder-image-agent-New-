import { test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import express from 'express';
import { localAccess } from '../src/middleware/localAccess.js';
import { buildRecoveryItems, getDesktopRuntime } from '../src/services/desktopRuntimeService.js';
import app from '../src/app.js';
import { platformDb, setMeta } from '../src/services/platformStore.js';
import { indexTask, indexedTaskState } from '../src/services/taskCenterService.js';
import { resetDatabaseForTests, createBatchTask, getBatchTask } from '../src/services/db.js';
import { withActor, claimResource } from '../src/services/ownershipService.js';

test('desktop local guard rejects missing token, foreign origin and rebinding hosts', async () => {
  const previous = process.env.LOCAL_API_TOKEN;
  process.env.LOCAL_API_TOKEN = 'test-local-secret';
  const app = express();
  app.use(localAccess);
  app.get('*', (_req, res) => res.json({ ok: true }));
  try {
    await request(app).get('/api/health').expect(200);
    await request(app).get('/api/tasks').expect(401);
    await request(app).get('/api/tasks').set('x-local-token', 'test-local-secret').expect(200);
    await request(app).get('/outputs/a.zip').set('Cookie', 'crossborder_local=test-local-secret').expect(200);
    await request(app).get('/api/tasks').set('x-local-token', 'test-local-secret').set('Origin', 'https://evil.example').expect(403);
    await request(app).get('/api/tasks').set('x-local-token', 'test-local-secret').set('Host', 'attacker.example:4000').expect(403);
  } finally {
    if (previous === undefined) delete process.env.LOCAL_API_TOKEN; else process.env.LOCAL_API_TOKEN = previous;
  }
});

test('recovery inventory includes unfinished jobs, excludes completed work and batch duplicates', () => {
  const items = buildRecoveryItems({
    batches: [{ id: 'b1', queue: { status: 'running' }, skuTasks: [{ taskId: 't1' }] }],
    jobs: [{ id: 'j1', status: 'paused' }, { id: 'j2', status: 'completed' }],
    tasks: [{ id: 't1', status: 'failed' }, { id: 't2', status: 'generating' }]
  });
  assert.deepEqual(items.map((item) => item.id).sort(), ['b1', 'j1', 't2']);
  assert.ok(items.every((item) => item.href.startsWith('/') && !('localPath' in item)));
});

test('SKU recovery opens its own result page rather than collection controls', () => {
  const [item] = buildRecoveryItems({ jobs: [{ id: 'sku-pack-test', type: 'sku-pack', status: 'paused' }] });
  assert.equal(item.href, '/results/sku-pack-test');
  assert.match(item.hint, /SKU/);
});

test('completed queue actions retain business waiting/errors but active queue controls keep precedence', () => {
  for (const [status, expected] of [['waiting_confirm', 'waiting_user'], ['planned', 'waiting_user'], ['partial_failed', 'partial'], ['failed', 'failed'], ['cancelled', 'cancelled'], ['completed', 'completed'], ['imported', 'completed']]) {
    const record = { id: 'queue-state', status, queue: { status: 'completed' } };
    assert.equal(indexedTaskState(record), expected);
    const recovery = buildRecoveryItems({ batches: [record] });
    assert.equal(recovery.length, ['waiting_user', 'partial', 'failed'].includes(expected) ? 1 : 0);
  }
  for (const state of ['queued', 'running', 'paused', 'cancelled', 'partial_failed', 'failed']) {
    assert.equal(indexedTaskState({ status: 'waiting_confirm', queue: { status: state } }), state === 'partial_failed' ? 'partial' : state);
  }
});

test('old core indexes refresh waiting batches once without restarting the completed legacy scan', async () => {
  await resetDatabaseForTests();
  const db = platformDb(); db.prepare('DELETE FROM task_index').run();
  const batch = { id: 'old-index-waiting-batch', status: 'waiting_confirm', queue: { status: 'completed' }, name: '批量-原文' };
  await createBatchTask(batch);
  await getDesktopRuntime();
  db.prepare("UPDATE task_index SET state='completed' WHERE id=?").run(batch.id);
  setMeta('task-index-schema', 2); setMeta('core-index-dirty', false); setMeta('task-index-migrated', true);
  const before = JSON.stringify(await getBatchTask(batch.id));
  const legacy = { status: 'completed', processed: 10000, total: 10000, failed: 0, recovered: 0 };
  setMeta('legacy-index-status', legacy);
  const result = await getDesktopRuntime();
  assert.equal(result.recovery.find(item => item.id === batch.id)?.state, 'waiting_user');
  assert.deepEqual(result.indexStatus, legacy);
  assert.equal(JSON.stringify(await getBatchTask(batch.id)), before);
});

test('all known unfinished kinds appear in SQL recovery, terminal/draft/device tasks do not, and reads leave records unchanged', async () => {
  await resetDatabaseForTests();
  const db = platformDb(); db.prepare('DELETE FROM task_index').run(); setMeta('task-index-migrated', true);
  // Initialize core indexing first so the synthetic core fixtures are not replaced.
  await getDesktopRuntime();
  const kinds = ['batch', 'image', 'collection-job', 'sku-pack', 'image-pack', 'collection-plan', 'studio', 'listing-dry-run', 'pricing-preview', 'template-fill', 'commerce-sandbox'];
  const states = ['queued', 'running', 'waiting_user', 'paused', 'failed', 'partial'];
  for (const kind of kinds) for (const status of [...states, 'draft', 'completed', 'cancelled']) indexTask({ id: `recover-${kind}-${status}`, type: kind, status, createdAt: '2026-10-24T01:00:00Z' });
  indexTask({ id: 'recover-device-waiting', type: 'device-task', status: 'waiting_user' });
  indexTask({ id: 'recover-child', type: 'image', status: 'waiting_user', batchId: 'recover-batch-waiting_user' });
  const before = db.prepare('SELECT * FROM task_index ORDER BY id').all();
  const result = await getDesktopRuntime({ pageSize: 100 });
  assert.equal(result.recoveryPagination.total, kinds.length * states.length);
  assert.equal(result.recovery.length, kinds.length * states.length);
  for (const kind of kinds) for (const state of states) {
    const row = result.recovery.find(item => item.id === `recover-${kind}-${state}`);
    assert.ok(row, `${kind}/${state} should be recoverable`);
    assert.equal(row.state, state);
    if (state === 'waiting_user') assert.match(row.hint, /手动确认.*不会自动执行/);
  }
  assert.equal(result.recovery.find(item => item.id === 'recover-commerce-sandbox-paused').href, '/commerce-sandbox/recover-commerce-sandbox-paused');
  assert.equal(result.recovery.find(item => item.id === 'recover-template-fill-waiting_user').href, '/results/recover-template-fill-waiting_user');
  assert.deepEqual(db.prepare('SELECT * FROM task_index ORDER BY id').all(), before);
});

test('waiting recovery keeps member ownership and support isolation, including counts and pagination', async () => {
  await resetDatabaseForTests();
  const db = platformDb(); db.prepare('DELETE FROM task_index').run(); setMeta('task-index-migrated', true);
  await getDesktopRuntime();
  const a = { id: 'recover-owner-a', role: 'operator' }, b = { id: 'recover-owner-b', role: 'operator' };
  for (const actor of [a, b]) withActor(actor, () => {
    for (const kind of ['template-fill', 'commerce-sandbox', 'collection-plan', 'image', 'batch']) {
      const id = `${actor.id}-${kind}`;
      claimResource(kind === 'image' || kind === 'batch' ? kind : 'job', id);
      indexTask({ id, type: kind, status: 'waiting_user' });
    }
  });
  const before = db.prepare('SELECT * FROM resource_owners ORDER BY resource_id').all();
  for (const actor of [a, b]) {
    const first = await withActor(actor, () => getDesktopRuntime({ pageSize: 2 }));
    const second = await withActor(actor, () => getDesktopRuntime({ pageSize: 2, page: 2 }));
    assert.equal(first.recoveryPagination.total, 5);
    assert.ok([...first.recovery, ...second.recovery].every(item => item.id.startsWith(actor.id)));
    assert.equal(new Set([...first.recovery, ...second.recovery].map(item => item.id)).size, 4);
  }
  const support = await withActor({ id: 'recover-support', role: 'support' }, () => getDesktopRuntime());
  assert.equal(support.recoveryPagination.total, 0); assert.deepEqual(support.recovery, []);
  assert.deepEqual(db.prepare('SELECT * FROM resource_owners ORDER BY resource_id').all(), before);
});

test('legacy recovery helper uses the same unfinished-state policy and safe destinations', () => {
  const result = buildRecoveryItems({ batches: [{ id: 'b', status: 'planned', queue: { status: 'idle' } }], jobs: [
    { id: 'template', type: 'template-fill', status: 'waiting_user' }, { id: 'plan', type: 'collection-plan', status: 'planned' },
    { id: 'sandbox', type: 'commerce-sandbox', state: 'paused' }, { id: 'done', type: 'studio', status: 'completed' },
    { id: 'device', type: 'device-task', status: 'waiting_user' }
  ], tasks: [{ id: 'image', status: 'recognized' }, { id: 'child', status: 'confirmed', batchId: 'b' }] });
  assert.deepEqual(result.map(item => item.id).sort(), ['b', 'image', 'plan', 'sandbox', 'template']);
  assert.equal(result.find(item => item.id === 'sandbox').href, '/commerce-sandbox/sandbox');
  assert.ok(result.filter(item => item.id !== 'sandbox').every(item => item.state === 'waiting_user'));
});

test('10000 resumable jobs use SQL pagination and first recovery response is below two seconds', async () => {
  await resetDatabaseForTests();
  const db = platformDb(); db.prepare('DELETE FROM task_index').run();
  setMeta('task-index-migrated', true);
  db.transaction(() => { for (let index = 0; index < 10000; index++) indexTask({ id: `collect-job-recovery-${index}`, type: 'collection-job', name: `Recovery ${index}`, status: 'paused', createdAt: '2026-10-20T01:00:00Z' }); })();
  const started = performance.now();
  const first = await request(app).get('/api/desktop/runtime?page=1&pageSize=50').expect(200);
  assert.ok(performance.now() - started < 2000);
  assert.equal(first.body.recovery.length, 50); assert.equal(first.body.recoveryPagination.total, 10000);
  const next = await request(app).get('/api/desktop/runtime?page=2&pageSize=50').expect(200);
  assert.ok(!first.body.recovery.some((item) => next.body.recovery.some((second) => item.id === second.id)));
  assert.ok(first.body.recovery.every((item) => item.href.startsWith('/workbench/collection?jobId=')));
});
