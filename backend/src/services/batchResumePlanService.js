import { analyzeBatchStability } from './batchStabilityService.js';
import { planSkuRetry } from './skuRetryService.js';

const SAFE_STEPS = new Set(['imagePlan', 'imageGeneration', 'review']);

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

function paidRiskFor(progress = {}, retryPlan = {}) {
  const text = [
    progress.failedStep,
    progress.errorMessage,
    progress.nextSuggestedAction,
    ...asArray(retryPlan.warnings),
    ...asArray(retryPlan.blockedRetrySteps).map((item) => item.reason)
  ].join(' ');
  return /recognition|export|real|provider|Image2|paid|付费|真实|识别|导出/i.test(text);
}

function recommendedStep(retryPlan = {}, progress = {}) {
  const allowed = asArray(retryPlan.allowedRetrySteps).filter((step) => SAFE_STEPS.has(step));
  if (allowed.includes(progress.failedStep)) return progress.failedStep;
  if (allowed.length) return allowed[0];
  return '';
}

function basePlanItem({ progress = {}, retryPlan = {}, order = 0, group = '' } = {}) {
  const step = recommendedStep(retryPlan, progress);
  const paidApiRisk = paidRiskFor(progress, retryPlan) && !step;
  return {
    order,
    taskId: progress.taskId || retryPlan.taskId || '',
    sku: progress.sku || retryPlan.sku || '',
    productName: progress.productName || '',
    currentStatus: progress.status || retryPlan.currentStatus || '',
    recommendedRetryStep: step,
    mode: 'mockOnly',
    canRetry: Boolean(step && retryPlan.canRetry !== false),
    requiresManualAction: Boolean(progress.requiresManualAction),
    blockedReason: '',
    paidApiRisk,
    group,
    suggestion: progress.nextSuggestedAction || retryPlan.nextSuggestedAction || ''
  };
}

function manualReason(progress = {}) {
  return progress.errorMessage || progress.nextSuggestedAction || '需要人工复查高风险字段、审核风险或字段证据。';
}

function blockedReason(progress = {}, retryPlan = {}) {
  const blocked = asArray(retryPlan.blockedRetrySteps)
    .find((item) => item.retryStep === progress.failedStep) || asArray(retryPlan.blockedRetrySteps)[0];
  return progress.errorMessage || blocked?.reason || progress.nextSuggestedAction || '当前状态无法安全生成自动重试建议。';
}

function groupItem({ progress, retryPlan, group }) {
  const item = basePlanItem({ progress, retryPlan, group });
  if (group === 'manualRequired') {
    item.canRetry = false;
    item.requiresManualAction = true;
    item.blockedReason = manualReason(progress);
  }
  if (group === 'blocked') {
    item.canRetry = false;
    item.blockedReason = blockedReason(progress, retryPlan);
    item.paidApiRisk = paidRiskFor(progress, retryPlan);
  }
  if (group === 'noReview') {
    item.recommendedRetryStep = 'review';
    item.canRetry = true;
    item.suggestion = '建议先逐个 SKU 执行 mock/ruleBased 审核，再判断是否继续恢复。';
  }
  if (group === 'completed') {
    item.canRetry = false;
    item.recommendedRetryStep = '';
    item.suggestion = '该 SKU 已完成，不需要恢复。';
  }
  return item;
}

function emptyGroups() {
  return {
    safeMockRetry: [],
    manualRequired: [],
    waiting: [],
    blocked: [],
    noReview: [],
    completed: []
  };
}

function isFirstRunPendingRecognition(progress = {}) {
  if (progress.status !== 'pending') return false;
  if (progress.failedStep || progress.errorMessage) return false;
  if (progress.canRetry === true || progress.requiresManualAction === true) return false;
  const currentStep = String(progress.currentStep || '').toLowerCase();
  return ['', 'upload', 'uploaded', 'imported', 'recognition', 'recognize', 'pending'].includes(currentStep);
}

function groupFor(progress = {}, retryPlan = {}) {
  if (progress.status === 'completed') return 'completed';
  if (progress.status === 'noReview') return 'noReview';
  if (progress.status === 'needsManualReview' || progress.requiresManualAction) return 'manualRequired';
  if (isFirstRunPendingRecognition(progress)) return 'waiting';
  const step = recommendedStep(retryPlan, progress);
  if (step && retryPlan.canRetry !== false && progress.canRetry !== false) return 'safeMockRetry';
  return 'blocked';
}

function buildRecommendations(summary) {
  const recommendations = [
    '当前仅为批量恢复计划预览，不会自动恢复整批。',
    '请逐个 SKU 执行安全重试，并在每次重试后刷新稳定性摘要。',
    '涉及真实 Provider、Image2、真实审核或导出的步骤当前不会自动执行。'
  ];
  if (summary.manualOnlySku > 0) recommendations.push('存在需要人工处理的 SKU，请先复查高风险字段、审核 fatal/high 和证据缺失。');
  if (summary.blockedSku > 0) recommendations.push('存在 blocked SKU，请不要直接批量恢复，先查看 blockedReason。');
  if (summary.noReviewSku > 0) recommendations.push('存在未审核 SKU，建议先逐个执行 mock/ruleBased 审核。');
  return recommendations;
}

export function buildBatchResumePlanFromReports({
  batchId,
  stabilityReport = {},
  retryPlansByTaskId = new Map(),
  generatedAt = new Date().toISOString()
} = {}) {
  const groups = emptyGroups();
  const orderedCandidates = [];

  for (const progress of asArray(stabilityReport.skuProgress)) {
    const retryPlan = retryPlansByTaskId.get(progress.taskId) || {};
    const group = groupFor(progress, retryPlan);
    const item = groupItem({ progress, retryPlan, group });
    groups[group].push(item);
    if (group !== 'completed') orderedCandidates.push(item);
  }

  const orderedPriority = { safeMockRetry: 1, noReview: 2, waiting: 3, manualRequired: 4, blocked: 5 };
  const orderedPlan = orderedCandidates
    .sort((a, b) => (orderedPriority[a.group] || 99) - (orderedPriority[b.group] || 99) || String(a.sku).localeCompare(String(b.sku)))
    .map((item, index) => ({ ...item, order: index + 1 }));

  const summary = {
    totalSku: stabilityReport.summary?.totalSku || asArray(stabilityReport.skuProgress).length,
    recoverableSku: groups.safeMockRetry.length,
    blockedSku: groups.blocked.length,
    waitingSku: groups.waiting.length,
    manualOnlySku: groups.manualRequired.length,
    noReviewSku: groups.noReview.length,
    completedSku: groups.completed.length,
    estimatedRetryActions: groups.safeMockRetry.length + groups.noReview.length,
    paidApiRiskCount: Object.values(groups).flat().filter((item) => item.paidApiRisk).length,
    canExecuteBatchAutomatically: false
  };
  const warnings = [];
  if (summary.totalSku === 0) warnings.push('当前 batch 暂无 SKU。');
  if (summary.paidApiRiskCount > 0) warnings.push('存在可能涉及真实 Provider、Image2、真实审核或导出的风险项，当前不会自动执行。');

  const recommendations = buildRecommendations(summary);

  return sanitizeValue({
    meta: {
      batchId: batchId || stabilityReport.meta?.batchId || '',
      generatedAt,
      mode: 'previewOnly',
      source: 'batchStability + skuRetryPlan'
    },
    summary,
    resumeGroups: groups,
    orderedPlan,
    warnings,
    recommendations,
    nextSuggestedAction: '请逐个 SKU 执行安全重试，不建议自动恢复整批。'
  });
}

export async function buildBatchResumePlan(batchId, options = {}) {
  const stabilityReport = await analyzeBatchStability(batchId, options);
  const retryPlansByTaskId = new Map();
  for (const progress of asArray(stabilityReport.skuProgress)) {
    if (!progress.taskId || progress.status === 'completed') continue;
    try {
      retryPlansByTaskId.set(progress.taskId, await planSkuRetry(batchId, progress.taskId));
    } catch (error) {
      retryPlansByTaskId.set(progress.taskId, {
        taskId: progress.taskId,
        sku: progress.sku,
        canRetry: false,
        allowedRetrySteps: [],
        blockedRetrySteps: [{ retryStep: progress.failedStep || 'unknown', reason: error.message || '无法生成单 SKU 重试计划。' }],
        warnings: [error.message || '无法生成单 SKU 重试计划。']
      });
    }
  }
  return buildBatchResumePlanFromReports({
    batchId,
    stabilityReport,
    retryPlansByTaskId,
    generatedAt: options.generatedAt || new Date().toISOString()
  });
}
