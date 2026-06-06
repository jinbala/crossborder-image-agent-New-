import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildReviewReport } from '../src/services/reviewReportService.js';

function taskWithReview(overrides = {}) {
  return {
    id: 'review-report-task',
    platformId: 'amazon',
    categoryId: 'electronics_storage',
    productInfoConfirmed: { sku: 'RR-001', name: 'Portable Drive' },
    generatedImages: [
      { id: 'img-main', type: 'main_image', isMockPreview: true },
      { id: 'img-feature', type: 'feature_image', isMockPreview: false }
    ],
    review: {
      reviewedAt: '2026-06-01T12:00:00.000Z',
      reviewMode: 'mock',
      overallStatus: 'failed',
      items: [
        {
          imageId: 'img-main',
          type: 'main_image',
          fileName: 'main.jpg',
          reviewMode: 'mock',
          issues: [
            { type: 'main_image_text', category: 'platform', level: 'high', message: 'main image text' },
            { type: 'mock_preview', category: 'source', level: 'medium', message: 'mock preview' }
          ]
        },
        {
          imageId: 'img-feature',
          type: 'feature_image',
          fileName: 'feature.jpg',
          issues: [
            { type: 'chinese_text', category: 'text', level: 'high', message: '含中文' },
            { type: 'unconfirmed_capacity', category: 'evidence', level: 'high', fieldKey: 'capacity', message: 'capacity missing D:\\Code\\.env OPENAI_API_KEY=sk-secret app.sqlite node_modules' }
          ]
        }
      ]
    },
    ...overrides
  };
}

test('builds structured review report summary grouped issues and recommendations', () => {
  const report = buildReviewReport(taskWithReview());

  assert.equal(report.meta.taskId, 'review-report-task');
  assert.equal(report.meta.sku, 'RR-001');
  assert.equal(report.meta.reviewMode, 'mock');
  assert.equal(report.summary.passed, false);
  assert.equal(report.summary.fatalCount, 3);
  assert.equal(report.summary.mockInfoCount, 1);
  assert.equal(report.summary.realComplianceIssueCount, 3);
  assert.equal(report.summary.mockOnlyIssueCount, 1);
  assert.equal(report.summary.manualConfirmRequiredCount >= 1, true);
  assert.equal(report.groupedIssues.length >= 3, true);
  assert.ok(report.byImageType.main_image);
  assert.ok(report.byImageType.feature_image);
  assert.equal(report.fixSuggestions.some((item) => item.actionType === 'editTextLayout'), true);
  assert.equal(report.fixSuggestions.some((item) => item.actionType === 'confirmFieldEvidence'), true);
  assert.equal(report.fixSummary.total, report.fixSuggestions.length);
  assert.equal(report.fixSummary.byActionType.skipMockOnly, 1);
  assert.match(report.recommendations.join('\n'), /fatal|高风险|中文|Amazon/);
  assert.match(report.nextSuggestedAction, /fatal|high/);
});

test('buildReviewReport returns safe empty report when review is missing', () => {
  const report = buildReviewReport(taskWithReview({ review: null }));

  assert.equal(report.summary.totalIssues, 0);
  assert.equal(report.summary.passed, false);
  assert.deepEqual(report.groupedIssues, []);
  assert.deepEqual(report.fixSuggestions, []);
  assert.equal(report.fixSummary.total, 0);
  assert.match(report.nextSuggestedAction, /请先执行审核/);
});

test('review report strips secrets local paths and sqlite markers', () => {
  const report = buildReviewReport(taskWithReview());
  const json = JSON.stringify(report);

  assert.doesNotMatch(json, /\.env/i);
  assert.doesNotMatch(json, /OPENAI_API_KEY/i);
  assert.doesNotMatch(json, /sk-secret/i);
  assert.doesNotMatch(json, /[A-Z]:\\/);
  assert.doesNotMatch(json, /app\.sqlite/i);
  assert.doesNotMatch(json, /node_modules/i);
});
