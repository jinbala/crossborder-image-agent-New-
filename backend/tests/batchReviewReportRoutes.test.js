import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import request from 'supertest';
import app from '../src/app.js';
import { createBatchTask, createTask, readDb, resetDatabaseForTests } from '../src/services/db.js';

beforeEach(async () => {
  await resetDatabaseForTests();
});

async function seedBatch() {
  await createTask({
    id: 'route-review-task',
    status: 'reviewed',
    productInfoConfirmed: { sku: 'ROUTE-SKU', name: 'Route Product' },
    generatedImages: [{ id: 'route-img-main', type: 'main_image', isMockPreview: true }],
    review: {
      reviewMode: 'mock',
      overallStatus: 'failed',
      items: [{
        imageId: 'route-img-main',
        type: 'main_image',
        issues: [
          { type: 'main_image_text', category: 'platform', message: 'Amazon main image text' },
          { type: 'mock_preview', category: 'source', message: '.env API_KEY=sk-secret D:\\Code\\app.sqlite node_modules' }
        ]
      }]
    }
  });
  await createBatchTask({
    id: 'route-batch-review',
    name: 'Route batch',
    status: 'reviewed',
    skuTasks: [
      { skuId: 'ROUTE-SKU', taskId: 'route-review-task', displayName: 'Route SKU', status: 'reviewed' },
      { skuId: 'NO-REVIEW', taskId: 'missing-task', displayName: 'No Review', status: 'generated' }
    ],
    createdAt: '2026-06-01T12:00:00.000Z',
    updatedAt: '2026-06-01T12:00:00.000Z'
  });
}

test('GET /api/batches/:batchId/review-report returns read-only sanitized BatchReviewReport', async () => {
  await seedBatch();
  const before = JSON.stringify(await readDb());

  await request(app)
    .get('/api/batches/route-batch-review/review-report')
    .expect(200)
    .expect((res) => {
      assert.equal(res.body.batchId, 'route-batch-review');
      assert.equal(res.body.reviewReport.summary.failedSku, 1);
      assert.equal(res.body.reviewReport.summary.noReviewSku, 1);
      assert.equal(res.body.reviewReport.summary.mockOnlyIssueCount, 1);
      assert.equal(res.body.reviewReport.skuReports[1].status, 'noReview');
      const json = JSON.stringify(res.body);
      assert.doesNotMatch(json, /\.env/i);
      assert.doesNotMatch(json, /API_KEY/i);
      assert.doesNotMatch(json, /sk-secret/i);
      assert.doesNotMatch(json, /[A-Z]:\\/);
      assert.doesNotMatch(json, /app\.sqlite/i);
      assert.doesNotMatch(json, /node_modules/i);
    });

  assert.equal(JSON.stringify(await readDb()), before);
});

test('GET /api/batches/:batchId/review-report returns 404 for missing batch', async () => {
  await request(app)
    .get('/api/batches/missing-batch/review-report')
    .expect(404);
});
