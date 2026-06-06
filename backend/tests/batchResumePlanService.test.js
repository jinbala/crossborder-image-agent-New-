import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import {
  buildBatchResumePlan,
  buildBatchResumePlanFromReports
} from '../src/services/batchResumePlanService.js';
import {
  createBatchTask,
  createTask,
  getBatchTask,
  getTask,
  resetDatabaseForTests
} from '../src/services/db.js';

const now = '2026-06-01T12:00:00.000Z';

function sku(overrides = {}) {
  return {
    skuId: 'SKU-SAFE',
    taskId: 'task-safe',
    displayName: 'Safe SKU',
    status: 'failed',
    currentStep: 'generate',
    queueStatus: 'failed',
    error: null,
    ...overrides
  };
}

function task(overrides = {}) {
  return {
    id: 'task-safe',
    batchId: 'batch-resume',
    sku: 'SKU-SAFE',
    status: 'planned',
    productInfoConfirmed: { sku: 'SKU-SAFE', name: 'Safe Product' },
    imagePlans: [{ id: 'plan-safe', type: 'feature_image' }],
    generatedImages: [],
    reviewResults: [],
    review: null,
    normalizedReviewReport: null,
    recognitionQuality: null,
    fieldEvidence: {},
    createdAt: now,
    updatedAt: now,
    ...overrides
  };
}

function batch(overrides = {}) {
  return {
    id: 'batch-resume',
    name: 'Resume Preview Batch',
    status: 'partial_failed',
    createdAt: now,
    updatedAt: now,
    skuTasks: [
      sku()
    ],
    ...overrides
  };
}

async function seedMixedBatch() {
  await createBatchTask(batch({
    skuTasks: [
      sku({
        skuId: 'SKU-SAFE',
        taskId: 'task-safe',
        currentStep: 'generate',
        error: { code: 'GENERATE_FAILED', message: 'mock failed' }
      }),
      sku({
        skuId: 'SKU-MANUAL',
        taskId: 'task-manual',
        status: 'reviewed',
        currentStep: 'reviewed',
        queueStatus: 'idle'
      }),
      sku({
        skuId: 'SKU-BLOCKED',
        taskId: 'task-blocked',
        currentStep: 'recognize',
        error: { code: 'RECOGNITION_FAILED', message: 'OPENAI_API_KEY=sk-secret D:\\Code\\.env app.sqlite node_modules' }
      }),
      sku({
        skuId: 'SKU-NOREVIEW',
        taskId: 'task-no-review',
        status: 'generated',
        currentStep: 'review',
        queueStatus: 'idle'
      }),
      sku({
        skuId: 'SKU-DONE',
        taskId: 'task-done',
        status: 'exported',
        currentStep: 'exported',
        queueStatus: 'idle'
      })
    ]
  }));
  await createTask(task({
    id: 'task-safe',
    sku: 'SKU-SAFE',
    imagePlans: [{ id: 'plan-safe', type: 'feature_image' }],
    generatedImages: [{ id: 'img-failed', planId: 'plan-safe', type: 'feature_image', status: 'failed' }]
  }));
  await createTask(task({
    id: 'task-manual',
    sku: 'SKU-MANUAL',
    status: 'reviewed',
    recognitionQuality: { riskLevel: 'high', blockedHighRisk: [{ field: 'capacity' }] },
    normalizedReviewReport: { summary: { fatalCount: 0, highCount: 1 } },
    review: { items: [{ issues: [{ level: 'high', message: 'manual check required' }] }] }
  }));
  await createTask(task({
    id: 'task-blocked',
    sku: 'SKU-BLOCKED',
    status: 'uploaded',
    imagePlans: [],
    generatedImages: []
  }));
  await createTask(task({
    id: 'task-no-review',
    sku: 'SKU-NOREVIEW',
    status: 'generated',
    imagePlans: [{ id: 'plan-no-review', type: 'feature_image' }],
    generatedImages: [{ id: 'img-no-review', planId: 'plan-no-review', type: 'feature_image', status: 'succeeded' }],
    review: null,
    normalizedReviewReport: null
  }));
  await createTask(task({
    id: 'task-done',
    sku: 'SKU-DONE',
    status: 'exported',
    exportFile: { status: 'succeeded' },
    review: { reviewedAt: now, reviewMode: 'mock', overallStatus: 'passed', items: [] },
    normalizedReviewReport: { summary: { fatalCount: 0, highCount: 0 } }
  }));
}

beforeEach(async () => {
  await resetDatabaseForTests();
});

test('buildBatchResumePlanFromReports groups safe mock retry manual blocked noReview and completed SKU', () => {
  const stabilityReport = {
    meta: { batchId: 'batch-resume', generatedAt: now },
    summary: { totalSku: 5, noReviewSku: 1 },
    skuProgress: [
      { taskId: 'task-safe', sku: 'SKU-SAFE', productName: 'Safe Product', status: 'failed', failedStep: 'imageGeneration', canRetry: true, requiresManualAction: false, nextSuggestedAction: 'retry mock' },
      { taskId: 'task-manual', sku: 'SKU-MANUAL', productName: 'Manual Product', status: 'needsManualReview', failedStep: '', canRetry: false, requiresManualAction: true, nextSuggestedAction: 'manual first' },
      { taskId: 'task-blocked', sku: 'SKU-BLOCKED', productName: 'Blocked Product', status: 'failed', failedStep: 'recognition', canRetry: true, requiresManualAction: false, nextSuggestedAction: 'blocked real provider' },
      { taskId: 'task-no-review', sku: 'SKU-NOREVIEW', productName: 'No Review Product', status: 'noReview', failedStep: '', canRetry: false, requiresManualAction: false, nextSuggestedAction: 'review first' },
      { taskId: 'task-done', sku: 'SKU-DONE', productName: 'Done Product', status: 'completed', failedStep: '', canRetry: false, requiresManualAction: false, nextSuggestedAction: 'done' }
    ],
    failures: []
  };
  const retryPlansByTaskId = new Map([
    ['task-safe', { allowedRetrySteps: ['imageGeneration'], canRetry: true, warnings: [] }],
    ['task-blocked', {
      allowedRetrySteps: [],
      canRetry: false,
      warnings: ['requires real Provider'],
      blockedRetrySteps: [{ retryStep: 'recognition', reason: '需要真实 Provider' }]
    }],
    ['task-no-review', { allowedRetrySteps: ['review'], canRetry: true, warnings: [] }]
  ]);

  const plan = buildBatchResumePlanFromReports({ batchId: 'batch-resume', stabilityReport, retryPlansByTaskId, generatedAt: now });

  assert.equal(plan.meta.mode, 'previewOnly');
  assert.equal(plan.summary.totalSku, 5);
  assert.equal(plan.summary.canExecuteBatchAutomatically, false);
  assert.equal(plan.summary.recoverableSku, 1);
  assert.equal(plan.summary.manualOnlySku, 1);
  assert.equal(plan.summary.blockedSku, 1);
  assert.equal(plan.summary.noReviewSku, 1);
  assert.equal(plan.resumeGroups.safeMockRetry[0].taskId, 'task-safe');
  assert.equal(plan.resumeGroups.manualRequired[0].taskId, 'task-manual');
  assert.equal(plan.resumeGroups.blocked[0].taskId, 'task-blocked');
  assert.equal(plan.resumeGroups.noReview[0].taskId, 'task-no-review');
  assert.equal(plan.resumeGroups.completed[0].taskId, 'task-done');
  assert.deepEqual(plan.orderedPlan.map((item) => item.taskId), ['task-safe', 'task-no-review', 'task-manual', 'task-blocked']);
  assert.equal(plan.orderedPlan[0].recommendedRetryStep, 'imageGeneration');
  assert.equal(plan.orderedPlan[0].mode, 'mockOnly');
  assert.equal(plan.orderedPlan[0].paidApiRisk, false);
  assert.match(plan.nextSuggestedAction, /逐个 SKU|閫愪釜 SKU/);
});

test('new real-test pending recognition SKU is waiting not blocked and paid API risk is warning only', () => {
  const stabilityReport = {
    meta: { batchId: 'batch-real-test', generatedAt: now },
    summary: { totalSku: 1 },
    skuProgress: [{
      taskId: 'task-fresh',
      sku: 'SKU-FRESH',
      productName: 'Fresh Product',
      status: 'pending',
      currentStep: 'recognition',
      completedSteps: ['upload'],
      pendingSteps: ['recognition', 'productConfirm', 'platformRules', 'imagePlan', 'imageGeneration', 'review', 'export'],
      failedStep: '',
      errorMessage: '',
      canRetry: false,
      canResume: true,
      requiresManualAction: false,
      nextSuggestedAction: '真实识别可能产生 API 成本，请确认后启动。'
    }],
    failures: []
  };
  const retryPlansByTaskId = new Map([[
    'task-fresh',
    {
      taskId: 'task-fresh',
      sku: 'SKU-FRESH',
      canRetry: false,
      allowedRetrySteps: [],
      blockedRetrySteps: [{ retryStep: 'recognition', reason: '第一阶段暂不执行识别重试，避免重复调用真实识别 Provider 或污染识别字段。' }],
      warnings: ['当前 SKU 没有可安全执行的重试步骤。']
    }
  ]]);

  const plan = buildBatchResumePlanFromReports({ batchId: 'batch-real-test', stabilityReport, retryPlansByTaskId, generatedAt: now });

  assert.equal(plan.resumeGroups.blocked.length, 0);
  assert.equal(plan.summary.blockedSku, 0);
  assert.equal(plan.resumeGroups.waiting.length, 1);
  assert.equal(plan.resumeGroups.waiting[0].taskId, 'task-fresh');
  assert.equal(plan.resumeGroups.waiting[0].blockedReason, '');
  assert.equal(plan.resumeGroups.waiting[0].paidApiRisk, true);
  assert.equal(plan.summary.paidApiRiskCount, 1);
  assert.match(plan.warnings.join('\n'), /真实 Provider|Provider/);
  assert.doesNotMatch(JSON.stringify(plan.resumeGroups.blocked), /第一阶段暂不执行识别重试/);
});

test('recognition retry and failed SKU remain blocked in resume plan', () => {
  const stabilityReport = {
    meta: { batchId: 'batch-resume', generatedAt: now },
    summary: { totalSku: 2 },
    skuProgress: [
      {
        taskId: 'task-recognition-failed',
        sku: 'SKU-RECOGNITION-FAILED',
        productName: 'Recognition Failed Product',
        status: 'failed',
        currentStep: 'recognition',
        completedSteps: ['upload'],
        pendingSteps: ['productConfirm', 'platformRules', 'imagePlan', 'imageGeneration', 'review', 'export'],
        failedStep: 'recognition',
        errorMessage: 'provider timeout',
        canRetry: true,
        canResume: true,
        requiresManualAction: false,
        nextSuggestedAction: 'recognition retry is blocked'
      },
      {
        taskId: 'task-manual-failed',
        sku: 'SKU-MANUAL-FAILED',
        productName: 'Manual Failed Product',
        status: 'failed',
        currentStep: 'unknown',
        completedSteps: [],
        pendingSteps: [],
        failedStep: 'unknown',
        errorMessage: 'manual required',
        canRetry: false,
        canResume: false,
        requiresManualAction: false,
        nextSuggestedAction: 'manual required'
      }
    ],
    failures: []
  };
  const retryPlansByTaskId = new Map([
    ['task-recognition-failed', {
      taskId: 'task-recognition-failed',
      sku: 'SKU-RECOGNITION-FAILED',
      canRetry: false,
      allowedRetrySteps: [],
      blockedRetrySteps: [{ retryStep: 'recognition', reason: '第一阶段暂不执行识别重试，避免重复调用真实识别 Provider 或污染识别字段。' }],
      warnings: ['requires real Provider']
    }],
    ['task-manual-failed', {
      taskId: 'task-manual-failed',
      sku: 'SKU-MANUAL-FAILED',
      canRetry: false,
      allowedRetrySteps: [],
      blockedRetrySteps: [{ retryStep: 'unknown', reason: '无法安全恢复。' }],
      warnings: []
    }]
  ]);

  const plan = buildBatchResumePlanFromReports({ batchId: 'batch-resume', stabilityReport, retryPlansByTaskId, generatedAt: now });

  assert.equal(plan.resumeGroups.blocked.length, 2);
  assert.equal(plan.resumeGroups.blocked.some((item) => item.taskId === 'task-recognition-failed'), true);
  assert.equal(plan.resumeGroups.blocked.some((item) => item.taskId === 'task-manual-failed'), true);
  assert.equal(plan.summary.blockedSku, 2);
});

test('buildBatchResumePlan keeps newly imported real-test SKU waiting before recognition starts', async () => {
  await createBatchTask(batch({
    id: 'batch-real-test',
    name: 'Real Test Batch',
    status: 'imported',
    workflowTemplateSnapshot: {
      id: 'real_api_small_batch_test',
      modes: {
        recognition: 'real',
        imageGeneration: 'real-test',
        review: 'real',
        upload: 'dry-run'
      }
    },
    skuTasks: [sku({
      skuId: 'SKU-FRESH',
      taskId: 'task-fresh',
      displayName: 'Fresh Product',
      status: 'uploaded',
      currentStep: 'imported',
      queueStatus: 'pending',
      error: null
    })]
  }));
  await createTask(task({
    id: 'task-fresh',
    batchId: 'batch-real-test',
    sku: 'SKU-FRESH',
    status: 'uploaded',
    productInfoRaw: null,
    productInfo: null,
    productInfoConfirmed: null,
    imagePlans: [],
    generatedImages: [],
    review: null,
    normalizedReviewReport: null,
    recognitionQuality: null,
    fieldEvidence: {}
  }));

  const beforeBatch = await getBatchTask('batch-real-test');
  const beforeTask = await getTask('task-fresh');
  const plan = await buildBatchResumePlan('batch-real-test', { generatedAt: now });

  assert.equal(plan.resumeGroups.blocked.length, 0);
  assert.equal(plan.summary.blockedSku, 0);
  assert.equal(plan.resumeGroups.waiting.length, 1);
  assert.equal(plan.resumeGroups.waiting[0].taskId, 'task-fresh');
  assert.equal(plan.summary.paidApiRiskCount, 1);
  assert.match(plan.warnings.join('\n'), /Provider/);
  assert.deepEqual(await getBatchTask('batch-real-test'), beforeBatch);
  assert.deepEqual(await getTask('task-fresh'), beforeTask);
});

test('buildBatchResumePlan reads existing data without writing batch or task records', async () => {
  await seedMixedBatch();
  const beforeBatch = await getBatchTask('batch-resume');
  const beforeTask = await getTask('task-safe');

  const plan = await buildBatchResumePlan('batch-resume', { generatedAt: now });

  assert.equal(plan.summary.totalSku, 5);
  assert.equal(plan.summary.canExecuteBatchAutomatically, false);
  assert.equal(plan.resumeGroups.safeMockRetry.length, 1);
  assert.equal(plan.resumeGroups.manualRequired.length, 1);
  assert.equal(plan.resumeGroups.blocked.length, 1);
  assert.equal(plan.resumeGroups.noReview.length, 1);
  assert.equal(plan.resumeGroups.completed.length, 1);
  assert.equal(plan.summary.paidApiRiskCount >= 1, true);
  assert.deepEqual(await getBatchTask('batch-resume'), beforeBatch);
  assert.deepEqual(await getTask('task-safe'), beforeTask);
});

test('buildBatchResumePlan returns safe empty plan for empty batch', async () => {
  await createBatchTask(batch({ skuTasks: [], status: 'imported' }));

  const plan = await buildBatchResumePlan('batch-resume', { generatedAt: now });

  assert.equal(plan.summary.totalSku, 0);
  assert.equal(plan.summary.recoverableSku, 0);
  assert.deepEqual(plan.orderedPlan, []);
  assert.match(plan.warnings.join('\n'), /暂无 SKU|鏆傛棤 SKU/);
});

test('buildBatchResumePlan returns 404 style error for missing batch and sanitizes output', async () => {
  await assert.rejects(
    () => buildBatchResumePlan('missing-batch'),
    (error) => error.statusCode === 404 && /Batch task not found/.test(error.message)
  );

  await seedMixedBatch();
  const plan = await buildBatchResumePlan('batch-resume', { generatedAt: now });
  const json = JSON.stringify(plan);

  assert.doesNotMatch(json, /\.env/i);
  assert.doesNotMatch(json, /API_KEY/i);
  assert.doesNotMatch(json, /sk-secret/i);
  assert.doesNotMatch(json, /[A-Z]:\\/);
  assert.doesNotMatch(json, /app\.sqlite/i);
  assert.doesNotMatch(json, /node_modules/i);
});
