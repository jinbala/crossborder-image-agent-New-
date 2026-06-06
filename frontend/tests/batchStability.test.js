import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import {
  buildBatchStabilityReportDownload,
  getBatchStabilityDisplayModel
} from '../src/utils/batchStability.js';

function report(overrides = {}) {
  return {
    meta: { batchId: 'batch-1', generatedAt: '2026-06-01T12:00:00.000Z', mode: 'readOnly', source: 'batch/tasks' },
    summary: {
      totalSku: 4,
      completedSku: 1,
      runningSku: 1,
      failedSku: 1,
      pendingSku: 1,
      needsManualReviewSku: 1,
      noReviewSku: 1,
      progressPercent: 25,
      canResumeCount: 1,
      canRetryCount: 1,
      blockedCount: 1
    },
    stepSummary: {
      upload: { total: 4, completed: 4, failed: 0, pending: 0 },
      recognition: { total: 4, completed: 3, failed: 1, pending: 0 },
      productConfirm: { total: 4, completed: 2, failed: 0, pending: 2 },
      platformRules: { total: 4, completed: 2, failed: 0, pending: 2 },
      imagePlan: { total: 4, completed: 2, failed: 0, pending: 2 },
      imageGeneration: { total: 4, completed: 1, failed: 1, pending: 2 },
      review: { total: 4, completed: 1, failed: 0, pending: 2, needsManualReview: 1 },
      export: { total: 4, completed: 1, failed: 0, pending: 3 }
    },
    skuProgress: [
      { taskId: 'task-1', sku: 'SKU-1', status: 'completed', currentStep: 'export', nextSuggestedAction: '已完成' }
    ],
    failures: [
      {
        taskId: 'task-fail',
        sku: 'SKU-FAIL',
        failedStep: 'imageGeneration',
        errorMessage: '生成失败',
        severity: 'medium',
        canRetry: true,
        requiresManualAction: false,
        suggestion: '可在后续版本安全重试'
      }
    ],
    resumePlan: {
      canResume: true,
      safeResumeSteps: ['retryFailedSku'],
      blockedReasons: ['存在需要人工复查的 SKU'],
      recommendations: ['先处理人工复查 SKU']
    },
    recommendations: ['本阶段仅提供断点续跑分析，不会自动恢复或重试。'],
    warnings: [],
    ...overrides
  };
}

test('getBatchStabilityDisplayModel summarizes stability report for BatchPage', () => {
  const model = getBatchStabilityDisplayModel(report());

  assert.equal(model.emptyText, '');
  assert.equal(model.summaryCards.some((card) => card.label === 'SKU 总数' && card.value === 4), true);
  assert.equal(model.summaryCards.some((card) => card.label === '失败' && card.value === 1), true);
  assert.equal(model.summaryCards.some((card) => card.label === '需人工复查' && card.value === 1), true);
  assert.equal(model.summaryCards.some((card) => card.label === '未审核' && card.value === 1), true);
  assert.equal(model.stepRows.length, 8);
  assert.equal(model.failureRows[0].sku, 'SKU-FAIL');
  assert.equal(model.resumePlan.canResume, true);
  assert.match(model.readOnlyNotice, /不会自动恢复或重试/);
});

test('getBatchStabilityDisplayModel handles empty report without blank state', () => {
  const model = getBatchStabilityDisplayModel(report({
    summary: { totalSku: 0 },
    stepSummary: {},
    skuProgress: [],
    failures: [],
    resumePlan: { canResume: false, safeResumeSteps: [], blockedReasons: [], recommendations: [] },
    recommendations: [],
    warnings: []
  }));

  assert.match(model.emptyText, /当前 batch 暂无 SKU/);
  assert.deepEqual(model.failureRows, []);
  assert.deepEqual(model.stepRows, []);
});

test('buildBatchStabilityReportDownload creates sanitized JSON with required file name', () => {
  const download = buildBatchStabilityReportDownload({
    report: report({
      recommendations: ['API_KEY=abc sk-secret123 D:\\Code\\.env app.sqlite node_modules']
    }),
    batchId: 'batch-1',
    timestamp: '2026-06-01T12-00-00-000Z'
  });

  assert.equal(download.fileName, 'batch-stability-report-batch-1-2026-06-01T12-00-00-000Z.json');
  assert.equal(download.mimeType, 'application/json');
  assert.equal(download.json.includes('summary'), true);
  assert.equal(download.json.includes('failures'), true);
  assert.equal(download.json.includes('resumePlan'), true);
  assert.equal(download.json.includes('API_KEY'), false);
  assert.equal(download.json.includes('sk-secret123'), false);
  assert.equal(download.json.includes('D:\\Code'), false);
  assert.equal(download.json.includes('app.sqlite'), false);
  assert.equal(download.json.includes('node_modules'), false);
  assert.equal(download.json.includes('.env'), false);
});

test('BatchPage contains batch stability summary area export button and API wiring', () => {
  const pageSource = fs.readFileSync(path.resolve('src/pages/BatchPage.jsx'), 'utf8');
  const apiSource = fs.readFileSync(path.resolve('src/services/api.js'), 'utf8');

  assert.match(pageSource, /批量任务稳定性摘要/);
  assert.match(pageSource, /本阶段仅提供断点续跑分析，不会自动恢复或重试/);
  assert.match(pageSource, /导出批量稳定性报告 JSON/);
  assert.match(pageSource, /失败 SKU 列表/);
  assert.match(pageSource, /恢复建议/);
  assert.match(apiSource, /getBatchStability/);
});
