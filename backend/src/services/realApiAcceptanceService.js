import { getTask } from './db.js';
import { getProviderCallCost } from '../config/providerCostConfig.js';
import { getVisionProvider } from '../providers/vision/index.js';
import { getReviewProvider } from '../providers/review/index.js';
import { runSingleImageGeneration } from './singleImageGenerationService.js';
import { buildReviewReport } from './reviewReportService.js';

const MAX_REAL_API_CALLS = 3;
const SUPPORTED_IMAGE_TYPES = new Set(['main_image', 'feature_image', 'detail_image']);
const reportsByTaskId = new Map();

const SECRET_PATTERNS = [
  [/\b[A-Z0-9_]*API[_-]?KEY\b\s*[:=]\s*[^\s"',锛屻€傦紱;]+/gi, '[credential removed]'],
  [/\b(provider[_-]?secret|provider[_-]?credential|api[_-]?key|secret|token|password)\b\s*[:=]\s*[^\s"',锛屻€傦紱;]+/gi, '[credential removed]'],
  [/\b(?:sk|rk|ak)-[A-Za-z0-9_-]{6,}\b/gi, '[credential removed]'],
  [/[A-Z]:\\[^\s"',锛屻€傦紱;]+/gi, '[local path removed]'],
  [/\.env(?:\.[\w.-]+)?/gi, '[env file removed]'],
  [/\b[\w.-]*\.sqlite\b/gi, '[sqlite path removed]'],
  [/\bnode_modules\b/gi, '[node modules removed]']
];

function nowIso() {
  return new Date().toISOString();
}

function timestampSafe(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, '-');
}

function asArray(value) {
  return Array.isArray(value) ? value.filter((item) => item !== undefined && item !== null) : [];
}

function sanitizeText(value) {
  let text = String(value ?? '');
  for (const [pattern, replacement] of SECRET_PATTERNS) text = text.replace(pattern, replacement);
  return text;
}

function sanitizeValue(value) {
  if (Array.isArray(value)) return value.map(sanitizeValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value)
      .filter(([key]) => !/apiKey|api_key|secret|token|password|credential|absolutePath|sourceFolderPath|sqlitePath|dbPath|requestBody/i.test(key))
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

function normalizeBoolean(value, fallback = false) {
  if (value === true || value === 'true') return true;
  if (value === false || value === 'false') return false;
  return fallback;
}

function normalizeImageTypes(value) {
  const requested = asArray(value).map((item) => String(item || '').trim()).filter(Boolean);
  const imageTypes = requested.length ? requested : ['main_image'];
  const unsupported = imageTypes.find((imageType) => !SUPPORTED_IMAGE_TYPES.has(imageType));
  if (unsupported) {
    throw badRequest('Only main_image, feature_image, and detail_image are allowed for real API acceptance.');
  }
  return [...new Set(imageTypes)].slice(0, MAX_REAL_API_CALLS);
}

function normalizeInput(input = {}) {
  if (!input.taskId) throw badRequest('taskId is required.');
  if (Array.isArray(input.taskIds) || Array.isArray(input.batchIds) || input.batchId) {
    throw badRequest('Batch or multi-SKU real API acceptance is not allowed. Only one taskId is supported.');
  }
  if (input.confirmRealApi !== true) throw badRequest('confirmRealApi=true is required before real API acceptance.');
  if (input.confirmPaidApi !== true) throw badRequest('confirmPaidApi=true is required before paid API acceptance.');
  if (input.confirmNoPlatformUpload !== true) {
    throw badRequest('confirmNoPlatformUpload=true is required to confirm no platform upload will be performed.');
  }

  const maxRealApiCalls = input.maxRealApiCalls === undefined ? MAX_REAL_API_CALLS : Number(input.maxRealApiCalls);
  if (!Number.isFinite(maxRealApiCalls) || maxRealApiCalls < 1 || maxRealApiCalls > MAX_REAL_API_CALLS) {
    throw badRequest(`maxRealApiCalls must be between 1 and ${MAX_REAL_API_CALLS}.`);
  }

  const enableVision = normalizeBoolean(input.enableVision, true);
  const imageTypes = normalizeImageTypes(input.imageTypes);
  const enableReview = normalizeBoolean(input.enableReview, false);
  const plannedRealApiCalls = (enableVision ? 1 : 0) + imageTypes.length + (enableReview ? 1 : 0);
  if (plannedRealApiCalls > maxRealApiCalls) {
    throw badRequest(`Requested real API call count ${plannedRealApiCalls} exceeds maxRealApiCalls=${maxRealApiCalls}.`);
  }

  return {
    taskId: String(input.taskId),
    enableVision,
    enableReview,
    imageTypes,
    maxRealApiCalls,
    provider: input.provider || 'openai',
    visionProviderName: input.visionProvider || '',
    reviewProviderName: input.reviewProvider || '',
    mattingProvider: 'sharp'
  };
}

function taskSku(task = {}) {
  return task.productInfoConfirmed?.sku || task.productInfo?.sku || task.productInfoRaw?.sku || task.sku || '';
}

function taskName(task = {}) {
  return task.productInfoConfirmed?.name || task.productInfo?.name || task.productInfoRaw?.name || task.productName || '';
}

function callCost(apiType, provider) {
  const action = apiType === 'imageGeneration' ? 'image' : apiType;
  return getProviderCallCost(action, provider || 'mock') || 0;
}

async function captureApiCall({ apiType, provider, model, runner, fallbackUsed = false }) {
  const started = Date.now();
  const startedAt = new Date(started).toISOString();
  try {
    const result = await runner();
    const completed = Date.now();
    return {
      result,
      call: sanitizeValue({
        provider: result?.provider || provider || '',
        model: result?.model || model || '',
        apiType,
        startedAt,
        completedAt: new Date(completed).toISOString(),
        durationMs: Number(result?.durationMs) || completed - started,
        status: ['success', 'succeeded'].includes(result?.status) ? 'success' : result?.status || 'success',
        errorMessage: result?.error?.message || result?.error || '',
        fallbackUsed: Boolean(result?.fallbackUsed || fallbackUsed),
        estimatedCost: callCost(apiType, result?.provider || provider)
      })
    };
  } catch (error) {
    const completed = Date.now();
    return {
      result: null,
      call: sanitizeValue({
        provider: provider || '',
        model: model || '',
        apiType,
        startedAt,
        completedAt: new Date(completed).toISOString(),
        durationMs: completed - started,
        status: 'failed',
        errorMessage: error.message || error,
        fallbackUsed: Boolean(fallbackUsed),
        estimatedCost: callCost(apiType, provider)
      })
    };
  }
}

function flowStep(stepKey, label, status, notes = '') {
  return sanitizeValue({ stepKey, label, status, notes });
}

function summaryFrom({ apiCalls, generatedOutputs, reviewSummary }) {
  const failedCount = apiCalls.filter((call) => call.status === 'failed').length;
  const fallbackCount = Math.max(
    apiCalls.filter((call) => call.fallbackUsed).length,
    generatedOutputs.filter((output) => output.fallbackUsed).length
  );
  const hasFallbackOutput = generatedOutputs.some((output) => output.fallbackUsed || output.status === 'fallback_mock');
  const fatalIssueCount = Number(reviewSummary?.fatalCount || 0);
  const highIssueCount = Number(reviewSummary?.highCount || 0);
  return {
    overallStatus: failedCount ? (apiCalls.length === failedCount && !hasFallbackOutput ? 'failed' : 'partial') : 'pending',
    realApiCallCount: apiCalls.length,
    realVisionCallCount: apiCalls.filter((call) => call.apiType === 'vision').length,
    realImageGenerationCallCount: apiCalls.filter((call) => call.apiType === 'imageGeneration').length,
    realReviewCallCount: apiCalls.filter((call) => call.apiType === 'review').length,
    fallbackCount,
    estimatedCost: apiCalls.reduce((sum, call) => sum + (Number(call.estimatedCost) || 0), 0),
    fatalIssueCount,
    highIssueCount,
    readyForBatchRealTest: false,
    readyForPlatformUpload: false
  };
}

function emptyManualChecklist() {
  return {
    productShapePreserved: false,
    portsAndHolesPreserved: false,
    texturePreserved: false,
    noChineseText: false,
    noWrongCapacityCertificationWarranty: false,
    amazonMainImageRuleChecked: false,
    reviewedByHuman: false,
    notes: ''
  };
}

async function runVision({ task, options, deps, apiCalls, flowSteps, warnings }) {
  if (!options.enableVision) {
    flowSteps.push(flowStep('realVision', 'Real vision recognition', 'skipped', 'Real vision recognition was not selected.'));
    return null;
  }
  const provider = deps.visionProvider || getVisionProvider();
  const { result, call } = await captureApiCall({
    apiType: 'vision',
    provider: provider.provider || options.visionProviderName,
    model: provider.model || '',
    runner: () => provider.recognize({ task, image: task.sourceImages?.[0], images: task.sourceImages || [] })
  });
  apiCalls.push(call);
  if (result?.status === 'success' || result?.status === 'succeeded') {
    flowSteps.push(flowStep('realVision', 'Real vision recognition', 'completed', 'Real vision result captured in report only.'));
    return sanitizeValue(result.data || {});
  }
  warnings.push({ code: 'REAL_VISION_FAILED', message: call.errorMessage || 'Real vision recognition failed.' });
  flowSteps.push(flowStep('realVision', 'Real vision recognition', 'failed', call.errorMessage));
  return null;
}

async function runImages({ task, options, deps, apiCalls, flowSteps, generatedOutputs, warnings }) {
  const runner = deps.singleImageRunner || runSingleImageGeneration;
  for (const imageType of options.imageTypes) {
    const started = Date.now();
    let result = null;
    let thrownError = null;
    try {
      result = await runner({
        taskId: task.id,
        imageType,
        provider: options.provider,
        mattingProvider: options.mattingProvider,
        confirmReal: true
      }, {
        ...deps,
        taskReader: async () => task
      });
    } catch (error) {
      thrownError = error;
    }
    const generation = result?.singleImageGeneration || {};
    const completed = Date.now();
    const call = sanitizeValue({
      provider: generation.requestedProvider || generation.providerUsed || options.provider,
      model: generation.model || '',
      apiType: 'imageGeneration',
      startedAt: new Date(started).toISOString(),
      completedAt: new Date(completed).toISOString(),
      durationMs: Number(generation.durationMs) || Number(result?.durationMs) || completed - started,
      status: thrownError ? 'failed' : generation.status === 'fallback_mock' ? 'failed' : generation.status || 'success',
      errorMessage: thrownError?.message || generation.fallbackReason || '',
      fallbackUsed: Boolean(generation.fallbackUsed),
      estimatedCost: callCost('imageGeneration', generation.requestedProvider || generation.providerUsed || options.provider)
    });
    apiCalls.push(call);
    if (thrownError) {
      warnings.push({ code: 'REAL_IMAGE_GENERATION_FAILED', message: call.errorMessage || `${imageType} real image generation failed.` });
      flowSteps.push(flowStep(`realImage:${imageType}`, `Real sample generation ${imageType}`, 'failed', call.errorMessage));
      continue;
    }
    const output = sanitizeValue({
      imageType,
      status: generation.status || 'unknown',
      providerUsed: generation.providerUsed || '',
      model: generation.model || '',
      previewUrl: generation.previewUrl || '',
      isRealGenerated: Boolean(generation.isRealGenerated),
      fallbackUsed: Boolean(generation.fallbackUsed),
      fallbackReason: generation.fallbackReason || '',
      qualityScore: result?.qualityScore || null,
      warnings: result?.warnings || []
    });
    generatedOutputs.push(output);
    if (output.fallbackUsed) warnings.push({ code: 'IMAGE_GENERATION_FALLBACK', message: output.fallbackReason || `${imageType} fallback used.` });
    flowSteps.push(flowStep(`realImage:${imageType}`, `Real sample generation ${imageType}`, output.fallbackUsed ? 'fallback' : 'completed', output.fallbackReason));
  }
}

async function runReview({ task, options, deps, apiCalls, flowSteps, generatedOutputs, warnings }) {
  if (!options.enableReview) {
    flowSteps.push(flowStep('realReview', 'Real structured review', 'skipped', 'Real review was not selected.'));
    return buildReviewReport(task).summary || {};
  }
  const output = generatedOutputs.find((item) => item.isRealGenerated) || generatedOutputs[0];
  const image = output ? {
    id: `${output.imageType || 'sample'}-real-api-output`,
    planId: `${output.imageType || 'sample'}-plan`,
    type: output.imageType,
    imageType: output.imageType,
    fileName: output.previewUrl,
    previewUrl: output.previewUrl,
    isRealGenerated: output.isRealGenerated
  } : asArray(task.generatedImages)[0];
  if (!image) {
    warnings.push({ code: 'REAL_REVIEW_SKIPPED_NO_IMAGE', message: 'No generated image is available for real review.' });
    flowSteps.push(flowStep('realReview', 'Real structured review', 'skipped', 'No generated image available.'));
    return {};
  }
  const plan = asArray(task.imagePlans).find((item) => item.type === (image.imageType || image.type)) || asArray(task.imagePlans)[0];
  const provider = deps.reviewProvider || getReviewProvider('real');
  const mockProvider = deps.mockReviewProvider || getReviewProvider('mock');
  const { result, call } = await captureApiCall({
    apiType: 'review',
    provider: provider.provider || options.reviewProviderName,
    model: provider.model || '',
    runner: () => provider.review({ task, image, plan, generationRequest: image.generationRequest || null })
  });
  if (result?.status !== 'success' && result?.status !== 'succeeded') {
    const fallback = await mockProvider.review({
      task,
      image,
      plan,
      generationRequest: image.generationRequest || null,
      fallbackToMockReview: true,
      realReviewError: result?.error || call.errorMessage
    });
    call.fallbackUsed = true;
    call.status = 'failed';
    call.errorMessage = call.errorMessage || result?.error?.message || 'Real review failed.';
    apiCalls.push(sanitizeValue(call));
    warnings.push({ code: 'REAL_REVIEW_FALLBACK', message: call.errorMessage });
    flowSteps.push(flowStep('realReview', 'Real structured review', 'fallback', call.errorMessage));
    return { ...(fallback?.data || {}), fallbackToMockReview: true };
  }
  apiCalls.push(call);
  flowSteps.push(flowStep('realReview', 'Real structured review', 'completed', 'Real review result captured in report only.'));
  return result?.data || {};
}

export async function runSingleSkuRealApiAcceptance(input = {}, deps = {}) {
  const options = normalizeInput(input);
  const task = await (deps.taskReader || getTask)(options.taskId);
  if (!task) {
    const error = new Error('Task not found');
    error.statusCode = 404;
    throw error;
  }

  const apiCalls = [];
  const generatedOutputs = [];
  const flowSteps = [
    flowStep('inputScope', 'Single SKU scope check', 'passed', 'Only one taskId is accepted. Batch real runs are disabled.'),
    flowStep('platformUpload', 'Platform upload', 'disabled', 'Platform upload is disabled for this acceptance run.')
  ];
  const warnings = [];

  const visionResult = await runVision({ task, options, deps, apiCalls, flowSteps, warnings });
  await runImages({ task, options, deps, apiCalls, flowSteps, generatedOutputs, warnings });
  const reviewSummary = await runReview({ task, options, deps, apiCalls, flowSteps, generatedOutputs, warnings });
  const templateAudit = generatedOutputs[0]?.templateAudit || {};
  const ruleAuditSummary = generatedOutputs[0]?.ruleAuditSummary || {};
  const summary = summaryFrom({ apiCalls, generatedOutputs, reviewSummary });
  if (warnings.length && summary.overallStatus === 'pending') summary.overallStatus = 'partial';

  const report = sanitizeValue({
    meta: {
      taskId: task.id,
      sku: taskSku(task),
      productName: taskName(task),
      generatedAt: nowIso(),
      mode: 'single-sku-real-api-acceptance',
      realApiEnabled: true,
      platformUploadEnabled: false,
      realUploadEnabled: false,
      readyForPlatformUpload: false,
      maxRealApiCalls: options.maxRealApiCalls
    },
    summary,
    flowSteps,
    apiCalls,
    visionSummary: visionResult ? {
      hasProductInfoRaw: Boolean(visionResult.productInfoRaw),
      visibleTextCount: asArray(visionResult.visibleText).length,
      riskCount: asArray(visionResult.risks).length
    } : null,
    generatedOutputs,
    reviewSummary,
    templateAudit,
    ruleAuditSummary,
    exportSummary: { generated: false, platformUploadEnabled: false },
    uploadDryRunSummary: { realUploadEnabled: false, canUploadNow: false, platformApiCalled: false },
    manualChecklist: emptyManualChecklist(),
    warnings,
    recommendations: [
      'Review the generated sample images manually before any wider real API test.',
      'Do not use this report as approval for platform upload.'
    ],
    nextSuggestedAction: '请人工检查真实生成图片质量，确认后再决定是否进入 3 SKU 真实小样本。'
  });
  reportsByTaskId.set(task.id, report);
  return report;
}

export function getRealApiAcceptanceReport(taskId) {
  return sanitizeValue({
    taskId,
    latest: reportsByTaskId.get(taskId) || null,
    emptyStateText: reportsByTaskId.has(taskId) ? '' : 'No real API acceptance report yet.'
  });
}

export function exportRealApiAcceptanceReport(report = {}, options = {}) {
  const safe = sanitizeValue(report);
  const taskId = safe.meta?.taskId || safe.taskId || 'task';
  const timestamp = options.timestamp || timestampSafe();
  return {
    fileName: `real-api-acceptance-report-${sanitizeText(taskId)}-${timestamp}.json`,
    mimeType: 'application/json',
    content: JSON.stringify(safe, null, 2)
  };
}
