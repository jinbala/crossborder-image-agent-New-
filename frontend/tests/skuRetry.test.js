import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import {
  buildSkuRetryResultDownload,
  getSkuRetryDisplayModel
} from '../src/utils/skuRetry.js';

function retryPlan(overrides = {}) {
  return {
    batchId: 'batch-1',
    taskId: 'task-1',
    sku: 'SKU-1',
    currentStatus: 'failed',
    failedStep: 'imageGeneration',
    canRetry: true,
    allowedRetrySteps: ['imageGeneration'],
    blockedRetrySteps: [
      { retryStep: 'recognition', reason: '本阶段暂不执行识别重试。' },
      { retryStep: 'export', reason: '导出重试暂不开放。' }
    ],
    warnings: ['仅支持 mockOnly。'],
    nextSuggestedAction: '可以重试当前 SKU 的 mock 生图步骤。',
    ...overrides
  };
}

function retryResult(overrides = {}) {
  return {
    status: 'completed',
    batchId: 'batch-1',
    taskId: 'task-1',
    retryStep: 'imageGeneration',
    mode: 'mockOnly',
    startedAt: '2026-06-01T12:00:00.000Z',
    completedAt: '2026-06-01T12:00:01.000Z',
    durationMs: 1000,
    resultSummary: { message: '已完成 mock 生图重试。' },
    beforeSnapshot: { imagePlanCount: 1, generatedImageCount: 0, reviewResultCount: 0 },
    afterSnapshot: { imagePlanCount: 1, generatedImageCount: 1, reviewResultCount: 0 },
    warnings: [],
    nextSuggestedAction: '请刷新稳定性摘要并人工验收该 SKU。',
    ...overrides
  };
}

test('getSkuRetryDisplayModel summarizes retry plan and retry result for BatchPage', () => {
  const model = getSkuRetryDisplayModel({
    retryPlan: retryPlan(),
    retryResult: retryResult()
  });

  assert.equal(model.allowedStepsText, 'imageGeneration');
  assert.match(model.blockedStepsText, /recognition/);
  assert.match(model.warningsText, /mockOnly/);
  assert.equal(model.resultStatusText, 'completed');
  assert.equal(model.durationText, '1000ms');
  assert.match(model.snapshotSummary, /generatedImageCount: 0 -> 1/);
});

test('buildSkuRetryResultDownload creates sanitized JSON with required file name', () => {
  const download = buildSkuRetryResultDownload({
    taskId: 'task-1',
    retryPlan: retryPlan({ warnings: ['API_KEY=abc sk-secret D:\\Code\\.env app.sqlite node_modules'] }),
    retryResult: retryResult(),
    timestamp: '2026-06-01T12-00-00-000Z'
  });

  assert.equal(download.fileName, 'sku-retry-result-task-1-2026-06-01T12-00-00-000Z.json');
  assert.equal(download.mimeType, 'application/json');
  assert.equal(download.json.includes('retryPlan'), true);
  assert.equal(download.json.includes('retryResult'), true);
  assert.equal(download.json.includes('beforeSnapshot'), true);
  assert.equal(download.json.includes('afterSnapshot'), true);
  assert.equal(download.json.includes('API_KEY'), false);
  assert.equal(download.json.includes('sk-secret'), false);
  assert.equal(download.json.includes('D:\\Code'), false);
  assert.equal(download.json.includes('.env'), false);
  assert.equal(download.json.includes('app.sqlite'), false);
  assert.equal(download.json.includes('node_modules'), false);
});

test('BatchPage wires safe single-SKU retry controls without forbidden bulk/provider actions', () => {
  const pageSource = fs.readFileSync(path.resolve('src/pages/BatchPage.jsx'), 'utf8');
  const apiSource = fs.readFileSync(path.resolve('src/services/api.js'), 'utf8');

  assert.match(pageSource, /查看重试计划/);
  assert.match(pageSource, /重试该 SKU/);
  assert.match(pageSource, /本次只会重试当前 SKU 的指定步骤/);
  assert.match(pageSource, /confirmRetry: true/);
  assert.match(pageSource, /mode: 'mockOnly'/);
  assert.match(pageSource, /confirmPaidApi: false/);
  assert.match(pageSource, /window\.confirm/);
  assert.match(pageSource, /downloadSkuRetryResultJson/);
  assert.match(pageSource, /api\.getSkuRetryPlan/);
  assert.match(pageSource, /api\.executeSkuRetry/);
  assert.match(apiSource, /getSkuRetryPlan/);
  assert.match(apiSource, /executeSkuRetry/);

  assert.doesNotMatch(pageSource, /重试全部失败 SKU/);
  assert.doesNotMatch(pageSource, /自动恢复整个 batch/);
  assert.doesNotMatch(pageSource, /批量自动重试/);
  assert.doesNotMatch(pageSource, /真实 Provider 重试/);
  assert.doesNotMatch(pageSource, /上传平台/);
});
