import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  getSingleImageGenerationReport,
  runThreeSampleGeneration,
  runSingleImageGeneration
} from '../src/services/singleImageGenerationService.js';

const imageTypes = ['main_image', 'feature_image', 'detail_image'];

function plan(type) {
  return {
    id: `${type}-plan`,
    type,
    platformId: 'amazon',
    platformName: 'Amazon',
    categoryId: 'electronics_storage',
    title: `${type} plan`,
    background: type === 'main_image' ? 'pure_white' : 'clean_neutral',
    textBlocks: type === 'main_image' ? [] : [{ text: 'Fast backup', sourceFields: ['sellingPoints'] }],
    templateSeed: {
      templateType: type,
      templateName: `${type} Template`,
      layoutStyle: `${type}-layout`,
      backgroundStyle: type === 'main_image' ? 'pure_white' : 'clean_neutral',
      iconHints: []
    }
  };
}

function task(overrides = {}) {
  return {
    id: 'single-real-task',
    platformId: 'amazon',
    categoryId: 'electronics_storage',
    platform: 'Amazon',
    productInfoConfirmed: {
      sku: 'REAL-001',
      name: 'Portable External Drive',
      category: 'External Storage'
    },
    sourceImages: [{
      id: 'source-1',
      displayName: 'main.jpg',
      previewUrl: '/uploads/main.jpg',
      filePath: 'uploads/main.jpg'
    }],
    imagePlans: imageTypes.map(plan),
    generatedImages: [],
    inferredCandidates: [{ field: 'capacity', value: '5TB' }],
    recognitionQuality: {
      missingEvidenceFields: [{ field: 'capacity' }]
    },
    ...overrides
  };
}

function fakeProvider({ status = 'success', error = null } = {}) {
  return {
    provider: 'fake-real',
    model: 'fake-image-v1',
    generate: async ({ task: taskValue, plan: planValue }) => ({
      provider: 'fake-real',
      model: 'fake-image-v1',
      status,
      durationMs: 12,
      error,
      output: status === 'success' ? {
        fileName: `${planValue.type}.png`,
        previewUrl: `/outputs/${taskValue.id}/${planValue.type}.png`,
        url: `/outputs/${taskValue.id}/${planValue.type}.png`,
        width: 1536,
        height: 1536,
        format: 'png',
        isRealGenerated: true,
        isMockPreview: false
      } : null,
      metadata: {
        preserveQuality: { score: 91, level: 'good', warnings: [] },
        generationStrategy: { selectedMode: 'text_to_image' }
      }
    })
  };
}

test('single-image approval is strict and precedes task reads, matting, image calls and fallback writes', async () => {
  const calls = { read: 0, matting: 0, generation: 0, fallback: 0 };
  for (const confirmReal of [undefined, false, 'true', 1, {}]) await assert.rejects(runSingleImageGeneration({ taskId: 'single-real-task', imageType: 'main_image', mattingProvider: 'image2', confirmReal }, {
    taskReader: async () => { calls.read++; return task(); }, mattingRunner: async () => { calls.matting++; return {}; },
    imageProvider: { generate: async () => { calls.generation++; return {}; } }, mockGenerator: async () => { calls.fallback++; return {}; }
  }), (err) => err.statusCode === 403 && err.code === 'REAL_GENERATION_NOT_CONFIRMED');
  assert.deepEqual(calls, { read: 0, matting: 0, generation: 0, fallback: 0 });
});

test('single image generation supports main feature and detail without mutating task', async () => {
  for (const imageType of imageTypes) {
    const sourceTask = task();
    const before = JSON.parse(JSON.stringify(sourceTask));
    const report = await runSingleImageGeneration({
      confirmReal: true,
      taskId: sourceTask.id,
      imageType,
      realMode: 'text_to_image',
      mattingProvider: 'sharp'
    }, {
      taskReader: async () => sourceTask,
      imageProvider: fakeProvider(),
      mattingRunner: async () => ({
        providerUsed: 'sharp',
        fallbackUsed: false,
        fallbackReason: '',
        qualityScore: { score: 88, level: 'good', warnings: [] },
        warnings: []
      })
    });

    assert.equal(report.singleImageGeneration.taskId, sourceTask.id);
    assert.equal(report.singleImageGeneration.imageType, imageType);
    assert.equal(report.singleImageGeneration.status, 'succeeded');
    assert.equal(report.singleImageGeneration.providerUsed, 'fake-real');
    assert.equal(report.singleImageGeneration.isRealGenerated, true);
    assert.equal(report.singleImageGeneration.previewUrl, `/outputs/${sourceTask.id}/${imageType}.png`);
    assert.ok(report.templateAudit);
    assert.ok(report.ruleAuditSummary);
    assert.equal(typeof report.qualityScore.score, 'number');
    assert.deepEqual(sourceTask, before);
  }
});

test('single image generation records Image2 matting fallback to sharp', async () => {
  const report = await runSingleImageGeneration({
    confirmReal: true,
    taskId: 'single-real-task',
    imageType: 'detail_image',
    mattingProvider: 'image2'
  }, {
    taskReader: async () => task(),
    imageProvider: fakeProvider(),
    mattingRunner: async () => ({
      requestedProvider: 'image2',
      providerUsed: 'sharp',
      fallbackUsed: true,
      fallbackReason: 'Image2 unavailable, fallback to sharp',
      qualityScore: { score: 75, level: 'medium', warnings: ['edge needs review'] },
      warnings: ['edge needs review']
    })
  });

  assert.equal(report.singleImageGeneration.matting.requestedProvider, 'image2');
  assert.equal(report.singleImageGeneration.matting.providerUsed, 'sharp');
  assert.equal(report.singleImageGeneration.matting.fallbackUsed, true);
  assert.match(report.singleImageGeneration.fallbackReason, /Image2 unavailable/);
  assert.deepEqual(report.warnings, ['edge needs review']);
});

test('single image generation falls back to mock when real provider fails', async () => {
  const report = await runSingleImageGeneration({
    confirmReal: true,
    taskId: 'single-real-task',
    imageType: 'feature_image'
  }, {
    taskReader: async () => task(),
    imageProvider: fakeProvider({
      status: 'failed',
      error: { code: 'MISSING_API_KEY', message: 'OPENAI_API_KEY=sk-secret D:\\Code\\.env' }
    }),
    mattingRunner: async () => ({ qualityScore: { score: 80, level: 'good', warnings: [] } }),
    mockGenerator: async ({ task: taskValue, plan: planValue }) => ({
      id: `${planValue.id}-mock`,
      planId: planValue.id,
      type: planValue.type,
      imageType: planValue.type,
      previewUrl: `/outputs/${taskValue.id}/${planValue.type}-mock.jpg`,
      url: `/outputs/${taskValue.id}/${planValue.type}-mock.jpg`,
      fileName: `${planValue.type}-mock.jpg`,
      status: 'succeeded',
      isMockPreview: true,
      isRealGenerated: false
    })
  });

  const json = JSON.stringify(report);
  assert.equal(report.singleImageGeneration.status, 'fallback_mock');
  assert.equal(report.singleImageGeneration.fallbackUsed, true);
  assert.equal(report.singleImageGeneration.isRealGenerated, false);
  assert.doesNotMatch(json, /OPENAI_API_KEY/i);
  assert.doesNotMatch(json, /sk-secret/);
  assert.doesNotMatch(json, /\.env/i);
  assert.doesNotMatch(json, /[A-Z]:\\/);
});

test('single image generation report is available by task id from memory', async () => {
  await runSingleImageGeneration({
    confirmReal: true,
    taskId: 'single-real-task',
    imageType: 'main_image'
  }, {
    taskReader: async () => task(),
    imageProvider: fakeProvider(),
    mattingRunner: async () => ({ qualityScore: { score: 90, level: 'good', warnings: [] } })
  });

  const report = await getSingleImageGenerationReport('single-real-task');

  assert.equal(report.taskId, 'single-real-task');
  assert.equal(report.latest.singleImageGeneration.imageType, 'main_image');
  assert.ok(report.latest.ruleAuditSummary);
});

test('three sample generation enforces paid confirmation and three sample limit', async () => {
  await assert.rejects(
    runThreeSampleGeneration({
      taskId: 'single-real-task',
      confirmPaidApi: true,
      samples: [
        { sampleId: 's1', imageType: 'main_image' },
        { sampleId: 's2', imageType: 'feature_image' },
        { sampleId: 's3', imageType: 'detail_image' },
        { sampleId: 's4', imageType: 'main_image' }
      ]
    }, { taskReader: async () => task() }),
    /最多 3|maximum 3/i
  );

  let providerCalls = 0;
  await assert.rejects(
    runThreeSampleGeneration({
      taskId: 'single-real-task',
      confirmPaidApi: false,
      samples: [{ sampleId: 's1', imageType: 'main_image' }]
    }, {
      taskReader: async () => task(),
      imageProvider: {
        provider: 'fake-real',
        model: 'fake-image-v1',
        generate: async () => {
          providerCalls += 1;
          return { status: 'success', output: {} };
        }
      }
    }),
    /confirmPaidApi=true/
  );
  assert.equal(providerCalls, 0);
});

test('three sample generation builds aggregate report and isolates one sample failure', async () => {
  const sourceTask = task({
    sourceImages: [
      { id: 'source-1', displayName: 'front.jpg', previewUrl: '/uploads/front.jpg' },
      { id: 'source-2', displayName: 'angle.jpg', previewUrl: '/uploads/angle.jpg' },
      { id: 'source-3', displayName: 'port.jpg', previewUrl: '/uploads/port.jpg' }
    ]
  });
  const before = JSON.parse(JSON.stringify(sourceTask));
  const calls = [];
  const result = await runThreeSampleGeneration({
    taskId: sourceTask.id,
    confirmPaidApi: true,
    mattingProvider: 'sharp',
    generationProvider: 'fake-real',
    samples: [
      { sampleId: 'sample-1', imageType: 'main_image', imageId: 'source-1' },
      { sampleId: 'sample-2', imageType: 'unsupported_image', imageId: 'source-2' },
      { sampleId: 'sample-3', imageType: 'detail_image', imageId: 'source-3' }
    ]
  }, {
    taskReader: async () => sourceTask,
    imageProvider: {
      provider: 'fake-real',
      model: 'fake-image-v1',
      generate: async ({ plan: planValue }) => {
        calls.push(planValue.type);
        return {
          provider: 'fake-real',
          model: 'fake-image-v1',
          status: 'success',
          durationMs: planValue.type === 'main_image' ? 10 : 20,
          output: {
            fileName: `${planValue.type}.png`,
            previewUrl: `D:\\Code\\.env\\${planValue.type}.png`,
            url: `/outputs/${planValue.type}.png`,
            isRealGenerated: true,
            isMockPreview: false
          },
          metadata: { preserveQuality: { score: planValue.type === 'main_image' ? 90 : 80, level: 'good', warnings: [] } }
        };
      }
    },
    mattingRunner: async (input) => ({
      requestedProvider: input.provider,
      providerUsed: 'sharp',
      fallbackUsed: false,
      qualityScore: { score: 88, level: 'good', warnings: [] },
      warnings: []
    })
  });

  assert.equal(result.status, 'partial');
  assert.equal(result.sampleReports.length, 3);
  assert.equal(result.sampleReports[0].sampleId, 'sample-1');
  assert.equal(result.sampleReports[0].generationResult.status, 'succeeded');
  assert.equal(result.sampleReports[1].sampleId, 'sample-2');
  assert.equal(result.sampleReports[1].generationResult.status, 'failed');
  assert.equal(result.sampleReports[2].generationResult.status, 'succeeded');
  assert.deepEqual(calls, ['main_image', 'detail_image']);
  assert.equal(result.aggregateReport.summary.totalSamples, 3);
  assert.equal(result.aggregateReport.summary.successCount, 2);
  assert.equal(result.aggregateReport.summary.failedCount, 1);
  assert.equal(result.aggregateReport.meta.confirmPaidApi, true);
  assert.equal(result.aggregateReport.conclusion.keepExperimentalOnly, true);
  assert.equal(result.aggregateReport.conclusion.allowBatchGeneration, false);
  assert.equal(result.aggregateReport.conclusion.allowFormalGenerationUse, false);

  const json = JSON.stringify(result);
  assert.doesNotMatch(json, /\.env/i);
  assert.doesNotMatch(json, /[A-Z]:\\/);
  assert.deepEqual(sourceTask, before);
});

test('three sample generation sanitizes missing API key errors in full response', async () => {
  const sourceTask = task();
  const result = await runThreeSampleGeneration({
    taskId: sourceTask.id,
    confirmPaidApi: true,
    mattingProvider: 'sharp',
    generationProvider: 'fake-real',
    samples: [{ sampleId: 'sample-1', imageType: 'main_image', imageId: 'source-1' }]
  }, {
    taskReader: async () => sourceTask,
    imageProvider: fakeProvider({
      status: 'failed',
      error: {
        code: 'MISSING_API_KEY',
        message: 'OPENAI_API_KEY is required for BACKGROUND_PROVIDER=openai D:\\Code\\.env sk-secret'
      }
    }),
    mattingRunner: async () => ({ qualityScore: { score: 80, level: 'good', warnings: [] } }),
    mockGenerator: async ({ task: taskValue, plan: planValue }) => ({
      id: `${planValue.id}-mock`,
      planId: planValue.id,
      type: planValue.type,
      imageType: planValue.type,
      previewUrl: `/outputs/${taskValue.id}/${planValue.type}-mock.jpg`,
      url: `/outputs/${taskValue.id}/${planValue.type}-mock.jpg`,
      fileName: `${planValue.type}-mock.jpg`,
      status: 'succeeded',
      isMockPreview: true,
      isRealGenerated: false
    })
  });

  const json = JSON.stringify(result);
  assert.doesNotMatch(json, /API_KEY/i);
  assert.doesNotMatch(json, /sk-secret/i);
  assert.doesNotMatch(json, /\.env/i);
  assert.doesNotMatch(json, /[A-Z]:\\/);
});
