import { buildReviewReport } from './reviewReportService.js';
import { severityRank } from './reviewIssueService.js';

const SEVERITIES = ['fatal', 'high', 'medium', 'low', 'info', 'mockInfo'];

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
      .filter(([key]) => !/apiKey|api_key|secret|token|password|absolutePath|sourceFolderPath/i.test(key))
      .map(([key, item]) => [key, sanitizeValue(item)]));
  }
  if (typeof value === 'string') return sanitizeText(value);
  return value;
}

function emptyCounts() {
  return {
    fatal: 0,
    high: 0,
    medium: 0,
    low: 0,
    info: 0,
    mockInfo: 0
  };
}

function increment(map, key, amount = 1) {
  if (!key) return;
  map[key] = (map[key] || 0) + amount;
}

function taskSku(task = {}, sku = {}) {
  return task.productInfoConfirmed?.sku || task.productInfo?.sku || task.sku || sku.skuId || '';
}

function taskName(task = {}, sku = {}) {
  return task.productInfoConfirmed?.name || task.productInfo?.name || sku.displayName || sku.skuId || '';
}

function classifySku(report) {
  if (!report || !report.meta?.reviewMode) return 'noReview';
  const summary = report.summary || {};
  if (summary.fatalCount > 0 || summary.highCount > 0) return 'failed';
  if ((summary.realComplianceIssueCount || 0) === 0 && (summary.mockOnlyIssueCount || 0) > 0) return 'mockOnly';
  if ((summary.mediumCount || 0) > 0 || (summary.manualConfirmRequiredCount || 0) > 0) return 'needsManualReview';
  if ((summary.realComplianceIssueCount || 0) === 0) return 'passed';
  return 'needsManualReview';
}

function skuRiskScore(skuReport) {
  return (skuReport.fatalCount * 100000) +
    (skuReport.highCount * 10000) +
    (skuReport.mediumCount * 1000) +
    (skuReport.lowCount * 100) +
    (skuReport.infoCount * 10);
}

function buildSkuReport({ sku, task }) {
  const report = task?.review ? buildReviewReport(task) : null;
  const summary = report?.summary || {};
  const groupedIssues = asArray(report?.groupedIssues);
  const status = classifySku(report);
  const topIssues = groupedIssues
    .filter((group) => group.severity !== 'mockInfo')
    .sort((a, b) => severityRank(a.severity) - severityRank(b.severity))
    .slice(0, 5)
    .map((group) => ({
      groupKey: group.groupKey,
      severity: group.severity,
      title: group.title,
      count: group.count,
      suggestion: group.suggestion
    }));
  return {
    taskId: sku.taskId || task?.id || '',
    sku: taskSku(task, sku),
    productName: taskName(task, sku),
    status,
    fatalCount: summary.fatalCount || 0,
    highCount: summary.highCount || 0,
    mediumCount: summary.mediumCount || 0,
    lowCount: summary.lowCount || 0,
    infoCount: summary.infoCount || 0,
    mockInfoCount: summary.mockInfoCount || 0,
    realComplianceIssueCount: summary.realComplianceIssueCount || 0,
    mockOnlyIssueCount: summary.mockOnlyIssueCount || 0,
    autoFixCandidateCount: summary.autoFixCandidateCount || 0,
    manualConfirmRequiredCount: summary.manualConfirmRequiredCount || 0,
    topIssues,
    nextSuggestedAction: report?.nextSuggestedAction || '暂无结构化审核报告，请先执行审核。',
    reviewMode: report?.meta?.reviewMode || '',
    issueCount: summary.totalIssues || 0,
    fixSuggestionCount: report?.fixSummary?.total || 0,
    fixAutoFixCandidateCount: report?.fixSummary?.autoFixCandidateCount || 0,
    fixManualConfirmRequiredCount: report?.fixSummary?.manualConfirmRequiredCount || 0,
    fixMockOnlyCount: report?.fixSummary?.mockOnlyCount || 0,
    topFixSuggestions: asArray(report?.fixSuggestions).slice(0, 3),
    report
  };
}

function reviewModeFor(skuReports) {
  const modes = [...new Set(skuReports.map((item) => item.reviewMode).filter(Boolean))];
  if (!modes.length) return '';
  if (modes.length === 1) return modes[0];
  return 'mixed';
}

function recommendationsFor(summary) {
  const recommendations = [];
  if (summary.failedSku > 0 || summary.fatalCount > 0 || summary.highCount > 0) {
    recommendations.push('请优先处理 fatal/high 风险 SKU。');
  }
  if (summary.needsManualReviewSku > 0) {
    recommendations.push('中风险 SKU 建议人工复查字段证据、主体保真和文案安全。');
  }
  if (summary.mockOnlySku > 0) {
    recommendations.push('只有 mockInfo 的 SKU 可以继续流程测试，但不代表真实平台审核通过。');
  }
  if (summary.noReviewSku > 0) {
    recommendations.push('未审核 SKU 建议先执行审核。');
  }
  if (!recommendations.length) {
    recommendations.push('当前批次没有发现结构化审核风险，可继续人工验收和导出前复查。');
  }
  return recommendations;
}

function buildBatchFixSummary(skuReports = []) {
  const batchFixSummary = {
    totalFixSuggestions: 0,
    autoFixCandidateCount: 0,
    manualConfirmRequiredCount: 0,
    mockOnlyCount: 0,
    byActionType: {},
    bySku: [],
    topFixSuggestions: [],
    recommendations: []
  };
  for (const skuReport of skuReports) {
    const fixSummary = skuReport.report?.fixSummary || {};
    const fixSuggestions = asArray(skuReport.report?.fixSuggestions);
    batchFixSummary.totalFixSuggestions += fixSummary.total || 0;
    batchFixSummary.autoFixCandidateCount += fixSummary.autoFixCandidateCount || 0;
    batchFixSummary.manualConfirmRequiredCount += fixSummary.manualConfirmRequiredCount || 0;
    batchFixSummary.mockOnlyCount += fixSummary.mockOnlyCount || 0;
    for (const [actionType, count] of Object.entries(fixSummary.byActionType || {})) {
      batchFixSummary.byActionType[actionType] = (batchFixSummary.byActionType[actionType] || 0) + count;
    }
    batchFixSummary.bySku.push({
      taskId: skuReport.taskId,
      sku: skuReport.sku,
      status: skuReport.status,
      fixSuggestionCount: fixSummary.total || 0,
      autoFixCandidateCount: fixSummary.autoFixCandidateCount || 0,
      manualConfirmRequiredCount: fixSummary.manualConfirmRequiredCount || 0,
      topFixSuggestions: fixSuggestions.slice(0, 3)
    });
    batchFixSummary.topFixSuggestions.push(...fixSuggestions.map((suggestion) => ({
      ...suggestion,
      taskId: skuReport.taskId,
      sku: skuReport.sku,
      productName: skuReport.productName
    })));
  }
  batchFixSummary.topFixSuggestions = batchFixSummary.topFixSuggestions
    .filter((suggestion) => !['skipMockOnly', 'noActionNeeded'].includes(suggestion.actionType))
    .sort((a, b) => (a.priority || 99) - (b.priority || 99))
    .slice(0, 10);
  if (batchFixSummary.autoFixCandidateCount > 0) batchFixSummary.recommendations.push('可自动修正候选仅用于后续版本参考，本阶段不自动执行。');
  if (batchFixSummary.manualConfirmRequiredCount > 0) batchFixSummary.recommendations.push('请优先人工核对需要确认的字段证据和主体保真问题。');
  if (batchFixSummary.mockOnlyCount > 0) batchFixSummary.recommendations.push('mock 提示只作为流程测试信息，不作为真实违规修正处理。');
  if (!batchFixSummary.recommendations.length) batchFixSummary.recommendations.push('当前批次暂无需要归档的修正建议。');
  return batchFixSummary;
}

export function buildBatchReviewReport(batchTask = {}, tasks = []) {
  const taskById = Object.fromEntries(asArray(tasks).map((task) => [task.id, task]));
  const skuReports = asArray(batchTask.skuTasks).map((sku) => buildSkuReport({ sku, task: taskById[sku.taskId] }));
  const issueCounts = emptyCounts();
  const issuesByCode = {};
  const issuesByImageType = {};
  const issuesBySeverity = {};
  const mockInfoSummary = {};

  const summary = {
    passedSku: 0,
    failedSku: 0,
    needsManualReviewSku: 0,
    mockOnlySku: 0,
    noReviewSku: 0,
    fatalCount: 0,
    highCount: 0,
    mediumCount: 0,
    lowCount: 0,
    infoCount: 0,
    mockInfoCount: 0,
    realComplianceIssueCount: 0,
    mockOnlyIssueCount: 0,
    autoFixCandidateCount: 0,
    manualConfirmRequiredCount: 0
  };

  for (const skuReport of skuReports) {
    if (skuReport.status === 'passed') summary.passedSku += 1;
    if (skuReport.status === 'failed') summary.failedSku += 1;
    if (skuReport.status === 'needsManualReview') summary.needsManualReviewSku += 1;
    if (skuReport.status === 'mockOnly') summary.mockOnlySku += 1;
    if (skuReport.status === 'noReview') summary.noReviewSku += 1;
    for (const severity of SEVERITIES) {
      const key = `${severity}Count`;
      summary[key] += skuReport[key] || 0;
      issueCounts[severity] += skuReport[key] || 0;
      if (skuReport[key]) issuesBySeverity[severity] = (issuesBySeverity[severity] || 0) + skuReport[key];
    }
    summary.realComplianceIssueCount += skuReport.realComplianceIssueCount || 0;
    summary.mockOnlyIssueCount += skuReport.mockOnlyIssueCount || 0;
    summary.autoFixCandidateCount += skuReport.autoFixCandidateCount || 0;
    summary.manualConfirmRequiredCount += skuReport.manualConfirmRequiredCount || 0;
    for (const issue of asArray(skuReport.report?.issues)) {
      increment(issuesByCode, issue.code);
      increment(issuesByImageType, issue.imageType || 'unknown');
      if (issue.severity === 'mockInfo') increment(mockInfoSummary, issue.code || 'MOCK_INFO');
    }
  }

  const topRiskSku = skuReports
    .filter((skuReport) => skuRiskScore(skuReport) > 0)
    .sort((a, b) => skuRiskScore(b) - skuRiskScore(a))
    .slice(0, 10)
    .map(({ report, ...skuReport }) => skuReport);
  const recommendations = recommendationsFor(summary);
  const batchFixSummary = buildBatchFixSummary(skuReports);
  const report = {
    meta: {
      batchId: batchTask.id || '',
      generatedAt: new Date().toISOString(),
      reviewMode: reviewModeFor(skuReports),
      totalTasks: skuReports.filter((sku) => sku.taskId).length,
      totalSku: skuReports.length
    },
    summary,
    skuReports: skuReports.map(({ report, ...skuReport }) => skuReport),
    topRiskSku,
    issuesByCode,
    issuesByImageType,
    issuesBySeverity,
    mockInfoSummary,
    batchFixSummary,
    recommendations,
    nextSuggestedAction: (summary.fatalCount || summary.highCount)
      ? '请先处理 fatal 和 high 风险 SKU，再进入批量导出。'
      : summary.noReviewSku
        ? '请先审核未审核 SKU，再进行批量验收。'
        : '可继续人工验收；mockInfo 仅作为流程提示。'
  };
  return sanitizeValue(report);
}
