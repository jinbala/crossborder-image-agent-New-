import assert from 'node:assert/strict';
import { test, beforeEach } from 'node:test';
import {
  analyzeBatchStability,
  buildBatchStabilityReport
} from '../src/services/batchStabilityService.js';
import {
  createBatchTask,
  createTask,
  getBatchTask,
  getTask,
  resetDatabaseForTests
} from '../src/services/db.js';

const now = '2026-06-01T12:00:00.000Z';

function batchTask(overrides = {}) {
  return {
    id: 'batch-stability-1',
    name: 'Stability Batch',
    status: 'partial_failed',
    createdAt: now,
    updatedAt: now,
    skuTasks: [],
    ...overrides
  };
}

function sku(overrides = {}) {
  return {
    skuId: 'SKU-BASE',
    taskId: 'task-base',
    displayName: 'Base SKU',
    status: 'uploaded',
    currentStep: 'uploaded',
    error: null,
    warnings: [],
    ...overrides
  };
}

function task(overrides = {}) {
  return {
    id: 'task-base',
    batchId: 'batch-stability-1',
    sku: 'SKU-BASE',
    status: 'uploaded',
    productInfo: null,
    productInfoRaw: null,
    productInfoConfirmed: null,
    imagePlans: [],
    generatedImages: [],
    review: null,
    normalizedReviewReport: null,
    recognitionQuality: null,
    ...overrides
  };
}

beforeEach(async () => {
  await resetDatabaseForTests();
});

test('buildBatchStabilityReport summarizes completed failed noReview and manual review SKU without mutating inputs', () => {
  const sourceBatch = batchTask({
    skuTasks: [
      sku({ skuId: 'SKU-DONE', taskId: 'task-done', status: 'exported', currentStep: 'exported' }),
      sku({ skuId: 'SKU-GEN-FAIL', taskId: 'task-gen-fail', status: 'failed', currentStep: 'generate', error: { code: 'GENERATE_FAILED', message: 'D:\\Code\\.env API_KEY=abc sk-secret app.sqlite node_modules' } }),
      sku({ skuId: 'SKU-NOREVIEW', taskId: 'task-no-review', status: 'generated', currentStep: 'generated' }),
      sku({ skuId: 'SKU-MANUAL', taskId: 'task-manual', status: 'reviewed', currentStep: 'reviewed' }),
      sku({ skuId: 'SKU-MOCK', taskId: 'task-mock', status: 'reviewed', currentStep: 'reviewed' })
    ]
  });
  const sourceTasks = [
    task({ id: 'task-done', sku: 'SKU-DONE', status: 'exported', productInfoConfirmed: { name: 'Done Product' }, exportFile: { status: 'succeeded' } }),
    task({
      id: 'task-gen-fail',
      sku: 'SKU-GEN-FAIL',
      status: 'planned',
      imagePlans: [{ id: 'plan-1' }],
      generatedImages: [{ id: 'img-1', status: 'failed', error: { message: 'provider timeout' } }]
    }),
    task({ id: 'task-no-review', sku: 'SKU-NOREVIEW', status: 'generated', generatedImages: [{ id: 'img-ok', status: 'succeeded' }], review: null }),
    task({
      id: 'task-manual',
      sku: 'SKU-MANUAL',
      status: 'reviewed',
      productInfoConfirmed: { name: 'Manual Product' },
      normalizedReviewReport: { summary: { fatalCount: 0, highCount: 1, mockInfoCount: 0 } },
      review: { items: [{ issues: [{ level: 'high', category: 'text', type: 'MAIN_IMAGE_TEXT', message: 'high text risk' }] }] }
    }),
    task({
      id: 'task-mock',
      sku: 'SKU-MOCK',
      status: 'reviewed',
      normalizedReviewReport: { summary: { fatalCount: 0, highCount: 0, mockInfoCount: 3 } },
      review: { overallStatus: 'failed', items: [{ issues: [{ severity: 'mockInfo', category: 'mock', type: 'MOCK_PREVIEW' }] }] }
    })
  ];
  const beforeBatch = structuredClone(sourceBatch);
  const beforeTasks = structuredClone(sourceTasks);

  const report = buildBatchStabilityReport(sourceBatch, sourceTasks, { generatedAt: now });
  const json = JSON.stringify(report);

  assert.equal(report.meta.batchId, 'batch-stability-1');
  assert.equal(report.meta.mode, 'readOnly');
  assert.equal(report.summary.totalSku, 5);
  assert.equal(report.summary.completedSku, 1);
  assert.equal(report.summary.failedSku, 1);
  assert.equal(report.summary.noReviewSku, 1);
  assert.equal(report.summary.needsManualReviewSku, 1);
  assert.equal(report.summary.canRetryCount, 1);
  assert.equal(report.summary.canResumeCount >= 1, true);
  assert.equal(report.failures.length, 1);
  assert.equal(report.failures[0].failedStep, 'imageGeneration');
  assert.equal(report.failures[0].canRetry, true);
  assert.equal(report.skuProgress.find((item) => item.sku === 'SKU-MANUAL').status, 'needsManualReview');
  assert.equal(report.skuProgress.find((item) => item.sku === 'SKU-MOCK').status, 'completed');
  assert.equal(report.stepSummary.imageGeneration.failed, 1);
  assert.equal(report.stepSummary.review.needsManualReview, 1);
  assert.equal(report.resumePlan.canResume, true);
  assert.equal(report.resumePlan.safeResumeSteps.includes('retryFailedSku'), true);
  assert.match(report.recommendations.join('\n'), /人工|重试|审核/);
  assert.doesNotMatch(json, /\.env/i);
  assert.doesNotMatch(json, /API_KEY/i);
  assert.doesNotMatch(json, /sk-secret/i);
  assert.doesNotMatch(json, /[A-Z]:\\/);
  assert.doesNotMatch(json, /app\.sqlite/i);
  assert.doesNotMatch(json, /node_modules/i);
  assert.deepEqual(sourceBatch, beforeBatch);
  assert.deepEqual(sourceTasks, beforeTasks);
});

test('buildBatchStabilityReport returns safe empty report for empty batch', () => {
  const report = buildBatchStabilityReport(batchTask({ skuTasks: [] }), [], { generatedAt: now });

  assert.equal(report.summary.totalSku, 0);
  assert.equal(report.skuProgress.length, 0);
  assert.equal(report.failures.length, 0);
  assert.equal(report.resumePlan.canResume, false);
  assert.match(report.warnings.join('\n'), /暂无 SKU/);
});

test('analyzeBatchStability reads current batch data without writing database records', async () => {
  await createBatchTask(batchTask({
    skuTasks: [
      sku({ skuId: 'SKU-RECOGNITION', taskId: 'task-recognition', status: 'failed', currentStep: 'recognize', error: { code: 'RECOGNITION_FAILED', message: 'parse failed' } })
    ]
  }));
  await createTask(task({ id: 'task-recognition', sku: 'SKU-RECOGNITION', status: 'uploaded' }));
  const beforeBatch = await getBatchTask('batch-stability-1');
  const beforeTask = await getTask('task-recognition');

  const report = await analyzeBatchStability('batch-stability-1', { generatedAt: now });

  assert.equal(report.failures[0].failedStep, 'recognition');
  assert.equal(report.failures[0].canRetry, true);
  assert.equal(report.skuProgress[0].canResume, true);
  assert.deepEqual(await getBatchTask('batch-stability-1'), beforeBatch);
  assert.deepEqual(await getTask('task-recognition'), beforeTask);
});

test('analyzeBatchStability returns 404 style error for missing batch', async () => {
  await assert.rejects(
    () => analyzeBatchStability('missing-batch'),
    (error) => error.statusCode === 404 && /Batch task not found/.test(error.message)
  );
});
