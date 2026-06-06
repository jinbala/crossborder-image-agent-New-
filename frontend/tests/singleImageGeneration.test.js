import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  buildSingleImageGenerationDownload,
  buildThreeSampleGenerationDownload,
  singleImageAcceptanceReportSections,
  threeSampleGenerationSections,
  threeSampleCanRun,
  singleImageGenerationEmptyText,
  singleImageGenerationNotice,
  singleImageGenerationOptions,
  singleImageGenerationSections,
  singleImageGenerationWarningText
} from '../src/utils/singleImageGeneration.js';

function report(overrides = {}) {
  return {
    taskId: 'single-real-task',
    meta: {
      taskId: 'single-real-task',
      sku: 'SKU-001',
      productName: 'Portable External Drive',
      imageType: 'main_image',
      platformId: 'amazon',
      categoryId: 'electronics_storage',
      testMode: 'single-image-sample',
      providerMode: 'auto',
      mattingProvider: 'sharp',
      generationProvider: 'openai',
      modelName: 'gpt-image-2',
      costNotice: '单 SKU 小样本真实生图验收记录，仅用于人工测试。'
    },
    inputSummary: {
      sourceImageName: 'front.jpg',
      imagePlanId: 'main_image-plan',
      imageType: 'main_image',
      confirmedFieldsUsed: [{ field: 'brand', value: 'SafeBrand' }],
      blockedFields: ['capacity'],
      inferredFieldsExcluded: ['warranty'],
      conflictedFieldsExcluded: ['interfaceType']
    },
    generationResult: {
      status: 'succeeded',
      outputImage: '/outputs/single-real-task/main.png',
      previewImage: '/outputs/single-real-task/main.png',
      durationMs: 1234,
      fallbackUsed: false,
      fallbackReason: '',
      outputType: 'real-generated',
      warnings: []
    },
    singleImageGeneration: {
      taskId: 'single-real-task',
      planId: 'main_image-plan',
      imageType: 'main_image',
      status: 'succeeded',
      requestedProvider: 'openai',
      providerUsed: 'openai',
      model: 'gpt-image-2',
      previewUrl: '/outputs/single-real-task/main.png',
      fileName: 'main.png',
      width: 1536,
      height: 1536,
      isRealGenerated: true,
      fallbackUsed: false,
      fallbackReason: '',
      matting: {
        requestedProvider: 'sharp',
        providerUsed: 'sharp',
        fallbackUsed: false,
        qualityScore: { score: 88, level: 'good', warnings: [] }
      }
    },
    qualityScore: { score: 91, level: 'good', warnings: [] },
    manualChecklist: {
      productShapePreserved: false,
      edgeCleanliness: false,
      interfaceIntegrity: false,
      holeAndPortIntegrity: false,
      texturePreserved: false,
      textReadable: false,
      noChineseText: false,
      noWrongClaims: false,
      platformRulePass: false,
      suitableForMainImage: false,
      suitableForFeatureImage: false,
      suitableForDetailImage: false,
      suitableForNextStage: false,
      notes: ''
    },
    conclusion: {
      keepExperimentalOnly: true,
      allowBatchGeneration: false,
      allowFormalGenerationUse: false,
      recommendedNextAction: '请人工打开生成图，检查产品形状、接口、孔位、纹理和英文文案。未完成人工验收前，不建议扩大真实生图范围。'
    },
    warnings: [],
    templateAudit: {
      meta: { taskId: 'single-real-task', imageCount: 1 },
      imageTypeCoverage: [{ imageType: 'main_image', status: 'present' }],
      templateDiversity: { diversityScore: 100 },
      textSafety: { containsChinese: false },
      fieldSafety: { usesInferredCandidates: false },
      amazonMainImageCheck: { pass: true }
    },
    ruleAuditSummary: {
      passed: true,
      platformId: 'amazon',
      categoryId: 'electronics_storage',
      issueCounts: { error: 0, warning: 1, info: 0 },
      effectiveRulesSummary: { mainImageText: '白底，无文字，无 icon' },
      recommendations: ['人工验收主图白底和主体清晰度。']
    },
    effectiveRulesSummary: { mainImageText: '白底，无文字，无 icon' },
    issueCounts: { error: 0, warning: 1, info: 0 },
    recommendations: ['人工验收主图白底和主体清晰度。'],
    ...overrides
  };
}

function threeSampleResult(overrides = {}) {
  return {
    status: 'partial',
    summary: { totalSamples: 3, successCount: 2, failedCount: 1, fallbackCount: 0, averageQualityScore: 78 },
    sampleReports: [
      { sampleId: 's1', ...report({ meta: { ...report().meta, imageType: 'main_image' } }) },
      { sampleId: 's2', ...report({ meta: { ...report().meta, imageType: 'feature_image' }, qualityScore: { score: 70, level: 'medium', warnings: ['edge warning'] } }) },
      {
        sampleId: 's3',
        meta: { taskId: 'single-real-task', imageType: 'detail_image', generationProvider: 'openai', modelName: 'gpt-image-2', mattingProvider: 'sharp' },
        generationResult: { status: 'failed', fallbackUsed: false, warnings: ['failed warning'] },
        qualityScore: { score: 0, level: 'failed', warnings: ['failed warning'] },
        ruleAuditSummary: { issueCounts: { error: 1, warning: 0, info: 0 } },
        templateAudit: {},
        manualChecklist: { productShapePreserved: false, notes: '' },
        conclusion: { keepExperimentalOnly: true, allowBatchGeneration: false, allowFormalGenerationUse: false }
      }
    ],
    aggregateReport: {
      meta: {
        taskId: 'single-real-task',
        testMode: 'three-sample-real-generation',
        sampleCount: 3,
        imageTypes: ['main_image', 'feature_image', 'detail_image'],
        mattingProvider: 'sharp',
        generationProvider: 'openai',
        confirmPaidApi: true
      },
      summary: { totalSamples: 3, successCount: 2, failedCount: 1, fallbackCount: 0, averageQualityScore: 78 },
      comparison: {
        bestSampleId: 's1',
        worstSampleId: 's3',
        commonWarnings: ['edge warning', 'failed warning'],
        recommendation: '请人工逐张检查 3 张生成图。'
      },
      manualChecklist: {
        productShapeConsistency: false,
        textSafetyAcrossSamples: false,
        platformRuleConsistency: false,
        subjectPreservationAcrossSamples: false,
        suitableForNextStage: false,
        notes: ''
      },
      conclusion: {
        keepExperimentalOnly: true,
        allowBatchGeneration: false,
        allowFormalGenerationUse: false,
        recommendedNextAction: '请人工逐张检查 3 张生成图。'
      }
    },
    ...overrides
  };
}

test('single image generation helper exposes safe options notice and empty state', () => {
  assert.deepEqual(singleImageGenerationOptions.map((item) => item.value), ['main_image', 'feature_image', 'detail_image']);
  assert.match(singleImageGenerationNotice, /单 SKU 小样本/);
  assert.match(singleImageGenerationNotice, /不批量/);
  assert.match(singleImageGenerationWarningText, /导出内容已脱敏/);
  assert.match(singleImageGenerationEmptyText(null), /暂无真实生图小样本结果/);
  assert.match(singleImageGenerationEmptyText(null), /暂无单图生成报告/);
});

test('single image generation helpers tolerate null and missing report data', () => {
  assert.doesNotThrow(() => singleImageGenerationSections(null));
  assert.doesNotThrow(() => singleImageGenerationSections(undefined));
  assert.doesNotThrow(() => singleImageAcceptanceReportSections(null));
  assert.doesNotThrow(() => singleImageAcceptanceReportSections({ singleImageGeneration: null }));

  const nullSections = singleImageGenerationSections(null);
  const missingSections = singleImageAcceptanceReportSections({ singleImageGeneration: null });
  assert.match(nullSections.emptyText, /暂无真实生图小样本结果|暂无.*单图生成报告|鏆傛棤/);
  assert.equal(nullSections.cards.length, 0);
  assert.match(missingSections.emptyText, /暂无真实生图小样本结果|暂无.*单图生成报告|鏆傛棤/);
});

test('single image generation sections summarize result audit and quality', () => {
  const sections = singleImageGenerationSections(report());

  assert.equal(sections.emptyText, '');
  assert.match(sections.resultText, /main_image/);
  assert.match(sections.resultText, /openai/);
  assert.match(sections.auditText, /error 0/);
  assert.match(sections.qualityText, /91/);
  assert.match(sections.ruleText, /白底/);
  assert.equal(sections.cards.some((card) => card.label === 'qualityScore' && card.value === '91'), true);
});

test('single image acceptance report sections show manual checklist and conclusion', () => {
  const sections = singleImageAcceptanceReportSections(report());

  assert.equal(sections.emptyText, '');
  assert.match(sections.title, /真实生图验收报告/);
  assert.match(sections.statusText, /succeeded/);
  assert.match(sections.providerText, /openai/);
  assert.match(sections.providerText, /gpt-image-2/);
  assert.match(sections.providerText, /sharp/);
  assert.match(sections.fallbackText, /未触发/);
  assert.match(sections.qualityText, /91/);
  assert.match(sections.ruleAuditText, /warning 1/);
  assert.match(sections.templateAuditText, /templateAudit/);
  assert.match(sections.manualChecklistText, /默认未检查/);
  assert.match(sections.conclusionText, /仅保留小样本实验/);
});

test('single image generation JSON download is sanitized and complete', () => {
  const download = buildSingleImageGenerationDownload(report({
    warnings: ['OPENAI_API_KEY=sk-secret D:\\Code\\app.sqlite .env node_modules']
  }), '2026-06-01T02:03:04.000Z');

  assert.equal(download.fileName, 'single-image-generation-report-single-real-task-main_image-2026-06-01T02-03-04-000Z.json');
  assert.match(download.json, /ruleAuditSummary/);
  assert.match(download.json, /templateAudit/);
  assert.match(download.json, /qualityScore/);
  assert.match(download.json, /manualChecklist/);
  assert.match(download.json, /conclusion/);
  assert.doesNotMatch(download.json, /OPENAI_API_KEY/i);
  assert.doesNotMatch(download.json, /sk-secret/);
  assert.doesNotMatch(download.json, /\.env/i);
  assert.doesNotMatch(download.json, /[A-Z]:\\/);
  assert.doesNotMatch(download.json, /app\.sqlite/i);
  assert.doesNotMatch(download.json, /node_modules/i);
});

test('three sample helpers require cost confirmation and summarize aggregate report', () => {
  assert.equal(threeSampleCanRun({ confirmPaidApi: false, samples: [{}, {}, {}] }).canRun, false);
  assert.match(threeSampleCanRun({ confirmPaidApi: false, samples: [{}, {}, {}] }).reason, /API 成本/);
  assert.equal(threeSampleCanRun({ confirmPaidApi: true, samples: [{}, {}, {}, {}] }).canRun, false);
  assert.match(threeSampleCanRun({ confirmPaidApi: true, samples: [{}, {}, {}, {}] }).reason, /最多 3/);
  assert.equal(threeSampleCanRun({ confirmPaidApi: true, samples: [{}, {}, {}] }).canRun, true);

  const sections = threeSampleGenerationSections(threeSampleResult());
  assert.equal(sections.emptyText, '');
  assert.match(sections.title, /三张小样本对比/);
  assert.match(sections.summaryText, /成功 2/);
  assert.match(sections.summaryText, /失败 1/);
  assert.match(sections.comparisonText, /edge warning/);
  assert.match(sections.recommendationText, /人工逐张检查/);
  assert.equal(sections.sampleCards.length, 3);
  assert.match(sections.sampleCards[0].qualityText, /91/);
  assert.match(threeSampleGenerationSections(null).emptyText, /暂无三张小样本对比报告/);
});

test('three sample JSON download is sanitized and uses required file name', () => {
  const download = buildThreeSampleGenerationDownload(threeSampleResult({
    aggregateReport: {
      ...threeSampleResult().aggregateReport,
      unsafeDebug: 'OPENAI_API_KEY=sk-secret D:\\Code\\.env app.sqlite node_modules'
    }
  }), '2026-06-01T02:03:04.000Z');

  assert.equal(download.fileName, 'three-sample-generation-report-single-real-task-2026-06-01T02-03-04-000Z.json');
  assert.match(download.json, /aggregateReport/);
  assert.match(download.json, /sampleReports/);
  assert.match(download.json, /manualChecklist/);
  assert.match(download.json, /conclusion/);
  assert.doesNotMatch(download.json, /OPENAI_API_KEY/i);
  assert.doesNotMatch(download.json, /sk-secret/);
  assert.doesNotMatch(download.json, /\.env/i);
  assert.doesNotMatch(download.json, /[A-Z]:\\/);
  assert.doesNotMatch(download.json, /app\.sqlite/i);
  assert.doesNotMatch(download.json, /node_modules/i);
});

test('single image generation API helpers and pages are wired', async () => {
  const { api } = await import('../src/services/api.js');
  const captured = [];
  global.fetch = async (url, options = {}) => {
    captured.push({ url, options });
    return {
      ok: true,
      json: async () => ({ report: report() })
    };
  };

  await api.runSingleImageGeneration({
    taskId: 'single-real-task',
    imageType: 'detail_image',
    mattingProvider: 'sharp',
    confirmReal: true
  });
  await api.getSingleImageGenerationReport('single-real-task');
  await api.runThreeSampleGeneration({
    taskId: 'single-real-task',
    confirmPaidApi: true,
    mattingProvider: 'sharp',
    samples: [{ sampleId: 's1', imageType: 'main_image', imageId: 'source-1' }]
  });

  const generatePage = readFileSync(new URL('../src/pages/GeneratePage.jsx', import.meta.url), 'utf8');
  const imagePlanPage = readFileSync(new URL('../src/pages/ImagePlanPage.jsx', import.meta.url), 'utf8');

  assert.equal(captured[0].url, '/api/generate/single-image');
  assert.equal(JSON.parse(captured[0].options.body).imageType, 'detail_image');
  assert.equal(JSON.parse(captured[0].options.body).confirmReal, true);
  assert.equal(captured[1].url, '/api/generate/single-real-task/report');
  assert.equal(captured[2].url, '/api/generate/three-sample');
  assert.equal(JSON.parse(captured[2].options.body).confirmPaidApi, true);
  assert.match(generatePage, /单 SKU 小样本/);
  assert.match(generatePage, /三张小样本对比/);
  assert.match(generatePage, /我确认这是小样本测试/);
  assert.match(generatePage, /runSingleImageGeneration/);
  assert.match(generatePage, /真实生图验收报告/);
  assert.match(generatePage, /导出真实生图验收报告/);
  assert.match(imagePlanPage, /单 SKU 小样本/);
  assert.match(imagePlanPage, /三张小样本对比/);
  assert.match(imagePlanPage, /我确认这是小样本测试/);
  assert.match(imagePlanPage, /真实生图验收报告/);
  assert.match(imagePlanPage, /导出真实生图验收报告/);
  assert.match(imagePlanPage, /main_image/);
  assert.match(imagePlanPage, /feature_image/);
  assert.match(imagePlanPage, /detail_image/);
  assert.match(imagePlanPage, /暂无图片方案，请先生成图片方案。/);
  assert.match(imagePlanPage, /图片方案加载失败，请刷新或返回上一步重试。/);
  assert.match(imagePlanPage, /groupedPlans\.length/);
});
