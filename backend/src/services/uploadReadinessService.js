import { getBatchTask, getTask } from './db.js';
import {
  asArray,
  sanitizeValue,
  sourceTypeForImage,
  skuValue
} from './exportManifestService.js';
import { buildReviewReport } from './reviewReportService.js';
import { getUploadProvider, normalizeUploadPlatforms } from './uploadProviderService.js';

const SUCCESS_IMAGE_STATUSES = new Set(['succeeded', 'success', 'completed']);
const GALLERY_IMAGE_TYPES = [
  'feature_image',
  'size_image',
  'compatibility_image',
  'package_image',
  'lifestyle_image',
  'detail_image',
  'variant_image'
];

const UPLOAD_SECRET_PATTERNS = [
  [/\b[A-Z0-9_]*API[_-]?KEY\b\s*[:=]\s*[^\s"',，。；;]+/gi, '[credential-removed]'],
  [/\b(provider[_-]?credential|provider[_-]?secret|api[_-]?key|secret|token|password|account)\b\s*[:=]\s*[^\s"',，。；;]+/gi, '[credential-removed]'],
  [/\b(?:sk|rk|ak)-[A-Za-z0-9_-]{6,}\b/gi, '[credential-removed]'],
  [/sk-/gi, '[id-prefix-removed]'],
  [/\b(token|secret|account)\b/gi, '[credential-removed]'],
  [/[A-Z]:\\[^\s"',，。；;]+/gi, '[local-path-removed]'],
  [/\.env(?:\.[\w.-]+)?/gi, '[env-file-removed]'],
  [/\b[\w.-]*\.sqlite\b/gi, '[sqlite-path-removed]'],
  [/\bnode_modules\b/gi, '[node-modules-removed]']
];

function nowIso() {
  return new Date().toISOString();
}

function timestampSafe(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, '-');
}

function sanitizeUploadText(value) {
  let text = String(value ?? '');
  for (const [pattern, replacement] of UPLOAD_SECRET_PATTERNS) {
    text = text.replace(pattern, replacement);
  }
  return text;
}

function sanitizeUploadValue(value) {
  if (Array.isArray(value)) return value.map(sanitizeUploadValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value)
      .filter(([key]) => !/apiKey|api_key|secret|token|password|absolutePath|sourceFolderPath|sqlitePath|dbPath|platformAccount|account/i.test(key))
      .map(([key, item]) => [key, sanitizeUploadValue(item)]));
  }
  if (typeof value === 'string') return sanitizeUploadText(sanitizeValue(value));
  return sanitizeValue(value);
}

function sandboxConfigSummary(sandboxConfig = {}, platforms = []) {
  const items = platforms.map((platformId) => {
    const config = sandboxConfig?.[platformId] || {};
    const values = Object.values(config).filter((value) => value !== undefined && value !== null && String(value).trim() !== '');
    const credentialProvided = Object.entries(config).some(([key, value]) => (
      /credential|apiKey|api_key|token|secret|password/i.test(key) &&
      value !== undefined &&
      value !== null &&
      String(value).trim() !== ''
    ));
    return {
      platformId,
      configured: values.length > 0,
      credentialProvided,
      storageScope: 'clientLocalOnly',
      mode: 'sandboxDryRun'
    };
  });
  return {
    configuredPlatforms: items.filter((item) => item.configured).length,
    platforms: items
  };
}

async function requireBatch(batchId) {
  const batch = await getBatchTask(batchId);
  if (!batch) {
    const error = new Error('Batch task not found');
    error.statusCode = 404;
    throw error;
  }
  return batch;
}

async function tasksForBatch(batch = {}) {
  const tasks = [];
  for (const skuTask of asArray(batch.skuTasks)) {
    if (!skuTask.taskId) continue;
    const task = await getTask(skuTask.taskId);
    if (task) tasks.push(task);
  }
  return tasks;
}

function imageTypeOf(image = {}) {
  return image.imageType || image.type || image.mockPreview?.type || image.mockPreview?.template?.templateType || '';
}

function imagePlatformOf(image = {}, task = {}) {
  return String(image.platformId || image.platform || task.platformId || task.platform || '').toLowerCase();
}

function usableImages(task = {}, platformId = '') {
  return asArray(task.generatedImages).filter((image) => {
    if (image.status && !SUCCESS_IMAGE_STATUSES.has(image.status)) return false;
    const imagePlatform = imagePlatformOf(image, task);
    return imagePlatform === platformId || (platformId === 'miaoshou' && imagePlatform);
  });
}

function hasImage(task, platformId, imageType) {
  return usableImages(task, platformId).some((image) => imageTypeOf(image) === imageType);
}

function hasGalleryImage(task, platformId) {
  return usableImages(task, platformId).some((image) => GALLERY_IMAGE_TYPES.includes(imageTypeOf(image)));
}

function usesMockImages(task, platformId) {
  return usableImages(task, platformId).some((image) => sourceTypeForImage(image) === 'mock');
}

function productInfo(task = {}) {
  return task.productInfoConfirmed || task.productInfo || {};
}

function nonEmpty(value) {
  if (Array.isArray(value)) return value.some(nonEmpty);
  return value !== undefined && value !== null && String(value).trim() !== '';
}

function fieldValue(task = {}, field = '') {
  const info = productInfo(task);
  if (field === 'product_name' || field === 'product_title' || field === 'product_name_or_title') {
    return info.name || info.productName || info.product_title || info.productTitle || task.title || '';
  }
  if (field === 'category') return info.category || task.categoryId || task.category || '';
  if (field === 'sku') return info.sku || task.sku || '';
  if (field === 'product_description') return info.description || '';
  if (field === 'selling_point_1') return asArray(info.sellingPoints)[0] || '';
  return info[field];
}

function reviewStatus(task = {}) {
  if (!task || !task.review) return 'noReview';
  if (task.review.overallStatus === 'failed') return 'failed';
  if (task.review.overallStatus === 'passed') return 'passed';
  return task.review.overallStatus || 'reviewed';
}

function highRiskStatus(task = {}) {
  const report = buildReviewReport(task);
  return Boolean(
    report.summary?.fatalCount ||
    report.summary?.highCount ||
    asArray(task.review?.items).some((item) => asArray(item.issues).some((issue) => ['fatal', 'high'].includes(issue.severity)))
  );
}

function missingForProvider({ provider, task, skuTask, platformId }) {
  const missingFields = [];
  const missingImages = [];
  for (const field of provider.requiredFields || []) {
    if (field === 'main_image') {
      if (!hasImage(task, platformId, 'main_image')) {
        missingFields.push(field);
        missingImages.push('main_image');
      }
      continue;
    }
    if (field === 'gallery_image_1') {
      if (!hasGalleryImage(task, platformId)) {
        missingFields.push(field);
        missingImages.push('gallery_image_1');
      }
      continue;
    }
    if (field === 'listing_csv_row') {
      missingFields.push(field);
      continue;
    }
    if (!nonEmpty(fieldValue({ ...task, sku: task.sku || skuTask.skuId }, field))) missingFields.push(field);
  }
  return {
    missingFields: [...new Set(missingFields)],
    missingImages: [...new Set(missingImages)]
  };
}

function qualityWarnings(task = {}) {
  const quality = task.recognitionQuality || {};
  const warnings = [];
  const riskFields = [
    ...asArray(quality.blockedHighRiskFields),
    ...asArray(quality.blockedHighRisk),
    ...asArray(quality.missingEvidenceFields),
    ...asArray(quality.conflictFields),
    ...asArray(quality.inferredOnlyFields)
  ];
  if (riskFields.length) {
    warnings.push({
      code: 'RECOGNITION_QUALITY_WARNING',
      message: '识别质量复查存在缺证据、冲突或仅 AI 推测字段，上传前需要人工复核。',
      fields: riskFields.map((item) => typeof item === 'string' ? item : item?.field).filter(Boolean)
    });
  }
  return warnings;
}

function blockingIssue(code, message, extra = {}) {
  return sanitizeUploadValue({ code, message, ...extra });
}

function skuReportFor({ batch, skuTask, task, provider, platformId }) {
  const sku = skuValue(task, skuTask);
  const taskMissing = !task || !task.id;
  const failedSku = skuTask.status === 'failed';
  const missing = taskMissing
    ? { missingFields: provider.requiredFields || [], missingImages: provider.requiredImages || [] }
    : missingForProvider({ provider, task, skuTask, platformId });
  const status = taskMissing ? 'missingTask' : reviewStatus(task);
  const hasHighRiskIssues = taskMissing ? false : highRiskStatus(task);
  const blockingIssues = [];
  const warnings = [];

  if (provider.placeholder) {
    warnings.push(blockingIssue(
      'PLACEHOLDER_PROVIDER',
      `${provider.platformName} 目前只保留占位检查，不能作为可上传结论。`,
      { platformId }
    ));
  }
  if (taskMissing) {
    blockingIssues.push(blockingIssue('MISSING_TASK', 'SKU 任务不存在，不能进入平台交接。', { sku, platformId }));
  }
  if (failedSku) {
    blockingIssues.push(blockingIssue('FAILED_SKU', 'SKU 当前批量状态为失败，需要先处理失败原因。', {
      sku,
      platformId,
      failedStep: skuTask.currentStep || skuTask.status || 'unknown',
      errorMessage: skuTask.error?.message || skuTask.error || ''
    }));
  }
  if (status === 'noReview') blockingIssues.push(blockingIssue('NO_REVIEW', 'SKU 尚未审核，不能进入上传准备。', { sku, platformId }));
  if (status === 'failed') blockingIssues.push(blockingIssue('REVIEW_FAILED', 'SKU 审核未通过，不能进入上传准备。', { sku, platformId }));
  if (hasHighRiskIssues) blockingIssues.push(blockingIssue('HIGH_RISK_REVIEW_ISSUE', 'SKU 存在 high/fatal 审核风险，需要人工处理。', { sku, platformId }));
  if (missing.missingFields.length) {
    blockingIssues.push(blockingIssue('MISSING_REQUIRED_FIELD', '缺少平台必填字段。', {
      sku,
      platformId,
      fields: missing.missingFields
    }));
  }
  if (missing.missingImages.length) {
    blockingIssues.push(blockingIssue('MISSING_REQUIRED_IMAGE', '缺少平台必需图片。', {
      sku,
      platformId,
      images: missing.missingImages
    }));
  }
  if (!taskMissing && usesMockImages(task, platformId)) {
    warnings.push(blockingIssue('MOCK_IMAGE_WARNING', '当前包含 mock 图片，只能用于人工验收，不能作为真实上架素材。', { sku, platformId }));
  }
  if (!taskMissing) warnings.push(...qualityWarnings(task));

  const reportStatus = blockingIssues.length ? 'blocked' : warnings.length ? 'warning' : 'ready';
  return sanitizeUploadValue({
    sku,
    taskId: task?.id || skuTask.taskId || '',
    batchId: batch.id,
    platformId,
    platformName: provider.platformName,
    provider: provider.provider,
    mode: 'dryRun',
    status: reportStatus,
    reviewStatus: status,
    missingFields: missing.missingFields,
    missingImages: missing.missingImages,
    usesMockImages: taskMissing ? false : usesMockImages(task, platformId),
    hasHighRiskIssues,
    blockingIssues,
    warnings,
    recommendations: reportStatus === 'blocked'
      ? ['先补齐阻断项，再重新执行上传前检查。']
      : ['继续人工核对素材和上架表格。'],
    realUploadEnabled: false
  });
}

function platformReportFor(provider, skuReports) {
  const ownSkuReports = skuReports.filter((item) => item.platformId === provider.platformId);
  const warnings = provider.placeholder
    ? [blockingIssue('PLACEHOLDER_PROVIDER', `${provider.platformName} 第一阶段仅保留占位，不输出可上传结论。`, { platformId: provider.platformId })]
    : [];
  return sanitizeUploadValue({
    platformId: provider.platformId,
    platformName: provider.platformName,
    provider: provider.provider,
    providerName: provider.providerName,
    mode: 'dryRun',
    supportsDryRun: true,
    supportsRealUpload: false,
    realUploadEnabled: false,
    placeholder: provider.placeholder,
    requiredFields: provider.requiredFields,
    requiredImages: provider.requiredImages,
    suggestedFields: provider.suggestedFields,
    totalSku: ownSkuReports.length,
    readySku: ownSkuReports.filter((item) => item.status === 'ready').length,
    blockedSku: ownSkuReports.filter((item) => item.status === 'blocked').length,
    warningSku: ownSkuReports.filter((item) => item.status === 'warning').length,
    warnings,
    recommendations: provider.placeholder
      ? ['该平台需要后续补充字段映射和平台规则，当前不能作为上传依据。']
      : ['仅用于 dry-run 验收，确认字段、图片和审核状态后再进入后续对接。']
  });
}

function uniqueSkuCount(skuReports, predicate) {
  return new Set(skuReports.filter(predicate).map((item) => item.sku)).size;
}

function summarize(skuReports, totalSku) {
  const skuStatus = new Map();
  for (const report of skuReports) {
    const previous = skuStatus.get(report.sku) || 'ready';
    if (report.status === 'blocked' || previous === 'blocked') skuStatus.set(report.sku, 'blocked');
    else if (report.status === 'warning' || previous === 'warning') skuStatus.set(report.sku, 'warning');
    else skuStatus.set(report.sku, 'ready');
  }
  return {
    totalSku,
    readySku: [...skuStatus.values()].filter((status) => status === 'ready').length,
    blockedSku: [...skuStatus.values()].filter((status) => status === 'blocked').length,
    warningSku: uniqueSkuCount(skuReports, (item) => asArray(item.warnings).length > 0 || item.status === 'warning'),
    missingImageCount: skuReports.reduce((sum, item) => sum + asArray(item.missingImages).length, 0),
    missingFieldCount: skuReports.reduce((sum, item) => sum + asArray(item.missingFields).length, 0),
    noReviewSku: uniqueSkuCount(skuReports, (item) => item.reviewStatus === 'noReview'),
    highRiskSku: uniqueSkuCount(skuReports, (item) => item.hasHighRiskIssues),
    mockImageSku: uniqueSkuCount(skuReports, (item) => item.usesMockImages),
    canUploadNow: false
  };
}

function flattenIssues(skuReports) {
  return skuReports.flatMap((item) => asArray(item.blockingIssues).map((issue) => ({
    ...issue,
    sku: issue.sku || item.sku,
    platformId: issue.platformId || item.platformId
  })));
}

function flattenWarnings(skuReports, platformReports) {
  return [
    ...platformReports.flatMap((item) => asArray(item.warnings).map((warning) => ({
      ...warning,
      platformId: warning.platformId || item.platformId
    }))),
    ...skuReports.flatMap((item) => asArray(item.warnings).map((warning) => ({
      ...warning,
      sku: warning.sku || item.sku,
      platformId: warning.platformId || item.platformId
    })))
  ];
}

export async function buildUploadReadinessReport(batchId, options = {}) {
  const batch = await requireBatch(batchId);
  const platforms = normalizeUploadPlatforms(options.platforms);
  const providers = platforms.map(getUploadProvider);
  const tasks = await tasksForBatch(batch);
  const taskById = new Map(tasks.map((task) => [task.id, task]));
  const skuTasks = asArray(batch.skuTasks);
  const skuReports = providers.flatMap((provider) => skuTasks.map((skuTask) => skuReportFor({
    batch,
    skuTask,
    task: taskById.get(skuTask.taskId),
    provider,
    platformId: provider.platformId
  })));
  const platformReports = providers.map((provider) => platformReportFor(provider, skuReports));
  const blockingIssues = [
    blockingIssue('PACKAGE_NOT_VERIFIED', '第一阶段未读取到已验收的导出包清单，请先人工确认资料包完整。', {
      batchId,
      packageId: options.packageId || ''
    }),
    blockingIssue('MISSING_LISTING_CSV', '第一阶段未绑定已验收的上架 CSV，上传前检查不能给出可上传结论。', {
      batchId
    }),
    ...flattenIssues(skuReports)
  ];
  const warnings = flattenWarnings(skuReports, platformReports);
  if (skuReports.some((item) => item.usesMockImages)) {
    warnings.push(blockingIssue('MOCK_IMAGE_WARNING', '报告中存在 mock 图片，当前只适合人工验收。', { batchId }));
  }

  return sanitizeUploadValue({
    meta: {
      reportId: `upload-readiness-${batchId}-${timestampSafe()}`,
      batchId,
      packageId: options.packageId || '',
      generatedAt: nowIso(),
      mode: 'dryRun',
      targetPlatforms: platforms,
      realUploadEnabled: false,
      sandboxConfigSummary: sandboxConfigSummary(options.sandboxConfig, platforms)
    },
    summary: summarize(skuReports, skuTasks.length),
    platformReports,
    skuReports,
    blockingIssues,
    warnings,
    recommendations: [
      '先处理 blockingIssues，再重新执行上传前检查。',
      'Temu 和妙手目前只做 dry-run 验收，不会调用卖家后台接口。',
      'Amazon、Noon、Ozon、Rakuten 为预留平台，暂不能作为可上传结论。'
    ],
    nextSuggestedAction: '先补齐阻断项，并人工确认导出包、上架 CSV、审核状态和图片素材。'
  });
}
