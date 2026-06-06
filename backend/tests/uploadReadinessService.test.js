import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { createBatchTask, createTask, getBatchTask, resetDatabaseForTests } from '../src/services/db.js';
import { getUploadProvider, listUploadProviders } from '../src/services/uploadProviderService.js';
import { buildUploadReadinessReport } from '../src/services/uploadReadinessService.js';

const now = '2026-06-01T12:00:00.000Z';

function image(type, platformId = 'temu', overrides = {}) {
  return {
    id: `${platformId}-${type}`,
    imageType: type,
    type,
    status: 'succeeded',
    provider: 'mock',
    isMockPreview: true,
    platformId,
    ...overrides
  };
}

function task(overrides = {}) {
  return {
    id: overrides.id || 'task-ready',
    batchId: 'batch-upload-ready',
    sku: overrides.sku || 'SKU-READY',
    status: 'reviewed',
    platformId: 'temu',
    categoryId: 'electronics_storage',
    productInfoConfirmed: {
      sku: overrides.sku || 'SKU-READY',
      name: 'Ready Product',
      category: 'External Storage',
      sellingPoints: ['Safe feature'],
      description: 'Safe listing copy.'
    },
    generatedImages: [
      image('main_image', 'temu'),
      image('feature_image', 'temu'),
      image('main_image', 'amazon'),
      image('feature_image', 'amazon')
    ],
    recognitionQuality: {},
    review: { reviewedAt: now, reviewMode: 'mock', overallStatus: 'passed', items: [] },
    ...overrides
  };
}

async function seedBatch() {
  await createBatchTask({
    id: 'batch-upload-ready',
    name: 'Upload Ready Batch API_KEY=sk-secret D:\\Code\\.env',
    status: 'reviewed',
    createdAt: now,
    updatedAt: now,
    skuTasks: [
      { skuId: 'SKU-READY', taskId: 'task-ready', displayName: 'SKU-READY', status: 'reviewed', currentStep: 'review' },
      { skuId: 'SKU-MISSING', taskId: 'task-missing', displayName: 'SKU-MISSING', status: 'reviewed', currentStep: 'review' },
      { skuId: 'SKU-NOREVIEW', taskId: 'task-noreview', displayName: 'SKU-NOREVIEW', status: 'generated', currentStep: 'review' },
      { skuId: 'SKU-FAILED', taskId: 'task-failed', displayName: 'SKU-FAILED', status: 'reviewed', currentStep: 'review' },
      { skuId: 'SKU-HIGH', taskId: 'task-high', displayName: 'SKU-HIGH', status: 'reviewed', currentStep: 'review' },
      { skuId: 'SKU-BATCH-FAILED', taskId: 'task-batch-failed', displayName: 'SKU-BATCH-FAILED', status: 'failed', currentStep: 'generate', error: { message: 'C:\\tmp\\.env provider token sk-secret app.sqlite node_modules' } }
    ]
  });
  await createTask(task());
  await createTask(task({
    id: 'task-missing',
    sku: 'SKU-MISSING',
    productInfoConfirmed: { sku: 'SKU-MISSING', name: '', category: '' },
    generatedImages: [image('feature_image', 'temu')],
    review: { reviewedAt: now, reviewMode: 'mock', overallStatus: 'passed', items: [] }
  }));
  await createTask(task({
    id: 'task-noreview',
    sku: 'SKU-NOREVIEW',
    status: 'generated',
    review: null
  }));
  await createTask(task({
    id: 'task-failed',
    sku: 'SKU-FAILED',
    review: { reviewedAt: now, reviewMode: 'mock', overallStatus: 'failed', items: [] }
  }));
  await createTask(task({
    id: 'task-high',
    sku: 'SKU-HIGH',
    review: { reviewedAt: now, reviewMode: 'mock', overallStatus: 'passed', items: [{ issues: [{ severity: 'high', type: 'high_risk_claim', message: 'high risk' }] }] }
  }));
  await createTask(task({
    id: 'task-batch-failed',
    sku: 'SKU-BATCH-FAILED'
  }));
}

beforeEach(async () => {
  await resetDatabaseForTests();
});

test('upload provider registry exposes dry-run Temu Miaoshou and placeholder providers only', () => {
  const temu = getUploadProvider('temu');
  const miaoshou = getUploadProvider('miaoshou');
  const amazon = getUploadProvider('amazon');

  assert.equal(temu.platformId, 'temu');
  assert.equal(temu.mode, 'dryRun');
  assert.equal(temu.supportsDryRun, true);
  assert.equal(temu.supportsRealUpload, false);
  assert.deepEqual(temu.requiredFields, ['sku', 'product_name', 'category', 'main_image']);
  assert.equal(miaoshou.platformId, 'miaoshou');
  assert.equal(miaoshou.supportsRealUpload, false);
  assert.equal(amazon.placeholder, true);
  assert.equal(listUploadProviders().some((provider) => provider.platformId === 'rakuten'), true);
});

test('buildUploadReadinessReport blocks missing fields images noReview failed high risk and warns about mock images without writing db', async () => {
  await seedBatch();
  const beforeBatch = await getBatchTask('batch-upload-ready');

  const report = await buildUploadReadinessReport('batch-upload-ready', {
    platforms: ['temu', 'miaoshou', 'amazon'],
    packageId: 'export-package-batch-upload-ready-001'
  });

  assert.equal(report.meta.batchId, 'batch-upload-ready');
  assert.equal(report.meta.mode, 'dryRun');
  assert.equal(report.meta.realUploadEnabled, false);
  assert.deepEqual(report.meta.targetPlatforms, ['temu', 'miaoshou', 'amazon']);
  assert.equal(report.summary.totalSku, 6);
  assert.equal(report.summary.canUploadNow, false);
  assert.equal(report.summary.blockedSku > 0, true);
  assert.equal(report.summary.warningSku > 0, true);
  assert.equal(report.summary.missingImageCount > 0, true);
  assert.equal(report.summary.missingFieldCount > 0, true);
  assert.equal(report.summary.noReviewSku > 0, true);
  assert.equal(report.summary.highRiskSku > 0, true);
  assert.equal(report.summary.mockImageSku > 0, true);
  assert.equal(report.platformReports.some((item) => item.platformId === 'temu' && item.provider === 'dryRun'), true);
  assert.equal(report.platformReports.some((item) => item.platformId === 'amazon' && item.warnings.some((warning) => /placeholder/i.test(warning.code))), true);
  assert.equal(report.skuReports.some((item) => item.sku === 'SKU-MISSING' && item.status === 'blocked' && item.missingImages.includes('main_image')), true);
  assert.equal(report.skuReports.some((item) => item.sku === 'SKU-NOREVIEW' && item.reviewStatus === 'noReview' && item.status === 'blocked'), true);
  assert.equal(report.skuReports.some((item) => item.sku === 'SKU-FAILED' && item.reviewStatus === 'failed' && item.status === 'blocked'), true);
  assert.equal(report.skuReports.some((item) => item.sku === 'SKU-HIGH' && item.hasHighRiskIssues === true && item.status === 'blocked'), true);
  assert.equal(report.warnings.some((warning) => /mock/i.test(warning.message)), true);
  assert.equal(report.blockingIssues.some((issue) => issue.code === 'PACKAGE_NOT_VERIFIED'), true);
  assert.equal(report.blockingIssues.some((issue) => issue.code === 'MISSING_LISTING_CSV'), true);
  assert.doesNotMatch(JSON.stringify(report), /\.env|API_KEY|sk-secret|[A-Z]:\\|app\.sqlite|node_modules|token/i);
  assert.equal(await getBatchTask('batch-upload-ready').then((batch) => JSON.stringify(batch)), JSON.stringify(beforeBatch));
});

test('buildUploadReadinessReport returns 404 style error for missing batch and sanitized empty report data', async () => {
  await assert.rejects(
    buildUploadReadinessReport('missing-batch', { platforms: ['temu'] }),
    /Batch task not found/
  );
});

test('buildUploadReadinessReport returns an empty dry-run report for an empty batch', async () => {
  await createBatchTask({
    id: 'batch-upload-empty',
    name: 'Empty upload readiness batch',
    status: 'created',
    createdAt: now,
    updatedAt: now,
    skuTasks: []
  });

  const report = await buildUploadReadinessReport('batch-upload-empty', {
    platforms: ['temu'],
    sandboxConfig: {
      temu: { accountName: 'seller name', apiKey: 'sk-secret', token: 'temu-token' }
    }
  });

  assert.equal(report.meta.mode, 'dryRun');
  assert.equal(report.meta.realUploadEnabled, false);
  assert.equal(report.meta.sandboxConfigSummary.configuredPlatforms, 1);
  assert.equal(report.summary.totalSku, 0);
  assert.equal(report.summary.blockedSku, 0);
  assert.equal(report.summary.canUploadNow, false);
  assert.deepEqual(report.skuReports, []);
  assert.doesNotMatch(JSON.stringify(report), /seller|sk-|token|secret/i);
});
