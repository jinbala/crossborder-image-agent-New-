import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildSingleImageGenerationAcceptanceReport,
  buildThreeSampleAggregateReport
} from '../src/services/singleImageGenerationReportService.js';

function sampleTask() {
  return {
    id: 'acceptance-task-001',
    platformId: 'amazon',
    categoryId: 'electronics_storage',
    productInfoConfirmed: {
      sku: 'SKU-ACCEPT-001',
      name: 'Portable External Drive',
      brand: 'SafeBrand',
      model: 'X100'
    },
    sourceImages: [
      {
        id: 'source-1',
        displayName: 'front-view.jpg',
        filePath: 'uploads/front-view.jpg'
      }
    ],
    imagePlans: [
      {
        id: 'main-plan',
        type: 'main_image',
        platformId: 'amazon',
        categoryId: 'electronics_storage',
        usedConfirmedFields: [
          { field: 'brand', value: 'SafeBrand' },
          { field: 'model', value: 'X100' }
        ],
        excludedUnconfirmedFields: [
          { field: 'capacity', reason: 'missing evidence' }
        ],
        generationRequestSummary: {
          blockedFields: ['capacity'],
          inferredFieldsExcluded: ['warranty'],
          conflictedFieldsExcluded: ['interfaceType']
        }
      }
    ],
    generatedImages: [],
    inferredCandidates: [{ field: 'warranty', value: '3 years' }]
  };
}

function generationInput() {
  const task = sampleTask();
  const plan = task.imagePlans[0];
  return {
    task,
    plan,
    image: {
      id: 'main-image-real',
      imageType: 'main_image',
      type: 'main_image',
      previewUrl: '/outputs/acceptance-task-001/main.png',
      url: '/outputs/acceptance-task-001/main.png',
      fileName: 'main.png',
      status: 'succeeded',
      isRealGenerated: true
    },
    providerResult: {
      provider: 'openai',
      model: 'gpt-image-2',
      status: 'success',
      durationMs: 1234,
      metadata: {
        generationStrategy: { selectedMode: 'text_to_image' }
      }
    },
    mattingResult: {
      requestedProvider: 'image2',
      providerUsed: 'sharp',
      fallbackUsed: true,
      fallbackReason: 'Image2 unavailable, fallback to sharp'
    },
    generationRequest: {
      providerMode: 'auto',
      productReference: { sourceImageId: 'source-1' }
    },
    qualityScore: {
      score: 86,
      level: 'good',
      warnings: ['manual edge check required'],
      details: { edge: 'clean' }
    },
    templateAudit: {
      imageTypeCoverage: { present: ['main_image'], missing: [] },
      templateDiversity: { score: 100 },
      textSafety: { passed: true },
      fieldSafety: { passed: true },
      amazonMainImageCheck: { passed: true },
      ruleAuditSummary: {
        passed: true,
        issueCounts: { error: 0, warning: 1, info: 0 },
        issues: [{ severity: 'warning', code: 'manual_review', message: 'manual check' }],
        blockedFields: ['capacity'],
        cautionFields: ['material'],
        recommendations: ['人工检查主图白底和主体完整性。']
      }
    },
    fallbackUsed: true,
    fallbackReason: 'Image2 unavailable, fallback to sharp',
    warnings: ['manual edge check required'],
    generatedAt: '2026-06-01T10:20:30.000Z'
  };
}

test('builds single image acceptance report with required sections and defaults', () => {
  const source = generationInput();
  const before = JSON.stringify(source.task);
  const report = buildSingleImageGenerationAcceptanceReport(source);

  assert.match(report.meta.reportId, /^single-image-generation-report-acceptance-task-001-main_image-/);
  assert.equal(report.meta.taskId, 'acceptance-task-001');
  assert.equal(report.meta.sku, 'SKU-ACCEPT-001');
  assert.equal(report.meta.productName, 'Portable External Drive');
  assert.equal(report.meta.imageType, 'main_image');
  assert.equal(report.meta.testMode, 'single-image-sample');
  assert.equal(report.meta.mattingProvider, 'image2');
  assert.equal(report.meta.generationProvider, 'openai');
  assert.equal(report.meta.modelName, 'gpt-image-2');
  assert.match(report.meta.costNotice, /单 SKU 小样本/);

  assert.equal(report.inputSummary.sourceImageName, 'front-view.jpg');
  assert.equal(report.inputSummary.imagePlanId, 'main-plan');
  assert.deepEqual(report.inputSummary.confirmedFieldsUsed.map((item) => item.field), ['brand', 'model']);
  assert.deepEqual(report.inputSummary.blockedFields, ['capacity']);
  assert.deepEqual(report.inputSummary.inferredFieldsExcluded, ['warranty']);
  assert.deepEqual(report.inputSummary.conflictedFieldsExcluded, ['interfaceType']);

  assert.equal(report.generationResult.status, 'succeeded');
  assert.equal(report.generationResult.outputImage, '/outputs/acceptance-task-001/main.png');
  assert.equal(report.generationResult.previewImage, '/outputs/acceptance-task-001/main.png');
  assert.equal(report.generationResult.durationMs, 1234);
  assert.equal(report.generationResult.fallbackUsed, true);
  assert.equal(report.generationResult.outputType, 'real-generated');
  assert.deepEqual(report.qualityScore.warnings, ['manual edge check required']);
  assert.ok(report.templateAudit.imageTypeCoverage);
  assert.ok(report.ruleAuditSummary);

  for (const [key, value] of Object.entries(report.manualChecklist)) {
    if (key === 'notes') assert.equal(value, '');
    else assert.equal(value, false, `${key} should default to unchecked`);
  }
  assert.equal(report.conclusion.keepExperimentalOnly, true);
  assert.equal(report.conclusion.allowBatchGeneration, false);
  assert.equal(report.conclusion.allowFormalGenerationUse, false);
  assert.match(report.conclusion.recommendedNextAction, /人工/);
  assert.equal(JSON.stringify(source.task), before);
});

test('single image acceptance report is sanitized', () => {
  const report = buildSingleImageGenerationAcceptanceReport({
    ...generationInput(),
    image: {
      ...generationInput().image,
      previewUrl: 'D:\\Code\\crossborder-image-agent\\outputs\\main.png',
      url: 'C:\\Users\\demo\\app.sqlite'
    },
    providerResult: {
      ...generationInput().providerResult,
      error: {
        message: 'OPENAI_API_KEY=sk-secret D:\\Code\\.env node_modules app.sqlite'
      }
    },
    warnings: ['Provider secret sk-secret D:\\Code\\.env node_modules app.sqlite']
  });

  const json = JSON.stringify(report);
  assert.doesNotMatch(json, /\.env/i);
  assert.doesNotMatch(json, /API_KEY/i);
  assert.doesNotMatch(json, /sk-secret/i);
  assert.doesNotMatch(json, /[A-Z]:\\/);
  assert.doesNotMatch(json, /app\.sqlite/i);
  assert.doesNotMatch(json, /node_modules/i);
});

test('builds sanitized three-sample aggregate report with conservative defaults', () => {
  const sampleReports = ['main_image', 'feature_image', 'detail_image'].map((imageType, index) => ({
    sampleId: `sample-${index + 1}`,
    meta: {
      taskId: 'acceptance-task-001',
      imageType,
      generationProvider: 'fake-real',
      modelName: 'fake-image-v1',
      mattingProvider: 'sharp'
    },
    generationResult: {
      status: index === 1 ? 'fallback_mock' : 'succeeded',
      outputImage: `/outputs/acceptance-task-001/${imageType}.png`,
      previewImage: `/outputs/acceptance-task-001/${imageType}.png`,
      durationMs: 100 + index,
      fallbackUsed: index === 1,
      fallbackReason: index === 1 ? 'provider failed' : '',
      warnings: index === 2 ? ['edge warning'] : []
    },
    qualityScore: { score: [92, 61, 80][index], level: 'good', warnings: index === 2 ? ['edge warning'] : [] },
    templateAudit: { textSafety: { passed: true } },
    ruleAuditSummary: {
      passed: true,
      issueCounts: { error: 0, warning: index, info: 0 },
      recommendations: ['manual check']
    },
    manualChecklist: { productShapePreserved: false, notes: '' },
    conclusion: { keepExperimentalOnly: true, allowBatchGeneration: false, allowFormalGenerationUse: false }
  }));

  const report = buildThreeSampleAggregateReport({
    taskId: 'acceptance-task-001',
    sampleReports,
    mattingProvider: 'sharp',
    generationProvider: 'fake-real',
    confirmPaidApi: true,
    generatedAt: '2026-06-01T11:22:33.000Z',
    unsafeDebug: 'OPENAI_API_KEY=sk-secret D:\\Code\\.env app.sqlite node_modules'
  });

  assert.equal(report.meta.testMode, 'three-sample-real-generation');
  assert.equal(report.meta.sampleCount, 3);
  assert.deepEqual(report.meta.imageTypes, ['main_image', 'feature_image', 'detail_image']);
  assert.equal(report.summary.totalSamples, 3);
  assert.equal(report.summary.successCount, 2);
  assert.equal(report.summary.failedCount, 0);
  assert.equal(report.summary.fallbackCount, 1);
  assert.equal(report.summary.averageQualityScore, 78);
  assert.equal(report.summary.lowestQualityScore, 61);
  assert.equal(report.summary.highestQualityScore, 92);
  assert.equal(report.comparison.bestSampleId, 'sample-1');
  assert.equal(report.comparison.worstSampleId, 'sample-2');
  assert.deepEqual(report.comparison.commonWarnings, ['edge warning']);
  assert.equal(report.manualChecklist.productShapeConsistency, false);
  assert.equal(report.manualChecklist.textSafetyAcrossSamples, false);
  assert.equal(report.manualChecklist.notes, '');
  assert.equal(report.conclusion.keepExperimentalOnly, true);
  assert.equal(report.conclusion.allowBatchGeneration, false);
  assert.equal(report.conclusion.allowFormalGenerationUse, false);

  const json = JSON.stringify(report);
  assert.doesNotMatch(json, /OPENAI_API_KEY/i);
  assert.doesNotMatch(json, /sk-secret/i);
  assert.doesNotMatch(json, /\.env/i);
  assert.doesNotMatch(json, /[A-Z]:\\/);
  assert.doesNotMatch(json, /app\.sqlite/i);
  assert.doesNotMatch(json, /node_modules/i);
});
