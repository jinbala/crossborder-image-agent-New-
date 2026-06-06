import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import request from 'supertest';
import app from '../src/app.js';
import { createTask, resetDatabaseForTests } from '../src/services/db.js';

function reviewedTask(overrides = {}) {
  return {
    id: 'review-report-route-task',
    status: 'reviewed',
    platformId: 'amazon',
    categoryId: 'electronics_storage',
    productInfoConfirmed: { sku: 'ROUTE-RR-001', name: 'Portable Drive' },
    sourceImages: [{ id: 'src-1', displayName: 'front.jpg', previewUrl: '/uploads/front.jpg' }],
    imagePlans: [],
    generatedImages: [{ id: 'img-1', planId: 'plan-1', type: 'main_image', fileName: 'main.jpg', isMockPreview: true, provider: 'mock' }],
    reviewResults: [],
    review: {
      reviewedAt: '2026-06-01T12:00:00.000Z',
      reviewMode: 'mock',
      overallStatus: 'failed',
      items: [{
        imageId: 'img-1',
        type: 'main_image',
        fileName: 'main.jpg',
        status: 'failed',
        issues: [
          { type: 'main_image_text', category: 'platform', message: 'Amazon main image has text' },
          { type: 'mock_preview', category: 'source', message: 'mock preview' }
        ]
      }]
    },
    ...overrides
  };
}

beforeEach(async () => {
  await resetDatabaseForTests();
});

test('GET /api/tasks/:id attaches normalized review report without mutating stored review fields', async () => {
  await createTask(reviewedTask());

  await request(app)
    .get('/api/tasks/review-report-route-task')
    .expect(200)
    .expect((res) => {
      const report = res.body.task.normalizedReviewReport;
      assert.ok(report);
      assert.equal(report.summary.fatalCount, 1);
      assert.equal(report.summary.mockInfoCount, 1);
      assert.equal(report.summary.realComplianceIssueCount, 1);
      assert.equal(report.summary.mockOnlyIssueCount, 1);
      assert.equal(res.body.task.review.items[0].issues.length, 2);
    });
});

test('GET /api/tasks/:id returns empty normalized review report when review is missing', async () => {
  await createTask(reviewedTask({ id: 'no-review-task', status: 'generated', review: null, reviewResults: [] }));

  await request(app)
    .get('/api/tasks/no-review-task')
    .expect(200)
    .expect((res) => {
      assert.equal(res.body.task.normalizedReviewReport.summary.totalIssues, 0);
      assert.match(res.body.task.normalizedReviewReport.nextSuggestedAction, /请先执行审核/);
    });
});
