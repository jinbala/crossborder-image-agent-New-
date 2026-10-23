import { reportDisplayLabel } from './reportDisplayLabels.js';
const SEVERITY_ORDER = {
  fatal: 0,
  high: 1,
  medium: 2,
  low: 3,
  info: 4,
  mockInfo: 5
};

const EMPTY_TEXT = '暂无结构化审核报告，请先执行审核。';

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

export function sanitizeReviewReport(value) {
  if (Array.isArray(value)) return value.map(sanitizeReviewReport);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value)
      .filter(([key]) => !/apiKey|api_key|secret|token|password|absolutePath/i.test(key))
      .map(([key, item]) => [key, sanitizeReviewReport(item)]));
  }
  if (typeof value === 'string') return sanitizeText(value);
  return value;
}

function rank(group = {}) {
  return SEVERITY_ORDER[group.severity] ?? 99;
}

export function getReviewReportDisplayModel(report, t) {
  const ui = t || (value => value);
  if (!report) {
    return {
      emptyText: ui(EMPTY_TEXT),
      summaryCards: [],
      complianceGroups: [],
      mockHintGroups: [],
      fixSummaryCards: [],
      fixSuggestions: [],
      mockOnlyFixSuggestions: [],
      nextSuggestedAction: ui(EMPTY_TEXT),
      recommendations: []
    };
  }
  const summary = report.summary || {};
  const fixSummary = report.fixSummary || {};
  const groupedIssues = asArray(report.groupedIssues).slice().sort((a, b) => rank(a) - rank(b)).map(group => ({ ...group, severityLabel: reportDisplayLabel('severity', group.severity, t), imageTypeLabels: asArray(group.imageTypes).map(value => reportDisplayLabel('imageType', value, t)) }));
  const mockHintGroups = groupedIssues.filter((group) => group.severity === 'mockInfo' || String(group.groupKey || '').startsWith('mock:'));
  const complianceGroups = groupedIssues.filter((group) => !mockHintGroups.includes(group));
  const fixSuggestions = asArray(report.fixSuggestions).slice().sort((a, b) => (a.priority || 99) - (b.priority || 99)).map(item => ({ ...item, actionTypeLabel: reportDisplayLabel('action', item.actionType, t), imageTypeLabels: (asArray(item.affectedImageTypes).length ? item.affectedImageTypes : [item.imageType || '-']).map(value => reportDisplayLabel('imageType', value, t)) }));
  const mockOnlyFixSuggestions = fixSuggestions.filter((suggestion) => suggestion.isMockOnly || suggestion.actionType === 'skipMockOnly');
  return {
    emptyText: summary.totalIssues === 0 && !report.meta?.reviewMode ? ui(EMPTY_TEXT) : '',
    summaryCards: [
      { label: '致命风险', value: summary.fatalCount || 0, tone: 'red' },
      { label: '高风险', value: summary.highCount || 0, tone: 'orange' },
      { label: '中风险', value: summary.mediumCount || 0, tone: 'amber' },
      { label: '低风险', value: summary.lowCount || 0, tone: 'slate' },
      { label: '信息提示', value: summary.infoCount || 0, tone: 'blue' },
      { label: 'mock 流程提示', value: summary.mockInfoCount || 0, tone: 'violet' },
      { label: '真实合规问题', value: summary.realComplianceIssueCount || 0, tone: 'red' },
      { label: 'mock 提示', value: summary.mockOnlyIssueCount || 0, tone: 'slate' }
    ].map(card => ({ ...card, label: ui(card.label) })),
    complianceGroups,
    mockHintGroups,
    fixSummaryCards: [
      { label: '修正建议总数', value: fixSummary.total || 0 },
      { label: '可自动修正候选', value: fixSummary.autoFixCandidateCount || 0 },
      { label: '需要人工确认', value: fixSummary.manualConfirmRequiredCount || 0 },
      { label: 'mock 提示', value: fixSummary.mockOnlyCount || 0 }
    ].map(card => ({ ...card, label: ui(card.label) })),
    fixSuggestions: fixSuggestions.filter((suggestion) => !mockOnlyFixSuggestions.includes(suggestion)),
    mockOnlyFixSuggestions,
    nextSuggestedAction: report.nextSuggestedAction || ui(EMPTY_TEXT),
    recommendations: asArray(report.recommendations)
  };
}

export function buildReviewReportDownload({ report, taskId, timestamp = new Date().toISOString().replace(/[:.]/g, '-') } = {}) {
  const safeReport = sanitizeReviewReport(report || {});
  const safeTaskId = String(taskId || safeReport.meta?.taskId || 'task').replace(/[^a-zA-Z0-9_-]+/g, '-');
  return {
    fileName: `review-report-${safeTaskId}-${timestamp}.json`,
    mimeType: 'application/json',
    json: JSON.stringify(safeReport, null, 2)
  };
}

export function downloadReviewReportJson({ report, taskId } = {}) {
  const download = buildReviewReportDownload({ report, taskId });
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
