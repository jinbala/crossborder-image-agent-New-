import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import {
  buildBatchReviewReportDownload,
  getBatchReviewReportDisplayModel
} from '../src/utils/batchReviewReport.js';

test('getBatchReviewReportDisplayModel summarizes batch review report for operators', () => {
  const model = getBatchReviewReportDisplayModel({
    meta: { batchId: 'batch-1', totalSku: 4 },
    summary: {
      passedSku: 1,
      failedSku: 1,
      needsManualReviewSku: 1,
      mockOnlySku: 1,
      noReviewSku: 0,
      fatalCount: 1,
      highCount: 2,
      mediumCount: 1,
      lowCount: 0,
      infoCount: 0,
      mockInfoCount: 1,
      realComplianceIssueCount: 4,
      mockOnlyIssueCount: 1
    },
    topRiskSku: [
      { sku: 'SKU-HIGH', productName: 'High Risk Product', fatalCount: 1, highCount: 2, topIssues: [{ title: '主图文字', severity: 'fatal' }], nextSuggestedAction: '请先处理 fatal。' }
    ],
    issuesByCode: { MAIN_IMAGE_TEXT: 1 },
    issuesByImageType: { main_image: 2 },
    issuesBySeverity: { fatal: 1, high: 2, mockInfo: 1 },
    mockInfoSummary: { MOCK_PREVIEW: 1 },
    batchFixSummary: {
      totalFixSuggestions: 3,
      autoFixCandidateCount: 1,
      manualConfirmRequiredCount: 1,
      mockOnlyCount: 1,
      byActionType: { editTextLayout: 1, manualCheck: 1, skipMockOnly: 1 },
      topFixSuggestions: [{ sku: 'SKU-HIGH', title: 'Amazon 主图移除所有文字', actionType: 'editTextLayout' }],
      recommendations: ['请优先人工核对需要确认的字段证据和主体保真问题。']
    },
    recommendations: ['请优先处理 fatal/high 风险 SKU。']
  });

  assert.equal(model.emptyText, '');
  assert.equal(model.overviewCards.some((card) => card.label === '失败 SKU' && card.value === 1), true);
  assert.equal(model.riskCards.some((card) => card.label === 'mockInfo' && card.value === 1), true);
  assert.equal(model.topRiskSku[0].sku, 'SKU-HIGH');
  assert.equal(model.mockInfoNotice.includes('不代表真实平台上传失败'), true);
});

test('buildBatchReviewReportDownload sanitizes JSON and uses required file name', () => {
  const download = buildBatchReviewReportDownload({
    report: {
      meta: { batchId: 'batch-1' },
      batchFixSummary: { totalFixSuggestions: 1 },
      recommendations: ['API_KEY=abc sk-secret123 D:\\Code\\app.sqlite node_modules .env']
    },
    batchId: 'batch-1',
    timestamp: '2026-06-01T12-00-00-000Z'
  });

  assert.equal(download.fileName, 'batch-review-report-batch-1-2026-06-01T12-00-00-000Z.json');
  assert.equal(download.mimeType, 'application/json');
  assert.equal(download.json.includes('API_KEY'), false);
  assert.equal(download.json.includes('sk-secret123'), false);
  assert.equal(download.json.includes('D:\\Code'), false);
  assert.equal(download.json.includes('app.sqlite'), false);
  assert.equal(download.json.includes('node_modules'), false);
  assert.equal(download.json.includes('.env'), false);
  assert.equal(download.json.includes('batchFixSummary'), true);
});

test('getBatchReviewReportDisplayModel exposes batch fix summary', () => {
  const model = getBatchReviewReportDisplayModel({
    meta: { batchId: 'batch-1', totalSku: 1 },
    summary: {},
    batchFixSummary: {
      totalFixSuggestions: 3,
      autoFixCandidateCount: 1,
      manualConfirmRequiredCount: 1,
      mockOnlyCount: 1,
      byActionType: { editTextLayout: 1, manualCheck: 1, skipMockOnly: 1 },
      topFixSuggestions: [{ sku: 'SKU-HIGH', title: 'Amazon 主图移除所有文字', actionType: 'editTextLayout' }],
      recommendations: ['请优先人工核对需要确认的字段证据和主体保真问题。']
    }
  });

  assert.equal(model.fixSummaryCards.some((card) => card.label === '总修正建议数' && card.value === 3), true);
  assert.equal(model.topFixSuggestions[0].actionType, 'editTextLayout');
  assert.equal(model.fixActionRows[0].label, 'editTextLayout');
});

test('BatchPage contains batch review summary area export button and API wiring', () => {
  const pageSource = fs.readFileSync(path.resolve('src/pages/BatchPage.jsx'), 'utf8');
  const apiSource = fs.readFileSync(path.resolve('src/services/api.js'), 'utf8');

  assert.match(pageSource, /批量审核摘要/);
  assert.match(pageSource, /导出批量审核报告 JSON/);
  assert.match(pageSource, /mock 提示仅表示流程测试信息/);
  assert.match(pageSource, /高风险 SKU/);
  assert.match(apiSource, /getBatchReviewReport/);
});

test('BatchPage contains batch fix suggestion summary', () => {
  const pageSource = fs.readFileSync(path.resolve('src/pages/BatchPage.jsx'), 'utf8');

  assert.match(pageSource, /批量修正建议摘要/);
  assert.match(pageSource, /topFixSuggestions/);
});
