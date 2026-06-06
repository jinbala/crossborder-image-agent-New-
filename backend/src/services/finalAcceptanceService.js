import { listBatchTasks, listTasks } from './db.js';
import { buildReviewReport } from './reviewReportService.js';

const DEFAULT_VERSION = 'v6.1-stage1';
const DEFAULT_TARGET_SKU_COUNT = 5;
const V62_VERSION = 'v6.2-stage2';
const ISSUE_SEVERITIES = ['blocker', 'high', 'medium', 'low', 'info'];
const ISSUE_STATUSES = ['open', 'investigating', 'fixed', 'verified', 'wontFix'];
const ISSUE_MODULE_KEYS = [
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

const ACCEPTANCE_STEPS = [
  ['upload', '上传图片'],
  ['recognition', '商品识别'],
  ['productInfoConfirm', '商品信息确认'],
  ['recognitionQuality', '识别质量复查'],
  ['platformRules', '平台规则选择'],
  ['imagePlan', '图片方案生成'],
  ['templateAudit', '模板验收'],
  ['mockGeneration', 'mock 图片生成'],
  ['review', '结构化审核'],
  ['reviewFixSuggestions', '审核修正建议'],
  ['autoFixPlan', '自动修正计划预览'],
  ['lowRiskTextFix', '低风险文字修正保存'],
  ['regenerateMock', '手动重新生成 mock'],
  ['reviewAgain', '再次审核'],
  ['batchStability', '批量稳定性摘要'],
  ['skuRetry', '单 SKU 重试'],
  ['batchResumePlan', '批量恢复计划预览'],
  ['exportPackage', '上架前资料包 ZIP'],
  ['listingCsv', '平台 CSV'],
  ['uploadReadiness', '上传前 dry-run readiness'],
  ['uploadPayloadPreview', '上传 payload preview'],
  ['sandboxSimulation', 'sandbox simulation'],
  ['credentialSafety', '凭据安全检查']
];

const MODULES = [
  ['recognition', '商品识别'],
  ['recognitionQuality', '识别质量复查'],
  ['imagePlan', '图片方案'],
  ['mockGeneration', 'mock 图片生成'],
  ['templateAudit', '模板验收'],
  ['matting', '主体抠图'],
  ['realSampleGeneration', '单 SKU 小样本真实生图'],
  ['reviewReport', '结构化审核报告'],
  ['autoFix', '自动修正'],
  ['batchStability', '批量稳定性'],
  ['skuRetry', '单 SKU 重试'],
  ['exportPackage', '资料包 ZIP'],
  ['listingCsv', '平台 CSV'],
  ['uploadReadiness', '上传前 readiness'],
  ['uploadPayloadPreview', '上传 Payload 预览'],
  ['credentialSafety', '凭据安全检查'],
  ['cleanup', '数据清理'],
  ['snapshot', '备份快照'],
  ['healthCheck', '系统诊断']
];

const SECRET_PATTERNS = [
  [/\b[A-Z0-9_]*API[_-]?KEY\b\s*[:=]\s*[^\s"',，。；;]+/gi, '[credential removed]'],
  [/\b(?:sk|rk|ak)-[A-Za-z0-9_-]{6,}\b/gi, '[credential removed]'],
  [/\b(provider secret|provider credential|platform token|Temu token|Miaoshou token|Amazon token)\b/gi, '[credential removed]'],
  [/[A-Z]:\\[^\s"',，。；;]+/gi, '[local path removed]'],
  [/\.env(?:\.[\w.-]+)?/gi, '[env file removed]'],
  [/\b[\w.-]*\.sqlite\b/gi, '[sqlite path removed]'],
  [/\bnode_modules\b/gi, '[node modules removed]']
];

function nowIso() {
  return new Date().toISOString();
}

function timestampSafe(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, '-');
}

function asArray(value) {
  return Array.isArray(value) ? value.filter((item) => item !== undefined && item !== null) : [];
}

function nonEmpty(value) {
  if (Array.isArray(value)) return value.some(nonEmpty);
  return value !== undefined && value !== null && String(value).trim() !== '';
}

function sanitizeText(value) {
  let text = String(value ?? '');
  for (const [pattern, replacement] of SECRET_PATTERNS) text = text.replace(pattern, replacement);
  return text;
}

function sanitizeValue(value) {
  if (Array.isArray(value)) return value.map(sanitizeValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value)
      .filter(([key]) => !/apiKey|api_key|secret|token|password|credential|absolutePath|sourceFolderPath|sqlitePath|dbPath/i.test(key))
      .map(([key, item]) => [key, sanitizeValue(item)]));
  }
  if (typeof value === 'string') return sanitizeText(value);
  return value;
}

function normalizeAcceptanceOptions(options = {}) {
  const targetSkuCount = Number(options.targetSkuCount);
  const version = options.version === V62_VERSION ? V62_VERSION : DEFAULT_VERSION;
  const multiBatch = options.multiBatch === true || options.multiBatch === 'true';
  return {
    version,
    targetSkuCount: Number.isFinite(targetSkuCount) && targetSkuCount > 0
      ? Math.min(Math.floor(targetSkuCount), 50)
      : DEFAULT_TARGET_SKU_COUNT,
    multiBatch
  };
}

function manualAcceptance(overrides = {}) {
  return {
    status: ['pending', 'passed', 'failed', 'blocked'].includes(overrides.status) ? overrides.status : 'pending',
    reviewer: sanitizeText(overrides.reviewer || ''),
    checkedAt: sanitizeText(overrides.checkedAt || ''),
    notes: sanitizeText(overrides.notes || '')
  };
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
  const moduleKey = ISSUE_MODULE_KEYS.includes(issue.moduleKey) ? issue.moduleKey : 'other';
  return {
    issueId: sanitizeText(issue.issueId || `issue-${index + 1}`),
    title: sanitizeText(issue.title || ''),
    description: sanitizeText(issue.description || ''),
    relatedSku: sanitizeText(issue.relatedSku || ''),
    relatedTaskId: sanitizeText(issue.relatedTaskId || ''),
    relatedBatchId: sanitizeText(issue.relatedBatchId || ''),
    moduleKey,
    stepKey: sanitizeText(issue.stepKey || ''),
    severity,
    isBlockingFinalRelease: issue.isBlockingFinalRelease === true,
    status,
    reproduceSteps: asArray(issue.reproduceSteps).map(sanitizeText),
    expectedResult: sanitizeText(issue.expectedResult || ''),
    actualResult: sanitizeText(issue.actualResult || ''),
    suggestedFix: sanitizeText(issue.suggestedFix || ''),
    notes: sanitizeText(issue.notes || ''),
    createdAt: sanitizeText(issue.createdAt || ''),
    updatedAt: sanitizeText(issue.updatedAt || '')
  };
}

function issueBlocksFinalRelease(issue = {}) {
  return issue.isBlockingFinalRelease === true && ['open', 'investigating'].includes(issue.status);
}

function buildIssueSummary(issueLogs = []) {
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

function missingAssetWarning({ targetSkuCount = DEFAULT_TARGET_SKU_COUNT, availableSkuCount = 0, missingSkuCount } = {}) {
  const target = Number.isFinite(Number(targetSkuCount)) ? Number(targetSkuCount) : DEFAULT_TARGET_SKU_COUNT;
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
    const targetSkuCount = Number(warning.targetSkuCount || meta.targetSkuCount || DEFAULT_TARGET_SKU_COUNT);
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
  const issueSummary = buildIssueSummary(issueLogs);
  const summary = { ...(report.summary || {}) };
  if (issueSummary.blockingFinalReleaseCount > 0 && summary.overallStatus === 'passed') {
    summary.overallStatus = 'partial';
  }
  return {
    ...report,
    summary,
    warnings: normalizeWarnings(report.warnings, report.meta),
    issueSummary,
    issueLogs
  };
}

function statusStep(stepKey, status, notes = '', evidence = []) {
  const step = ACCEPTANCE_STEPS.find(([key]) => key === stepKey);
  return {
    stepKey,
    stepLabel: step?.[1] || stepKey,
    status,
    notes,
    evidence: asArray(evidence)
  };
}

function pendingSteps() {
  return ACCEPTANCE_STEPS.map(([stepKey, stepLabel]) => ({
    stepKey,
    stepLabel,
    status: 'pending',
    notes: '',
    evidence: []
  }));
}

function productInfo(task = {}) {
  return task.productInfoConfirmed || task.productInfo || {};
}

function productName(task = {}) {
  const info = productInfo(task);
  return info.name || info.productName || task.title || '';
}

function skuValue(task = {}) {
  return productInfo(task).sku || task.sku || task.id || '';
}

function hasUploadedImages(task = {}) {
  return Boolean(task.originalImage || asArray(task.sourceImages).length || asArray(task.images).length);
}

function hasReviewFatalOrHigh(task = {}) {
  const report = buildReviewReport(task);
  return Boolean(report.summary?.fatalCount || report.summary?.highCount);
}

function reviewStep(task = {}) {
  if (!task.review) return statusStep('review', 'pending', '尚未发现审核报告，不能标记为 passed。');
  if (task.review.overallStatus === 'failed' || hasReviewFatalOrHigh(task)) {
    return statusStep('review', 'failed', '审核存在 failed / fatal / high 风险，需要人工处理。');
  }
  if (task.review.overallStatus === 'passed') return statusStep('review', 'passed', '已存在结构化审核报告。');
  return statusStep('review', 'pending', '审核状态未明确通过。');
}

function taskStepMap(task = {}, batch = {}) {
  const review = reviewStep(task);
  const generatedImages = asArray(task.generatedImages);
  const mockImages = generatedImages.filter((image) => image.isMockPreview || image.provider === 'mock');
  const uploadReadiness = task.uploadReadinessReport || batch.uploadReadinessReport;
  const payloadPreview = task.uploadPayloadPreview || batch.uploadPayloadPreview;
  const sandboxReport = task.uploadSandboxReport || batch.uploadSandboxReport;
  const safetyReport = task.uploadSafetyReport || batch.uploadSafetyReport || task.credentialSafetyReport || batch.credentialSafetyReport;

  return new Map([
    ['upload', statusStep('upload', hasUploadedImages(task) ? 'passed' : 'pending', hasUploadedImages(task) ? '已发现上传源图。' : '缺少上传源图。')],
    ['recognition', statusStep('recognition', nonEmpty(task.productInfoRaw || task.productInfo) ? 'passed' : 'pending', nonEmpty(task.productInfoRaw || task.productInfo) ? '已发现识别结果。' : '缺少识别结果。')],
    ['productInfoConfirm', statusStep('productInfoConfirm', nonEmpty(task.productInfoConfirmed) ? 'passed' : 'pending', nonEmpty(task.productInfoConfirmed) ? '已发现确认后的商品信息。' : '缺少确认后的商品信息。')],
    ['recognitionQuality', statusStep('recognitionQuality', nonEmpty(task.recognitionQuality) ? 'passed' : 'pending', nonEmpty(task.recognitionQuality) ? '已发现识别质量复查报告。' : '缺少识别质量复查报告。')],
    ['platformRules', statusStep('platformRules', asArray(task.targets).length || task.platformId ? 'passed' : 'pending', '按当前任务平台规则数据自动预填。')],
    ['imagePlan', statusStep('imagePlan', asArray(task.imagePlans).length ? 'passed' : 'pending', asArray(task.imagePlans).length ? '已发现图片方案。' : '缺少图片方案。')],
    ['templateAudit', statusStep('templateAudit', nonEmpty(task.templateAudit) ? 'passed' : 'pending', nonEmpty(task.templateAudit) ? '已发现模板验收数据。' : '缺少模板验收数据。')],
    ['mockGeneration', statusStep('mockGeneration', mockImages.length ? 'passed' : 'pending', mockImages.length ? '已发现 mock 图片。' : '缺少 mock 图片。')],
    ['review', review],
    ['reviewFixSuggestions', statusStep('reviewFixSuggestions', task.review ? 'passed' : 'pending', task.review ? '可从结构化审核报告生成修正建议。' : '缺少审核报告。')],
    ['autoFixPlan', statusStep('autoFixPlan', nonEmpty(task.autoFixPlan) ? 'passed' : 'pending', '未发现自动修正计划则保持 pending。')],
    ['lowRiskTextFix', statusStep('lowRiskTextFix', nonEmpty(task.autoFixExecution) ? 'passed' : 'pending', '未发现已保存的低风险文字修正。')],
    ['regenerateMock', statusStep('regenerateMock', generatedImages.some((image) => Number(image.version || 1) > 1) ? 'passed' : 'pending', '未发现手动重新生成记录。')],
    ['reviewAgain', statusStep('reviewAgain', Number(task.review?.reviewCount || 0) > 1 ? 'passed' : 'pending', '未发现再次审核记录。')],
    ['batchStability', statusStep('batchStability', nonEmpty(batch.stabilityReport || batch.batchStabilityReport) ? 'passed' : 'pending', '批量稳定性为 batch 级验收。')],
    ['skuRetry', statusStep('skuRetry', nonEmpty(task.skuRetryResult || batch.skuRetryResults) ? 'passed' : 'pending', '未发现单 SKU 重试记录。')],
    ['batchResumePlan', statusStep('batchResumePlan', nonEmpty(batch.resumePlan || batch.batchResumePlan) ? 'passed' : 'pending', '未发现批量恢复计划。')],
    ['exportPackage', statusStep('exportPackage', nonEmpty(task.exportPackage || task.exportPackages || batch.exportPackageResult) ? 'passed' : 'pending', '未发现资料包导出记录。')],
    ['listingCsv', statusStep('listingCsv', nonEmpty(task.listingCsvExport || task.listingCsvExports || batch.listingCsvResult) ? 'passed' : 'pending', '未发现 CSV 导出记录。')],
    ['uploadReadiness', statusStep('uploadReadiness', nonEmpty(uploadReadiness) ? (uploadReadiness.summary?.blockedSku > 0 ? 'blocked' : 'passed') : 'pending', '按上传前 readiness 报告自动预填。')],
    ['uploadPayloadPreview', statusStep('uploadPayloadPreview', nonEmpty(payloadPreview) ? 'passed' : 'pending', '未发现上传 payload preview。')],
    ['sandboxSimulation', statusStep('sandboxSimulation', nonEmpty(sandboxReport) ? (sandboxReport.summary?.blockedPayloads > 0 ? 'blocked' : 'passed') : 'pending', '未发现 sandbox simulation。')],
    ['credentialSafety', statusStep('credentialSafety', nonEmpty(safetyReport) ? 'passed' : 'pending', '未发现凭据安全检查报告。')]
  ]);
}

function riskFromStep(status) {
  if (status === 'failed' || status === 'blocked') return 'high';
  if (status === 'pending' || status === 'skipped') return 'unknown';
  return 'low';
}

function buildSkuAcceptanceFromTask(task = {}, batch = {}) {
  const stepMap = taskStepMap(task, batch);
  const steps = ACCEPTANCE_STEPS.map(([key]) => stepMap.get(key) || statusStep(key, 'pending'));
  const blocking = steps.some((step) => ['failed', 'blocked'].includes(step.status));
  const allPassed = steps.every((step) => step.status === 'passed');
  const review = steps.find((step) => step.stepKey === 'review');

  return {
    sku: skuValue(task),
    taskId: task.id || '',
    batchId: batch.id || task.batchId || '',
    batchName: batch.name || '',
    productName: productName(task),
    testAssetStatus: hasUploadedImages(task) ? 'available' : 'pending',
    overallStatus: blocking ? 'blocked' : allPassed ? 'passed' : 'pending',
    steps,
    riskSummary: {
      recognitionRisk: riskFromStep(steps.find((step) => step.stepKey === 'recognition')?.status),
      templateRisk: riskFromStep(steps.find((step) => step.stepKey === 'templateAudit')?.status),
      reviewRisk: riskFromStep(review?.status),
      exportRisk: riskFromStep(steps.find((step) => step.stepKey === 'exportPackage')?.status),
      uploadDryRunRisk: riskFromStep(steps.find((step) => step.stepKey === 'uploadReadiness')?.status)
    },
    manualNotes: '',
    manualAcceptance: manualAcceptance(task.finalAcceptanceManual || task.manualAcceptance || {}),
    nextSuggestedAction: blocking
      ? '请先处理 failed / blocked 步骤，再继续最终验收。'
      : allPassed ? '可以进入人工复核结论。' : '请继续补齐 pending 步骤，不要将缺失数据标记为 passed。'
  };
}

function placeholderSku(index, missing = false) {
  return {
    sku: `ACCEPTANCE-SKU-${index + 1}`,
    taskId: '',
    productName: '',
    testAssetStatus: missing ? 'missing' : 'pending',
    overallStatus: 'pending',
    steps: pendingSteps(),
    riskSummary: {
      recognitionRisk: 'unknown',
      templateRisk: 'unknown',
      reviewRisk: 'unknown',
      exportRisk: 'unknown',
      uploadDryRunRisk: 'unknown'
    },
    manualNotes: '',
    manualAcceptance: manualAcceptance(),
    nextSuggestedAction: missing ? '缺少测试素材，请补充 SKU 后再验收。' : '请按步骤完成人工验收。'
  };
}

function moduleStatus(moduleKey, skuAcceptance = []) {
  const mappedStep = {
    recognition: 'recognition',
    recognitionQuality: 'recognitionQuality',
    imagePlan: 'imagePlan',
    mockGeneration: 'mockGeneration',
    templateAudit: 'templateAudit',
    reviewReport: 'review',
    autoFix: 'autoFixPlan',
    batchStability: 'batchStability',
    skuRetry: 'skuRetry',
    exportPackage: 'exportPackage',
    listingCsv: 'listingCsv',
    uploadReadiness: 'uploadReadiness',
    uploadPayloadPreview: 'uploadPayloadPreview',
    credentialSafety: 'credentialSafety'
  }[moduleKey];
  if (!mappedStep) return 'pending';
  const statuses = skuAcceptance.flatMap((sku) => sku.steps.filter((step) => step.stepKey === mappedStep).map((step) => step.status));
  if (!statuses.length) return 'pending';
  if (statuses.some((status) => ['failed', 'blocked'].includes(status))) return 'failed';
  if (statuses.some((status) => status === 'passed')) return statuses.every((status) => status === 'passed') ? 'passed' : 'partial';
  return 'pending';
}

function buildModuleAcceptance(skuAcceptance = []) {
  return MODULES.map(([moduleKey, moduleName]) => ({
    moduleKey,
    moduleName,
    status: moduleStatus(moduleKey, skuAcceptance),
    lastCheckedAt: '',
    issues: [],
    notes: '',
    manualAcceptance: manualAcceptance()
  }));
}

function summaryFor(skuAcceptance = []) {
  const passedSku = skuAcceptance.filter((item) => item.overallStatus === 'passed').length;
  const failedSku = skuAcceptance.filter((item) => item.overallStatus === 'failed').length;
  const blockedSku = skuAcceptance.filter((item) => item.overallStatus === 'blocked').length;
  const pendingSku = skuAcceptance.filter((item) => item.overallStatus === 'pending').length;
  const completedSku = passedSku;
  let overallStatus = 'pending';
  if (passedSku === skuAcceptance.length && skuAcceptance.length) overallStatus = 'passed';
  else if (failedSku || blockedSku) overallStatus = 'partial';
  else if (passedSku) overallStatus = 'partial';

  return {
    totalSku: skuAcceptance.length,
    completedSku,
    passedSku,
    failedSku,
    pendingSku,
    blockedSku,
    overallStatus,
    readinessLevel: 'local-workbench'
  };
}

function buildBatchAcceptance(batches = [], skuAcceptance = []) {
  const byBatch = new Map();
  for (const sku of skuAcceptance) {
    if (!sku.batchId) continue;
    const existing = byBatch.get(sku.batchId) || {
      batchId: sku.batchId,
      batchName: sku.batchName || '',
      skuCount: 0,
      passedSku: 0,
      failedSku: 0,
      pendingSku: 0,
      blockedSku: 0
    };
    existing.skuCount += 1;
    if (sku.overallStatus === 'passed') existing.passedSku += 1;
    else if (sku.overallStatus === 'failed') existing.failedSku += 1;
    else if (sku.overallStatus === 'blocked') existing.blockedSku += 1;
    else existing.pendingSku += 1;
    byBatch.set(sku.batchId, existing);
  }

  return [...byBatch.values()].map((batchRow) => {
    const batch = asArray(batches).find((item) => item.id === batchRow.batchId) || {};
    const status = batchRow.failedSku || batchRow.blockedSku
      ? 'partial'
      : batchRow.passedSku === batchRow.skuCount && batchRow.skuCount ? 'passed' : 'pending';
    return {
      ...batchRow,
      batchName: batchRow.batchName || batch.name || '',
      status,
      notes: '',
      manualAcceptance: manualAcceptance(batch.finalAcceptanceManual || batch.manualAcceptance || {})
    };
  });
}

function baseReport(skuAcceptance = [], extra = {}) {
  const options = normalizeAcceptanceOptions(extra.options || {});
  const reportId = extra.reportId || `final-acceptance-${timestampSafe()}`;
  const warnings = asArray(extra.warnings);
  return sanitizeValue(withIssueAudit({
    meta: {
      reportId,
      generatedAt: nowIso(),
      version: options.version,
      mode: options.multiBatch ? 'manual-acceptance-multi-batch' : 'manual-acceptance',
      target: 'local-workstation',
      targetSkuCount: options.targetSkuCount,
      multiBatch: options.multiBatch
    },
    summary: summaryFor(skuAcceptance),
    checklist: ACCEPTANCE_STEPS.map(([stepKey, stepLabel]) => ({ stepKey, stepLabel, status: 'pending' })),
    skuAcceptance,
    moduleAcceptance: buildModuleAcceptance(skuAcceptance),
    batchAcceptance: options.multiBatch ? asArray(extra.batchAcceptance) : [],
    blockingIssues: asArray(extra.blockingIssues),
    warnings,
    recommendations: [
      '请按 SKU 逐项完成人工验收，不要把 pending / missing 数据标记为 passed。',
      '全部通过后，再考虑真实沙盒 API 接入。'
    ],
    nextSuggestedAction: '请按 SKU 逐项完成验收，全部通过后再考虑真实沙盒 API。',
    issueLogs: asArray(extra.issueLogs)
  }));
}

export function buildFinalAcceptanceTemplate(options = {}) {
  const normalized = normalizeAcceptanceOptions(options);
  return baseReport(Array.from({ length: normalized.targetSkuCount }, (_, index) => placeholderSku(index)), {
    options: normalized,
    batchAcceptance: []
  });
}

function batchByTaskId(batches = []) {
  const map = new Map();
  for (const batch of batches) {
    for (const skuTask of asArray(batch.skuTasks)) {
      if (skuTask.taskId) map.set(skuTask.taskId, batch);
    }
  }
  return map;
}

export async function buildFinalAcceptanceReport(options = {}) {
  const normalized = normalizeAcceptanceOptions(options);
  const [tasks, batches] = await Promise.all([listTasks(), listBatchTasks()]);
  const batchMap = batchByTaskId(batches);
  const selectedTasks = asArray(tasks).slice(0, normalized.targetSkuCount);
  const availableSkuCount = selectedTasks.length;
  const skuAcceptance = selectedTasks.map((task) => buildSkuAcceptanceFromTask(task, batchMap.get(task.id) || {}));
  const warnings = [];
  while (skuAcceptance.length < normalized.targetSkuCount) {
    skuAcceptance.push(placeholderSku(skuAcceptance.length, true));
  }
  if (availableSkuCount < normalized.targetSkuCount) {
    warnings.push(missingAssetWarning({
      targetSkuCount: normalized.targetSkuCount,
      availableSkuCount,
      missingSkuCount: normalized.targetSkuCount - availableSkuCount
    }));
  }
  const blockingIssues = skuAcceptance
    .filter((sku) => sku.overallStatus === 'blocked')
    .map((sku) => ({ code: 'SKU_BLOCKED', sku: sku.sku, message: '该 SKU 存在 failed / blocked 验收步骤。' }));
  return baseReport(skuAcceptance, {
    options: normalized,
    warnings,
    blockingIssues,
    batchAcceptance: normalized.multiBatch ? buildBatchAcceptance(batches, skuAcceptance) : []
  });
}

function csvEscape(value) {
  const text = sanitizeText(value);
  if (/[",\n\r]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

function csvRows(report = {}) {
  const reportId = report.meta?.reportId || '';
  const normalizedReport = withIssueAudit(report);
  const rows = [['reportId', 'sku', 'taskId', 'productName', 'stepKey', 'stepLabel', 'status', 'riskLevel', 'notes', 'nextSuggestedAction', 'manualStatus', 'manualReviewer', 'manualNotes']];
  for (const sku of asArray(normalizedReport.skuAcceptance)) {
    const riskLevel = sku.riskSummary?.reviewRisk || sku.riskSummary?.recognitionRisk || 'unknown';
    const manual = manualAcceptance(sku.manualAcceptance || {});
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
  for (const module of asArray(normalizedReport.moduleAcceptance)) {
    const manual = manualAcceptance(module.manualAcceptance || {});
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
  if (asArray(normalizedReport.issueLogs).length) {
    rows.push([]);
    rows.push(['issueId', 'title', 'severity', 'status', 'isBlockingFinalRelease', 'relatedSku', 'relatedTaskId', 'relatedBatchId', 'moduleKey', 'stepKey', 'description', 'reproduceSteps', 'expectedResult', 'actualResult', 'suggestedFix', 'createdAt', 'updatedAt']);
    for (const issue of normalizedReport.issueLogs) {
      rows.push([
        issue.issueId,
        issue.title,
        issue.severity,
        issue.status,
        issue.isBlockingFinalRelease ? 'true' : 'false',
        issue.relatedSku,
        issue.relatedTaskId,
        issue.relatedBatchId,
        issue.moduleKey,
        issue.stepKey,
        issue.description,
        asArray(issue.reproduceSteps).join(' | '),
        issue.expectedResult,
        issue.actualResult,
        issue.suggestedFix,
        issue.createdAt,
        issue.updatedAt
      ]);
    }
  }
  return rows.map((row) => row.map(csvEscape).join(',')).join('\n');
}

export function exportFinalAcceptanceReport(report = {}, { format = 'json', timestamp } = {}) {
  const safeTimestamp = sanitizeText(timestamp || timestampSafe());
  const safeReport = sanitizeValue(withIssueAudit(report || {}));
  if (format === 'csv') {
    return {
      fileName: `final-acceptance-report-${safeTimestamp}.csv`,
      mimeType: 'text/csv',
      content: csvRows(safeReport)
    };
  }
  return {
    fileName: `final-acceptance-report-${safeTimestamp}.json`,
    mimeType: 'application/json',
    content: JSON.stringify(safeReport, null, 2)
  };
}
