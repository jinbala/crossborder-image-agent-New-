import { test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import app from '../src/app.js';
import { createTask, createBatchTask, getTask, getBatchTask, deleteBatchTaskRecord } from '../src/services/db.js';
import { paidProviderSummary, providerOrigin, requirePaidConfirmation } from '../src/services/paidOperationPolicy.js';
import { runBatchQueue, pauseBatchQueue, resumeBatchQueue, cancelBatchQueue } from '../src/services/batchQueueService.js';
import { MockVisionProvider } from '../src/providers/vision/mockVisionProvider.js';

test('paid confirmation is strict and provider destinations contain origins only', () => {
  for (const value of [undefined, false, 'true', 1, {}]) assert.throws(() => requirePaidConfirmation({ confirmPaidApi: value }, true), error => error.statusCode === 403);
  requirePaidConfirmation({ confirmPaidApi: true }, true); requirePaidConfirmation({}, false);
  const previous = process.env.OPENAI_BASE_URL;
  try {
    process.env.OPENAI_BASE_URL = 'https://name:secret@images.example/v1?key=private';
    assert.equal(providerOrigin('openai'), 'https://images.example');
    assert.ok(!/secret|private|name:/.test(JSON.stringify(paidProviderSummary())));
    process.env.OPENAI_BASE_URL = 'file:///private'; assert.equal(providerOrigin('openai'), null);
  } finally { if (previous === undefined) delete process.env.OPENAI_BASE_URL; else process.env.OPENAI_BASE_URL = previous; }
});
test('HTTP real vision, review, regeneration and batch queue requests reject missing approval before mutation', async () => {
  const id = 'paid-boundary-fixture', batchId = 'paid-boundary-batch';
  await createTask({ id, status: 'uploaded', sourceImages: [], generatedImages: [], imagePlans: [] });
  await createBatchTask({ id: batchId, skuTasks: [{ skuId: 'paid-boundary-sku', taskId: id }], queue: { status: 'paused', action: 'recognize', mode: 'real-test' } });
  const beforeTask = JSON.stringify(await getTask(id)), beforeBatch = JSON.stringify(await getBatchTask(batchId));
  const previous = process.env.VISION_PROVIDER;
  const previousMatting = process.env.MATTING_PROVIDER;
  try {
    process.env.VISION_PROVIDER = 'openai';
    process.env.MATTING_PROVIDER = 'external';
    const cases = [
      [`/api/tasks/${id}/recognize`, {}], [`/api/tasks/${id}/review`, { mode: 'real' }],
      [`/api/tasks/${id}/generate/plan`, { mode: 'real_background' }], [`/api/batches/${batchId}/recognize`, {}],
      [`/api/tasks/${id}/generate/plan`, { mode: 'real-test' }], [`/api/stress-test/run`, { mode: 'realVisionMockGenerate', batchId }],
      [`/api/tasks/${id}/plans/plan/matting-preview`, {}],
      [`/api/batches/${batchId}/review`, { mode: 'real' }], [`/api/batches/${batchId}/generate`, { mode: 'real_background' }],
      [`/api/batches/${batchId}/queue/start`, { action: 'recognize', mode: 'real-test' }],
      [`/api/batches/${batchId}/queue/retry-failed`, { action: 'recognize', mode: 'real-test' }], [`/api/batches/${batchId}/queue/resume`, {}]
    ];
    for (const [url, body] of cases) for (const confirmPaidApi of [undefined, false, 'true', 1]) {
      const response = await request(app).post(url).send({ ...body, confirmPaidApi }).expect(403);
      assert.match(response.body.error, /confirmPaidApi=true/);
    }
    assert.equal(JSON.stringify(await getTask(id)), beforeTask); assert.equal(JSON.stringify(await getBatchTask(batchId)), beforeBatch);
  } finally { await deleteBatchTaskRecord(batchId); if (previous === undefined) delete process.env.VISION_PROVIDER; else process.env.VISION_PROVIDER = previous; if (previousMatting === undefined) delete process.env.MATTING_PROVIDER; else process.env.MATTING_PROVIDER = previousMatting; }
});
test('pause then concurrent resume drains the in-flight SKU and preserves the selected queue mode', async () => {
  const batchId = 'resume-drain-fixture';
  const tasks = ['resume-drain-A', 'resume-drain-B'];
  for (const id of tasks) await createTask({ id, status: 'uploaded', sourceImages: [], productInfo: null });
  await createBatchTask({ id: batchId, status: 'imported', skuTasks: tasks.map((taskId, index) => ({ skuId: `resume-sku-${index}`, taskId, status: 'uploaded', currentStep: 'uploaded', queueStatus: 'pending' })) });
  const previousVision = process.env.VISION_PROVIDER, original = MockVisionProvider.prototype.recognize;
  let release, entered, calls = 0;
  const blocked = new Promise(resolve => { release = resolve; }), started = new Promise(resolve => { entered = resolve; });
  MockVisionProvider.prototype.recognize = async function (args) { calls++; if (calls === 1) { entered(); await blocked; } return original.call(this, args); };
  try {
    process.env.VISION_PROVIDER = 'mock';
    await runBatchQueue({ batchId, action: 'recognize', concurrency: 1, mode: 'real-test' }); await started;
    await pauseBatchQueue(batchId);
    const first = resumeBatchQueue(batchId), second = resumeBatchQueue(batchId);
    await new Promise(resolve => setImmediate(resolve)); assert.equal(calls, 1);
    release(); await Promise.all([first, second]);
    for (let i = 0; i < 200; i++) { const batch = await getBatchTask(batchId); if (['completed', 'partial_failed', 'failed'].includes(batch.queue?.status)) break; await new Promise(resolve => setTimeout(resolve, 25)); }
    const finished = await getBatchTask(batchId);
    assert.equal(calls, 2); assert.equal(finished.queue.mode, 'real-test'); assert.equal(finished.queue.status, 'completed');
    assert.ok(finished.skuTasks.every(sku => ['completed', 'skipped'].includes(sku.queueStatus)));
    for (const id of tasks) assert.equal((await getTask(id)).status, 'recognized');
  } finally { release(); await cancelBatchQueue(batchId); await deleteBatchTaskRecord(batchId); MockVisionProvider.prototype.recognize = original; if (previousVision === undefined) delete process.env.VISION_PROVIDER; else process.env.VISION_PROVIDER = previousVision; }
});
