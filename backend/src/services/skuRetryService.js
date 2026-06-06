import { getBatchTask, getTask, updateTask } from './db.js';
import { normalizeBatchTask } from './batchTaskService.js';
import { generateImagePlans } from './imagePlanService.js';
import { generateMockImages } from './mockImageService.js';
import { buildGenerationRequest } from './generationRequestService.js';
import { getReviewProvider } from '../providers/review/index.js';

const EXECUTABLE_STEPS = new Set(['imagePlan', 'imageGeneration', 'review']);
const STEP_LABELS = {
  imagePlan: '图片方案',
  imageGeneration: '图片生成 mock',
  review: '审核 mock/ruleBased',
  recognition: '识别',
  export: '导出'
};

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function sanitizeText(value) {
  return String(value)
    .replace(/\b[A-Z0-9_]*API[_-]?KEY\b\s*[:=]\s*[^\s"',，。；;]+/gi, '[api-key-removed]')
    .replace(/\b(provider[_-]?secret|api[_-]?key|secret)\b\s*[:=]\s*[^\s"',，。；;]+/gi, '[secret-removed]')
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
      .filter(([key]) => !/apiKey|api_key|secret|token|password|absolutePath|sourceFolderPath|folderPath/i.test(key))
      .map(([key, item]) => [key, sanitizeValue(item)]));
  }
  if (typeof value === 'string') return sanitizeText(value);
  return value;
}

function normalizeStep(value = '') {
  const text = String(value || '').toLowerCase();
  if (/recogn/.test(text)) return 'recognition';
  if (/plan/.test(text)) return 'imagePlan';
  if (/generat/.test(text)) return 'imageGeneration';
  if (/review/.test(text)) return 'review';
  if (/export/.test(text)) return 'export';
  return '';
}

function getSkuRecord(batch, taskId) {
  return asArray(batch.skuTasks).find((sku) => sku.taskId === taskId) || null;
}

async function requireBatchAndTask(batchId, taskId) {
  const batch = await getBatchTask(batchId);
  if (!batch) {
    const error = new Error('Batch task not found');
    error.statusCode = 404;
    throw error;
  }
  const task = await getTask(taskId);
  if (!task) {
    const error = new Error('Task not found');
    error.statusCode = 404;
    throw error;
  }
  const normalizedBatch = normalizeBatchTask(batch);
  const sku = getSkuRecord(normalizedBatch, taskId);
  if (!sku || task.batchId !== batchId) {
    const error = new Error('Task not found in batch');
    error.statusCode = 404;
    throw error;
  }
  return { batch: normalizedBatch, task, sku };
}

function inferFailedStep(sku = {}, task = {}) {
  const explicit = normalizeStep(sku.currentStep || sku.queueAction || task.failedStep || task.generationMeta?.step);
  if (explicit) return explicit;
  if (task.generationMeta?.status === 'failed' || asArray(task.generatedImages).some((image) => image.status === 'failed')) {
    return 'imageGeneration';
  }
  if (sku.status === 'failed' || sku.queueStatus === 'failed') return 'recognition';
  if (asArray(task.generatedImages).length && !task.review && !task.normalizedReviewReport) return 'review';
  if (!asArray(task.imagePlans).length && task.productInfoConfirmed && asArray(task.targets).length) return 'imagePlan';
  return '';
}

function blockedStep(retryStep, reason) {
  return { retryStep, label: STEP_LABELS[retryStep] || retryStep, reason };
}

function allowedStepsFor({ sku, task, failedStep }) {
  const allowed = [];
  const blocked = [
    blockedStep('recognition', '第一阶段暂不执行识别重试，避免重复调用真实识别 Provider 或污染识别字段。'),
    blockedStep('export', '第一阶段暂不执行导出重试，避免覆盖导出产物或扩大影响范围。')
  ];

  if (failedStep === 'imagePlan' || (!asArray(task.imagePlans).length && task.productInfoConfirmed && asArray(task.targets).length)) {
    allowed.push('imagePlan');
  } else {
    blocked.push(blockedStep('imagePlan', '当前 SKU 暂不需要或无法安全隔离图片方案重试。'));
  }

  if (failedStep === 'imageGeneration' && asArray(task.imagePlans).length) {
    allowed.push('imageGeneration');
  } else {
    blocked.push(blockedStep('imageGeneration', '需要已有图片方案且失败点位于图片生成步骤，才允许 mock 生图重试。'));
  }

  const noReview = asArray(task.generatedImages).length && !task.review && !task.normalizedReviewReport;
  if (failedStep === 'review' || noReview || normalizeStep(sku.currentStep) === 'review') {
    if (asArray(task.generatedImages).length) allowed.push('review');
    else blocked.push(blockedStep('review', '需要已有生成图片后才允许 mock/ruleBased 审核重试。'));
  } else {
    blocked.push(blockedStep('review', '当前 SKU 暂不需要审核重试。'));
  }

  return {
    allowedRetrySteps: [...new Set(allowed.filter((step) => EXECUTABLE_STEPS.has(step)))],
    blockedRetrySteps: blocked.filter((item, index, rows) => rows.findIndex((row) => row.retryStep === item.retryStep) === index)
  };
}

function snapshotTask(task = {}) {
  return sanitizeValue({
    taskId: task.id,
    sku: task.sku || task.productInfoConfirmed?.sku,
    status: task.status,
    imagePlanCount: asArray(task.imagePlans).length,
    generatedImageCount: asArray(task.generatedImages).length,
    reviewResultCount: asArray(task.reviewResults).length,
    hasReview: Boolean(task.review),
    reviewMode: task.review?.reviewMode || null,
    hasProductInfoConfirmed: Boolean(task.productInfoConfirmed),
    hasRecognitionQuality: Boolean(task.recognitionQuality),
    fieldEvidenceCount: Object.keys(task.fieldEvidence || {}).length,
    generatedProviders: [...new Set(asArray(task.generatedImages).map((image) => image.provider).filter(Boolean))],
    updatedAt: task.updatedAt || null
  });
}

function makeResult({ status, batchId, taskId, retryStep, mode, startedAt, completedAt, beforeSnapshot, afterSnapshot, resultSummary, warnings = [], nextSuggestedAction }) {
  const durationMs = Math.max(0, new Date(completedAt).getTime() - new Date(startedAt).getTime());
  return sanitizeValue({
    status,
    batchId,
    taskId,
    retryStep,
    mode,
    startedAt,
    completedAt,
    durationMs,
    resultSummary,
    beforeSnapshot,
    afterSnapshot,
    warnings,
    nextSuggestedAction
  });
}

export async function planSkuRetry(batchId, taskId) {
  const { task, sku } = await requireBatchAndTask(batchId, taskId);
  const failedStep = inferFailedStep(sku, task);
  const { allowedRetrySteps, blockedRetrySteps } = allowedStepsFor({ sku, task, failedStep });
  const warnings = [
    '本阶段只允许单 SKU、单步骤、mockOnly 重试。',
    '不会自动重试整个 batch，不会调用真实 Provider。'
  ];
  if (!allowedRetrySteps.length) warnings.push('当前 SKU 没有可安全执行的重试步骤。');
  return sanitizeValue({
    batchId,
    taskId,
    sku: task.productInfoConfirmed?.sku || task.sku || sku.skuId,
    currentStatus: task.status || sku.status || '',
    failedStep,
    canRetry: allowedRetrySteps.length > 0,
    allowedRetrySteps,
    blockedRetrySteps,
    warnings,
    nextSuggestedAction: allowedRetrySteps.length
      ? '请选择一个允许的步骤，只对当前 SKU 执行 mockOnly 重试。'
      : '请先人工检查该 SKU，确认数据完整后再处理。'
  });
}

async function retryImagePlan(task) {
  const imagePlans = generateImagePlans(task);
  const updatedTask = await updateTask(task.id, () => ({ imagePlans }));
  return {
    task: updatedTask,
    resultSummary: {
      message: `已重新生成 ${imagePlans.length} 个图片方案。`,
      imagePlanCount: imagePlans.length
    }
  };
}

async function retryMockImageGeneration(task) {
  const generatedImages = await generateMockImages(task);
  const updatedTask = await updateTask(task.id, () => ({ generatedImages }));
  return {
    task: updatedTask,
    resultSummary: {
      message: `已生成 ${generatedImages.length} 张 mock 图片。`,
      generatedImageCount: generatedImages.length,
      provider: 'mock'
    }
  };
}

async function retryMockReview(task) {
  const reviewProvider = getReviewProvider('mock');
  const reviewResults = [];
  for (const image of asArray(task.generatedImages)) {
    const plan = asArray(task.imagePlans).find((item) => item.id === image.planId);
    const generationRequest = image.generationRequest || (plan ? buildGenerationRequest({ task, plan }) : null);
    const result = await reviewProvider.review({ task, image, plan, generationRequest });
    if (result.status !== 'success' && result.status !== 'succeeded') {
      const error = new Error(result.error?.message || result.error || `Review failed for ${image.id}`);
      error.statusCode = 502;
      throw error;
    }
    reviewResults.push({
      ...result.data,
      durationMs: result.durationMs,
      provider: result.provider,
      model: result.model
    });
  }
  const review = {
    reviewedAt: new Date().toISOString(),
    reviewMode: 'mock',
    overallStatus: reviewResults.every((item) => item.status === 'passed') ? 'passed' : 'failed',
    items: reviewResults
  };
  const updatedTask = await updateTask(task.id, () => ({ reviewResults, review }));
  return {
    task: updatedTask,
    resultSummary: {
      message: `已完成 ${reviewResults.length} 张图片的 mock/ruleBased 审核。`,
      reviewResultCount: reviewResults.length,
      reviewMode: 'mock'
    }
  };
}

export async function executeSkuRetry(batchId, taskId, options = {}) {
  if (options.confirmRetry !== true) {
    const error = new Error('confirmRetry must be true before running a single SKU retry');
    error.statusCode = 400;
    throw error;
  }
  const retryStep = String(options.retryStep || '');
  const mode = options.mode || 'mockOnly';
  const startedAt = new Date().toISOString();
  const retryPlan = await planSkuRetry(batchId, taskId);
  const { task } = await requireBatchAndTask(batchId, taskId);
  const beforeSnapshot = snapshotTask(task);
  const warnings = [...asArray(retryPlan.warnings)];

  if (mode !== 'mockOnly' || options.confirmPaidApi === true) {
    const completedAt = new Date().toISOString();
    return makeResult({
      status: 'blocked',
      batchId,
      taskId,
      retryStep,
      mode,
      startedAt,
      completedAt,
      beforeSnapshot,
      afterSnapshot: beforeSnapshot,
      resultSummary: { message: '第一阶段只允许 mockOnly，真实 Provider 重试未开放。' },
      warnings: [...warnings, '已阻止非 mockOnly 或付费 API 重试请求。'],
      nextSuggestedAction: '请改用 mockOnly，并确认不会调用真实 Provider。'
    });
  }

  if (!retryPlan.allowedRetrySteps.includes(retryStep)) {
    const completedAt = new Date().toISOString();
    return makeResult({
      status: 'blocked',
      batchId,
      taskId,
      retryStep,
      mode,
      startedAt,
      completedAt,
      beforeSnapshot,
      afterSnapshot: beforeSnapshot,
      resultSummary: {
        message: `${retryStep || '未指定步骤'} 当前不在允许重试列表中。`,
        allowedRetrySteps: retryPlan.allowedRetrySteps
      },
      warnings,
      nextSuggestedAction: retryPlan.nextSuggestedAction
    });
  }

  try {
    let execution;
    if (retryStep === 'imagePlan') execution = await retryImagePlan(task);
    else if (retryStep === 'imageGeneration') execution = await retryMockImageGeneration(task);
    else if (retryStep === 'review') execution = await retryMockReview(task);
    else execution = null;

    if (!execution) {
      const completedAt = new Date().toISOString();
      return makeResult({
        status: 'blocked',
        batchId,
        taskId,
        retryStep,
        mode,
        startedAt,
        completedAt,
        beforeSnapshot,
        afterSnapshot: beforeSnapshot,
        resultSummary: { message: '该步骤第一阶段暂不支持执行。' },
        warnings,
        nextSuggestedAction: '请选择 imagePlan、imageGeneration 或 review。'
      });
    }

    const completedAt = new Date().toISOString();
    return makeResult({
      status: 'completed',
      batchId,
      taskId,
      retryStep,
      mode,
      startedAt,
      completedAt,
      beforeSnapshot,
      afterSnapshot: snapshotTask(execution.task),
      resultSummary: execution.resultSummary,
      warnings,
      nextSuggestedAction: '请刷新稳定性摘要，并人工验收当前 SKU 的结果。'
    });
  } catch (error) {
    const latestTask = await getTask(taskId);
    const completedAt = new Date().toISOString();
    return makeResult({
      status: 'failed',
      batchId,
      taskId,
      retryStep,
      mode,
      startedAt,
      completedAt,
      beforeSnapshot,
      afterSnapshot: snapshotTask(latestTask || task),
      resultSummary: { message: error.message || '单 SKU 重试失败。', code: error.code || 'SKU_RETRY_FAILED' },
      warnings,
      nextSuggestedAction: '请先人工检查该 SKU 的数据完整性，再决定是否继续。'
    });
  }
}
