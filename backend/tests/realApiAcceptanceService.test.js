import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  exportRealApiAcceptanceReport,
  runSingleSkuRealApiAcceptance
} from '../src/services/realApiAcceptanceService.js';

function sampleTask(overrides = {}) {
  return {
    id: 'task-real-api-001',
    sku: 'REAL-API-SKU',
    platformId: 'amazon',
    categoryId: 'electronics_storage',
    productInfoConfirmed: {
      sku: 'REAL-API-SKU',
      name: 'Portable External Drive',
      category: 'External Storage'
    },
    sourceImages: [{
      id: 'source-1',
      fileName: 'front.jpg',
      displayName: 'front.jpg',
      filePath: 'uploads/front.jpg',
      previewUrl: '/uploads/front.jpg'
    }],
    imagePlans: ['main_image', 'feature_image', 'detail_image'].map((imageType) => ({
      id: `${imageType}-plan`,
      type: imageType,
      platformId: 'amazon',
      categoryId: 'electronics_storage',
      title: `${imageType} plan`,
      textBlocks: imageType === 'main_image' ? [] : [{ text: 'Fast backup', sourceFields: ['sellingPoints'] }]
    })),
    generatedImages: [],
    review: null,
    ...overrides
  };
}

function successVisionProvider(calls) {
  return {
    provider: 'fake-vision',
    model: 'fake-vision-v1',
    recognize: async () => {
      calls.push('vision');
      return {
        provider: 'fake-vision',
        model: 'fake-vision-v1',
        status: 'success',
        durationMs: 14,
        data: {
          productInfoRaw: { sku: 'REAL-API-SKU', name: 'Portable External Drive' },
          visibleText: ['USB-C'],
          risks: [],
          confidence: { name: 0.9 }
        }
      };
    }
  };
}

function imageRunner(calls, patch = {}) {
  return async ({ taskId, imageType }) => {
    calls.push(`image:${imageType}`);
    return {
      taskId,
      singleImageGeneration: {
        taskId,
        imageType,
        status: patch.status || 'succeeded',
        providerUsed: patch.providerUsed || 'fake-image',
        requestedProvider: patch.requestedProvider || 'fake-image',
        model: 'fake-image-v1',
        durationMs: 21,
        isRealGenerated: patch.isRealGenerated ?? true,
        fallbackUsed: patch.fallbackUsed || false,
        fallbackReason: patch.fallbackReason || '',
        previewUrl: `/outputs/${taskId}/${imageType}.png`
      },
      qualityScore: { score: 91, level: 'good', warnings: [] },
      warnings: patch.warnings || [],
      templateAudit: { status: 'ok' },
      ruleAuditSummary: { issueCounts: { error: 0, warning: 0, info: 0 } }
    };
  };
}

test('real API acceptance refuses unconfirmed paid real API runs without provider calls', async () => {
  const calls = [];
  await assert.rejects(
    runSingleSkuRealApiAcceptance({
      taskId: 'task-real-api-001',
      confirmRealApi: false,
      confirmPaidApi: true,
      confirmNoPlatformUpload: true
    }, {
      taskReader: async () => sampleTask(),
      visionProvider: successVisionProvider(calls),
      singleImageRunner: imageRunner(calls)
    }),
    /confirmRealApi=true/
  );
  await assert.rejects(
    runSingleSkuRealApiAcceptance({
      taskId: 'task-real-api-001',
      confirmRealApi: true,
      confirmPaidApi: false,
      confirmNoPlatformUpload: true
    }, {
      taskReader: async () => sampleTask(),
      visionProvider: successVisionProvider(calls),
      singleImageRunner: imageRunner(calls)
    }),
    /confirmPaidApi=true/
  );
  assert.deepEqual(calls, []);
});

test('real API acceptance requires no-platform-upload confirmation before task lookup or provider calls', async () => {
  const calls = [];
  let taskReadCount = 0;
  const deps = {
    taskReader: async () => {
      taskReadCount += 1;
      return sampleTask();
    },
    visionProvider: successVisionProvider(calls),
    reviewProvider: { provider: 'fake-review', model: 'fake-review-v1', review: async () => calls.push('review') },
    singleImageRunner: imageRunner(calls)
  };

  await assert.rejects(
    runSingleSkuRealApiAcceptance({
      taskId: 'missing-task-real-api-001',
      confirmRealApi: true,
      confirmPaidApi: true
    }, deps),
    /confirmNoPlatformUpload=true/
  );
  await assert.rejects(
    runSingleSkuRealApiAcceptance({
      taskId: 'missing-task-real-api-001',
      confirmRealApi: true,
      confirmPaidApi: true,
      confirmNoPlatformUpload: false
    }, deps),
    /confirmNoPlatformUpload=true/
  );

  assert.equal(taskReadCount, 0);
  assert.deepEqual(calls, []);
});

test('real API acceptance allows only one task and enforces maxRealApiCalls', async () => {
  await assert.rejects(
    runSingleSkuRealApiAcceptance({ confirmRealApi: true, confirmPaidApi: true, confirmNoPlatformUpload: true }),
    /taskId is required/
  );
  await assert.rejects(
    runSingleSkuRealApiAcceptance({
      taskId: 'task-real-api-001',
      batchId: 'batch-001',
      confirmRealApi: true,
      confirmPaidApi: true,
      confirmNoPlatformUpload: true
    }),
    /Batch or multi-SKU/
  );
  await assert.rejects(
    runSingleSkuRealApiAcceptance({
      taskId: 'task-real-api-001',
      confirmRealApi: true,
      confirmPaidApi: true,
      confirmNoPlatformUpload: true,
      maxRealApiCalls: 4
    }),
    /maxRealApiCalls/
  );
  await assert.rejects(
    runSingleSkuRealApiAcceptance({
      taskId: 'task-real-api-001',
      confirmRealApi: true,
      confirmPaidApi: true,
      confirmNoPlatformUpload: true,
      maxRealApiCalls: 2,
      enableVision: true,
      imageTypes: ['main_image', 'feature_image']
    }, { taskReader: async () => sampleTask() }),
    /exceeds maxRealApiCalls/
  );
});

test('real API acceptance builds a sanitized report from stub providers without mutating task', async () => {
  const calls = [];
  const task = sampleTask();
  const before = JSON.parse(JSON.stringify(task));
  const report = await runSingleSkuRealApiAcceptance({
    taskId: task.id,
    confirmRealApi: true,
    confirmPaidApi: true,
    confirmNoPlatformUpload: true,
    maxRealApiCalls: 3,
    enableVision: true,
    imageTypes: ['main_image', 'feature_image'],
    enableReview: false
  }, {
    taskReader: async () => task,
    visionProvider: successVisionProvider(calls),
    singleImageRunner: imageRunner(calls)
  });

  assert.deepEqual(calls, ['vision', 'image:main_image', 'image:feature_image']);
  assert.equal(report.meta.mode, 'single-sku-real-api-acceptance');
  assert.equal(report.meta.platformUploadEnabled, false);
  assert.equal(report.meta.realUploadEnabled, false);
  assert.equal(report.meta.readyForPlatformUpload, false);
  assert.equal(report.summary.realApiCallCount, 3);
  assert.equal(report.summary.realVisionCallCount, 1);
  assert.equal(report.summary.realImageGenerationCallCount, 2);
  assert.equal(report.summary.realReviewCallCount, 0);
  assert.equal(report.summary.readyForPlatformUpload, false);
  assert.equal(report.uploadDryRunSummary.realUploadEnabled, false);
  assert.equal(report.uploadDryRunSummary.canUploadNow, false);
  assert.equal(report.generatedOutputs.length, 2);
  assert.equal(report.apiCalls.every((call) => call.provider && call.model && call.durationMs >= 0), true);
  assert.deepEqual(task, before);
});

test('real API acceptance records failed calls fallback and sanitizes report content', async () => {
  const calls = [];
  const report = await runSingleSkuRealApiAcceptance({
    taskId: 'task-real-api-001',
    confirmRealApi: true,
    confirmPaidApi: true,
    confirmNoPlatformUpload: true,
    maxRealApiCalls: 2,
    enableVision: true,
    imageTypes: ['detail_image']
  }, {
    taskReader: async () => sampleTask(),
    visionProvider: {
      provider: 'fake-vision',
      model: 'fake-vision-v1',
      recognize: async () => {
        calls.push('vision');
        return {
          provider: 'fake-vision',
          model: 'fake-vision-v1',
          status: 'failed',
          durationMs: 3,
          error: { code: 'MISSING_API_KEY', message: 'OPENAI_API_KEY=sk-secret D:\\Code\\.env' }
        };
      }
    },
    singleImageRunner: imageRunner(calls, {
      status: 'fallback_mock',
      providerUsed: 'mock',
      isRealGenerated: false,
      fallbackUsed: true,
      fallbackReason: 'OPENAI_API_KEY=sk-secret D:\\Code\\.env'
    })
  });

  const json = JSON.stringify(report);
  assert.equal(report.summary.overallStatus, 'partial');
  assert.equal(report.summary.fallbackCount, 1);
  assert.equal(report.apiCalls.some((call) => call.status === 'failed'), true);
  assert.equal(report.apiCalls.some((call) => call.fallbackUsed === true), true);
  assert.doesNotMatch(json, /OPENAI_API_KEY|sk-secret|[A-Z]:\\|\.env|app\.sqlite|node_modules/i);
});

test('real API acceptance records image generation errors without throwing', async () => {
  const calls = [];
  const report = await runSingleSkuRealApiAcceptance({
    taskId: 'task-real-api-001',
    confirmRealApi: true,
    confirmPaidApi: true,
    confirmNoPlatformUpload: true,
    maxRealApiCalls: 2,
    enableVision: true,
    imageTypes: ['main_image']
  }, {
    taskReader: async () => sampleTask(),
    visionProvider: successVisionProvider(calls),
    singleImageRunner: async () => {
      calls.push('image:main_image');
      throw new Error('IMAGE_API_KEY=sk-secret C:\\tmp\\.env provider failed');
    }
  });

  const json = JSON.stringify(report);
  assert.equal(report.summary.overallStatus, 'partial');
  assert.equal(report.apiCalls.length, 2);
  assert.equal(report.apiCalls[1].apiType, 'imageGeneration');
  assert.equal(report.apiCalls[1].status, 'failed');
  assert.match(report.warnings.map((item) => item.code).join(','), /REAL_IMAGE_GENERATION_FAILED/);
  assert.doesNotMatch(json, /IMAGE_API_KEY|sk-secret|[A-Z]:\\|\.env/i);
});

test('real API acceptance export returns sanitized JSON file', async () => {
  const report = {
    meta: { taskId: 'task-real-api-001', generatedAt: '2026-06-01T12:00:00.000Z' },
    apiCalls: [{ errorMessage: 'QWEN_API_KEY=sk-secret C:\\tmp\\.env' }]
  };
  const exported = exportRealApiAcceptanceReport(report, { timestamp: '2026-06-01T12-00-00-000Z' });

  assert.equal(exported.fileName, 'real-api-acceptance-report-task-real-api-001-2026-06-01T12-00-00-000Z.json');
  assert.equal(exported.mimeType, 'application/json');
  assert.doesNotMatch(exported.content, /QWEN_API_KEY|sk-secret|[A-Z]:\\|\.env/i);
});
