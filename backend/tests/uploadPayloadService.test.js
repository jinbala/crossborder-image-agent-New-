import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { createBatchTask, createTask, getBatchTask, resetDatabaseForTests } from '../src/services/db.js';
import { buildUploadPayloadPreview } from '../src/services/uploadPayloadService.js';

const now = '2026-06-01T12:00:00.000Z';

function image(type, platformId = 'temu', overrides = {}) {
  return {
    id: `${platformId}-${type}`,
    imageType: type,
    type,
    status: 'succeeded',
    provider: 'generated',
    sourceType: 'generated',
    platformId,
    ...overrides
  };
}

function task(overrides = {}) {
  return {
    id: overrides.id || 'task-ready',
    batchId: 'batch-payload',
    sku: overrides.sku || 'SKU-READY',
    status: 'reviewed',
    platformId: 'temu',
    categoryId: 'electronics_storage',
    productInfoConfirmed: {
      sku: overrides.sku || 'SKU-READY',
      name: 'Ready Product',
      category: 'External Storage',
      description: 'Safe product description.',
      sellingPoints: ['Fast backup', 'Portable design'],
      color: 'Black',
      capacity: '1TB',
      material: 'Aluminum',
      packageIncluded: ['Drive', 'Cable'],
      compatibleDevices: ['Laptop']
    },
    generatedImages: [image('main_image'), image('feature_image')],
    recognitionQuality: {},
    review: { reviewedAt: now, reviewMode: 'mock', overallStatus: 'passed', items: [] },
    ...overrides
  };
}

async function seedPayloadBatch() {
  await createBatchTask({
    id: 'batch-payload',
    name: 'Payload Batch API_KEY=sk-secret D:\\Code\\.env',
    status: 'reviewed',
    createdAt: now,
    updatedAt: now,
    skuTasks: [
      { skuId: 'SKU-READY', taskId: 'task-ready', status: 'reviewed', currentStep: 'review' },
      { skuId: 'SKU-MOCK', taskId: 'task-mock', status: 'reviewed', currentStep: 'review' },
      { skuId: 'SKU-MISSING', taskId: 'task-missing', status: 'reviewed', currentStep: 'review' },
      { skuId: 'SKU-NOREVIEW', taskId: 'task-noreview', status: 'generated', currentStep: 'review' },
      { skuId: 'SKU-FAILED', taskId: 'task-failed', status: 'reviewed', currentStep: 'review' },
      { skuId: 'SKU-HIGH', taskId: 'task-high', status: 'reviewed', currentStep: 'review' }
    ]
  });
  await createTask(task());
  await createTask(task({
    id: 'task-mock',
    sku: 'SKU-MOCK',
    generatedImages: [
      image('main_image', 'temu', { provider: 'mock', isMockPreview: true, sourceType: 'mock' }),
      image('feature_image', 'temu', { provider: 'mock', isMockPreview: true, sourceType: 'mock' })
    ]
  }));
  await createTask(task({
    id: 'task-missing',
    sku: 'SKU-MISSING',
    productInfoConfirmed: { sku: 'SKU-MISSING', name: '', category: '' },
    generatedImages: [image('feature_image')]
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
}

beforeEach(async () => {
  await resetDatabaseForTests();
});

test('buildUploadPayloadPreview requires confirmDryRun=true', async () => {
  await seedPayloadBatch();
  await assert.rejects(
    buildUploadPayloadPreview('batch-payload', { platforms: ['temu'] }),
    /confirmDryRun=true/
  );
});

test('buildUploadPayloadPreview generates Temu and Miaoshou payloads with blocked and warning SKU without writing db', async () => {
  await seedPayloadBatch();
  const beforeBatch = await getBatchTask('batch-payload');

  const preview = await buildUploadPayloadPreview('batch-payload', {
    platforms: ['temu', 'miaoshou', 'amazon'],
    packageId: 'export-package-payload-001',
    confirmDryRun: true
  });

  assert.equal(preview.meta.batchId, 'batch-payload');
  assert.equal(preview.meta.mode, 'payloadPreview');
  assert.equal(preview.meta.realUploadEnabled, false);
  assert.equal(preview.meta.realNetworkCalled, false);
  assert.deepEqual(preview.meta.targetPlatforms, ['temu', 'miaoshou', 'amazon']);
  assert.equal(preview.summary.totalSku, 6);
  assert.equal(preview.summary.readyPayloadCount > 0, true);
  assert.equal(preview.summary.warningPayloadCount > 0, true);
  assert.equal(preview.summary.blockedPayloadCount > 0, true);
  assert.equal(preview.platformPayloads.some((item) => item.platformId === 'temu'), true);
  assert.equal(preview.platformPayloads.some((item) => item.platformId === 'miaoshou'), true);
  assert.equal(preview.platformPayloads.some((item) => item.platformId === 'amazon' && item.placeholder === true), true);

  const temuReady = preview.skuPayloads.find((item) => item.platformId === 'temu' && item.sku === 'SKU-READY');
  assert.equal(temuReady.status, 'ready');
  assert.equal(temuReady.payload.productName, 'Ready Product');
  assert.equal(temuReady.payload.images.main.includes('Temu/SKU-READY/01_main.jpg'), true);
  assert.equal(temuReady.payload.images.gallery.length, 1);
  assert.equal(temuReady.payload.attributes.capacity, '1TB');

  const miaoshouReady = preview.skuPayloads.find((item) => item.platformId === 'miaoshou' && item.sku === 'SKU-READY');
  assert.equal(miaoshouReady.payload.title, 'Ready Product');
  assert.equal(miaoshouReady.payload.sourcePlatform, 'crossborder-image-agent');
  assert.equal(miaoshouReady.payload.listingCsvRow.sku, 'SKU-READY');
  assert.equal(miaoshouReady.payload.listingCsvRow.image_count > 0, true);
  assert.equal(miaoshouReady.missingFields.includes('listing_csv_row'), false);

  assert.equal(preview.skuPayloads.some((item) => item.sku === 'SKU-MOCK' && item.status === 'warning' && item.warnings.some((warning) => warning.code === 'MOCK_IMAGE_WARNING')), true);
  assert.equal(preview.skuPayloads.some((item) => item.sku === 'SKU-MISSING' && item.status === 'blocked' && item.missingFields.includes('productName')), true);
  assert.equal(preview.skuPayloads.some((item) => item.sku === 'SKU-MISSING' && item.status === 'blocked' && item.missingFields.includes('main_image')), true);
  assert.equal(preview.skuPayloads.some((item) => item.sku === 'SKU-NOREVIEW' && item.status === 'blocked'), true);
  assert.equal(preview.skuPayloads.some((item) => item.sku === 'SKU-FAILED' && item.status === 'blocked'), true);
  assert.equal(preview.skuPayloads.some((item) => item.sku === 'SKU-HIGH' && item.status === 'blocked'), true);
  assert.equal(preview.blockedPayloads.length > 0, true);
  assert.doesNotMatch(JSON.stringify(preview), /\.env|API_KEY|sk-|[A-Z]:\\|app\.sqlite|node_modules|token|secret/i);
  assert.equal(await getBatchTask('batch-payload').then((batch) => JSON.stringify(batch)), JSON.stringify(beforeBatch));
});
