import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import request from 'supertest';
import app from '../src/app.js';
import { createBatchTask, createTask, getBatchTask, resetDatabaseForTests } from '../src/services/db.js';

const now = '2026-06-01T12:00:00.000Z';

beforeEach(async () => {
  await resetDatabaseForTests();
});

test('GET /api/batches/:batchId/resume-plan returns read-only sanitized batchResumePlan', async () => {
  await createBatchTask({
    id: 'batch-resume-route',
    name: 'Resume Route Batch',
    status: 'partial_failed',
    createdAt: now,
    updatedAt: now,
    skuTasks: [
      {
        skuId: 'SKU-SAFE',
        taskId: 'task-safe-route',
        displayName: 'Safe SKU',
        status: 'failed',
        currentStep: 'generate',
        queueStatus: 'failed',
        error: { code: 'GENERATE_FAILED', message: 'D:\\Code\\.env OPENAI_API_KEY=sk-secret app.sqlite node_modules' }
      }
    ]
  });
  await createTask({
    id: 'task-safe-route',
    batchId: 'batch-resume-route',
    sku: 'SKU-SAFE',
    status: 'planned',
    productInfoConfirmed: { sku: 'SKU-SAFE', name: 'Safe Product' },
    imagePlans: [{ id: 'plan-safe', type: 'feature_image' }],
    generatedImages: [{ id: 'img-failed', planId: 'plan-safe', type: 'feature_image', status: 'failed' }],
    reviewResults: [],
    review: null,
    normalizedReviewReport: null
  });
  const beforeBatch = await getBatchTask('batch-resume-route');

  await request(app)
    .get('/api/batches/batch-resume-route/resume-plan')
    .expect(200)
    .expect((res) => {
      const plan = res.body.batchResumePlan;
      assert.equal(plan.meta.batchId, 'batch-resume-route');
      assert.equal(plan.meta.mode, 'previewOnly');
      assert.equal(plan.summary.canExecuteBatchAutomatically, false);
      assert.equal(plan.resumeGroups.safeMockRetry.length, 1);
      assert.equal(plan.orderedPlan[0].recommendedRetryStep, 'imageGeneration');
      const json = JSON.stringify(res.body);
      assert.doesNotMatch(json, /\.env/i);
      assert.doesNotMatch(json, /OPENAI_API_KEY/i);
      assert.doesNotMatch(json, /sk-secret/i);
      assert.doesNotMatch(json, /[A-Z]:\\/);
      assert.doesNotMatch(json, /app\.sqlite/i);
      assert.doesNotMatch(json, /node_modules/i);
    });

  assert.deepEqual(await getBatchTask('batch-resume-route'), beforeBatch);
});

test('GET /api/batches/:batchId/resume-plan returns empty plan and 404 for missing batch', async () => {
  await createBatchTask({
    id: 'batch-empty-resume',
    name: 'Empty Resume',
    status: 'imported',
    createdAt: now,
    updatedAt: now,
    skuTasks: []
  });

  await request(app)
    .get('/api/batches/batch-empty-resume/resume-plan')
    .expect(200)
    .expect((res) => {
      assert.equal(res.body.batchResumePlan.summary.totalSku, 0);
      assert.deepEqual(res.body.batchResumePlan.orderedPlan, []);
      assert.equal(res.body.batchResumePlan.summary.canExecuteBatchAutomatically, false);
    });

  await request(app)
    .get('/api/batches/missing-batch/resume-plan')
    .expect(404);
});
