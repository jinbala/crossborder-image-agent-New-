import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  STRESS_TEST_MODES,
  createStressReportDownload,
  formatStressDuration,
  normalizeStressTestPayload,
  stressReportStats,
  stressSkuStatusLabel,
  stressStatusLabel
} from '../src/utils/stressTest.js';

function sampleReport() {
  return {
    summary: {
      stressTestId: 'stress-001',
      mode: 'mockOnly',
      status: 'partial',
      totalSku: 2,
      successSku: 1,
      failedSku: 1,
      durationMs: 1234
    },
    skuResults: [
      { skuId: 'SKU-OK', status: 'completed', failedStep: null, durationMs: 500 },
      { skuId: 'SKU-BAD', status: 'failed', failedStep: 'recognition', errorMessage: 'mock failure', durationMs: 100 }
    ],
    providerStats: [
      { providerName: 'Mock Vision', providerType: 'vision', callCount: 1, estimatedCost: 0 }
    ],
    errors: {
      errorCount: 1,
      failedSkuList: ['SKU-BAD']
    }
  };
}

test('stress test mode labels keep real modes disabled with cost warning', () => {
  assert.equal(STRESS_TEST_MODES.mockOnly.label, 'mockOnly：全链路 Mock 压测');
  assert.equal(STRESS_TEST_MODES.mockOnly.enabled, true);
  assert.equal(STRESS_TEST_MODES.realVisionMockGenerate.enabled, true);
  assert.match(STRESS_TEST_MODES.realVisionMockGenerate.costWarning, /可能产生 API 成本/);
  assert.equal(STRESS_TEST_MODES.optionalRealReview.enabled, false);
  assert.match(STRESS_TEST_MODES.optionalRealReview.costWarning, /本阶段不会调用真实 Provider/);
});

test('normalizeStressTestPayload keeps mockOnly safe defaults', () => {
  assert.deepEqual(normalizeStressTestPayload({
    mode: 'optionalRealReview',
    skuCount: '5',
    concurrency: '9',
    exportZip: true,
    batchId: 'batch-1'
  }), {
    mode: 'optionalRealReview',
    skuCount: 5,
    concurrency: 2,
    exportZip: true,
    batchId: 'batch-1'
  });

  assert.deepEqual(normalizeStressTestPayload({}), {
    mode: 'mockOnly',
    skuCount: 3,
    concurrency: 1,
    exportZip: false
  });
});

test('stress report helpers format summary, failed step, provider stats and JSON export', () => {
  const report = sampleReport();
  const stats = stressReportStats(report);
  const download = createStressReportDownload(report);

  assert.equal(stressStatusLabel('partial'), '部分完成');
  assert.equal(stressSkuStatusLabel('failed'), '失败');
  assert.equal(formatStressDuration(1234), '1.23 秒');
  assert.equal(stats.failedSkuText, 'SKU-BAD');
  assert.equal(stats.providerCallCount, 1);
  assert.equal(stats.estimatedCostText, 'USD 0.0000');
  assert.equal(download.fileName, 'stress-001-report.json');
  assert.equal(JSON.parse(download.content).summary.stressTestId, 'stress-001');
});

test('real vision report helpers show calls, success, failures, average duration and cost placeholder', () => {
  const report = {
    ...sampleReport(),
    summary: { ...sampleReport().summary, mode: 'realVisionMockGenerate', realProviderCalls: 2 },
    providerStats: [
      {
        providerName: 'gemini',
        providerType: 'vision',
        callCount: 2,
        successCount: 1,
        failureCount: 1,
        averageDurationMs: 1200,
        estimatedCost: 0,
        costNote: '当前成本为估算占位，后续可接入真实价格表。'
      },
      { providerName: 'Mock Image', providerType: 'image', callCount: 2, successCount: 2, failureCount: 0, estimatedCost: 0 }
    ],
    costNotice: '当前成本为估算占位，尚未接入真实价格表。真实识别可能已产生实际 API 成本。'
  };

  const stats = stressReportStats(report);
  const download = createStressReportDownload(report);

  assert.equal(stats.visionCallCount, 2);
  assert.equal(stats.visionSuccessCount, 1);
  assert.equal(stats.visionFailureCount, 1);
  assert.equal(stats.visionAverageDurationText, '1.20 秒');
  assert.equal(stats.costPlaceholder, true);
  assert.match(stats.costNotice, /尚未接入真实价格表/);
  assert.equal(JSON.parse(download.content).summary.mode, 'realVisionMockGenerate');
  assert.match(download.fileName, /^stress-test-report-/);
});

test('stress API methods call minimal endpoints', async () => {
  const { api } = await import('../src/services/api.js');
  const captured = [];
  global.fetch = async (url, options = {}) => {
    captured.push({ url, options });
    return {
      ok: true,
      json: async () => ({ summary: { stressTestId: 'stress-001' } })
    };
  };

  await api.getStressTestConfig();
  await api.runStressTest({ mode: 'mockOnly', skuCount: '3', concurrency: '1' });
  await api.getStressTest('stress-001');
  await api.getStressTestReport('stress-001');

  assert.equal(captured[0].url, '/api/stress-test/config');
  assert.equal(captured[1].url, '/api/stress-test/run');
  assert.equal(captured[1].options.body, '{"mode":"mockOnly","skuCount":3,"concurrency":1,"exportZip":false}');
  assert.equal(captured[2].url, '/api/stress-test/stress-001');
  assert.equal(captured[3].url, '/api/stress-test/stress-001/report');
});
