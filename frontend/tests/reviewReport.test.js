import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import {
  buildReviewReportDownload,
  getReviewReportDisplayModel
} from '../src/utils/reviewReport.js';

test('getReviewReportDisplayModel separates compliance issues from mock process hints', () => {
  const model = getReviewReportDisplayModel({
    summary: {
      passed: false,
      fatalCount: 1,
      highCount: 1,
      mediumCount: 0,
      lowCount: 0,
      infoCount: 0,
      mockInfoCount: 1,
      totalIssues: 3,
      realComplianceIssueCount: 2,
      mockOnlyIssueCount: 1
    },
    nextSuggestedAction: '请先处理 fatal 和 high 风险问题，再进入导出。',
    groupedIssues: [
      { groupKey: 'mock:MOCK_PREVIEW_SOURCE', severity: 'mockInfo', title: 'mock 提示', count: 1, suggestion: 'mock 仅用于流程测试。' },
      { groupKey: 'MAIN_IMAGE_TEXT:main_image', severity: 'fatal', title: 'Amazon 主图包含文字', count: 1, suggestion: 'Amazon 主图应保持白底无文字。' },
      { groupKey: 'field:capacity:UNCONFIRMED_CAPACITY', severity: 'high', title: '容量字段问题', count: 1, suggestion: '请先确认容量证据。' }
    ]
  });

  assert.equal(model.emptyText, '');
  assert.equal(model.summaryCards.some((card) => card.label === '真实合规问题' && card.value === 2), true);
  assert.deepEqual(model.complianceGroups.map((group) => group.severity), ['fatal', 'high']);
  assert.deepEqual(model.mockHintGroups.map((group) => group.groupKey), ['mock:MOCK_PREVIEW_SOURCE']);
  assert.equal(model.nextSuggestedAction, '请先处理 fatal 和 high 风险问题，再进入导出。');
});

test('ReviewPage contains fix suggestion checklist without one-click repair', () => {
  const source = fs.readFileSync(path.resolve('src/pages/ReviewPage.jsx'), 'utf8');

  assert.match(source, /修正建议清单/);
  assert.match(source, /recommendedSteps/);
  assert.doesNotMatch(source, /一键修复/);
});

test('buildReviewReportDownload sanitizes review JSON and creates the expected file name', () => {
  const download = buildReviewReportDownload({
    report: {
      meta: { taskId: 'task-1', sku: 'SKU-1' },
      fixSuggestions: [{ title: '删除中文文案', actionType: 'removeText' }],
      fixSummary: { total: 1 },
      issues: [
        {
          message: 'API_KEY=abc sk-secret123 D:\\Code\\app.sqlite node_modules .env',
          suggestion: '请人工复核。'
        }
      ]
    },
    taskId: 'task-1',
    timestamp: '2026-06-01T12-00-00-000Z'
  });

  assert.equal(download.fileName, 'review-report-task-1-2026-06-01T12-00-00-000Z.json');
  assert.equal(download.mimeType, 'application/json');
  assert.equal(download.json.includes('sk-secret123'), false);
  assert.equal(download.json.includes('API_KEY'), false);
  assert.equal(download.json.includes('D:\\Code'), false);
  assert.equal(download.json.includes('app.sqlite'), false);
  assert.equal(download.json.includes('node_modules'), false);
  assert.equal(download.json.includes('.env'), false);
  assert.equal(download.json.includes('fixSuggestions'), true);
  assert.equal(download.json.includes('fixSummary'), true);
});

test('getReviewReportDisplayModel exposes fix suggestions and separates mock-only hints', () => {
  const model = getReviewReportDisplayModel({
    summary: { totalIssues: 2 },
    fixSummary: {
      total: 2,
      autoFixCandidateCount: 1,
      manualConfirmRequiredCount: 1,
      mockOnlyCount: 1,
      byActionType: { removeText: 1, skipMockOnly: 1 }
    },
    fixSuggestions: [
      {
        suggestionId: 'fix-1',
        severity: 'fatal',
        actionType: 'removeText',
        title: '删除中文文案',
        recommendedSteps: ['返回图片方案。', '删除中文文案。'],
        isMockOnly: false
      },
      {
        suggestionId: 'fix-2',
        severity: 'mockInfo',
        actionType: 'skipMockOnly',
        title: 'mock 流程提示',
        recommendedSteps: ['记录提示。'],
        isMockOnly: true
      }
    ]
  });

  assert.equal(model.fixSummaryCards.some((card) => card.label === '修正建议总数' && card.value === 2), true);
  assert.equal(model.fixSuggestions[0].title, '删除中文文案');
  assert.equal(model.mockOnlyFixSuggestions[0].actionType, 'skipMockOnly');
});

test('ReviewPage contains structured review report area and JSON export action', () => {
  const source = fs.readFileSync(path.resolve('src/pages/ReviewPage.jsx'), 'utf8');

  assert.match(source, /结构化审核摘要/);
  assert.match(source, /导出审核报告 JSON/);
  assert.match(source, /流程提示/);
  assert.match(source, /暂无结构化审核报告，请先执行审核。/);
});
