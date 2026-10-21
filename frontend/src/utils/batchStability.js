const EMPTY_TEXT = '暂无批量任务稳定性报告，请先选择一个 batch。';

const stepLabels = {
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

export function sanitizeBatchStabilityReport(value) {
  if (Array.isArray(value)) return value.map(sanitizeBatchStabilityReport);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value)
      .filter(([key]) => !/apiKey|api_key|secret|token|password|absolutePath|sourceFolderPath|folderPath/i.test(key))
      .map(([key, item]) => [key, sanitizeBatchStabilityReport(item)]));
  }
  if (typeof value === 'string') return sanitizeText(value);
  return value;
}

export function getBatchStabilityDisplayModel(report, t = value => value) {
  if (!report) {
    return {
      emptyText: t(EMPTY_TEXT),
      summaryCards: [],
      stepRows: [],
      skuRows: [],
      failureRows: [],
      resumePlan: { canResume: false, safeResumeSteps: [], blockedReasons: [], recommendations: [] },
      recommendations: [],
      warnings: [],
      readOnlyNotice: t('本阶段仅提供断点续跑分析，不会自动恢复或重试。')
    };
  }
  const summary = report.summary || {};
  const stepRows = Object.entries(report.stepSummary || {}).map(([step, rawRow]) => {
    const row = rawRow || {};
    const knownLabel = Object.hasOwn(stepLabels, step) ? stepLabels[step] : null;
    return {
    step,
    label: knownLabel && (!row.label || row.label === knownLabel) ? t(knownLabel) : row.label || step,
    total: row.total || 0,
    completed: row.completed || 0,
    running: row.running || 0,
    failed: row.failed || 0,
    pending: row.pending || 0,
    needsManualReview: row.needsManualReview || 0
    };
  });
  return {
    emptyText: summary.totalSku === 0 ? t('当前 batch 暂无 SKU。') : '',
    summaryCards: [
      { label: t('SKU 总数'), value: summary.totalSku || 0 },
      { label: t('已完成'), value: summary.completedSku || 0 },
      { label: t('运行中'), value: summary.runningSku || 0 },
      { label: t('失败'), value: summary.failedSku || 0 },
      { label: t('待处理'), value: summary.pendingSku || 0 },
      { label: t('需人工复查'), value: summary.needsManualReviewSku || 0 },
      { label: t('未审核'), value: summary.noReviewSku || 0 },
      { label: t('进度百分比'), value: `${summary.progressPercent || 0}%` }
    ],
    stepRows,
    skuRows: asArray(report.skuProgress),
    failureRows: asArray(report.failures),
    resumePlan: report.resumePlan || { canResume: false, safeResumeSteps: [], blockedReasons: [], recommendations: [] },
    recommendations: asArray(report.recommendations),
    warnings: asArray(report.warnings),
    readOnlyNotice: t('本阶段仅提供断点续跑分析，不会自动恢复或重试。请先处理需要人工确认的 SKU，再执行后续批量恢复。')
  };
}

export function buildBatchStabilityReportDownload({ report, batchId, timestamp = new Date().toISOString().replace(/[:.]/g, '-') } = {}) {
  const safeReport = sanitizeBatchStabilityReport(report || {});
  const safeBatchId = String(batchId || safeReport.meta?.batchId || 'batch').replace(/[^a-zA-Z0-9_-]+/g, '-');
  return {
    fileName: `batch-stability-report-${safeBatchId}-${timestamp}.json`,
    mimeType: 'application/json',
    json: JSON.stringify(safeReport, null, 2)
  };
}

export function downloadBatchStabilityReportJson({ report, batchId } = {}) {
  const download = buildBatchStabilityReportDownload({ report, batchId });
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
