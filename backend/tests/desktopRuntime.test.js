import { test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import express from 'express';
import { localAccess } from '../src/middleware/localAccess.js';
import { buildRecoveryItems } from '../src/services/desktopRuntimeService.js';
import app from '../src/app.js';
import { platformDb, setMeta } from '../src/services/platformStore.js';
import { indexTask } from '../src/services/taskCenterService.js';
import { resetDatabaseForTests } from '../src/services/db.js';

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
