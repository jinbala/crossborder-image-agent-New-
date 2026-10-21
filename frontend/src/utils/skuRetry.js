import { batchReportLabel } from './batchReportLabels.js';
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

export function sanitizeSkuRetryPayload(value) {
  if (Array.isArray(value)) return value.map(sanitizeSkuRetryPayload);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value)
      .filter(([key]) => !/apiKey|api_key|secret|token|password|absolutePath|sourceFolderPath|folderPath/i.test(key))
      .map(([key, item]) => [key, sanitizeSkuRetryPayload(item)]));
  }
  if (typeof value === 'string') return sanitizeText(value);
  return value;
}

function snapshotDiff(before = {}, after = {}, t) {
  const keys = ['imagePlanCount', 'generatedImageCount', 'reviewResultCount'];
  return keys
    .filter((key) => before[key] !== undefined || after[key] !== undefined)
    .map((key) => `${batchReportLabel('snapshot', key, t)}: ${before[key] ?? 0} -> ${after[key] ?? 0}`)
    .join(' / ');
}

export function getSkuRetryDisplayModel({ retryPlan = null, retryResult = null } = {}, t) {
  const ui = t || (value => value);
  const allowedSteps = asArray(retryPlan?.allowedRetrySteps);
  const blockedSteps = asArray(retryPlan?.blockedRetrySteps);
  const warnings = [
    ...asArray(retryPlan?.warnings),
    ...asArray(retryResult?.warnings)
  ];
  return {
    allowedSteps,
    blockedSteps,
    allowedStepsText: allowedSteps.map(step => batchReportLabel('step', step, t)).join(' / ') || ui('暂无'),
    blockedStepsText: blockedSteps.map((item) => `${batchReportLabel('step', item.retryStep, t)}: ${item.reason}`).join(' / ') || ui('暂无'),
    warnings,
    warningsText: warnings.join(' / ') || ui('暂无'),
    nextSuggestedAction: retryResult?.nextSuggestedAction || retryPlan?.nextSuggestedAction || '',
    resultStatusText: batchReportLabel('result', retryResult?.status || '', t),
    durationText: retryResult?.durationMs != null ? `${retryResult.durationMs}ms` : '',
    resultSummaryText: retryResult?.resultSummary?.message || '',
    snapshotSummary: retryResult
      ? snapshotDiff(retryResult.beforeSnapshot || {}, retryResult.afterSnapshot || {}, t)
      : ''
  };
}

export function buildSkuRetryResultDownload({
  taskId,
  retryPlan,
  retryResult,
  timestamp = new Date().toISOString().replace(/[:.]/g, '-')
} = {}) {
  const safePayload = sanitizeSkuRetryPayload({
    retryPlan: retryPlan || null,
    retryResult: retryResult || null,
    beforeSnapshot: retryResult?.beforeSnapshot || null,
    afterSnapshot: retryResult?.afterSnapshot || null,
    warnings: [
      ...asArray(retryPlan?.warnings),
      ...asArray(retryResult?.warnings)
    ],
    nextSuggestedAction: retryResult?.nextSuggestedAction || retryPlan?.nextSuggestedAction || ''
  });
  const safeTaskId = String(taskId || retryResult?.taskId || retryPlan?.taskId || 'task').replace(/[^a-zA-Z0-9_-]+/g, '-');
  return {
    fileName: `sku-retry-result-${safeTaskId}-${timestamp}.json`,
    mimeType: 'application/json',
    json: JSON.stringify(safePayload, null, 2)
  };
}

export function downloadSkuRetryResultJson({ taskId, retryPlan, retryResult } = {}) {
  const download = buildSkuRetryResultDownload({ taskId, retryPlan, retryResult });
  const blob = new Blob([download.json], { type: download.mimeType });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = download.fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
  return download;
}
