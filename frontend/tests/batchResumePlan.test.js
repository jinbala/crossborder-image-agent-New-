import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import {
  buildBatchResumePlanDownload,
  getBatchResumePlanDisplayModel
} from '../src/utils/batchResumePlan.js';

function resumePlan(overrides = {}) {
  return {
    meta: { batchId: 'batch-1', generatedAt: '2026-06-01T12:00:00.000Z', mode: 'previewOnly', source: 'batchStability + skuRetryPlan' },
    summary: {
      totalSku: 5,
      recoverableSku: 1,
      blockedSku: 1,
      waitingSku: 1,
      manualOnlySku: 1,
      noReviewSku: 1,
      completedSku: 1,
      estimatedRetryActions: 2,
      paidApiRiskCount: 1,
      canExecuteBatchAutomatically: false
    },
    resumeGroups: {
      safeMockRetry: [{ taskId: 'task-safe', sku: 'SKU-SAFE', recommendedRetryStep: 'imageGeneration', suggestion: '建议先重试 mock 图片生成。' }],
      manualRequired: [{ taskId: 'task-manual', sku: 'SKU-MANUAL', blockedReason: '需要人工复查高风险字段。' }],
      blocked: [{ taskId: 'task-blocked', sku: 'SKU-BLOCKED', blockedReason: '识别重试需要真实 Provider。' }],
      noReview: [{ taskId: 'task-no-review', sku: 'SKU-NOREVIEW', recommendedRetryStep: 'review', suggestion: '建议先执行 mock 审核。' }],
      completed: [{ taskId: 'task-done', sku: 'SKU-DONE', suggestion: '已完成。' }]
    },
    orderedPlan: [
      { order: 1, taskId: 'task-safe', sku: 'SKU-SAFE', recommendedRetryStep: 'imageGeneration', mode: 'mockOnly', canRetry: true, paidApiRisk: false, suggestion: '建议先重试 mock 图片生成。' },
      { order: 2, taskId: 'task-no-review', sku: 'SKU-NOREVIEW', recommendedRetryStep: 'review', mode: 'mockOnly', canRetry: true, paidApiRisk: false, suggestion: '建议先执行 mock 审核。' }
    ],
    warnings: ['当前仅为批量恢复计划预览，不会自动恢复整批。'],
    recommendations: ['请逐个 SKU 执行安全重试。'],
    nextSuggestedAction: '请逐个 SKU 执行安全重试，不建议自动恢复整批。',
    ...overrides
  };
}

test('getBatchResumePlanDisplayModel summarizes groups ordered plan and safety notice', () => {
  const model = getBatchResumePlanDisplayModel(resumePlan());

  assert.equal(model.emptyText, '');
  assert.equal(model.summaryCards.some((card) => card.label === '可安全 mock 重试' && card.value === 1), true);
  assert.equal(model.summaryCards.some((card) => card.label === '需人工处理' && card.value === 1), true);
  assert.equal(model.groupSections.safeMockRetry.rows[0].sku, 'SKU-SAFE');
  assert.equal(model.groupSections.manualRequired.rows[0].sku, 'SKU-MANUAL');
  assert.equal(model.groupSections.blocked.rows[0].sku, 'SKU-BLOCKED');
  assert.equal(model.groupSections.noReview.rows[0].sku, 'SKU-NOREVIEW');
  assert.equal(model.groupSections.completed.rows[0].sku, 'SKU-DONE');
  assert.equal(model.orderedRows[0].recommendedRetryStep, 'imageGeneration');
  assert.match(model.safetyNotice, /不会自动恢复整批/);
});

test('getBatchResumePlanDisplayModel handles empty plan without blank screen', () => {
  const model = getBatchResumePlanDisplayModel(resumePlan({
    summary: { totalSku: 0, canExecuteBatchAutomatically: false },
    resumeGroups: { safeMockRetry: [], manualRequired: [], blocked: [], noReview: [], completed: [] },
    orderedPlan: [],
    warnings: [],
    recommendations: []
  }));

  assert.match(model.emptyText, /暂无 SKU|当前 batch 暂无 SKU/);
  assert.deepEqual(model.orderedRows, []);
});

test('getBatchResumePlanDisplayModel shows waiting recognition group separately from blocked', () => {
  const model = getBatchResumePlanDisplayModel({
    summary: {
      totalSku: 1,
      waitingSku: 1,
      blockedSku: 0,
      canExecuteBatchAutomatically: false
    },
    resumeGroups: {
      waiting: [{ taskId: 'task-waiting', sku: 'SKU-WAITING', suggestion: '等待开始批量识别。' }],
      blocked: []
    },
    orderedPlan: [],
    warnings: ['真实识别可能产生 API 成本，请确认后启动。'],
    recommendations: []
  });

  assert.equal(model.summaryCards.some((card) => card.label === '待开始识别 SKU' && card.value === 1), true);
  assert.equal(model.groupSections.waiting.rows[0].sku, 'SKU-WAITING');
  assert.equal(model.groupSections.blocked.rows.length, 0);
});

test('buildBatchResumePlanDownload creates sanitized JSON with required file name', () => {
  const download = buildBatchResumePlanDownload({
    batchId: 'batch-1',
    plan: resumePlan({ warnings: ['API_KEY=abc sk-secret D:\\Code\\.env app.sqlite node_modules'] }),
    timestamp: '2026-06-01T12-00-00-000Z'
  });

  assert.equal(download.fileName, 'batch-resume-plan-batch-1-2026-06-01T12-00-00-000Z.json');
  assert.equal(download.mimeType, 'application/json');
  assert.equal(download.json.includes('summary'), true);
  assert.equal(download.json.includes('resumeGroups'), true);
  assert.equal(download.json.includes('orderedPlan'), true);
  assert.equal(download.json.includes('API_KEY'), false);
  assert.equal(download.json.includes('sk-secret'), false);
  assert.equal(download.json.includes('D:\\Code'), false);
  assert.equal(download.json.includes('.env'), false);
  assert.equal(download.json.includes('app.sqlite'), false);
  assert.equal(download.json.includes('node_modules'), false);
});

test('BatchPage wires batch resume plan preview without forbidden execution buttons', () => {
  const pageSource = fs.readFileSync(path.resolve('src/pages/BatchPage.jsx'), 'utf8');
  const apiSource = fs.readFileSync(path.resolve('src/services/api.js'), 'utf8');

  assert.match(pageSource, /批量恢复计划预览/);
  assert.match(pageSource, /刷新恢复计划/);
  assert.match(pageSource, /导出恢复计划 JSON/);
  assert.match(pageSource, /当前仅为批量恢复计划预览，不会自动恢复整批/);
  assert.match(pageSource, /api\.getBatchResumePlan/);
  assert.match(pageSource, /downloadBatchResumePlanJson/);
  assert.match(apiSource, /getBatchResumePlan/);

  assert.doesNotMatch(pageSource, /执行整批恢复/);
  assert.doesNotMatch(pageSource, /一键重试全部/);
  assert.doesNotMatch(pageSource, /自动恢复 batch/);
});
