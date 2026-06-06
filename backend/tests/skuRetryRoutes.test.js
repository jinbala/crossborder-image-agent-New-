import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import request from 'supertest';
import app from '../src/app.js';
import { createBatchTask, createTask, getBatchTask, getTask, resetDatabaseForTests } from '../src/services/db.js';
import { getPlatformRuleSnapshot } from '../src/rules/platformRules.js';

const now = '2026-06-01T12:00:00.000Z';

function target() {
  return {
    id: 'target-amazon',
    targetId: 'target-amazon',
    platformId: 'amazon',
    platformName: 'Amazon',
    site: 'US',
    language: 'English',
    categoryId: 'electronics_storage',
    rulesSnapshot: getPlatformRuleSnapshot({ platformId: 'amazon', site: 'US', language: 'English', category: 'electronics_storage' })
  };
}

function plan() {
  return {
    id: 'plan-feature',
    type: 'feature_image',
    title: 'Feature image',
    targetId: 'target-amazon',
    platformId: 'amazon',
    platformName: 'Amazon',
    language: 'English',
    categoryId: 'electronics_storage',
    textBlocks: [{ id: 'feature-text', text: 'Fast backup', field: 'sellingPoints' }]
  };
}

function task(overrides = {}) {
  return {
    id: 'task-route-retry',
    batchId: 'batch-route-retry',
    sku: 'SKU-ROUTE',
    status: 'planned',
    productInfoConfirmed: { sku: 'SKU-ROUTE', name: 'Portable Drive', sellingPoints: ['Fast backup'] },
    productInfoRaw: { name: 'Raw Drive' },
    productInfo: { name: 'Portable Drive' },
    fieldEvidence: { name: [{ source: 'visible_text', text: 'Portable Drive' }] },
    recognitionQuality: { status: 'reviewed' },
    inferredCandidates: [],
    targets: [target()],
    imagePlans: [plan()],
    generatedImages: [],
    reviewResults: [],
    review: null,
    createdAt: now,
    updatedAt: now,
    ...overrides
  };
}

function batch(overrides = {}) {
  return {
    id: 'batch-route-retry',
    name: 'Route Retry Batch',
    status: 'partial_failed',
    createdAt: now,
    updatedAt: now,
    skuTasks: [{
      skuId: 'SKU-ROUTE',
      taskId: 'task-route-retry',
      displayName: 'Route SKU',
      status: 'failed',
      currentStep: 'generate',
      queueStatus: 'failed',
      error: { code: 'GENERATE_FAILED', message: 'provider failed' }
    }],
    ...overrides
  };
}

beforeEach(async () => {
  await resetDatabaseForTests();
});

test('GET /api/batches/:batchId/tasks/:taskId/retry-plan returns safe single-SKU plan', async () => {
  await createBatchTask(batch());
  await createTask(task());

  await request(app)
    .get('/api/batches/batch-route-retry/tasks/task-route-retry/retry-plan')
    .expect(200)
    .expect((res) => {
      assert.equal(res.body.retryPlan.batchId, 'batch-route-retry');
      assert.equal(res.body.retryPlan.taskId, 'task-route-retry');
      assert.equal(res.body.retryPlan.sku, 'SKU-ROUTE');
      assert.deepEqual(res.body.retryPlan.allowedRetrySteps, ['imageGeneration']);
      assert.equal(res.body.retryPlan.blockedRetrySteps.some((item) => item.retryStep === 'export'), true);
    });
});

test('retry plan route returns 404 for missing batch and missing task', async () => {
  await request(app)
    .get('/api/batches/missing/tasks/task-route-retry/retry-plan')
    .expect(404);

  await createBatchTask(batch());
  await request(app)
    .get('/api/batches/batch-route-retry/tasks/missing-task/retry-plan')
    .expect(404);
});

test('POST /api/batches/:batchId/tasks/:taskId/retry rejects unconfirmed run and does not write', async () => {
  await createBatchTask(batch());
  await createTask(task());
  const beforeTask = await getTask('task-route-retry');

  await request(app)
    .post('/api/batches/batch-route-retry/tasks/task-route-retry/retry')
    .send({ retryStep: 'imageGeneration', mode: 'mockOnly', confirmPaidApi: false })
    .expect(400);

  assert.deepEqual(await getTask('task-route-retry'), beforeTask);
});

test('POST /api/batches/:batchId/tasks/:taskId/retry executes one mockOnly step and leaves batch status untouched', async () => {
  await createBatchTask(batch());
  await createTask(task());
  const beforeBatch = await getBatchTask('batch-route-retry');

  await request(app)
    .post('/api/batches/batch-route-retry/tasks/task-route-retry/retry')
    .send({ retryStep: 'imageGeneration', confirmRetry: true, mode: 'mockOnly', confirmPaidApi: false })
    .expect(200)
    .expect((res) => {
      assert.equal(res.body.retryResult.status, 'completed');
      assert.equal(res.body.retryResult.retryStep, 'imageGeneration');
      assert.ok(res.body.retryResult.beforeSnapshot);
      assert.ok(res.body.retryResult.afterSnapshot);
      assert.equal(JSON.stringify(res.body).includes('Image2'), false);
    });

  const afterTask = await getTask('task-route-retry');
  assert.equal(afterTask.generatedImages.length, 1);
  assert.equal(afterTask.generatedImages[0].provider, 'mock');
  assert.deepEqual(await getBatchTask('batch-route-retry'), beforeBatch);
});
