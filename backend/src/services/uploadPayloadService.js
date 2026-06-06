import { getBatchTask, getTask } from './db.js';
import {
  asArray,
  imageTypeFileName,
  platformFolder,
  safeSegment,
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

const SECRET_PATTERNS = [
  [/\b[A-Z0-9_]*API[_-]?KEY\b\s*[:=]\s*[^\s"',，。；;]+/gi, '[credential-removed]'],
  [/\b(provider[_-]?credential|provider[_-]?secret|api[_-]?key|secret|token|password|account)\b\s*[:=]\s*[^\s"',，。；;]+/gi, '[credential-removed]'],
  [/\b(?:sk|rk|ak)-[A-Za-z0-9_-]{6,}\b/gi, '[credential-removed]'],
  [/sk-/gi, '[id-prefix-removed]'],
  [/\b(token|secret|account|seller)\b/gi, '[credential-removed]'],
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

function sanitizeText(value) {
  let text = String(value ?? '');
  for (const [pattern, replacement] of SECRET_PATTERNS) text = text.replace(pattern, replacement);
  return text;
}

export function sanitizeUploadPayloadValue(value) {
  if (Array.isArray(value)) return value.map(sanitizeUploadPayloadValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value)
      .filter(([key]) => !/apiKey|api_key|secret|token|password|credential|absolutePath|sourceFolderPath|sqlitePath|dbPath|platformAccount|account/i.test(key))
      .map(([key, item]) => [key, sanitizeUploadPayloadValue(item)]));
  }
  if (typeof value === 'string') return sanitizeText(sanitizeValue(value));
  return sanitizeValue(value);
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

function imagePathFor(task = {}, skuTask = {}, platformId, imageType) {
  return `${platformFolder(platformId)}/${safeSegment(skuValue(task, skuTask), 'SKU')}/${imageTypeFileName(imageType)}`;
}

function imagePayload(task = {}, skuTask = {}, platformId) {
  const images = usableImages(task, platformId);
  const main = images.find((image) => imageTypeOf(image) === 'main_image');
  const gallery = images
    .filter((image) => GALLERY_IMAGE_TYPES.includes(imageTypeOf(image)))
    .map((image) => imagePathFor(task, skuTask, platformId, imageTypeOf(image)));
  return {
    main: main ? imagePathFor(task, skuTask, platformId, 'main_image') : '',
    gallery,
    sourceTypes: images.map((image) => ({
      imageType: imageTypeOf(image),
      sourceType: sourceTypeForImage(image)
    }))
  };
}

function info(task = {}) {
  return task.productInfoConfirmed || task.productInfo || {};
}

function nonEmpty(value) {
  if (Array.isArray(value)) return value.some(nonEmpty);
  return value !== undefined && value !== null && String(value).trim() !== '';
}

function reviewStatus(task = {}) {
  if (!task || !task.review) return 'noReview';
  if (task.review.overallStatus === 'failed') return 'failed';
  if (task.review.overallStatus === 'passed') return 'passed';
  return task.review.overallStatus || 'reviewed';
}

function hasHighRisk(task = {}) {
  const report = buildReviewReport(task);
  return Boolean(
    report.summary?.fatalCount ||
    report.summary?.highCount ||
    asArray(task.review?.items).some((item) => asArray(item.issues).some((issue) => ['fatal', 'high'].includes(issue.severity)))
  );
}

function warning(code, message, extra = {}) {
  return sanitizeUploadPayloadValue({ code, message, ...extra });
}

function block(code, message, extra = {}) {
  return sanitizeUploadPayloadValue({ code, message, ...extra });
}

function commonChecks({ task, skuTask, platformId, images, requiredNameField = 'productName', requireListingCsv = false, hasListingCsv = false }) {
  const data = info(task);
  const missingFields = [];
  const blockedFields = [];
  const blockingIssues = [];
  const warnings = [];
  const riskNotes = [];
  const status = reviewStatus(task);

  if (!nonEmpty(data.sku || task?.sku || skuTask?.skuId)) missingFields.push('sku');
  if (!nonEmpty(data.name || data.productName || data.productTitle)) missingFields.push(requiredNameField);
  if (!nonEmpty(data.category || task?.categoryId || task?.category)) missingFields.push('category');
  if (!images.main) missingFields.push('main_image');
  if (requireListingCsv && !hasListingCsv) missingFields.push('listing_csv_row');
  if (status === 'noReview') blockingIssues.push(block('NO_REVIEW', 'SKU has no review and cannot be submitted in sandbox.', { platformId }));
  if (status === 'failed') blockingIssues.push(block('REVIEW_FAILED', 'SKU review failed and cannot be submitted in sandbox.', { platformId }));
  if (hasHighRisk(task)) blockingIssues.push(block('HIGH_RISK_REVIEW_ISSUE', 'SKU has fatal or high review risk.', { platformId }));
  if (missingFields.length) blockingIssues.push(block('MISSING_REQUIRED_FIELD', 'Required upload payload fields are missing.', { platformId, fields: missingFields }));
  if (images.sourceTypes.some((item) => item.sourceType === 'mock')) warnings.push(warning('MOCK_IMAGE_WARNING', 'Payload contains mock images and is for manual sandbox review only.', { platformId }));
  const quality = task?.recognitionQuality || {};
  const qualityFields = [
    ...asArray(quality.blockedHighRiskFields),
    ...asArray(quality.blockedHighRisk),
    ...asArray(quality.missingEvidenceFields),
    ...asArray(quality.conflictFields),
    ...asArray(quality.inferredOnlyFields)
  ].map((item) => typeof item === 'string' ? item : item?.field).filter(Boolean);
  if (qualityFields.length) {
    blockedFields.push(...qualityFields);
    riskNotes.push(...qualityFields.map((field) => `${field}:needs_manual_confirm`));
    warnings.push(warning('RISK_NOTES_WARNING', 'Recognition quality has risk notes that need manual handling.', { platformId, fields: qualityFields }));
  }
  return {
    missingFields: [...new Set(missingFields)],
    blockedFields: [...new Set(blockedFields)],
    blockingIssues,
    warnings,
    riskNotes,
    reviewStatus: status
  };
}

function temuPayload({ batch, skuTask, task }) {
  const data = info(task);
  const platformId = 'temu';
  const sku = skuValue(task, skuTask);
  const images = imagePayload(task, skuTask, platformId);
  const checks = commonChecks({ task, skuTask, platformId, images, requiredNameField: 'productName' });
  const status = checks.blockingIssues.length ? 'blocked' : checks.warnings.length ? 'warning' : 'ready';
  return sanitizeUploadPayloadValue({
    platformId,
    sku,
    taskId: task?.id || skuTask.taskId || '',
    batchId: batch.id,
    status,
    payload: {
      sku,
      productName: data.name || data.productName || '',
      category: data.category || task?.categoryId || '',
      description: data.description || '',
      sellingPoints: asArray(data.sellingPoints).slice(0, 5),
      images: { main: images.main, gallery: images.gallery },
      attributes: {
        color: data.color || '',
        capacity: checks.blockedFields.includes('capacity') ? '' : data.capacity || '',
        material: checks.blockedFields.includes('material') ? '' : data.material || '',
        packageIncluded: checks.blockedFields.includes('packageIncluded') ? '' : asArray(data.packageIncluded).join('; '),
        compatibleDevices: checks.blockedFields.includes('compatibleDevices') ? '' : asArray(data.compatibleDevices).join('; ')
      }
    },
    fieldMapping: {
      sku: 'productInfoConfirmed.sku',
      productName: 'productInfoConfirmed.name',
      category: 'productInfoConfirmed.category',
      images: 'generatedImages'
    },
    missingFields: checks.missingFields,
    blockedFields: checks.blockedFields,
    warnings: checks.warnings,
    blockingIssues: checks.blockingIssues,
    riskNotes: checks.riskNotes,
    reviewStatus: checks.reviewStatus
  });
}

function miaoshouPayload({ batch, skuTask, task, hasListingCsv = false }) {
  const data = info(task);
  const platformId = 'miaoshou';
  const sku = skuValue(task, skuTask);
  const images = imagePayload(task, skuTask, platformId);
  const checks = commonChecks({ task, skuTask, platformId, images, requiredNameField: 'title', requireListingCsv: true, hasListingCsv });
  const status = checks.blockingIssues.length ? 'blocked' : checks.warnings.length ? 'warning' : 'ready';
  return sanitizeUploadPayloadValue({
    platformId,
    sku,
    taskId: task?.id || skuTask.taskId || '',
    batchId: batch.id,
    status,
    payload: {
      sku,
      title: data.name || data.productName || data.productTitle || '',
      category: data.category || task?.categoryId || '',
      description: data.description || '',
      imageList: [images.main, ...images.gallery].filter(Boolean),
      sourcePlatform: 'crossborder-image-agent',
      listingCsvRow: hasListingCsv ? {
        sku,
        title: data.name || data.productName || data.productTitle || '',
        category: data.category || task?.categoryId || '',
        main_image: images.main,
        image_count: [images.main, ...images.gallery].filter(Boolean).length
      } : {}
    },
    fieldMapping: {
      sku: 'productInfoConfirmed.sku',
      title: 'productInfoConfirmed.name',
      category: 'productInfoConfirmed.category',
      imageList: 'generatedImages',
      listingCsvRow: 'listing CSV'
    },
    missingFields: checks.missingFields,
    blockedFields: checks.blockedFields,
    warnings: [
      ...checks.warnings,
      warning('MAPPING_INCOMPLETE_WARNING', 'Miaoshou field mapping is incomplete in this sandbox phase.', { platformId })
    ],
    blockingIssues: checks.blockingIssues,
    riskNotes: checks.riskNotes,
    reviewStatus: checks.reviewStatus
  });
}

function placeholderPayload({ batch, skuTask, task, provider }) {
  const sku = skuValue(task, skuTask);
  return sanitizeUploadPayloadValue({
    platformId: provider.platformId,
    sku,
    taskId: task?.id || skuTask.taskId || '',
    batchId: batch.id,
    status: 'blocked',
    payload: {},
    fieldMapping: {},
    missingFields: provider.requiredFields || [],
    blockedFields: [],
    warnings: [warning('PLACEHOLDER_PROVIDER', `${provider.platformName} payload is reserved for later mapping.`, { platformId: provider.platformId })],
    blockingIssues: [block('PLACEHOLDER_PROVIDER', 'Reserved platform payload cannot be submitted.', { platformId: provider.platformId })],
    riskNotes: []
  });
}

function payloadFor({ batch, skuTask, task, provider, hasListingCsv = false }) {
  if (provider.platformId === 'temu') return temuPayload({ batch, skuTask, task });
  if (provider.platformId === 'miaoshou') return miaoshouPayload({ batch, skuTask, task, hasListingCsv });
  return placeholderPayload({ batch, skuTask, task, provider });
}

function platformPayloadFor(provider, skuPayloads) {
  const own = skuPayloads.filter((item) => item.platformId === provider.platformId);
  return sanitizeUploadPayloadValue({
    platformId: provider.platformId,
    platformName: provider.platformName,
    provider: provider.provider,
    placeholder: provider.placeholder,
    mode: 'payloadPreview',
    realUploadEnabled: false,
    realNetworkCalled: false,
    totalPayloads: own.length,
    readyPayloadCount: own.filter((item) => item.status === 'ready').length,
    warningPayloadCount: own.filter((item) => item.status === 'warning').length,
    blockedPayloadCount: own.filter((item) => item.status === 'blocked').length,
    warnings: provider.placeholder ? [warning('PLACEHOLDER_PROVIDER', 'Payload mapping is reserved for a later phase.', { platformId: provider.platformId })] : []
  });
}

function summarizePayloads(skuPayloads, totalSku) {
  return {
    totalSku,
    totalPayloads: skuPayloads.length,
    readyPayloadCount: skuPayloads.filter((item) => item.status === 'ready').length,
    warningPayloadCount: skuPayloads.filter((item) => item.status === 'warning').length,
    blockedPayloadCount: skuPayloads.filter((item) => item.status === 'blocked').length,
    missingFieldCount: skuPayloads.reduce((sum, item) => sum + asArray(item.missingFields).length, 0),
    blockedFieldCount: skuPayloads.reduce((sum, item) => sum + asArray(item.blockedFields).length, 0),
    mockImagePayloadCount: skuPayloads.filter((item) => asArray(item.warnings).some((warn) => warn.code === 'MOCK_IMAGE_WARNING')).length,
    realUploadEnabled: false,
    canUploadNow: false
  };
}

export async function buildUploadPayloadPreview(batchId, options = {}) {
  if (options.confirmDryRun !== true) {
    const error = new Error('confirmDryRun=true is required to generate upload payload preview');
    error.statusCode = 400;
    throw error;
  }
  const batch = await requireBatch(batchId);
  const platforms = normalizeUploadPlatforms(options.platforms);
  const providers = platforms.map(getUploadProvider);
  const tasks = await tasksForBatch(batch);
  const taskById = new Map(tasks.map((task) => [task.id, task]));
  const skuTasks = asArray(batch.skuTasks);
  const hasListingCsv = Boolean(options.packageId || options.listingCsvId || options.sourcePackageId);
  const skuPayloads = providers.flatMap((provider) => skuTasks.map((skuTask) => payloadFor({
    batch,
    skuTask,
    task: taskById.get(skuTask.taskId),
    provider,
    hasListingCsv
  })));
  const platformPayloads = providers.map((provider) => platformPayloadFor(provider, skuPayloads));
  const blockedPayloads = skuPayloads.filter((item) => item.status === 'blocked');
  const warnings = [
    ...platformPayloads.flatMap((item) => asArray(item.warnings)),
    ...skuPayloads.flatMap((item) => asArray(item.warnings))
  ];

  return sanitizeUploadPayloadValue({
    meta: {
      reportId: `upload-payload-preview-${batchId}-${timestampSafe()}`,
      batchId,
      packageId: options.packageId || '',
      generatedAt: nowIso(),
      mode: 'payloadPreview',
      targetPlatforms: platforms,
      realUploadEnabled: false,
      realNetworkCalled: false,
      externalApiCalled: false,
      uploaded: false
    },
    summary: summarizePayloads(skuPayloads, skuTasks.length),
    platformPayloads,
    skuPayloads,
    blockedPayloads,
    warnings,
    recommendations: [
      'This payload preview is for sandbox review only.',
      'Resolve blocked payloads before any later real integration.',
      'Mock image payloads must be replaced or approved before production upload.'
    ]
  });
}
