import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { createBatchTask, createTask, getBatchTask, getTask, resetDatabaseForTests } from '../src/services/db.js';
import { getPlatformRuleSnapshot } from '../src/rules/platformRules.js';
import { planSkuRetry, executeSkuRetry } from '../src/services/skuRetryService.js';

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
    category: 'electronics_storage',
    rulesSnapshot: getPlatformRuleSnapshot({
      platformId: 'amazon',
      site: 'US',
      language: 'English',
      category: 'electronics_storage'
    })
  };
}

function plan(type = 'feature_image') {
  return {
    id: `plan-${type}`,
    type,
    title: `${type} plan`,
    platformId: 'amazon',
    platformName: 'Amazon',
    targetId: 'target-amazon',
    language: 'English',
    categoryId: 'electronics_storage',
    textBlocks: type === 'main_image' ? [] : [{ id: `${type}-text`, text: 'Fast backup', field: 'sellingPoints' }]
  };
}

function generatedImage(type = 'feature_image') {
  return {
    id: `image-${type}`,
    planId: `plan-${type}`,
    targetId: 'target-amazon',
    platformId: 'amazon',
    type,
    imageType: type,
    fileName: `${type}.jpg`,
    previewUrl: `/outputs/task-safe/${type}.jpg`,
    provider: 'mock',
    model: 'mock-image-test',
    status: 'succeeded',
    isMockPreview: true
  };
}

function task(overrides = {}) {
  return {
    id: 'task-safe',
    batchId: 'batch-safe',
    sku: 'SKU-SAFE',
    status: 'planned',
    sourceImages: [],
    productInfoRaw: { name: 'Raw Drive', capacity: ['9TB'] },
    productInfo: { name: 'Form Drive' },
    productInfoConfirmed: {
      sku: 'SKU-SAFE',
      name: 'Portable External Drive',
      category: 'External Storage',
      sellingPoints: ['Fast backup'],
      packageIncluded: ['USB-C cable']
    },
    fieldEvidence: { name: [{ source: 'visible_text', text: 'Portable External Drive' }] },
    inferredCandidates: [{ field: 'capacity', value: '9TB' }],
    recognitionQuality: { status: 'reviewed', blockedHighRisk: [{ field: 'capacity' }] },
    visibleText: ['Portable External Drive'],
    risks: [],
    confidence: {},
    recognitionMeta: { provider: 'mock-vision' },
    targets: [target()],
    imagePlans: [plan('feature_image')],
    generatedImages: [],
    reviewResults: [],
    review: null,
    exports: [],
    exportFile: null,
    createdAt: now,
    updatedAt: now,
    ...overrides
  };
}

function batch(overrides = {}) {
  return {
    id: 'batch-safe',
    name: 'Safe Retry Batch',
    status: 'partial_failed',
    createdAt: now,
    updatedAt: now,
    skuTasks: [
      {
        skuId: 'SKU-SAFE',
        taskId: 'task-safe',
        displayName: 'Safe SKU',
        status: 'failed',
        currentStep: 'generate',
        queueStatus: 'failed',
        error: { code: 'GENERATE_FAILED', message: 'mock generation failed' }
      }
    ],
    ...overrides
  };
}

async function seed({ batchOverrides = {}, taskOverrides = {} } = {}) {
  await createBatchTask(batch(batchOverrides));
  await createTask(task(taskOverrides));
}

beforeEach(async () => {
  await resetDatabaseForTests();
});

test('planSkuRetry builds a single-SKU retry plan from current batch and task state', async () => {
  await seed();

  const retryPlan = await planSkuRetry('batch-safe', 'task-safe');

  assert.equal(retryPlan.batchId, 'batch-safe');
  assert.equal(retryPlan.taskId, 'task-safe');
  assert.equal(retryPlan.sku, 'SKU-SAFE');
  assert.equal(retryPlan.failedStep, 'imageGeneration');
  assert.equal(retryPlan.canRetry, true);
  assert.deepEqual(retryPlan.allowedRetrySteps, ['imageGeneration']);
  assert.equal(retryPlan.blockedRetrySteps.some((item) => item.retryStep === 'recognition'), true);
  assert.equal(retryPlan.blockedRetrySteps.some((item) => item.retryStep === 'export'), true);
});

test('planSkuRetry returns 404 style errors for missing batch and missing task', async () => {
  await assert.rejects(
    () => planSkuRetry('missing-batch', 'task-safe'),
    (error) => error.statusCode === 404 && /Batch task not found/.test(error.message)
  );

  await createBatchTask(batch());
  await assert.rejects(
    () => planSkuRetry('batch-safe', 'missing-task'),
    (error) => error.statusCode === 404 && /Task not found/.test(error.message)
  );
});

test('executeSkuRetry requires explicit confirmation and blocks disallowed steps without writes', async () => {
  await seed();
  const beforeBatch = await getBatchTask('batch-safe');
  const beforeTask = await getTask('task-safe');

  await assert.rejects(
    () => executeSkuRetry('batch-safe', 'task-safe', { retryStep: 'imageGeneration', mode: 'mockOnly' }),
    (error) => error.statusCode === 400 && /confirmRetry/.test(error.message)
  );

  const blocked = await executeSkuRetry('batch-safe', 'task-safe', {
    retryStep: 'recognition',
    confirmRetry: true,
    mode: 'mockOnly',
    confirmPaidApi: false
  });

  assert.equal(blocked.status, 'blocked');
  assert.equal(blocked.retryStep, 'recognition');
  assert.deepEqual(await getBatchTask('batch-safe'), beforeBatch);
  assert.deepEqual(await getTask('task-safe'), beforeTask);
});

test('imagePlan retry only updates imagePlans and preserves recognition and generated/review data', async () => {
  await seed({
    batchOverrides: {
      skuTasks: [{
        skuId: 'SKU-SAFE',
        taskId: 'task-safe',
        displayName: 'Safe SKU',
        status: 'failed',
        currentStep: 'plan',
        queueStatus: 'failed',
        error: { code: 'PLAN_FAILED', message: 'plan failed' }
      }]
    },
    taskOverrides: {
      status: 'rules_selected',
      imagePlans: [],
      generatedImages: [generatedImage('feature_image')],
      review: { reviewedAt: now, reviewMode: 'mock', overallStatus: 'failed', items: [{ id: 'old-review' }] },
      reviewResults: [{ id: 'old-review' }]
    }
  });
  const before = await getTask('task-safe');

  const result = await executeSkuRetry('batch-safe', 'task-safe', {
    retryStep: 'imagePlan',
    confirmRetry: true,
    mode: 'mockOnly',
    confirmPaidApi: false
  });
  const after = await getTask('task-safe');

  assert.equal(result.status, 'completed');
  assert.equal(after.imagePlans.length > 0, true);
  assert.deepEqual(after.generatedImages, before.generatedImages);
  assert.deepEqual(after.review, before.review);
  assert.deepEqual(after.reviewResults, before.reviewResults);
  assert.deepEqual(after.productInfoConfirmed, before.productInfoConfirmed);
  assert.deepEqual(after.recognitionQuality, before.recognitionQuality);
  assert.deepEqual(after.fieldEvidence, before.fieldEvidence);
  assert.equal(after.status, before.status);
});

test('imageGeneration mock retry uses only mock output and leaves other SKU plus protected fields untouched', async () => {
  await createBatchTask(batch({
    skuTasks: [
      batch().skuTasks[0],
      { skuId: 'SKU-OTHER', taskId: 'task-other', displayName: 'Other SKU', status: 'planned', currentStep: 'planned' }
    ]
  }));
  await createTask(task());
  await createTask(task({ id: 'task-other', sku: 'SKU-OTHER', generatedImages: [generatedImage('detail_image')] }));
  const beforeBatch = await getBatchTask('batch-safe');
  const before = await getTask('task-safe');
  const otherBefore = await getTask('task-other');

  const result = await executeSkuRetry('batch-safe', 'task-safe', {
    retryStep: 'imageGeneration',
    confirmRetry: true,
    mode: 'mockOnly',
    confirmPaidApi: false
  });
  const after = await getTask('task-safe');

  assert.equal(result.status, 'completed');
  assert.equal(after.generatedImages.length, before.imagePlans.length);
  assert.equal(after.generatedImages.every((image) => image.provider === 'mock' && image.isMockPreview === true), true);
  assert.equal(JSON.stringify(after).includes('Image2'), false);
  assert.deepEqual(after.imagePlans, before.imagePlans);
  assert.deepEqual(after.review, before.review);
  assert.deepEqual(after.productInfoConfirmed, before.productInfoConfirmed);
  assert.deepEqual(after.recognitionQuality, before.recognitionQuality);
  assert.deepEqual(after.fieldEvidence, before.fieldEvidence);
  assert.equal(after.status, before.status);
  assert.deepEqual(await getTask('task-other'), otherBefore);
  assert.deepEqual(await getBatchTask('batch-safe'), beforeBatch);
});

test('review mock retry uses rule-based mock review and only updates review fields', async () => {
  await seed({
    batchOverrides: {
      skuTasks: [{
        skuId: 'SKU-SAFE',
        taskId: 'task-safe',
        displayName: 'Safe SKU',
        status: 'generated',
        currentStep: 'review'
      }]
    },
    taskOverrides: {
      status: 'generated',
      imagePlans: [plan('feature_image')],
      generatedImages: [generatedImage('feature_image')],
      review: null,
      reviewResults: []
    }
  });
  const before = await getTask('task-safe');

  const result = await executeSkuRetry('batch-safe', 'task-safe', {
    retryStep: 'review',
    confirmRetry: true,
    mode: 'mockOnly',
    confirmPaidApi: false
  });
  const after = await getTask('task-safe');

  assert.equal(result.status, 'completed');
  assert.equal(after.review.reviewMode, 'mock');
  assert.equal(after.reviewResults.every((item) => item.provider === 'mock' && item.isRealReview === false), true);
  assert.deepEqual(after.imagePlans, before.imagePlans);
  assert.deepEqual(after.generatedImages, before.generatedImages);
  assert.deepEqual(after.productInfoConfirmed, before.productInfoConfirmed);
  assert.deepEqual(after.fieldEvidence, before.fieldEvidence);
  assert.equal(after.status, before.status);
});

test('executeSkuRetry returns before and after snapshots and sanitized result payload', async () => {
  await seed({
    batchOverrides: {
      skuTasks: [{
        skuId: 'SKU-SAFE',
        taskId: 'task-safe',
        displayName: 'Safe SKU',
        status: 'failed',
        currentStep: 'generate',
        queueStatus: 'failed',
        error: { code: 'GENERATE_FAILED', message: 'D:\\Code\\.env API_KEY=abc sk-secret app.sqlite node_modules' }
      }]
    }
  });

  const result = await executeSkuRetry('batch-safe', 'task-safe', {
    retryStep: 'imageGeneration',
    confirmRetry: true,
    mode: 'mockOnly',
    confirmPaidApi: false
  });
  const json = JSON.stringify(result);

  assert.ok(result.beforeSnapshot);
  assert.ok(result.afterSnapshot);
  assert.ok(result.durationMs >= 0);
  assert.doesNotMatch(json, /\.env/i);
  assert.doesNotMatch(json, /API_KEY/i);
  assert.doesNotMatch(json, /sk-secret/i);
  assert.doesNotMatch(json, /[A-Z]:\\/);
  assert.doesNotMatch(json, /app\.sqlite/i);
  assert.doesNotMatch(json, /node_modules/i);
});
