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
    id: 'batch-payload-route',
    name: 'Payload Route API_KEY=sk-secret D:\\Code\\.env',
    status: 'reviewed',
    createdAt: now,
    updatedAt: now,
    skuTasks: [
      { skuId: 'SKU-ROUTE', taskId: 'task-payload-route', status: 'reviewed' }
    ]
  });
  await createTask({
    id: 'task-payload-route',
    batchId: 'batch-payload-route',
    sku: 'SKU-ROUTE',
    status: 'reviewed',
    productInfoConfirmed: { sku: 'SKU-ROUTE', name: 'Route Product', category: 'Storage', description: 'Safe copy' },
    generatedImages: [
      { id: 'main', imageType: 'main_image', type: 'main_image', status: 'succeeded', provider: 'generated', sourceType: 'generated', platformId: 'temu' },
      { id: 'feature', imageType: 'feature_image', type: 'feature_image', status: 'succeeded', provider: 'generated', sourceType: 'generated', platformId: 'temu' }
    ],
    review: { reviewedAt: now, reviewMode: 'mock', overallStatus: 'passed', items: [] }
  });
}

test('POST /api/batches/:batchId/upload-payload/preview returns sanitized read-only payload preview', async () => {
  await seedRouteBatch();
  const beforeBatch = await getBatchTask('batch-payload-route');

  await request(app)
    .post('/api/batches/batch-payload-route/upload-payload/preview')
    .send({
      platforms: ['temu', 'miaoshou'],
      packageId: 'export-package-route-001',
      confirmDryRun: true,
      platformToken: 'sk-secret temu token D:\\Code\\.env'
    })
    .expect(200)
    .expect((res) => {
      const preview = res.body.uploadPayloadPreview;
      assert.equal(preview.meta.mode, 'payloadPreview');
      assert.equal(preview.meta.realNetworkCalled, false);
      assert.equal(preview.summary.totalSku, 1);
      assert.equal(Array.isArray(preview.platformPayloads), true);
      assert.equal(Array.isArray(preview.skuPayloads), true);
      assert.doesNotMatch(JSON.stringify(res.body), /\.env|API_KEY|sk-|[A-Z]:\\|app\.sqlite|node_modules|token|secret/i);
    });

  assert.equal(await getBatchTask('batch-payload-route').then((batch) => JSON.stringify(batch)), JSON.stringify(beforeBatch));
});

test('POST /api/batches/:batchId/upload-payload/preview requires confirmDryRun=true', async () => {
  await seedRouteBatch();

  await request(app)
    .post('/api/batches/batch-payload-route/upload-payload/preview')
    .send({ platforms: ['temu'] })
    .expect(400)
    .expect((res) => {
      assert.match(res.body.error, /confirmDryRun=true/);
    });
});

test('POST /api/batches/:batchId/upload-sandbox/simulate returns uploaded false and no network flags', async () => {
  await seedRouteBatch();
  const beforeBatch = await getBatchTask('batch-payload-route');

  await request(app)
    .post('/api/batches/batch-payload-route/upload-sandbox/simulate')
    .send({
      platforms: ['temu'],
      packageId: 'export-package-route-001',
      confirmSandboxSubmit: true
    })
    .expect(200)
    .expect((res) => {
      const report = res.body.uploadSandboxReport;
      assert.equal(report.meta.mode, 'sandboxSubmitSimulation');
      assert.equal(report.meta.realNetworkCalled, false);
      assert.equal(report.meta.externalApiCalled, false);
      assert.equal(report.meta.uploaded, false);
      assert.equal(report.simulatedResults[0].uploaded, false);
      assert.equal(report.simulatedResults[0].realNetworkCalled, false);
      assert.equal(report.simulatedResults[0].externalApiCalled, false);
      assert.doesNotMatch(JSON.stringify(res.body), /\.env|API_KEY|sk-|[A-Z]:\\|app\.sqlite|node_modules|token|secret/i);
    });

  assert.equal(await getBatchTask('batch-payload-route').then((batch) => JSON.stringify(batch)), JSON.stringify(beforeBatch));
});

test('POST /api/batches/:batchId/upload-sandbox/simulate requires confirmSandboxSubmit=true', async () => {
  await seedRouteBatch();

  await request(app)
    .post('/api/batches/batch-payload-route/upload-sandbox/simulate')
    .send({ platforms: ['temu'] })
    .expect(400)
    .expect((res) => {
      assert.match(res.body.error, /confirmSandboxSubmit=true/);
    });
});
