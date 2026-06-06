import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildBatchReviewReport } from '../src/services/batchReviewReportService.js';

function taskWithReview({ id, sku, issues = [], reviewMode = 'mock', overallStatus = 'failed' }) {
  return {
    id,
    status: 'reviewed',
    platformId: 'amazon',
    categoryId: 'electronics_storage',
    productInfoConfirmed: { sku, name: `${sku} Product` },
    generatedImages: [
      { id: `${id}-main`, type: 'main_image', isMockPreview: true },
      { id: `${id}-feature`, type: 'feature_image', isMockPreview: false }
    ],
    review: {
      reviewedAt: '2026-06-01T12:00:00.000Z',
      reviewMode,
      overallStatus,
      items: [
        {
          imageId: `${id}-main`,
          type: 'main_image',
          fileName: `${sku}-main.jpg`,
          issues
        }
      ]
    }
  };
}

function batchTask() {
  return {
    id: 'batch-review-001',
    name: 'Review batch',
    status: 'reviewed',
    skuTasks: [
      { skuId: 'SKU-PASS', taskId: 'task-pass', displayName: 'Passed SKU', status: 'reviewed' },
      { skuId: 'SKU-MOCK', taskId: 'task-mock', displayName: 'Mock SKU', status: 'reviewed' },
      { skuId: 'SKU-FATAL', taskId: 'task-fatal', displayName: 'Fatal SKU', status: 'reviewed' },
      { skuId: 'SKU-MEDIUM', taskId: 'task-medium', displayName: 'Medium SKU', status: 'reviewed' },
      { skuId: 'SKU-NO-REVIEW', taskId: 'task-no-review', displayName: 'No Review SKU', status: 'generated' }
    ]
  };
}

test('buildBatchReviewReport summarizes sku statuses and issue counts without mutating input', () => {
  const batch = batchTask();
  const tasks = [
    taskWithReview({ id: 'task-pass', sku: 'SKU-PASS', issues: [], overallStatus: 'passed' }),
    taskWithReview({ id: 'task-mock', sku: 'SKU-MOCK', issues: [{ type: 'mock_preview', category: 'source', message: 'mock preview only' }] }),
    taskWithReview({ id: 'task-fatal', sku: 'SKU-FATAL', issues: [{ type: 'main_image_text', category: 'platform', message: 'Amazon main image has text' }] }),
    taskWithReview({ id: 'task-medium', sku: 'SKU-MEDIUM', issues: [{ type: 'soft_layout_warning', category: 'layout', severity: 'medium', message: 'layout needs manual review' }] }),
    { id: 'task-no-review', status: 'generated', productInfoConfirmed: { sku: 'SKU-NO-REVIEW', name: 'No Review Product' }, review: null }
  ];
  const before = JSON.stringify({ batch, tasks });

  const report = buildBatchReviewReport(batch, tasks);

  assert.equal(JSON.stringify({ batch, tasks }), before);
  assert.equal(report.meta.batchId, 'batch-review-001');
  assert.equal(report.meta.totalSku, 5);
  assert.equal(report.summary.passedSku, 1);
  assert.equal(report.summary.failedSku, 1);
  assert.equal(report.summary.needsManualReviewSku, 1);
  assert.equal(report.summary.mockOnlySku, 1);
  assert.equal(report.summary.noReviewSku, 1);
  assert.equal(report.summary.fatalCount, 1);
  assert.equal(report.summary.mediumCount, 1);
  assert.equal(report.summary.mockInfoCount, 1);
  assert.equal(report.summary.realComplianceIssueCount, 2);
  assert.equal(report.summary.mockOnlyIssueCount, 1);
  assert.deepEqual(report.skuReports.map((item) => item.status), ['passed', 'mockOnly', 'failed', 'needsManualReview', 'noReview']);
  assert.equal(report.topRiskSku[0].sku, 'SKU-FATAL');
  assert.equal(report.issuesByCode.MAIN_IMAGE_TEXT, 1);
  assert.equal(report.issuesByImageType.main_image, 3);
  assert.equal(report.issuesBySeverity.fatal, 1);
  assert.equal(report.batchFixSummary.totalFixSuggestions, 3);
  assert.equal(report.batchFixSummary.autoFixCandidateCount, 1);
  assert.equal(report.batchFixSummary.manualConfirmRequiredCount, 1);
  assert.equal(report.batchFixSummary.mockOnlyCount, 1);
  assert.equal(report.batchFixSummary.byActionType.editTextLayout, 1);
  assert.equal(report.batchFixSummary.bySku.find((item) => item.sku === 'SKU-NO-REVIEW').fixSuggestionCount, 0);
  assert.equal(report.batchFixSummary.topFixSuggestions[0].actionType, 'editTextLayout');
  assert.match(report.recommendations.join('\n'), /请优先处理 fatal\/high 风险 SKU|未审核 SKU 建议先执行审核/);
  assert.match(report.nextSuggestedAction, /fatal 和 high 风险 SKU/);
});

test('buildBatchReviewReport returns a safe empty report and strips secrets from output', () => {
  const report = buildBatchReviewReport(
    { id: 'batch-empty', name: '.env API_KEY=sk-secret D:\\Code\\app.sqlite node_modules', skuTasks: [] },
    []
  );
  const json = JSON.stringify(report);

  assert.equal(report.meta.batchId, 'batch-empty');
  assert.equal(report.meta.totalSku, 0);
  assert.deepEqual(report.skuReports, []);
  assert.equal(report.batchFixSummary.totalFixSuggestions, 0);
  assert.doesNotMatch(json, /\.env/i);
  assert.doesNotMatch(json, /API_KEY/i);
  assert.doesNotMatch(json, /sk-secret/i);
  assert.doesNotMatch(json, /[A-Z]:\\/);
  assert.doesNotMatch(json, /app\.sqlite/i);
  assert.doesNotMatch(json, /node_modules/i);
});
