import { batchReportLabel } from './batchReportLabels.js';
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

export function getBatchReviewReportDisplayModel(report, t) {
  const ui = t || (value => value);
  if (!report) {
    return {
      emptyText: ui(EMPTY_TEXT),
      overviewCards: [],
      riskCards: [],
      fixSummaryCards: [],
      fixActionRows: [],
      topFixSuggestions: [],
      fixRecommendations: [],
      topRiskSku: [],
      recommendations: [],
      issueRows: [],
      mockInfoNotice: ui('mock 提示仅表示流程测试信息，不代表真实平台上传失败。')
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
    emptyText: meta.totalSku === 0 ? ui('当前 batch 暂无 SKU，批量审核报告为空。') : '',
    overviewCards: [
      { label: ui('SKU 总数'), value: meta.totalSku || 0 },
      { label: ui('通过 SKU'), value: summary.passedSku || 0 },
      { label: ui('失败 SKU'), value: summary.failedSku || 0 },
      { label: ui('需人工复查 SKU'), value: summary.needsManualReviewSku || 0 },
      { label: ui('仅 mock 提示 SKU'), value: summary.mockOnlySku || 0 },
      { label: ui('未审核 SKU'), value: summary.noReviewSku || 0 }
    ],
    riskCards: [
      { label: batchReportLabel('severity', 'fatal', t), value: summary.fatalCount || 0 },
      { label: batchReportLabel('severity', 'high', t), value: summary.highCount || 0 },
      { label: batchReportLabel('severity', 'medium', t), value: summary.mediumCount || 0 },
      { label: batchReportLabel('severity', 'low', t), value: summary.lowCount || 0 },
      { label: batchReportLabel('severity', 'info', t), value: summary.infoCount || 0 },
      { label: batchReportLabel('severity', 'mockInfo', t), value: summary.mockInfoCount || 0 },
      { label: ui('真实合规问题'), value: summary.realComplianceIssueCount || 0 },
      { label: t ? ui('仅 mock 流程问题') : 'mock only issue', value: summary.mockOnlyIssueCount || 0 }
    ],
    fixSummaryCards: [
      { label: ui('总修正建议数'), value: batchFixSummary.totalFixSuggestions || 0 },
      { label: ui('可自动修正候选'), value: batchFixSummary.autoFixCandidateCount || 0 },
      { label: ui('需要人工确认'), value: batchFixSummary.manualConfirmRequiredCount || 0 },
      { label: ui('mock 提示'), value: batchFixSummary.mockOnlyCount || 0 }
    ],
    fixActionRows: Object.entries(batchFixSummary.byActionType || {})
      .sort((a, b) => b[1] - a[1])
      .map(([label, value]) => ({ key: label, label: batchReportLabel('action', label, t), value })),
    topFixSuggestions: asArray(batchFixSummary.topFixSuggestions),
    fixRecommendations: asArray(batchFixSummary.recommendations),
    topRiskSku: asArray(report.topRiskSku),
    recommendations: asArray(report.recommendations),
    issueRows,
    issuesByImageType: report.issuesByImageType || {},
    issuesBySeverity: report.issuesBySeverity || {},
    mockInfoSummary: report.mockInfoSummary || {},
    mockInfoNotice: ui('mock 提示仅表示流程测试信息，不代表真实平台上传失败。')
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
