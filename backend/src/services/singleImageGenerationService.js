import { getTask } from './db.js';
import { buildGenerationRequest } from './generationRequestService.js';
import { generateMockImageForPlan } from './mockImageService.js';
import { runMatting } from './mattingService.js';
import { analyzeTemplateSet } from './templateAuditService.js';
import {
  buildSingleImageGenerationAcceptanceReport,
  buildThreeSampleAggregateReport
} from './singleImageGenerationReportService.js';
import { getBackgroundProvider } from '../providers/image/backgroundProviders.js';

const SUPPORTED_IMAGE_TYPES = new Set(['main_image', 'feature_image', 'detail_image']);
const reportsByTaskId = new Map();
const threeSampleReportsByTaskId = new Map();

function sanitizeText(value) {
  return String(value)
    .replace(/\b[A-Z0-9_]*API[_-]?KEY\b\s*[:=]\s*[^\s"',，。；;]+/gi, '[api-key-removed]')
    .replace(/\b[A-Z0-9_]*API[_-]?KEY\b/gi, '[api-key-removed]')
    .replace(/\b(?:sk|rk|ak)-[A-Za-z0-9_-]{6,}\b/g, '[secret-removed]')
    .replace(/[A-Z]:\\[^\s"',，。；;]+/gi, '[local-path-removed]')
    .replace(/\.env(?:\.[\w.-]+)?/gi, '[env-file-removed]')
    .replace(/\b[\w.-]*\.sqlite\b/gi, '[sqlite-path-removed]')
    .replace(/\bnode_modules\b/gi, '[node-modules-removed]');
}

function sanitizeValue(value) {
  if (Array.isArray(value)) return value.map(sanitizeValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value)
      .filter(([key]) => !/apiKey|api_key|secret|token|password|absolutePath|subjectPngPath|maskPath/i.test(key))
      .map(([key, item]) => [key, sanitizeValue(item)]));
  }
  if (typeof value === 'string') return sanitizeText(value);
  return value;
}

function badRequest(message) {
  const error = new Error(message);
  error.statusCode = 400;
  return error;
}

function normalizeImageType(value) {
  const imageType = String(value || '').trim();
  if (!SUPPORTED_IMAGE_TYPES.has(imageType)) {
    throw badRequest('Only main_image, feature_image, and detail_image are supported for single SKU sample real generation.');
  }
  return imageType;
}

function requireSingleTask(input = {}) {
  if (Array.isArray(input.taskIds) || Array.isArray(input.batchIds) || input.batchId) {
    throw badRequest('Only one taskId is allowed. Batch or multi-SKU generation is not supported in this endpoint.');
  }
  if (!input.taskId) throw badRequest('taskId is required.');
}

function findPlan(task = {}, { imageType, planId }) {
  const plans = Array.isArray(task.imagePlans) ? task.imagePlans : [];
  const plan = planId
    ? plans.find((item) => item.id === planId)
    : plans.find((item) => item.type === imageType || item.imageType === imageType);
  if (!plan) {
    const error = new Error('Image plan not found for requested single image generation.');
    error.statusCode = 404;
    throw error;
  }
  return plan;
}

function sourceImageId(task = {}, explicit) {
  return explicit || task.sourceImages?.[0]?.id || task.originalImage?.id || '';
}

async function safeRunMatting(input = {}, deps = {}) {
  if (deps.mattingRunner) return deps.mattingRunner(input);
  try {
    return await runMatting(input, deps.mattingDeps || {});
  } catch (error) {
    return {
      requestedProvider: input.provider || 'sharp',
      providerUsed: 'sharp',
      fallbackUsed: input.provider === 'image2',
      fallbackReason: sanitizeText(error.message || 'Matting preview unavailable for this sample.'),
      qualityScore: { score: 0, level: 'unknown', warnings: ['抠图预处理暂不可用，已继续进行单图生成验收。'] },
      warnings: ['抠图预处理暂不可用，已继续进行单图生成验收。']
    };
  }
}

function imageFromProviderResult({ task, plan, result, generationRequest, fallbackPatch = {} }) {
  const output = result.output || {};
  const now = new Date().toISOString();
  return sanitizeValue({
    id: `${plan.id}-single-real-${Date.now()}`,
    planId: plan.id,
    targetId: plan.targetId,
    platformId: plan.platformId || generationRequest.platformId || task.platformId,
    categoryId: plan.categoryId || generationRequest.categoryId || task.categoryId,
    type: plan.type,
    imageType: plan.type,
    title: plan.title,
    fileName: output.fileName,
    filePath: output.filePath,
    previewUrl: output.previewUrl || output.url,
    url: output.url || output.previewUrl,
    width: output.width,
    height: output.height,
    format: output.format,
    provider: result.provider,
    model: result.model,
    status: 'succeeded',
    generatedAt: now,
    isMockPreview: Boolean(output.isMockPreview),
    isRealGenerated: output.isRealGenerated !== false && !output.isMockPreview,
    generationRequest,
    generationRequestSummary: result.metadata?.generationRequestSummary || plan.generationRequestSummary || null,
    preserveQuality: result.metadata?.preserveQuality || null,
    generationStrategy: result.metadata?.generationStrategy || null,
    fallbackToMock: false,
    ...fallbackPatch
  });
}

function providerFailureResult(error, provider = 'openai') {
  return {
    provider,
    model: '',
    status: 'failed',
    durationMs: 0,
    error: error || { code: 'REAL_PROVIDER_UNAVAILABLE', message: 'Real image provider unavailable.' },
    output: null,
    metadata: {}
  };
}

async function callImageProvider({ task, plan, generationRequest, input, deps }) {
  if (!input.confirmReal && !deps.imageProvider) {
    return providerFailureResult({
      code: 'REAL_GENERATION_NOT_CONFIRMED',
      message: 'confirmReal=true is required before calling a real image provider.'
    });
  }
  const provider = deps.imageProvider || getBackgroundProvider(input.provider || 'openai');
  if (!provider) return providerFailureResult(null, input.provider || 'openai');
  return provider.generate({
    task,
    plan,
    generationRequest,
    version: 1,
    realMode: input.realMode || 'auto'
  });
}

function qualityFrom({ providerResult, mattingResult, image }) {
  const preserve = providerResult.metadata?.preserveQuality;
  const mattingScore = mattingResult?.qualityScore;
  if (preserve?.score !== undefined) return preserve;
  if (image?.preserveQuality?.score !== undefined) return image.preserveQuality;
  if (mattingScore?.score !== undefined) return mattingScore;
  return { score: 0, level: 'unknown', warnings: [] };
}

function buildReport({ task, plan, image, providerResult, mattingResult, fallbackUsed, fallbackReason, warnings }) {
  const templateAudit = analyzeTemplateSet({
    ...task,
    imagePlans: [plan],
    generatedImages: [image]
  });
  const qualityScore = qualityFrom({ providerResult, mattingResult, image });
  const acceptanceReport = buildSingleImageGenerationAcceptanceReport({
    task,
    plan,
    image,
    providerResult,
    mattingResult,
    generationRequest: image.generationRequest || {},
    qualityScore,
    templateAudit,
    fallbackUsed,
    fallbackReason,
    warnings
  });
  const report = sanitizeValue({
    taskId: task.id,
    generatedAt: new Date().toISOString(),
    ...acceptanceReport,
    singleImageGeneration: {
      taskId: task.id,
      planId: plan.id,
      imageType: plan.type,
      status: fallbackUsed ? 'fallback_mock' : 'succeeded',
      requestedProvider: providerResult.provider || 'openai',
      providerUsed: fallbackUsed ? 'mock' : providerResult.provider,
      model: providerResult.model || '',
      previewUrl: image.previewUrl || image.url,
      fileName: image.fileName,
      width: image.width,
      height: image.height,
      isRealGenerated: Boolean(image.isRealGenerated),
      fallbackUsed,
      fallbackReason,
      matting: mattingResult || null
    },
    qualityScore,
    warnings,
    templateAudit,
    ruleAuditSummary: templateAudit.ruleAuditSummary,
    effectiveRulesSummary: templateAudit.ruleAuditSummary?.effectiveRulesSummary || null,
    issueCounts: templateAudit.ruleAuditSummary?.issueCounts || { error: 0, warning: 0, info: 0 },
    recommendations: templateAudit.ruleAuditSummary?.recommendations || []
  });
  reportsByTaskId.set(task.id, report);
  return report;
}

export async function runSingleImageGeneration(input = {}, deps = {}) {
  requireSingleTask(input);
  const imageType = normalizeImageType(input.imageType);
  const task = await (deps.taskReader || getTask)(input.taskId);
  if (!task) {
    const error = new Error('Task not found');
    error.statusCode = 404;
    throw error;
  }
  const plan = findPlan(task, { imageType, planId: input.planId });
  if ((plan.type || plan.imageType) !== imageType) {
    throw badRequest('planId does not match requested imageType.');
  }
  const generationRequest = buildGenerationRequest({ task, plan });
  const mattingProvider = ['sharp', 'image2'].includes(String(input.mattingProvider || '').toLowerCase())
    ? String(input.mattingProvider).toLowerCase()
    : 'sharp';
  const mattingResult = await safeRunMatting({
    taskId: task.id,
    imageId: sourceImageId(task, input.sourceImageId),
    provider: mattingProvider
  }, deps);

  const providerResult = await callImageProvider({ task, plan, generationRequest, input, deps });
  const warnings = [...(mattingResult?.warnings || mattingResult?.qualityScore?.warnings || [])].map(sanitizeText);

  if (providerResult.status !== 'success' && providerResult.status !== 'succeeded') {
    const mock = await (deps.mockGenerator || generateMockImageForPlan)({
      task,
      plan,
      outputIndex: 1,
      version: 1,
      provider: 'mock',
      model: 'mock-single-real-fallback'
    });
    const fallbackReason = sanitizeText([
      providerResult.error?.code || 'REAL_PROVIDER_FAILED',
      providerResult.error?.message || providerResult.error || 'Real provider failed; fallback to mock preview.'
    ].filter(Boolean).join(': '));
    return buildReport({
      task,
      plan,
      image: {
        ...mock,
        generationRequest
      },
      providerResult,
      mattingResult,
      fallbackUsed: true,
      fallbackReason,
      warnings
    });
  }

  const image = imageFromProviderResult({ task, plan, result: providerResult, generationRequest });
  return buildReport({
    task,
    plan,
    image,
    providerResult,
    mattingResult,
    fallbackUsed: Boolean(mattingResult?.fallbackUsed),
    fallbackReason: mattingResult?.fallbackReason || '',
    warnings
  });
}

export async function getSingleImageGenerationReport(taskId) {
  const latest = reportsByTaskId.get(taskId) || null;
  return sanitizeValue({
    taskId,
    latest,
    emptyStateText: latest ? '' : '暂无单 SKU 小样本真实生图报告，请先运行一次单图生成。'
  });
}

function requireThreeSampleInput(input = {}) {
  if (!input.taskId) throw badRequest('taskId is required.');
  const samples = Array.isArray(input.samples) ? input.samples : [];
  if (!samples.length) throw badRequest('samples are required.');
  if (samples.length > 3) throw badRequest('三张小样本对比最多 3 张样本。Three-sample generation allows maximum 3 samples.');
  if (input.confirmPaidApi !== true) {
    throw badRequest('confirmPaidApi=true is required before running three-sample paid API generation.');
  }
  if (Array.isArray(input.taskIds) || input.batchId || Array.isArray(input.batchIds)) {
    throw badRequest('Only one taskId is allowed. Batch generation is not supported.');
  }
  return samples;
}

function failedSampleReport({ task = {}, sample = {}, error }) {
  const imageType = String(sample.imageType || '');
  const message = sanitizeText(error?.message || error || 'Sample generation failed.');
  return sanitizeValue({
    sampleId: sample.sampleId || sample.imageId || 'sample',
    meta: {
      sampleId: sample.sampleId || sample.imageId || 'sample',
      taskId: task.id,
      sku: task.productInfoConfirmed?.sku || task.productInfo?.sku || '',
      productName: task.productInfoConfirmed?.name || task.productInfo?.name || '',
      imageType,
      platformId: task.platformId || '',
      categoryId: task.categoryId || '',
      generatedAt: new Date().toISOString(),
      testMode: 'single-image-sample',
      generationProvider: '',
      modelName: '',
      mattingProvider: '',
      costNotice: '该样本生成失败，仅记录错误用于人工排查。'
    },
    inputSummary: {
      sourceImageName: sample.imageId || sample.imagePath || '',
      imagePlanId: '',
      imageType,
      confirmedFieldsUsed: [],
      blockedFields: [],
      inferredFieldsExcluded: [],
      conflictedFieldsExcluded: []
    },
    generationResult: {
      status: 'failed',
      outputImage: '',
      previewImage: '',
      durationMs: 0,
      fallbackUsed: false,
      fallbackReason: '',
      outputType: '',
      warnings: [message],
      errorMessage: message
    },
    qualityScore: { score: 0, level: 'failed', warnings: [message] },
    templateAudit: {},
    ruleAuditSummary: { passed: false, issueCounts: { error: 1, warning: 0, info: 0 }, issues: [], blockedFields: [], cautionFields: [], recommendations: [] },
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
      recommendedNextAction: '该样本生成失败，请人工查看错误后再决定是否重试。'
    }
  });
}

export async function runThreeSampleGeneration(input = {}, deps = {}) {
  const samples = requireThreeSampleInput(input);
  const task = await (deps.taskReader || getTask)(input.taskId);
  if (!task) {
    const error = new Error('Task not found');
    error.statusCode = 404;
    throw error;
  }
  const sampleReports = [];
  for (const [index, sample] of samples.entries()) {
    try {
      const report = await runSingleImageGeneration({
        taskId: input.taskId,
        imageType: sample.imageType,
        planId: sample.planId,
        sourceImageId: sample.imageId || sample.sourceImageId,
        provider: input.generationProvider === 'configured' ? input.provider : (input.generationProvider || input.provider || 'openai'),
        realMode: input.realMode || 'auto',
        mattingProvider: input.mattingProvider || 'sharp',
        confirmReal: true
      }, {
        ...deps,
        taskReader: async () => task
      });
      sampleReports.push(sanitizeValue({
        sampleId: sample.sampleId || `sample-${index + 1}`,
        ...report,
        meta: {
          ...report.meta,
          sampleId: sample.sampleId || `sample-${index + 1}`
        }
      }));
    } catch (error) {
      sampleReports.push(failedSampleReport({
        task,
        sample: { sampleId: sample.sampleId || `sample-${index + 1}`, ...sample },
        error
      }));
    }
  }
  const aggregateReport = buildThreeSampleAggregateReport({
    taskId: task.id,
    sampleReports,
    mattingProvider: input.mattingProvider || 'sharp',
    generationProvider: input.generationProvider || input.provider || 'openai',
    confirmPaidApi: input.confirmPaidApi === true
  });
  const failedCount = aggregateReport.summary.failedCount;
  const successCount = aggregateReport.summary.successCount;
  const result = sanitizeValue({
    status: failedCount === 0 ? 'completed' : successCount > 0 ? 'partial' : 'failed',
    summary: aggregateReport.summary,
    sampleReports,
    aggregateReport
  });
  threeSampleReportsByTaskId.set(task.id, result);
  return result;
}

export async function getThreeSampleGenerationReport(taskId) {
  return sanitizeValue({
    taskId,
    latest: threeSampleReportsByTaskId.get(taskId) || null,
    emptyStateText: threeSampleReportsByTaskId.has(taskId) ? '' : '暂无三张小样本对比报告。'
  });
}
