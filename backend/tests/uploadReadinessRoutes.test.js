import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import request from 'supertest';
import app from '../src/app.js';
import { createBatchTask, createTask, getBatchTask, resetDatabaseForTests } from '../src/services/db.js';

const now = '2026-06-01T12:00:00.000Z';

beforeEach(async () => {
  await resetDatabaseForTests();
});

async function seedRouteBatch() {
  await createBatchTask({
    id: 'batch-upload-route',
    name: 'Upload Route Batch API_KEY=sk-secret D:\\Code\\.env',
    status: 'reviewed',
    createdAt: now,
    updatedAt: now,
    skuTasks: [
      { skuId: 'SKU-ROUTE', taskId: 'task-upload-route', displayName: 'SKU-ROUTE', status: 'reviewed', currentStep: 'review' }
    ]
  });
  await createTask({
    id: 'task-upload-route',
    batchId: 'batch-upload-route',
    sku: 'SKU-ROUTE',
    status: 'reviewed',
    productInfoConfirmed: { sku: 'SKU-ROUTE', name: 'Route Product', category: 'Storage' },
    generatedImages: [
      { id: 'main', imageType: 'main_image', type: 'main_image', status: 'succeeded', provider: 'mock', isMockPreview: true, platformId: 'temu' },
      { id: 'feature', imageType: 'feature_image', type: 'feature_image', status: 'succeeded', provider: 'mock', isMockPreview: true, platformId: 'temu' }
    ],
    recognitionQuality: {},
    review: { reviewedAt: now, reviewMode: 'mock', overallStatus: 'passed', items: [] }
  });
}

test('GET /api/batches/:batchId/upload-readiness/preview returns sanitized read-only dry-run report', async () => {
  await seedRouteBatch();
  const beforeBatch = await getBatchTask('batch-upload-route');

  await request(app)
    .get('/api/batches/batch-upload-route/upload-readiness/preview?platforms=temu,miaoshou')
    .expect(200)
    .expect((res) => {
      const report = res.body.uploadReadinessReport;
      assert.equal(report.meta.batchId, 'batch-upload-route');
      assert.equal(report.meta.mode, 'dryRun');
      assert.equal(report.meta.realUploadEnabled, false);
      assert.deepEqual(report.meta.targetPlatforms, ['temu', 'miaoshou']);
      assert.equal(report.summary.canUploadNow, false);
      assert.equal(Array.isArray(report.platformReports), true);
      assert.equal(Array.isArray(report.skuReports), true);
      assert.doesNotMatch(JSON.stringify(res.body), /\.env|API_KEY|sk-|[A-Z]:\\|app\.sqlite|node_modules|token/i);
    });

  assert.equal(await getBatchTask('batch-upload-route').then((batch) => JSON.stringify(batch)), JSON.stringify(beforeBatch));
});

test('POST /api/batches/:batchId/upload-readiness/preview runs confirmed sandbox dry-run without storing credentials', async () => {
  await seedRouteBatch();
  const beforeBatch = await getBatchTask('batch-upload-route');

  await request(app)
    .post('/api/batches/batch-upload-route/upload-readiness/preview')
    .send({
      platforms: ['temu', 'miaoshou', 'bad'],
      packageId: 'export-package-route-001',
      confirmDryRun: true,
      platformAccounts: {
        temu: { accountName: 'temu seller', apiKey: 'sk-secret', token: 'temu-token D:\\Code\\.env' },
        miaoshou: { accountName: 'miaoshou seller', secret: 'provider-secret app.sqlite node_modules' }
      }
    })
    .expect(200)
    .expect((res) => {
      const report = res.body.uploadReadinessReport;
      assert.equal(report.meta.mode, 'dryRun');
      assert.equal(report.meta.realUploadEnabled, false);
      assert.deepEqual(report.meta.targetPlatforms, ['temu', 'miaoshou']);
      assert.equal(report.meta.sandboxConfigSummary.configuredPlatforms, 2);
      assert.equal(report.meta.sandboxConfigSummary.platforms.every((item) => item.credentialProvided === true), true);
      assert.equal(report.summary.canUploadNow, false);
      assert.doesNotMatch(JSON.stringify(res.body), /\.env|API_KEY|sk-|[A-Z]:\\|app\.sqlite|node_modules|token|secret|seller/i);
    });

  assert.equal(await getBatchTask('batch-upload-route').then((batch) => JSON.stringify(batch)), JSON.stringify(beforeBatch));
});

test('POST /api/batches/:batchId/upload-readiness/preview requires confirmDryRun=true', async () => {
  await seedRouteBatch();

  await request(app)
    .post('/api/batches/batch-upload-route/upload-readiness/preview')
    .send({ platforms: ['temu'] })
    .expect(400)
    .expect((res) => {
      assert.match(res.body.error, /confirmDryRun=true/);
    });
});

test('upload readiness route returns 404 for missing batch', async () => {
  await request(app)
    .get('/api/batches/missing-batch/upload-readiness/preview?platforms=temu')
    .expect(404);
});
