import { getBatchTask, getTask } from './db.js';
import { normalizeBatchTask } from './batchTaskService.js';

const STEP_ORDER = [
  'upload',
  'recognition',
  'productConfirm',
  'platformRules',
  'imagePlan',
  'imageGeneration',
  'review',
  'export'
];

const STEP_LABELS = {
  upload: '上传',
  recognition: '识别',
  productConfirm: '商品确认',
  platformRules: '平台规则',
  imagePlan: '图片方案',
  imageGeneration: '图片生成',
  review: '审核',
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

function emptyStepSummary() {
  return Object.fromEntries(STEP_ORDER.map((step) => [step, {
    step,
    label: STEP_LABELS[step],
    total: 0,
    completed: 0,
    running: 0,
    failed: 0,
    pending: 0,
    needsManualReview: 0
  }]));
}

function taskById(tasks = []) {
  return new Map(asArray(tasks).filter(Boolean).map((task) => [task.id, task]));
}

function productName(task = {}, sku = {}) {
  return task.productInfoConfirmed?.name ||
    task.productInfo?.name ||
    task.productInfoRaw?.name ||
    task.productInfoRaw?.productName ||
    sku.displayName ||
    sku.skuId ||
    task.sku ||
    '未知商品';
}

function skuCode(task = {}, sku = {}) {
  return task.productInfoConfirmed?.sku || task.productInfo?.sku || task.sku || sku.skuId || 'unknown';
}

function reviewCounts(task = {}) {
  const summary = task.normalizedReviewReport?.summary || {};
  let fatal = Number(summary.fatalCount || 0);
  let high = Number(summary.highCount || 0);
  let mockInfo = Number(summary.mockInfoCount || 0);
  for (const item of asArray(task.review?.items)) {
    for (const issue of asArray(item.issues)) {
      const level = issue.severity || issue.level || issue.riskLevel;
      if (level === 'fatal') fatal += 1;
      if (level === 'high') high += 1;
      if (level === 'mockInfo' || issue.category === 'mock' || issue.mockOnly === true) mockInfo += 1;
    }
  }
  return { fatal, high, mockInfo };
}

function hasHighRiskRecognition(task = {}) {
  const quality = task.recognitionQuality || {};
  if (quality.riskLevel === 'high' || quality.level === 'high') return true;
  if (asArray(quality.conflicted).length || asArray(quality.blockedHighRisk).length) return true;
  if (asArray(quality.sections?.conflicted).length || asArray(quality.sections?.blockedHighRisk).length) return true;
  if (quality.summary?.blockedHighRiskCount > 0 || quality.summary?.conflictedCount > 0) return true;
  return false;
}

function generationFailed(task = {}) {
  if (task.generationMeta?.status === 'failed') return true;
  return asArray(task.generatedImages).some((image) => image.status === 'failed');
}

function hasGeneratedImages(task = {}) {
  return asArray(task.generatedImages).some((image) => image.status !== 'failed');
}

function normalizeStep(value = '') {
  const text = String(value || '').toLowerCase();
  if (/import|upload|uploaded/.test(text)) return 'upload';
  if (/recogn/.test(text)) return 'recognition';
  if (/confirm|waiting_confirm/.test(text)) return 'productConfirm';
  if (/rule|target/.test(text)) return 'platformRules';
  if (/plan|planning/.test(text)) return 'imagePlan';
  if (/generat/.test(text)) return 'imageGeneration';
  if (/review/.test(text)) return 'review';
  if (/export/.test(text)) return 'export';
  return '';
}

function statusStep(task = {}, sku = {}) {
  const status = task.status || sku.status || '';
  const byCurrent = normalizeStep(sku.currentStep);
  if (byCurrent) return byCurrent;
  if (status === 'uploaded') return 'recognition';
  if (status === 'recognized') return 'productConfirm';
  if (status === 'confirmed') return 'platformRules';
  if (status === 'rules_selected') return 'imagePlan';
  if (status === 'planned') return 'imageGeneration';
  if (status === 'generated') return 'review';
  if (status === 'reviewed') return 'export';
  if (status === 'exported' || status === 'completed') return 'export';
  return 'upload';
}

function completedStepsFor(task = {}, status, failedStep = '') {
  if (status === 'completed') return STEP_ORDER.slice();
  const current = failedStep || statusStep(task);
  const index = STEP_ORDER.indexOf(current);
  return index > 0 ? STEP_ORDER.slice(0, index) : [];
}

function pendingStepsFor(completedSteps = [], currentStep = '') {
  const completed = new Set(completedSteps);
  return STEP_ORDER.filter((step) => !completed.has(step) && step !== currentStep);
}

function errorMessageFor(sku = {}, task = {}) {
  return sku.error?.message ||
    sku.lastQueueError?.message ||
    sku.classifiedError?.message ||
    task.generationMeta?.error?.message ||
    asArray(task.generatedImages).find((image) => image.status === 'failed')?.error?.message ||
    '';
}

function classifySku(sku = {}, task = null) {
  const queueRunning = sku.queueStatus === 'running';
  const queuePending = sku.queueStatus === 'pending';
  const errorMessage = errorMessageFor(sku, task || {});
  const review = task ? reviewCounts(task) : { fatal: 0, high: 0, mockInfo: 0 };

  if (!task && sku.taskId) {
    return {
      status: 'failed',
      currentStep: normalizeStep(sku.currentStep) || 'upload',
      failedStep: normalizeStep(sku.currentStep) || 'upload',
      errorMessage: errorMessage || '关联 task 不存在',
      canRetry: false,
      canResume: false,
      requiresManualAction: true,
      nextSuggestedAction: '请人工检查该 SKU 的导入记录。'
    };
  }

  if (sku.status === 'failed' || sku.queueStatus === 'failed') {
    const failedStep = normalizeStep(sku.currentStep || sku.queueAction) || (generationFailed(task || {}) ? 'imageGeneration' : 'recognition');
    const retryable = ['recognition', 'imageGeneration'].includes(failedStep) || sku.retryable === true;
    return {
      status: 'failed',
      currentStep: failedStep,
      failedStep,
      errorMessage: errorMessage || 'SKU 处理失败',
      canRetry: retryable,
      canResume: retryable,
      requiresManualAction: sku.requiresUserAction === true || !retryable,
      nextSuggestedAction: retryable ? '当前阶段仅给出可重试建议，后续版本再执行安全重试。' : '请人工处理后再继续。'
    };
  }

  if (generationFailed(task || {})) {
    return {
      status: 'failed',
      currentStep: 'imageGeneration',
      failedStep: 'imageGeneration',
      errorMessage: errorMessage || '图片生成失败',
      canRetry: true,
      canResume: true,
      requiresManualAction: false,
      nextSuggestedAction: '图片生成失败，可在后续安全重试能力中单独重试该 SKU。'
    };
  }

  if (review.fatal > 0 || review.high > 0 || hasHighRiskRecognition(task || {})) {
    return {
      status: 'needsManualReview',
      currentStep: 'review',
      failedStep: '',
      errorMessage: '',
      canRetry: false,
      canResume: false,
      requiresManualAction: true,
      nextSuggestedAction: '请先人工复查高风险字段、文案或审核问题。'
    };
  }

  if (task && hasGeneratedImages(task) && !task.review && !task.normalizedReviewReport) {
    return {
      status: 'noReview',
      currentStep: 'review',
      failedStep: '',
      errorMessage: '',
      canRetry: false,
      canResume: true,
      requiresManualAction: false,
      nextSuggestedAction: '已生成图片但尚未审核，建议先执行审核。'
    };
  }

  if (task && (task.review || task.normalizedReviewReport) && review.fatal === 0 && review.high === 0) {
    return {
      status: 'completed',
      currentStep: 'export',
      failedStep: '',
      errorMessage: '',
      canRetry: false,
      canResume: false,
      requiresManualAction: false,
      nextSuggestedAction: '审核未发现 fatal/high 风险，可进入导出或人工验收。'
    };
  }

  if (queueRunning) {
    return {
      status: 'running',
      currentStep: normalizeStep(sku.currentStep || sku.queueAction) || statusStep(task || {}, sku),
      failedStep: '',
      errorMessage: '',
      canRetry: false,
      canResume: false,
      requiresManualAction: false,
      nextSuggestedAction: 'SKU 正在处理中，请等待当前队列完成。'
    };
  }

  if (queuePending) {
    return {
      status: 'pending',
      currentStep: normalizeStep(sku.queueAction || sku.currentStep) || statusStep(task || {}, sku),
      failedStep: '',
      errorMessage: '',
      canRetry: false,
      canResume: true,
      requiresManualAction: false,
      nextSuggestedAction: 'SKU 正在等待队列处理。'
    };
  }

  if (['exported', 'completed'].includes(sku.status) || ['exported', 'completed'].includes(task?.status)) {
    return {
      status: 'completed',
      currentStep: 'export',
      failedStep: '',
      errorMessage: '',
      canRetry: false,
      canResume: false,
      requiresManualAction: false,
      nextSuggestedAction: '该 SKU 已完成。'
    };
  }

  return {
    status: 'pending',
    currentStep: statusStep(task || {}, sku),
    failedStep: '',
    errorMessage: '',
    canRetry: false,
    canResume: true,
    requiresManualAction: false,
    nextSuggestedAction: '请按当前流程继续处理该 SKU。'
  };
}

function severityFor(classification = {}) {
  if (classification.requiresManualAction) return 'high';
  if (classification.canRetry) return 'medium';
  return 'low';
}

function updateStepSummary(stepSummary, progress) {
  for (const step of STEP_ORDER) {
    const row = stepSummary[step];
    row.total += 1;
    if (progress.failedStep === step) row.failed += 1;
    else if (progress.status === 'needsManualReview' && step === 'review') row.needsManualReview += 1;
    else if (progress.completedSteps.includes(step)) row.completed += 1;
    else if (progress.status === 'running' && progress.currentStep === step) row.running += 1;
    else row.pending += 1;
  }
}

function buildResumePlan(summary, failures) {
  const safeResumeSteps = [];
  const blockedReasons = [];
  const recommendations = [];
  if (summary.canRetryCount > 0) {
    safeResumeSteps.push('retryFailedSku');
    recommendations.push('存在可重试 SKU，但本阶段只提供建议，不会自动执行重试。');
  }
  if (summary.noReviewSku > 0) {
    safeResumeSteps.push('runReviewForNoReviewSku');
    recommendations.push('存在未审核 SKU，建议先补充审核再判断是否需要恢复。');
  }
  if (summary.needsManualReviewSku > 0) {
    blockedReasons.push('存在需要人工复查的 SKU。');
    recommendations.push('请先处理需要人工确认的 SKU，再执行后续批量恢复。');
  }
  if (failures.some((item) => item.requiresManualAction)) {
    blockedReasons.push('部分失败需要人工处理，不能直接重试。');
  }
  return {
    canResume: safeResumeSteps.length > 0,
    safeResumeSteps,
    blockedReasons,
    recommendations
  };
}

export function buildBatchStabilityReport(batchTask = {}, tasks = [], { generatedAt = new Date().toISOString() } = {}) {
  const batch = normalizeBatchTask(batchTask || {});
  const taskMap = taskById(tasks);
  const stepSummary = emptyStepSummary();
  const skuProgress = [];
  const failures = [];
  const summary = {
    totalSku: asArray(batch.skuTasks).length,
    completedSku: 0,
    runningSku: 0,
    failedSku: 0,
    pendingSku: 0,
    needsManualReviewSku: 0,
    noReviewSku: 0,
    progressPercent: 0,
    canResumeCount: 0,
    canRetryCount: 0,
    blockedCount: 0
  };

  for (const sku of asArray(batch.skuTasks)) {
    const task = sku.taskId ? taskMap.get(sku.taskId) : null;
    const classification = classifySku(sku, task);
    const completedSteps = completedStepsFor(task || {}, classification.status, classification.failedStep);
    const progress = {
      taskId: sku.taskId || '',
      sku: skuCode(task || {}, sku),
      productName: productName(task || {}, sku),
      status: classification.status,
      currentStep: classification.currentStep,
      completedSteps,
      pendingSteps: pendingStepsFor(completedSteps, classification.currentStep),
      failedStep: classification.failedStep,
      errorMessage: classification.errorMessage,
      canRetry: classification.canRetry,
      canResume: classification.canResume,
      requiresManualAction: classification.requiresManualAction,
      nextSuggestedAction: classification.nextSuggestedAction
    };
    skuProgress.push(progress);
    updateStepSummary(stepSummary, progress);

    if (progress.status === 'completed' && (
      ['exported', 'completed'].includes(sku.status) ||
      ['exported', 'completed'].includes(task?.status) ||
      task?.exportFile?.status === 'succeeded'
    )) summary.completedSku += 1;
    else if (progress.status === 'running') summary.runningSku += 1;
    else if (progress.status === 'failed') summary.failedSku += 1;
    else if (progress.status === 'needsManualReview') summary.needsManualReviewSku += 1;
    else if (progress.status === 'noReview') summary.noReviewSku += 1;
    else summary.pendingSku += 1;
    if (progress.canResume) summary.canResumeCount += 1;
    if (progress.canRetry) summary.canRetryCount += 1;
    if (progress.requiresManualAction) summary.blockedCount += 1;

    if (progress.status === 'failed') {
      failures.push({
        taskId: progress.taskId,
        sku: progress.sku,
        failedStep: progress.failedStep,
        errorMessage: progress.errorMessage,
        severity: severityFor(progress),
        canRetry: progress.canRetry,
        requiresManualAction: progress.requiresManualAction,
        suggestion: progress.nextSuggestedAction
      });
    }
  }

  summary.progressPercent = summary.totalSku ? Math.round((summary.completedSku / summary.totalSku) * 100) : 0;
  const resumePlan = buildResumePlan(summary, failures);
  const recommendations = [
    '本阶段仅提供断点续跑分析，不会自动恢复或重试。',
    '请先处理需要人工确认的 SKU，再执行后续批量恢复。'
  ];
  if (summary.canRetryCount > 0) recommendations.push('存在可重试 SKU，可等待后续安全重试入口处理。');
  if (summary.noReviewSku > 0) recommendations.push('存在未审核 SKU，建议先完成审核。');
  const warnings = summary.totalSku === 0 ? ['当前 batch 暂无 SKU。'] : [];

  return sanitizeValue({
    meta: {
      batchId: batch.id || '',
      generatedAt,
      mode: 'readOnly',
      source: 'batch/tasks'
    },
    summary,
    stepSummary,
    skuProgress,
    failures,
    resumePlan,
    recommendations,
    warnings
  });
}

export async function analyzeBatchStability(batchId, options = {}) {
  const batch = await getBatchTask(batchId);
  if (!batch) {
    const error = new Error('Batch task not found');
    error.statusCode = 404;
    throw error;
  }
  const normalized = normalizeBatchTask(batch);
  const tasks = [];
  for (const sku of asArray(normalized.skuTasks)) {
    if (!sku.taskId) continue;
    const task = await getTask(sku.taskId);
    if (task) tasks.push(task);
  }
  return buildBatchStabilityReport(normalized, tasks, options);
}
