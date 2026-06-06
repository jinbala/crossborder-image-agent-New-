const EMPTY_TEXT = '暂无批量审核报告，请先执行批量审核或刷新当前 batch。';

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

export function sanitizeBatchReviewReport(value) {
  if (Array.isArray(value)) return value.map(sanitizeBatchReviewReport);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value)
      .filter(([key]) => !/apiKey|api_key|secret|token|password|absolutePath|sourceFolderPath/i.test(key))
      .map(([key, item]) => [key, sanitizeBatchReviewReport(item)]));
  }
  if (typeof value === 'string') return sanitizeText(value);
  return value;
}

export function getBatchReviewReportDisplayModel(report) {
  if (!report) {
    return {
      emptyText: EMPTY_TEXT,
      overviewCards: [],
      riskCards: [],
      fixSummaryCards: [],
      fixActionRows: [],
      topFixSuggestions: [],
      fixRecommendations: [],
      topRiskSku: [],
      recommendations: [],
      issueRows: [],
      mockInfoNotice: 'mock 提示仅表示流程测试信息，不代表真实平台上传失败。'
    };
  }
  const summary = report.summary || {};
  const meta = report.meta || {};
  const batchFixSummary = report.batchFixSummary || {};
  const issueRows = Object.entries(report.issuesByCode || {})
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([code, count]) => ({ label: code, value: count }));
  return {
    emptyText: meta.totalSku === 0 ? '当前 batch 暂无 SKU，批量审核报告为空。' : '',
    overviewCards: [
      { label: 'SKU 总数', value: meta.totalSku || 0 },
      { label: '通过 SKU', value: summary.passedSku || 0 },
      { label: '失败 SKU', value: summary.failedSku || 0 },
      { label: '需人工复查 SKU', value: summary.needsManualReviewSku || 0 },
      { label: '仅 mock 提示 SKU', value: summary.mockOnlySku || 0 },
      { label: '未审核 SKU', value: summary.noReviewSku || 0 }
    ],
    riskCards: [
      { label: 'fatal', value: summary.fatalCount || 0 },
      { label: 'high', value: summary.highCount || 0 },
      { label: 'medium', value: summary.mediumCount || 0 },
      { label: 'low', value: summary.lowCount || 0 },
      { label: 'info', value: summary.infoCount || 0 },
      { label: 'mockInfo', value: summary.mockInfoCount || 0 },
      { label: '真实合规问题', value: summary.realComplianceIssueCount || 0 },
      { label: 'mock only issue', value: summary.mockOnlyIssueCount || 0 }
    ],
    fixSummaryCards: [
      { label: '总修正建议数', value: batchFixSummary.totalFixSuggestions || 0 },
      { label: '可自动修正候选', value: batchFixSummary.autoFixCandidateCount || 0 },
      { label: '需要人工确认', value: batchFixSummary.manualConfirmRequiredCount || 0 },
      { label: 'mock 提示', value: batchFixSummary.mockOnlyCount || 0 }
    ],
    fixActionRows: Object.entries(batchFixSummary.byActionType || {})
      .sort((a, b) => b[1] - a[1])
      .map(([label, value]) => ({ label, value })),
    topFixSuggestions: asArray(batchFixSummary.topFixSuggestions),
    fixRecommendations: asArray(batchFixSummary.recommendations),
    topRiskSku: asArray(report.topRiskSku),
    recommendations: asArray(report.recommendations),
    issueRows,
    issuesByImageType: report.issuesByImageType || {},
    issuesBySeverity: report.issuesBySeverity || {},
    mockInfoSummary: report.mockInfoSummary || {},
    mockInfoNotice: 'mock 提示仅表示流程测试信息，不代表真实平台上传失败。'
  };
}

export function buildBatchReviewReportDownload({ report, batchId, timestamp = new Date().toISOString().replace(/[:.]/g, '-') } = {}) {
  const safeReport = sanitizeBatchReviewReport(report || {});
  const safeBatchId = String(batchId || safeReport.meta?.batchId || 'batch').replace(/[^a-zA-Z0-9_-]+/g, '-');
  return {
    fileName: `batch-review-report-${safeBatchId}-${timestamp}.json`,
    mimeType: 'application/json',
    json: JSON.stringify(safeReport, null, 2)
  };
}

export function downloadBatchReviewReportJson({ report, batchId } = {}) {
  const download = buildBatchReviewReportDownload({ report, batchId });
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
