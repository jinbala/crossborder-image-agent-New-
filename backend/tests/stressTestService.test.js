import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  getStressTestReport,
  runStressTest
} from '../src/services/stressTestService.js';

function makeBatch(overrides = {}) {
  return {
    id: 'batch-stress-1',
    name: '压测样例 batch',
    createdAt: '2026-06-01T00:00:00.000Z',
    skuTasks: [
      { skuId: 'SKU-001', taskId: 'task-001', displayName: '样例 SKU 001', status: 'uploaded', currentStep: 'uploaded', imageCount: 2 },
      { skuId: 'SKU-002', taskId: 'task-002', displayName: '样例 SKU 002', status: 'uploaded', currentStep: 'uploaded', imageCount: 1 },
      { skuId: 'SKU-003', taskId: 'task-003', displayName: '样例 SKU 003', status: 'uploaded', currentStep: 'uploaded', imageCount: 3 }
    ],
    ...overrides
  };
}

async function makeOptions(batch = makeBatch()) {
  const reportDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cia-stress-test-'));
  return {
    reportDir,
    batchReader: async () => batch,
    listBatchesReader: async () => [batch],
    taskReader: async (taskId) => ({
      id: taskId,
      sku: taskId,
      sourceImages: [{ id: `${taskId}-source-1`, filePath: 'uploads/mock.png', role: 'main' }],
      originalImage: { id: `${taskId}-source-1`, filePath: 'uploads/mock.png' }
    })
  };
}

test('mockOnly stress test creates a completed report and persists it', async () => {
  const options = await makeOptions();

  const report = await runStressTest({ mode: 'mockOnly', skuCount: 3 }, options);
  const persisted = await getStressTestReport(report.summary.stressTestId, options);

  assert.equal(report.summary.mode, 'mockOnly');
  assert.equal(report.summary.status, 'completed');
  assert.equal(report.summary.totalSku, 3);
  assert.equal(report.summary.successSku, 3);
  assert.equal(report.summary.failedSku, 0);
  assert.equal(report.skuResults.length, 3);
  assert.equal(persisted.summary.stressTestId, report.summary.stressTestId);
  assert.equal(persisted.skuResults[0].skuId, 'SKU-001');
});

test('mockOnly stress test isolates failed SKU and keeps remaining SKU successful', async () => {
  const batch = makeBatch({
    skuTasks: [
      { skuId: 'SKU-OK', taskId: 'task-ok', displayName: '正常 SKU', status: 'uploaded', currentStep: 'uploaded', imageCount: 1 },
      {
        skuId: 'SKU-BAD',
        taskId: null,
        displayName: '导入失败 SKU',
        status: 'failed',
        currentStep: 'import',
        error: { code: 'NO_VALID_IMAGES', message: '没有可用图片' },
        imageCount: 0
      },
      { skuId: 'SKU-AFTER', taskId: 'task-after', displayName: '后续 SKU', status: 'uploaded', currentStep: 'uploaded', imageCount: 1 }
    ]
  });
  const options = await makeOptions(batch);

  const report = await runStressTest({ mode: 'mockOnly', skuCount: 3 }, options);
  const failed = report.skuResults.find((item) => item.skuId === 'SKU-BAD');
  const after = report.skuResults.find((item) => item.skuId === 'SKU-AFTER');

  assert.equal(report.summary.status, 'partial');
  assert.equal(report.summary.successSku, 2);
  assert.equal(report.summary.failedSku, 1);
  assert.equal(failed.status, 'failed');
  assert.equal(failed.failedStep, 'importScan');
  assert.match(failed.errorMessage, /没有可用图片/);
  assert.equal(after.status, 'completed');
  assert.deepEqual(report.errors.failedSkuList, ['SKU-BAD']);
});

test('mockOnly stress test records step durations and zero-cost mock provider stats', async () => {
  const options = await makeOptions();

  const report = await runStressTest({ mode: 'mockOnly', skuCount: 2, exportZip: false }, options);

  assert.equal(report.stepDurations.total.count, 2);
  assert.equal(report.stepDurations.recognition.totalMs > 0, true);
  assert.equal(report.stepDurations.productConfirmWait.skipped, true);
  assert.equal(report.stepDurations.export.skipped, true);

  const vision = report.providerStats.find((item) => item.providerType === 'vision');
  const image = report.providerStats.find((item) => item.providerType === 'image');
  const review = report.providerStats.find((item) => item.providerType === 'review');
  assert.equal(vision.providerName, 'Mock Vision');
  assert.equal(vision.callCount, 2);
  assert.equal(image.callCount, 4);
  assert.equal(review.callCount, 4);
  assert.equal(vision.estimatedCost, 0);
  assert.equal(image.estimatedCost, 0);
  assert.equal(review.estimatedCost, 0);
});

test('realVisionMockGenerate runs Vision Provider while image and review stay mock-only', async () => {
  const options = await makeOptions();
  let visionCalls = 0;
  let imageCalls = 0;
  let reviewCalls = 0;
  options.visionProviderFactory = () => ({
    provider: 'gemini',
    model: 'gemini-test-model',
    recognize: async ({ task, images }) => {
      visionCalls += 1;
      assert.equal(Array.isArray(images), true);
      return {
        provider: 'gemini',
        model: 'gemini-test-model',
        status: 'success',
        durationMs: 25,
        data: {
          productInfoRaw: { productName: `识别 ${task.id}`, category: 'Storage', brand: 'Demo' },
          risks: [{ type: 'text', severity: 'low' }],
          inferredCandidates: []
        }
      };
    }
  });
  options.imageProviderFactory = () => {
    imageCalls += 1;
  };
  options.reviewProviderFactory = () => {
    reviewCalls += 1;
  };

  const report = await runStressTest({ mode: 'realVisionMockGenerate', skuCount: 2 }, options);
  const vision = report.providerStats.find((item) => item.providerType === 'vision' && item.providerName === 'gemini');
  const mockImage = report.providerStats.find((item) => item.providerType === 'image');
  const mockReview = report.providerStats.find((item) => item.providerType === 'review');

  assert.equal(visionCalls, 2);
  assert.equal(imageCalls, 0);
  assert.equal(reviewCalls, 0);
  assert.equal(report.summary.mode, 'realVisionMockGenerate');
  assert.equal(report.summary.realProviderCalls, 2);
  assert.equal(report.summary.mockProviderCalls, 8);
  assert.equal(report.summary.estimatedCost, 0);
  assert.equal(vision.callCount, 2);
  assert.equal(vision.successCount, 2);
  assert.equal(vision.failureCount, 0);
  assert.equal(vision.averageDurationMs, 25);
  assert.equal(mockImage.providerName, 'Mock Image');
  assert.equal(mockReview.providerName, 'Mock Review');
  assert.match(report.costNotice, /尚未接入真实价格表/);
  assert.equal(report.skuResults[0].recognitionStatus, 'success');
  assert.equal(report.skuResults[0].recognitionDurationMs, 25);
  assert.equal(report.skuResults[0].recognitionProvider, 'gemini');
  assert.equal(report.skuResults[0].recognizedFieldCount, 3);
  assert.equal(report.generatedAt, report.summary.completedAt);
});

test('realVisionMockGenerate isolates one recognition failure and keeps later SKU running', async () => {
  const batch = makeBatch({
    skuTasks: [
      { skuId: 'SKU-OK', taskId: 'task-ok', displayName: '正常 SKU', status: 'uploaded', currentStep: 'uploaded', imageCount: 1 },
      { skuId: 'SKU-BAD', taskId: 'task-bad', displayName: '失败 SKU', status: 'uploaded', currentStep: 'uploaded', imageCount: 1 },
      { skuId: 'SKU-AFTER', taskId: 'task-after', displayName: '后续 SKU', status: 'uploaded', currentStep: 'uploaded', imageCount: 1 }
    ]
  });
  const options = await makeOptions(batch);
  options.visionProviderFactory = () => ({
    provider: 'openai',
    model: 'vision-test',
    recognize: async ({ task }) => {
      if (task.id === 'task-bad') {
        return {
          provider: 'openai',
          model: 'vision-test',
          status: 'failed',
          durationMs: 31,
          error: { code: 'HTTP_ERROR', message: '识别服务超时' },
          data: null
        };
      }
      return {
        provider: 'openai',
        model: 'vision-test',
        status: 'success',
        durationMs: 18,
        data: { productInfoRaw: { productName: task.id }, risks: [], inferredCandidates: [] }
      };
    }
  });

  const report = await runStressTest({ mode: 'realVisionMockGenerate', skuCount: 3 }, options);
  const failed = report.skuResults.find((item) => item.skuId === 'SKU-BAD');
  const after = report.skuResults.find((item) => item.skuId === 'SKU-AFTER');
  const vision = report.providerStats.find((item) => item.providerType === 'vision' && item.providerName === 'openai');

  assert.equal(report.summary.status, 'partial');
  assert.equal(report.summary.successSku, 2);
  assert.equal(report.summary.failedSku, 1);
  assert.equal(failed.status, 'failed');
  assert.equal(failed.failedStep, 'recognition');
  assert.equal(failed.recognitionStatus, 'failed');
  assert.equal(failed.recognitionDurationMs, 31);
  assert.match(failed.recognitionError, /识别服务超时/);
  assert.equal(failed.generatedImageCount, 0);
  assert.equal(after.status, 'completed');
  assert.equal(vision.callCount, 3);
  assert.equal(vision.successCount, 2);
  assert.equal(vision.failureCount, 1);
  assert.deepEqual(report.errors.errorsByStep, { recognition: 1 });
});

test('realVisionMockGenerate returns a clear Chinese error when Vision Provider is unavailable', async () => {
  const options = await makeOptions();
  options.visionProviderFactory = () => {
    throw new Error('provider config missing');
  };

  await assert.rejects(
    () => runStressTest({ mode: 'realVisionMockGenerate', skuCount: 1 }, options),
    /真实识别 Provider 未配置或不可用，请先检查 Provider 设置。/
  );
});
