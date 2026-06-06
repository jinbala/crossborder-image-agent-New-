import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import request from 'supertest';
import app from '../src/app.js';
import {
  createBatchTask,
  createTask,
  getBatchTask,
  resetDatabaseForTests
} from '../src/services/db.js';

const now = '2026-06-01T12:00:00.000Z';

beforeEach(async () => {
  await resetDatabaseForTests();
});

test('GET /api/batches/:batchId/stability returns read-only sanitized batchStabilityReport', async () => {
  await createBatchTask({
    id: 'batch-stability-route',
    name: 'Route Stability',
    status: 'partial_failed',
    createdAt: now,
    updatedAt: now,
    skuTasks: [
      {
        skuId: 'SKU-FAIL',
        taskId: 'task-fail',
        status: 'failed',
        currentStep: 'generate',
        error: { code: 'GENERATE_FAILED', message: 'D:\\Code\\.env OPENAI_API_KEY=sk-secret app.sqlite node_modules' }
      },
      {
        skuId: 'SKU-NOREVIEW',
        taskId: 'task-no-review',
        status: 'generated',
        currentStep: 'generated',
        error: null
      }
    ]
  });
  await createTask({
    id: 'task-fail',
    batchId: 'batch-stability-route',
    sku: 'SKU-FAIL',
    status: 'planned',
    productInfoConfirmed: { name: 'Failed Product' },
    imagePlans: [{ id: 'plan-1' }],
    generatedImages: [{ id: 'img-1', status: 'failed', error: { message: 'failed' } }],
    review: null
  });
  await createTask({
    id: 'task-no-review',
    batchId: 'batch-stability-route',
    sku: 'SKU-NOREVIEW',
    status: 'generated',
    productInfoConfirmed: { name: 'No Review Product' },
    generatedImages: [{ id: 'img-1', status: 'succeeded' }],
    review: null
  });
  const before = await getBatchTask('batch-stability-route');

  await request(app)
    .get('/api/batches/batch-stability-route/stability')
    .expect(200)
    .expect((res) => {
      const report = res.body.batchStabilityReport;
      assert.equal(report.meta.batchId, 'batch-stability-route');
      assert.equal(report.meta.mode, 'readOnly');
      assert.equal(report.summary.totalSku, 2);
      assert.equal(report.summary.failedSku, 1);
      assert.equal(report.summary.noReviewSku, 1);
      assert.equal(report.failures[0].failedStep, 'imageGeneration');
      assert.equal(report.resumePlan.canResume, true);
      const json = JSON.stringify(res.body);
      assert.doesNotMatch(json, /\.env/i);
      assert.doesNotMatch(json, /OPENAI_API_KEY/i);
      assert.doesNotMatch(json, /sk-secret/i);
      assert.doesNotMatch(json, /[A-Z]:\\/);
      assert.doesNotMatch(json, /app\.sqlite/i);
      assert.doesNotMatch(json, /node_modules/i);
    });

  assert.deepEqual(await getBatchTask('batch-stability-route'), before);
});

test('GET /api/batches/:batchId/stability returns empty report for empty batch', async () => {
  await createBatchTask({
    id: 'batch-empty-stability',
    name: 'Empty Stability',
    status: 'imported',
    createdAt: now,
    updatedAt: now,
    skuTasks: []
  });

  await request(app)
    .get('/api/batches/batch-empty-stability/stability')
    .expect(200)
    .expect((res) => {
      assert.equal(res.body.batchStabilityReport.summary.totalSku, 0);
      assert.deepEqual(res.body.batchStabilityReport.failures, []);
      assert.equal(res.body.batchStabilityReport.resumePlan.canResume, false);
    });
});

test('GET /api/batches/:batchId/stability returns 404 for missing batch', async () => {
  await request(app)
    .get('/api/batches/not-found/stability')
    .expect(404);
});
