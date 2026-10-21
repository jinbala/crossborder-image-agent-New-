const SECRET_PATTERNS = [
  [/[A-Z]:\\[^\s"',，。；;]+/gi, '[local path removed]'],
  [/\b[\w.-]*\.sqlite\b/gi, '[sqlite path removed]'],
  [/\bnode_modules\b/gi, '[node modules removed]'],
  [/\.env(?:\.[\w.-]+)?/gi, '[env file removed]'],
  [/\b[A-Z0-9_]*API[_-]?KEY\b\s*[:=]\s*[^\s"',，。；;]+/gi, '[credential removed]'],
  [/\b(?:sk|rk|ak)-[A-Za-z0-9_-]{6,}\b/gi, '[credential removed]'],
  [/\b(provider secret|provider credential|platform token|Temu token|Miaoshou token|Amazon token)\b/gi, '[credential removed]']
];

export const finalAcceptanceNotice = '本页面的普通验收报告只用于最终人工验收，不会调用真实 Provider，不会调用 Image2，不会上传平台，也不会修改任务数据。1 SKU 真实 API 验收专区必须三重确认后才可运行。pending / missing 项需要人工补齐，不能伪造成 passed。';
export const finalAcceptanceIssueNotice = '验收问题和人工结论保存在当前成员的验收工作区，不修改原业务任务；请确认保存成功，版本冲突时先导出副本再重新读取。';

const ISSUE_SEVERITIES = ['blocker', 'high', 'medium', 'low', 'info'];
const ISSUE_STATUSES = ['open', 'investigating', 'fixed', 'verified', 'wontFix'];
export const finalAcceptanceIssueModules = [
  'recognition',
  'recognitionQuality',
  'imagePlan',
  'mockGeneration',
  'templateAudit',
  'reviewReport',
  'autoFix',
  'batchStability',
  'skuRetry',
  'exportPackage',
  'listingCsv',
  'uploadReadiness',
  'uploadPayloadPreview',
  'credentialSafety',
  'finalAcceptance',
  'other'
];

function asArray(value) {
  return Array.isArray(value) ? value : value ? [value] : [];
}

function safeText(value) {
  let text = String(value ?? '');
  for (const [pattern, replacement] of SECRET_PATTERNS) text = text.replace(pattern, replacement);
  return text;
}

function sanitizeForDisplay(value) {
  if (Array.isArray(value)) return value.map(sanitizeForDisplay);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value)
      .filter(([key]) => !/apiKey|api_key|secret|token|password|credential|absolutePath|sourceFolderPath|sqlitePath|dbPath/i.test(key))
      .map(([key, item]) => [key, sanitizeForDisplay(item)]));
  }
  if (typeof value === 'string') return safeText(value);
  return value;
}

function cloneReport(report = {}) {
  return JSON.parse(JSON.stringify(report || {}));
}

function normalizeManualAcceptance(patch = {}, current = {}) {
  return {
    status: ['pending', 'passed', 'failed', 'blocked'].includes(patch.status) ? patch.status : current.status || 'pending',
    reviewer: safeText(patch.reviewer ?? current.reviewer ?? ''),
    checkedAt: safeText(patch.checkedAt ?? current.checkedAt ?? ''),
    notes: safeText(patch.notes ?? current.notes ?? '')
  };
}

export function applySkuManualAcceptance(report = {}, skuOrTaskId = '', patch = {}) {
  const next = cloneReport(report);
  next.skuAcceptance = asArray(next.skuAcceptance).map((sku) => {
    if (sku.sku !== skuOrTaskId && sku.taskId !== skuOrTaskId) return sku;
    return {
      ...sku,
      manualAcceptance: normalizeManualAcceptance(patch, sku.manualAcceptance || {})
    };
  });
  return next;
}

export function applyModuleManualAcceptance(report = {}, moduleKey = '', patch = {}) {
  const next = cloneReport(report);
  next.moduleAcceptance = asArray(next.moduleAcceptance).map((module) => {
    if (module.moduleKey !== moduleKey) return module;
    return {
      ...module,
      manualAcceptance: normalizeManualAcceptance(patch, module.manualAcceptance || {})
    };
  });
  return next;
}

function emptyIssueSummary() {
  return {
    totalIssues: 0,
    blockerCount: 0,
    highCount: 0,
    mediumCount: 0,
    lowCount: 0,
    infoCount: 0,
    openCount: 0,
    fixedCount: 0,
    verifiedCount: 0,
    blockingFinalReleaseCount: 0
  };
}

function normalizeIssueLog(issue = {}, index = 0) {
  const severity = ISSUE_SEVERITIES.includes(issue.severity) ? issue.severity : 'medium';
  const status = ISSUE_STATUSES.includes(issue.status) ? issue.status : 'open';
  const moduleKey = finalAcceptanceIssueModules.includes(issue.moduleKey) ? issue.moduleKey : 'other';
  return {
    issueId: safeText(issue.issueId || `issue-${Date.now()}-${index + 1}`),
    title: safeText(issue.title || ''),
    description: safeText(issue.description || ''),
    relatedSku: safeText(issue.relatedSku || ''),
    relatedTaskId: safeText(issue.relatedTaskId || ''),
    relatedBatchId: safeText(issue.relatedBatchId || ''),
    moduleKey,
    stepKey: safeText(issue.stepKey || ''),
    severity,
    isBlockingFinalRelease: issue.isBlockingFinalRelease === true,
    status,
    reproduceSteps: asArray(issue.reproduceSteps).map(safeText),
    expectedResult: safeText(issue.expectedResult || ''),
    actualResult: safeText(issue.actualResult || ''),
    suggestedFix: safeText(issue.suggestedFix || ''),
    notes: safeText(issue.notes || ''),
    createdAt: safeText(issue.createdAt || ''),
    updatedAt: safeText(issue.updatedAt || '')
  };
}

function issueBlocksFinalRelease(issue = {}) {
  return issue.isBlockingFinalRelease === true && ['open', 'investigating'].includes(issue.status);
}

export function buildFinalAcceptanceIssueSummary(issueLogs = []) {
  const summary = emptyIssueSummary();
  for (const issue of asArray(issueLogs)) {
    summary.totalIssues += 1;
    if (issue.severity === 'blocker') summary.blockerCount += 1;
    else if (issue.severity === 'high') summary.highCount += 1;
    else if (issue.severity === 'medium') summary.mediumCount += 1;
    else if (issue.severity === 'low') summary.lowCount += 1;
    else if (issue.severity === 'info') summary.infoCount += 1;

    if (issue.status === 'open') summary.openCount += 1;
    else if (issue.status === 'fixed') summary.fixedCount += 1;
    else if (issue.status === 'verified') summary.verifiedCount += 1;

    if (issueBlocksFinalRelease(issue)) summary.blockingFinalReleaseCount += 1;
  }
  return summary;
}

function missingAssetWarning({ targetSkuCount = 5, availableSkuCount = 0, missingSkuCount } = {}) {
  const target = Number.isFinite(Number(targetSkuCount)) ? Number(targetSkuCount) : 5;
  const available = Number.isFinite(Number(availableSkuCount)) ? Number(availableSkuCount) : 0;
  const missing = Number.isFinite(Number(missingSkuCount)) ? Number(missingSkuCount) : Math.max(target - available, 0);
  return {
    code: 'MISSING_TEST_ASSET',
    message: `当前可用于最终验收的 SKU 不足 ${target} 个，已生成占位验收项，缺失项保持 missing / pending。`,
    targetSkuCount: target,
    availableSkuCount: available,
    missingSkuCount: missing
  };
}

function normalizeWarnings(warnings = [], meta = {}) {
  const result = [];
  let missingWarning = null;
  for (const warning of asArray(warnings)) {
    if (warning?.code !== 'MISSING_TEST_ASSET') {
      result.push(warning);
      continue;
    }
    const targetSkuCount = Number(warning.targetSkuCount || meta.targetSkuCount || 5);
    const availableSkuCount = Number(warning.availableSkuCount || 0);
    const missingSkuCount = Number(warning.missingSkuCount || Math.max(targetSkuCount - availableSkuCount, 0));
    if (!missingWarning) {
      missingWarning = missingAssetWarning({ targetSkuCount, availableSkuCount, missingSkuCount });
    } else {
      missingWarning = missingAssetWarning({
        targetSkuCount: Math.max(missingWarning.targetSkuCount, targetSkuCount),
        availableSkuCount: Math.min(missingWarning.availableSkuCount, availableSkuCount),
        missingSkuCount: Math.max(missingWarning.missingSkuCount, missingSkuCount)
      });
    }
  }
  if (missingWarning) result.push(missingWarning);
  return result;
}

function withIssueAudit(report = {}) {
  const issueLogs = asArray(report.issueLogs).map((issue, index) => normalizeIssueLog(issue, index));
  const issueSummary = buildFinalAcceptanceIssueSummary(issueLogs);
  const summary = { ...(report.summary || {}) };
  if (issueSummary.blockingFinalReleaseCount > 0 && summary.overallStatus === 'passed') {
    summary.overallStatus = 'partial';
  }
  return {
    ...report,
    summary,
    warnings: normalizeWarnings(report.warnings, report.meta),
    issueLogs,
    issueSummary
  };
}

export function addFinalAcceptanceIssue(report = {}, issue = {}) {
  const now = new Date().toISOString();
  const next = cloneReport(report);
  const issueLogs = asArray(next.issueLogs);
  issueLogs.push(normalizeIssueLog({
    ...issue,
    issueId: issue.issueId || `issue-${Date.now()}`,
    createdAt: issue.createdAt || now,
    updatedAt: issue.updatedAt || now
  }, issueLogs.length));
  return withIssueAudit({ ...next, issueLogs });
}

export function updateFinalAcceptanceIssue(report = {}, issueId = '', patch = {}) {
  const next = cloneReport(report);
  const issueLogs = asArray(next.issueLogs).map((issue, index) => {
    if (issue.issueId !== issueId) return normalizeIssueLog(issue, index);
    return normalizeIssueLog({
      ...issue,
      ...patch,
      issueId,
      updatedAt: patch.updatedAt || new Date().toISOString()
    }, index);
  });
  return withIssueAudit({ ...next, issueLogs });
}

export function deleteFinalAcceptanceIssue(report = {}, issueId = '') {
  const next = cloneReport(report);
  return withIssueAudit({
    ...next,
    issueLogs: asArray(next.issueLogs).filter((issue) => issue.issueId !== issueId)
  });
}

function issueText(items = []) {
  return asArray(items)
    .map((item) => {
      if (typeof item === 'string') return safeText(item);
      const detail = item.code === 'MISSING_TEST_ASSET'
        ? [
          item.targetSkuCount !== undefined ? `目标 SKU 数: ${item.targetSkuCount}` : '',
          item.availableSkuCount !== undefined ? `可用 SKU 数: ${item.availableSkuCount}` : '',
          item.missingSkuCount !== undefined ? `缺失 SKU 数: ${item.missingSkuCount}` : ''
        ].filter(Boolean).join(' / ')
        : '';
      return [item.code, item.sku, item.message, detail].filter(Boolean).map(safeText).join(' - ');
    })
    .filter(Boolean)
    .join(' / ');
}

function stepSummary(steps = []) {
  const counts = asArray(steps).reduce((acc, step) => {
    const key = step.status || 'pending';
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
  return Object.entries(counts).map(([key, value]) => `${key}: ${value}`).join(' / ') || 'pending: 0';
}

export function getFinalAcceptanceDisplayModel(report) {
  if (!report) {
    return {
      emptyText: '暂无最终验收报告。请先生成验收模板，或根据当前数据预填验收报告。',
      notice: finalAcceptanceNotice,
      summaryCards: [],
      skuRows: [],
      moduleRows: [],
      batchRows: [],
      issueRows: [],
      issueSummaryCards: [],
      issueBlockingText: '',
      blockingText: '',
      warningText: '',
      recommendationText: '',
      nextSuggestedAction: ''
    };
  }
  const safe = sanitizeForDisplay(withIssueAudit(report));
  const summary = safe.summary || {};
  const issueSummary = safe.issueSummary || emptyIssueSummary();
  return {
    emptyText: '',
    notice: finalAcceptanceNotice,
    summaryCards: [
      { label: '总 SKU', value: String(summary.totalSku || 0) },
      { label: '已通过', value: String(summary.passedSku || 0) },
      { label: '失败', value: String(summary.failedSku || 0) },
      { label: '待验收', value: String(summary.pendingSku || 0) },
      { label: '阻断项', value: String(summary.blockedSku || 0) },
      { label: 'overallStatus', value: String(summary.overallStatus || 'pending') },
      { label: 'readinessLevel', value: String(summary.readinessLevel || 'local-workbench') }
    ],
    skuRows: asArray(safe.skuAcceptance).map((item) => ({
      ...item,
      stepSummary: stepSummary(item.steps),
      riskText: Object.entries(item.riskSummary || {}).map(([key, value]) => `${key}: ${value}`).join(' / ') || 'unknown'
    })),
    moduleRows: asArray(safe.moduleAcceptance),
    batchRows: asArray(safe.batchAcceptance),
    issueRows: asArray(safe.issueLogs),
    issueSummaryCards: [
      { label: 'totalIssues', value: String(issueSummary.totalIssues || 0) },
      { label: 'blocker', value: String(issueSummary.blockerCount || 0) },
      { label: 'high', value: String(issueSummary.highCount || 0) },
      { label: 'medium', value: String(issueSummary.mediumCount || 0) },
      { label: 'low', value: String(issueSummary.lowCount || 0) },
      { label: 'info', value: String(issueSummary.infoCount || 0) },
      { label: 'blockingFinalRelease', value: String(issueSummary.blockingFinalReleaseCount || 0) }
    ],
    issueBlockingText: issueSummary.blockingFinalReleaseCount > 0
      ? `open blocker issues: ${issueSummary.blockingFinalReleaseCount}`
      : '',
    blockingText: issueText(safe.blockingIssues),
    warningText: issueText(safe.warnings),
    recommendationText: asArray(safe.recommendations).map(safeText).join(' / '),
    nextSuggestedAction: safeText(safe.nextSuggestedAction || '')
  };
}

function csvEscape(value) {
  const text = safeText(value);
  if (/[",\n\r]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

function csvContent(report = {}) {
  const safe = sanitizeForDisplay(withIssueAudit(report || {}));
  const rows = [['reportId', 'sku', 'taskId', 'productName', 'stepKey', 'stepLabel', 'status', 'riskLevel', 'notes', 'nextSuggestedAction', 'manualStatus', 'manualReviewer', 'manualNotes']];
  const reportId = safe.meta?.reportId || '';
  for (const sku of asArray(safe.skuAcceptance)) {
    const riskLevel = sku.riskSummary?.reviewRisk || sku.riskSummary?.recognitionRisk || 'unknown';
    const manual = normalizeManualAcceptance({}, sku.manualAcceptance || {});
    for (const step of asArray(sku.steps)) {
      rows.push([
        reportId,
        sku.sku || '',
        sku.taskId || '',
        sku.productName || '',
        step.stepKey || '',
        step.stepLabel || '',
        step.status || '',
        riskLevel,
        step.notes || sku.manualNotes || '',
        sku.nextSuggestedAction || '',
        manual.status,
        manual.reviewer,
        manual.notes
      ]);
    }
  }
  for (const module of asArray(safe.moduleAcceptance)) {
    const manual = normalizeManualAcceptance({}, module.manualAcceptance || {});
    rows.push([
      reportId,
      `MODULE:${module.moduleKey || ''}`,
      '',
      module.moduleName || '',
      module.moduleKey || '',
      module.moduleName || '',
      module.status || '',
      '',
      module.notes || '',
      '',
      manual.status,
      manual.reviewer,
      manual.notes
    ]);
  }
  if (asArray(safe.issueLogs).length) {
    rows.push([]);
    rows.push(issueCsvHeader());
    for (const issue of asArray(safe.issueLogs)) rows.push(issueCsvRow(issue));
  }
  return rows.map((row) => row.map(csvEscape).join(',')).join('\n');
}

function issueCsvHeader() {
  return ['issueId', 'title', 'severity', 'status', 'isBlockingFinalRelease', 'relatedSku', 'relatedTaskId', 'relatedBatchId', 'moduleKey', 'stepKey', 'description', 'reproduceSteps', 'expectedResult', 'actualResult', 'suggestedFix', 'createdAt', 'updatedAt'];
}

function issueCsvRow(issue = {}) {
  return [
    issue.issueId || '',
    issue.title || '',
    issue.severity || '',
    issue.status || '',
    issue.isBlockingFinalRelease ? 'true' : 'false',
    issue.relatedSku || '',
    issue.relatedTaskId || '',
    issue.relatedBatchId || '',
    issue.moduleKey || '',
    issue.stepKey || '',
    issue.description || '',
    asArray(issue.reproduceSteps).join(' | '),
    issue.expectedResult || '',
    issue.actualResult || '',
    issue.suggestedFix || '',
    issue.createdAt || '',
    issue.updatedAt || ''
  ];
}

function issuesCsvContent(report = {}) {
  const safe = sanitizeForDisplay(withIssueAudit(report || {}));
  const rows = [issueCsvHeader()];
  for (const issue of asArray(safe.issueLogs)) rows.push(issueCsvRow(issue));
  return rows.map((row) => row.map(csvEscape).join(',')).join('\n');
}

function timestampSafe(timestamp) {
  return safeText(timestamp || new Date().toISOString().replace(/[:.]/g, '-'));
}

const REAL_API_IMAGE_TYPES = ['main_image', 'feature_image', 'detail_image'];

export function normalizeRealApiAcceptancePayload(input = {}) {
  const maxRealApiCallsRaw = Number(input.maxRealApiCalls);
  const maxRealApiCalls = Number.isFinite(maxRealApiCallsRaw)
    ? Math.max(1, Math.min(Math.floor(maxRealApiCallsRaw), 3))
    : 3;
  const enableVision = input.enableVision !== false;
  const requestedImageTypes = asArray(input.imageTypes)
    .map((item) => String(item || '').trim())
    .filter((item) => REAL_API_IMAGE_TYPES.includes(item));
  const imageTypes = [...new Set(requestedImageTypes.length ? requestedImageTypes : ['main_image'])];
  const availableSlots = Math.max(maxRealApiCalls - (enableVision ? 1 : 0), 0);
  const limitedImageTypes = imageTypes.slice(0, availableSlots);
  const enableReview = input.enableReview === true &&
    (enableVision ? 1 : 0) + limitedImageTypes.length + 1 <= maxRealApiCalls;
  return {
    taskId: safeText(input.taskId || ''),
    enableVision,
    imageTypes: limitedImageTypes,
    enableReview,
    maxRealApiCalls,
    provider: input.provider || 'openai',
    mattingProvider: 'sharp',
    confirmRealApi: input.confirmRealApi === true,
    confirmPaidApi: input.confirmPaidApi === true,
    confirmNoPlatformUpload: input.confirmNoPlatformUpload === true,
    platformUploadEnabled: false
  };
}

export function canRunRealApiAcceptance(input = {}) {
  const payload = normalizeRealApiAcceptancePayload(input);
  return Boolean(payload.taskId && payload.confirmRealApi && payload.confirmPaidApi && payload.confirmNoPlatformUpload);
}

export function getRealApiAcceptanceDisplayModel(report) {
  if (!report) {
    return {
      emptyText: '暂无 1 SKU 真实 API 验收报告。请先选择 1 个 taskId，并勾选确认后运行。',
      summaryCards: [],
      apiCallRows: [],
      generatedRows: [],
      warningText: '',
      nextSuggestedAction: ''
    };
  }
  const safe = sanitizeForDisplay(report);
  const summary = safe.summary || {};
  return {
    emptyText: '',
    summaryCards: [
      { label: '状态', value: String(summary.overallStatus || 'pending') },
      { label: 'API 调用次数', value: String(summary.realApiCallCount || 0) },
      { label: '真实识别', value: String(summary.realVisionCallCount || 0) },
      { label: '真实生图', value: String(summary.realImageGenerationCallCount || 0) },
      { label: '真实审核', value: String(summary.realReviewCallCount || 0) },
      { label: 'fallback', value: String(summary.fallbackCount || 0) },
      { label: '预估成本', value: String(summary.estimatedCost || 0) }
    ],
    apiCallRows: asArray(safe.apiCalls),
    generatedRows: asArray(safe.generatedOutputs),
    warningText: issueText(safe.warnings),
    nextSuggestedAction: safe.nextSuggestedAction || ''
  };
}

export function buildRealApiAcceptanceJsonDownload({ report, timestamp } = {}) {
  const safe = sanitizeForDisplay(report || {});
  const taskId = safe.meta?.taskId || safe.taskId || 'task';
  return {
    fileName: `real-api-acceptance-report-${safeText(taskId)}-${timestampSafe(timestamp)}.json`,
    mimeType: 'application/json',
    content: JSON.stringify(safe, null, 2)
  };
}

export function finalAcceptanceJson(report) {
  return JSON.stringify(sanitizeForDisplay(withIssueAudit(report || {})), null, 2);
}

export function buildFinalAcceptanceJsonDownload({ report, timestamp } = {}) {
  return {
    fileName: `final-acceptance-report-${timestampSafe(timestamp)}.json`,
    mimeType: 'application/json',
    content: finalAcceptanceJson(report)
  };
}

export function buildFinalAcceptanceCsvDownload({ report, timestamp } = {}) {
  return {
    fileName: `final-acceptance-report-${timestampSafe(timestamp)}.csv`,
    mimeType: 'text/csv',
    content: csvContent(report)
  };
}

export function buildFinalAcceptanceIssuesCsvDownload({ report, timestamp } = {}) {
  return {
    fileName: `final-acceptance-issues-${timestampSafe(timestamp)}.csv`,
    mimeType: 'text/csv',
    content: issuesCsvContent(report)
  };
}

function downloadText({ content, mimeType, fileName }) {
  if (typeof document === 'undefined') return null;
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
  URL.revokeObjectURL(url);
  return { content, mimeType, fileName };
}

export function downloadFinalAcceptanceJson({ report, timestamp } = {}) {
  return downloadText(buildFinalAcceptanceJsonDownload({ report, timestamp }));
}

export function downloadFinalAcceptanceCsv({ report, timestamp } = {}) {
  return downloadText(buildFinalAcceptanceCsvDownload({ report, timestamp }));
}

export function downloadFinalAcceptanceIssuesCsv({ report, timestamp } = {}) {
  return downloadText(buildFinalAcceptanceIssuesCsvDownload({ report, timestamp }));
}

export function downloadRealApiAcceptanceJson({ report, timestamp } = {}) {
  return downloadText(buildRealApiAcceptanceJsonDownload({ report, timestamp }));
}
