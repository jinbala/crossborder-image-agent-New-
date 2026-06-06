import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import request from 'supertest';
import app from '../src/app.js';
import { createBatchTask, resetDatabaseForTests } from '../src/services/db.js';
import {
  generateBatchSop,
  generateGeneralSop,
  renderSopMarkdown
} from '../src/services/sopService.js';

beforeEach(async () => {
  await resetDatabaseForTests();
});

function sampleBatch() {
  return {
    id: 'batch-sop-1',
    name: 'SOP Demo Batch',
    status: 'waiting_confirm',
    createdAt: '2026-05-30T00:00:00.000Z',
    updatedAt: '2026-05-30T00:00:00.000Z',
    workflowTemplateSnapshot: {
      id: 'hard_drive_multi_platform_balanced',
      name: '移动硬盘多平台 balanced',
      defaultTargets: [
        { platformId: 'amazon', site: 'US', language: 'English', categoryId: 'electronics_storage' }
      ],
      providers: { visionProvider: 'gemini', imageProvider: 'mock', reviewProvider: 'mock' }
    },
    defaultTargets: [
      { platformId: 'amazon', site: 'US', language: 'English', categoryId: 'electronics_storage' }
    ],
    skuTasks: [
      { skuId: 'sku-await-confirm', taskId: 'task-1', status: 'recognized', currentStep: 'waiting_confirm', imageCount: 3 },
      { skuId: 'sku-timeout', taskId: 'task-2', status: 'failed', queueStatus: 'failed', retryable: true, lastErrorCategory: 'timeout', lastErrorCode: 'JOB_TIMEOUT', error: { code: 'JOB_TIMEOUT', message: 'timeout' } },
      { skuId: 'sku-key', taskId: 'task-3', status: 'failed', queueStatus: 'failed', requiresUserAction: true, lastUserActionType: 'provide_key', lastErrorCategory: 'config', lastErrorCode: 'MISSING_API_KEY', error: { code: 'MISSING_API_KEY', message: 'missing key' } }
    ],
    queue: { status: 'paused', action: 'recognize', concurrency: 2 },
    analytics: {
      sku: { total: 3, failed: 2, waitingConfirm: 1 },
      failureSummary: {
        totalFailed: 2,
        byCategory: { timeout: 1, config: 1 },
        retryableCount: 1,
        requiresUserActionCount: 1,
        userActionTypes: { provide_key: 1 }
      },
      providers: { vision: { gemini: { calls: 1 } }, image: {}, review: {}, matting: {} },
      cost: { currency: 'USD', estimatedTotal: 0.12 },
      review: { highRiskCount: 1, mediumRiskCount: 0, lowRiskCount: 0 }
    }
  };
}

test('generateGeneralSop returns markdown-ready SOP without secrets', () => {
  process.env.OPENAI_API_KEY = 'SHOULD_NOT_APPEAR_IN_SOP';
  const sop = generateGeneralSop();
  const markdown = renderSopMarkdown(sop);
  assert.equal(sop.type, 'general');
  assert.match(markdown, /# CrossBorder Image Agent 通用 SOP/);
  assert.match(markdown, /批量 SKU 流程/);
  assert.doesNotMatch(markdown, /SHOULD_NOT_APPEAR_IN_SOP/);
  delete process.env.OPENAI_API_KEY;
});

test('generateBatchSop includes current step pending confirmation failures and checklist', () => {
  const sop = generateBatchSop(sampleBatch());
  const markdown = renderSopMarkdown(sop);
  assert.equal(sop.type, 'batch');
  assert.equal(sop.batchContext.currentStep, 'confirm');
  assert.match(markdown, /sku-await-confirm/);
  assert.match(markdown, /sku-timeout/);
  assert.match(markdown, /JOB_TIMEOUT/);
  assert.match(markdown, /MISSING_API_KEY/);
  assert.match(markdown, /\[ \] 打开下一个待确认 SKU/);
  assert.match(markdown, /\[ \] 重试 1 个可重试失败/);
});

test('batch SOP download API returns markdown file', async () => {
  await createBatchTask(sampleBatch());
  const response = await request(app)
    .get('/api/batches/batch-sop-1/sop/download')
    .expect(200)
    .expect('Content-Type', /markdown/);
  assert.match(response.headers['content-disposition'], /Batch-SOP-batch-sop-1\.md/);
  assert.match(response.text, /# Batch SOP - SOP Demo Batch/);
  assert.doesNotMatch(response.text, /API_KEY=/);
});
