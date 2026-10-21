import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTask, createBatchTask, getTask, getBatchTask, updateBatchTask, deleteBatchTaskRecord } from '../src/services/db.js';
import { runBatchQueue, pauseBatchQueue, resumeBatchQueue, cancelBatchQueue, batchQueueRuntime } from '../src/services/batchQueueService.js';
import { MockVisionProvider } from '../src/providers/vision/mockVisionProvider.js';
import { MockImageProvider } from '../src/providers/mock/MockImageProvider.js';
import request from 'supertest';
import app from '../src/app.js';
import { deleteBatch } from '../src/services/batchControlService.js';

async function fixture(name, run) {
  const batchId = `queue-lifecycle-${name}`;
  const ids = [0, 1].map(index => `${batchId}-${index}`);
  for (const id of ids) await createTask({ id, status: 'uploaded', sourceImages: [] });
  await createBatchTask({ id: batchId, status: 'imported', skuTasks: ids.map(taskId => ({ taskId, skuId: taskId, status: 'uploaded', queueStatus: 'pending' })) });
  const original = MockVisionProvider.prototype.recognize;
  let release, entered, calls = 0;
  const gate = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  MockVisionProvider.prototype.recognize = async function (args) {
    calls++;
    if (calls === 1) { entered(); await gate; }
    return original.call(this, args);
  };
  let execution;
  try {
    execution = runBatchQueue({ batchId, action: 'recognize', concurrency: 1, waitForCompletion: true });
    await started;
    await run({ batchId, ids, release, execution, calls: () => calls });
  } finally {
    release();
    await execution;
    if (await getBatchTask(batchId)) await cancelBatchQueue(batchId, { waitForCompletion: true });
    MockVisionProvider.prototype.recognize = original;
    if (await getBatchTask(batchId)) await deleteBatchTaskRecord(batchId);
  }
}

test('read-only runtime reports the active worker separately and is never persisted into batch data',async()=>{
  await fixture('runtime',async({batchId,release,execution})=>{
    assert.equal(batchQueueRuntime(batchId).queueActive,true);
    assert.equal((await request(app).get(`/api/batches/${batchId}`).expect(200)).body.batchTask.runtime.queueActive,true);
    assert.equal((await getBatchTask(batchId)).runtime,undefined);
    release();await execution;assert.equal(batchQueueRuntime(batchId).queueActive,false);
    assert.equal((await request(app).get(`/api/batches/${batchId}`).expect(200)).body.batchTask.runtime.queueActive,false);
  });
});

test('legacy batch mutation endpoints cannot bypass a running, paused or cancelled-but-draining queue', async () => {
  const batchId = 'queue-lifecycle-legacy-guard', taskId = `${batchId}-task`;
  await createTask({ id: taskId, status: 'uploaded', sourceImages: [] });
  await createBatchTask({ id: batchId, skuTasks: [{ taskId, skuId: taskId, status: 'uploaded' }] });
  try {
    for (const [status, locked] of [['running', false], ['running', true], ['paused', true], ['cancelled', true]]) {
      await updateBatchTask(batchId, () => ({ queue: { status }, locks: { isRunning: locked } }));
      const before = JSON.stringify(await getBatchTask(batchId)), beforeTask = JSON.stringify(await getTask(taskId));
      for (const action of ['recognize', 'apply-targets', 'apply-template', 'plan', 'generate', 'review', `tasks/${taskId}/retry`]) {
        const response = await request(app).post(`/api/batches/${batchId}/${action}`).send({ mode: 'mock', confirmRetry: true }).expect(409);
        assert.match(response.body.error, /等待队列锁释放/);
      }
      assert.equal(JSON.stringify(await getBatchTask(batchId)), before);
      assert.equal(JSON.stringify(await getTask(taskId)), beforeTask);
    }
  } finally { await deleteBatchTaskRecord(batchId); }
});

test('cancel retains the live lock until drain, preserves cancelled state and accurate unprocessed counts', { timeout: 10000 }, async () => {
  await fixture('cancel', async ({ batchId, ids, release, execution, calls }) => {
    // Expiring the persisted lease must not allow takeover of a live local worker.
    await updateBatchTask(batchId, current => ({ locks: { ...current.locks, expiresAt: new Date(0).toISOString() } }));
    await assert.rejects(runBatchQueue({ batchId, action: 'recognize' }), error => error.statusCode === 409);
    await pauseBatchQueue(batchId);
    const cancelled = await cancelBatchQueue(batchId);
    assert.equal(cancelled.queue.status, 'cancelled');
    assert.equal(cancelled.locks.isRunning, true);
    await assert.rejects(runBatchQueue({ batchId, action: 'recognize' }), error => error.statusCode === 409);
    await resumeBatchQueue(batchId);
    assert.equal(calls(), 1);
    release(); await execution;
    const final = await getBatchTask(batchId);
    assert.equal(final.status, 'cancelled');
    assert.equal(final.queue.status, 'cancelled');
    assert.equal(final.locks.isRunning, false);
    assert.equal(final.queue.completedJobs, 1);
    assert.equal(final.queue.pendingJobs, 1);
    assert.equal(final.queue.runningJobs, 0);
    assert.equal(calls(), 1);
    assert.equal((await getTask(ids[1])).status, 'uploaded');
    assert.ok(!final.executionLogs.some(log => /批量recognize完成/.test(log.message)));
  });
});

test('resume launches only pending SKUs and keeps total counts consistent', { timeout: 10000 }, async () => {
  await fixture('resume', async ({ batchId, release, execution, calls }) => {
    await pauseBatchQueue(batchId);
    release(); await execution;
    await resumeBatchQueue(batchId);
    for (let i = 0; i < 200; i++) {
      if ((await getBatchTask(batchId)).queue.status === 'completed') break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    const final = await getBatchTask(batchId);
    assert.equal(final.queue.status, 'completed');
    assert.equal(final.queue.totalJobs, 2);
    assert.equal(final.queue.completedJobs, 2);
    assert.equal(final.queue.skippedJobs, 0);
    assert.equal(final.executionLogs.filter(log => /开始 recognize$/.test(log.message)).length, 2);
    assert.equal(calls(), 2);
  });
});

test('cancelling an already-drained paused queue releases its lock without touching pending SKUs', { timeout: 10000 }, async () => {
  await fixture('paused-cancel', async ({ batchId, release, execution, calls }) => {
    await pauseBatchQueue(batchId); release(); await execution;
    assert.equal((await getBatchTask(batchId)).queue.status, 'paused');
    await cancelBatchQueue(batchId, { waitForCompletion: true });
    const final = await getBatchTask(batchId);
    assert.equal(final.status, 'cancelled');
    assert.equal(final.queue.status, 'cancelled');
    assert.equal(final.locks.isRunning, false);
    assert.equal(final.queue.pendingJobs, 1);
    await pauseBatchQueue(batchId); await resumeBatchQueue(batchId);
    assert.equal((await getBatchTask(batchId)).queue.status, 'cancelled');
    assert.equal(calls(), 1);
  });
});

test('delete waits for the live SKU before removing task records', { timeout: 10000 }, async () => {
  await fixture('delete', async ({ batchId, ids, release, execution, calls }) => {
    let deleted = false;
    const removing = deleteBatch(batchId).then(result => { deleted = true; return result; });
    try {
      for (let i = 0; i < 100 && (await getBatchTask(batchId)).queue.status !== 'cancelled'; i++) await new Promise(resolve => setTimeout(resolve, 10));
      assert.equal(deleted, false);
      assert.ok(await getTask(ids[0]));
    } finally { release(); }
    await execution; await removing;
    assert.equal(calls(), 1);
    assert.equal(await getBatchTask(batchId), null);
    for (const id of ids) assert.equal(await getTask(id), null);
  });
});

test('cancel during retry backoff prevents another provider request', { timeout: 10000 }, async () => {
  const previous = Object.fromEntries(['BATCH_AUTO_RETRY_ENABLED', 'BATCH_RETRY_DELAY_MS', 'BATCH_MAX_RETRY_PER_JOB'].map(key => [key, process.env[key]]));
  const original = MockVisionProvider.prototype.recognize;
  let failingCalls = 0;
  try {
    process.env.BATCH_AUTO_RETRY_ENABLED = 'true'; process.env.BATCH_RETRY_DELAY_MS = '400'; process.env.BATCH_MAX_RETRY_PER_JOB = '1';
    MockVisionProvider.prototype.recognize = async () => { failingCalls++; throw Object.assign(new Error('fixture disconnected'), { code: 'ECONNRESET' }); };
    await fixture('retry-cancel', async ({ batchId, release, execution }) => {
      release();
      for (let i = 0; i < 150; i++) {
        if ((await getBatchTask(batchId)).executionLogs?.some(log => /retry_scheduled/.test(log.message))) break;
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      assert.ok((await getBatchTask(batchId)).executionLogs.some(log => /retry_scheduled/.test(log.message)));
      await cancelBatchQueue(batchId, { waitForCompletion: true }); await execution;
      const final = await getBatchTask(batchId);
      assert.equal(failingCalls, 1);
      assert.equal(final.queue.status, 'cancelled');
      assert.equal(final.queue.runningJobs, 0);
      assert.equal(final.queue.pendingJobs, 2);
      assert.equal(final.queue.completedJobs, 0);
    });
  } finally {
    MockVisionProvider.prototype.recognize = original;
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
});

test('persisted paused queue resumes only its unfinished SKU after controller loss', { timeout: 10000 }, async () => {
  const batchId = 'queue-lifecycle-persisted';
  const ids = [`${batchId}-completed`, `${batchId}-pending`];
  try {
    await createTask({ id: ids[0], status: 'recognized', sourceImages: [] });
    await createTask({ id: ids[1], status: 'uploaded', sourceImages: [] });
    await createBatchTask({ id: batchId, status: 'waiting_confirm', locks: { isRunning: true }, queue: { status: 'paused', action: 'recognize', mode: 'mock', concurrency: 1 }, skuTasks: ids.map((id, index) => ({ skuId: id, taskId: id, status: index ? 'uploaded' : 'recognized', queueAction: 'recognize', queueStatus: index ? 'pending' : 'completed' })) });
    await resumeBatchQueue(batchId);
    for (let i = 0; i < 200; i++) {
      if ((await getBatchTask(batchId)).queue.status === 'completed') break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    const final = await getBatchTask(batchId);
    assert.equal(final.queue.status, 'completed');
    assert.equal(final.queue.totalJobs, 2);
    assert.equal(final.queue.completedJobs, 2);
    assert.equal(final.queue.skippedJobs, 0);
    assert.equal(final.executionLogs.filter(log => /开始 recognize$/.test(log.message)).length, 1);
  } finally {
    if (await getBatchTask(batchId)) {
      await cancelBatchQueue(batchId, { waitForCompletion: true });
      await deleteBatchTaskRecord(batchId);
    }
  }
});

test('a timed-out provider drains before retry or unlock and cannot write a late task result', { timeout: 10000 }, async () => {
  const previous = Object.fromEntries(['BATCH_AUTO_RETRY_ENABLED', 'BATCH_JOB_TIMEOUT_MS', 'BATCH_RETRY_DELAY_MS'].map(key => [key, process.env[key]]));
  try {
    process.env.BATCH_AUTO_RETRY_ENABLED = 'true'; process.env.BATCH_JOB_TIMEOUT_MS = '20'; process.env.BATCH_RETRY_DELAY_MS = '1';
    await fixture('timeout-drain', async ({ batchId, ids, release, execution, calls }) => {
      for (let i = 0; i < 100; i++) {
        if ((await getBatchTask(batchId)).executionLogs?.some(log => /timeout_draining/.test(log.message))) break;
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      assert.equal(calls(), 1, 'timeout must not overlap another attempt or SKU');
      assert.ok((await getBatchTask(batchId)).executionLogs.some(log => /timeout_draining/.test(log.message)));
      assert.equal((await getBatchTask(batchId)).locks.isRunning, true);
      await cancelBatchQueue(batchId);
      assert.equal((await getBatchTask(batchId)).locks.isRunning, true);
      release(); await execution;
      const final = await getBatchTask(batchId);
      assert.equal(final.queue.status, 'cancelled'); assert.equal(final.status, 'cancelled');
      assert.equal(final.queue.failedJobs, 1); assert.equal(final.queue.pendingJobs, 1); assert.equal(final.queue.completedJobs, 0);
      assert.equal(final.locks.isRunning, false);
      for (const id of ids) assert.equal((await getTask(id)).status, 'uploaded');
      assert.equal(calls(), 1);
    });
  } finally {
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
});

test('expired image-generation attempt does not execute further plans or save its late image', { timeout: 10000 }, async () => {
  const batchId = 'queue-lifecycle-image-timeout', taskId = `${batchId}-task`;
  const original = MockImageProvider.prototype.generate, previousTimeout = process.env.BATCH_JOB_TIMEOUT_MS;
  let release, entered, calls = 0, execution;
  const blocked = new Promise(resolve => { release = resolve; }), started = new Promise(resolve => { entered = resolve; });
  try {
    process.env.BATCH_JOB_TIMEOUT_MS = '20';
    await createTask({ id: taskId, status: 'planned', imagePlans: [{ id: 'plan-A', type: 'main_image' }, { id: 'plan-B', type: 'detail_image' }], generatedImages: [] });
    await createBatchTask({ id: batchId, status: 'planning', skuTasks: [{ taskId, skuId: taskId, status: 'planned', queueStatus: 'pending' }] });
    MockImageProvider.prototype.generate = async () => { calls++; entered(); await blocked; return { status: 'succeeded', data: { id: 'late-fixture-image' } }; };
    execution = runBatchQueue({ batchId, action: 'generate', concurrency: 1, waitForCompletion: true });
    await started;
    for (let i = 0; i < 100; i++) {
      if ((await getBatchTask(batchId)).executionLogs?.some(log => /timeout_draining/.test(log.message))) break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.ok((await getBatchTask(batchId)).executionLogs.some(log => /timeout_draining/.test(log.message)));
    await cancelBatchQueue(batchId); release(); await execution;
    const task = await getTask(taskId), batch = await getBatchTask(batchId);
    assert.equal(calls, 1); assert.equal(task.status, 'planned'); assert.deepEqual(task.generatedImages, []);
    assert.equal(batch.queue.status, 'cancelled'); assert.equal(batch.queue.failedJobs, 1); assert.equal(batch.queue.completedJobs, 0);
  } finally {
    release(); if (execution) await execution;
    MockImageProvider.prototype.generate = original;
    if (previousTimeout === undefined) delete process.env.BATCH_JOB_TIMEOUT_MS; else process.env.BATCH_JOB_TIMEOUT_MS = previousTimeout;
    if (await getBatchTask(batchId)) { await cancelBatchQueue(batchId, { waitForCompletion: true }); await deleteBatchTaskRecord(batchId); }
  }
});
