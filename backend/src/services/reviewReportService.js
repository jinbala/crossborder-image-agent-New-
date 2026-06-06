import { groupReviewIssues, normalizeReviewIssues, severityRank } from './reviewIssueService.js';
import { buildFixSuggestions, buildFixSummary } from './reviewFixSuggestionService.js';

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
      .filter(([key]) => !/apiKey|api_key|secret|token|password|absolutePath/i.test(key))
      .map(([key, item]) => [key, sanitizeValue(item)]));
  }
  if (typeof value === 'string') return sanitizeText(value);
  return value;
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function imageTypeFor(item = {}, imageById = {}) {
  return item.imageType || item.type || imageById[item.imageId]?.type || imageById[item.imageId]?.imageType || '';
}

function collectIssues(task = {}) {
  const imageById = Object.fromEntries(asArray(task.generatedImages).map((image) => [image.id, image]));
  return asArray(task.review?.items).flatMap((item) => {
    const imageType = imageTypeFor(item, imageById);
    return normalizeReviewIssues(asArray(item.issues), {
      source: item.isRealReview ? 'reviewProvider' : 'mockReview',
      imageType
    }).map((issue) => ({
      ...issue,
      imageId: item.imageId,
      imageType: issue.imageType || imageType,
      fileName: item.fileName || imageById[item.imageId]?.fileName || ''
    }));
  });
}

function countBy(issues, predicate) {
  return issues.filter(predicate).length;
}

function byImageType(issues = []) {
  return issues.reduce((acc, issue) => {
    const key = issue.imageType || 'unknown';
    const current = acc[key] || { total: 0, fatal: 0, high: 0, medium: 0, low: 0, info: 0, mockInfo: 0 };
    current.total += 1;
    current[issue.severity] = (current[issue.severity] || 0) + 1;
    acc[key] = current;
    return acc;
  }, {});
}

function recommendationsFor(issues = []) {
  if (!issues.length) return ['暂无结构化审核问题。'];
  const suggestions = [...new Set(issues.map((issue) => issue.suggestion).filter(Boolean))];
  const priority = [];
  if (issues.some((issue) => issue.severity === 'fatal')) priority.push('请先处理 fatal 致命风险问题，再进入导出。');
  if (issues.some((issue) => issue.severity === 'high')) priority.push('请继续处理 high 高风险问题，必要时回到商品确认页补证据。');
  if (issues.some((issue) => issue.severity === 'mockInfo')) priority.push('mockInfo 仅为流程提示，不等同于真实合规错误。');
  return [...priority, ...suggestions].slice(0, 12);
}

function emptyReport(task = {}) {
  return {
    meta: {
      taskId: task.id || '',
      sku: task.productInfoConfirmed?.sku || task.productInfo?.sku || task.sku || '',
      platformId: task.platformId || task.targets?.[0]?.platformId || '',
      categoryId: task.categoryId || task.targets?.[0]?.categoryId || '',
      generatedAt: new Date().toISOString(),
      reviewMode: task.review?.reviewMode || '',
      isMockPreview: asArray(task.generatedImages).some((image) => image.isMockPreview)
    },
    summary: {
      passed: false,
      fatalCount: 0,
      highCount: 0,
      mediumCount: 0,
      lowCount: 0,
      infoCount: 0,
      mockInfoCount: 0,
      totalIssues: 0,
      realComplianceIssueCount: 0,
      mockOnlyIssueCount: 0,
      autoFixCandidateCount: 0,
      manualConfirmRequiredCount: 0
    },
    groupedIssues: [],
    issues: [],
    fixSuggestions: [],
    fixSummary: buildFixSummary([]),
    byImageType: {},
    recommendations: ['暂无结构化审核报告，请先执行审核。'],
    nextSuggestedAction: '暂无结构化审核报告，请先执行审核。'
  };
}

export function buildReviewReport(task = {}) {
  if (!task.review) return sanitizeValue(emptyReport(task));
  const issues = collectIssues(task).sort((a, b) => severityRank(a.severity) - severityRank(b.severity));
  const groupedIssues = groupReviewIssues(issues);
  const fixSuggestions = buildFixSuggestions({ issues, groupedIssues });
  const fixSummary = buildFixSummary(fixSuggestions);
  const summary = {
    passed: Boolean(task.review?.overallStatus === 'passed' && !issues.some((issue) => issue.isRealComplianceRisk && ['fatal', 'high'].includes(issue.severity))),
    fatalCount: countBy(issues, (issue) => issue.severity === 'fatal'),
    highCount: countBy(issues, (issue) => issue.severity === 'high'),
    mediumCount: countBy(issues, (issue) => issue.severity === 'medium'),
    lowCount: countBy(issues, (issue) => issue.severity === 'low'),
    infoCount: countBy(issues, (issue) => issue.severity === 'info'),
    mockInfoCount: countBy(issues, (issue) => issue.severity === 'mockInfo'),
    totalIssues: issues.length,
    realComplianceIssueCount: countBy(issues, (issue) => issue.isRealComplianceRisk),
    mockOnlyIssueCount: countBy(issues, (issue) => issue.isMockOnly),
    autoFixCandidateCount: countBy(issues, (issue) => issue.canAutoFixLater),
    manualConfirmRequiredCount: countBy(issues, (issue) => issue.requiresManualConfirm)
  };
  const report = {
    meta: {
      taskId: task.id || '',
      sku: task.productInfoConfirmed?.sku || task.productInfo?.sku || task.sku || '',
      platformId: task.platformId || task.targets?.[0]?.platformId || '',
      categoryId: task.categoryId || task.targets?.[0]?.categoryId || '',
      generatedAt: new Date().toISOString(),
      reviewMode: task.review?.reviewMode || 'mock',
      isMockPreview: asArray(task.generatedImages).some((image) => image.isMockPreview)
    },
    summary,
    groupedIssues,
    issues,
    fixSuggestions,
    fixSummary,
    byImageType: byImageType(issues),
    recommendations: recommendationsFor(issues),
    nextSuggestedAction: summary.fatalCount || summary.highCount
      ? '请先处理 fatal 和 high 风险问题，再进入导出。'
      : '可人工复核 medium / low 提示，mockInfo 仅作为流程提示。'
  };
  return sanitizeValue(report);
}
