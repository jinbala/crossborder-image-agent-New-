import { exportTargetsForPlatform, exportImageKey, structuredTargetFolder, latestImagesForExportTarget, exportImageExclusion } from '../../../frontend/src/utils/exportTargets.js';
import {
  IMAGE_TYPE_ORDER,
  asArray,
  platformFolder,
  safeSegment,
  sanitizeText,
  sanitizeValue,
  skuValue,
  toCsv
} from './exportManifestService.js';

export const AMAZON_COLUMNS = [
  'sku',
  'product_title',
  'brand',
  'category',
  'bullet_point_1',
  'bullet_point_2',
  'bullet_point_3',
  'bullet_point_4',
  'bullet_point_5',
  'product_description',
  'main_image',
  'other_image_1',
  'other_image_2',
  'other_image_3',
  'other_image_4',
  'other_image_5',
  'variation_theme',
  'color_name',
  'size_name',
  'capacity',
  'material',
  'compatible_devices',
  'package_included',
  'condition_type',
  'review_status',
  'risk_notes'
];

export const TEMU_COLUMNS = [
  'sku',
  'product_name',
  'category',
  'product_description',
  'selling_point_1',
  'selling_point_2',
  'selling_point_3',
  'selling_point_4',
  'selling_point_5',
  'main_image',
  'gallery_image_1',
  'gallery_image_2',
  'gallery_image_3',
  'gallery_image_4',
  'gallery_image_5',
  'variation_name',
  'color',
  'capacity',
  'material',
  'package_included',
  'compatible_devices',
  'review_status',
  'risk_notes'
];

const PLATFORM_COLUMNS = {
  amazon: AMAZON_COLUMNS,
  temu: TEMU_COLUMNS
};

const HIGH_RISK_FIELDS = new Set([
  'capacity',
  'dimensions',
  'interfaceType',
  'certifications',
  'warranty',
  'material',
  'model',
  'brand',
  'packageIncluded',
  'compatibleDevices',
  'speed',
  'waterproof',
  'shockproof'
]);

const FIELD_ALIASES = {
  product_title: 'name',
  product_name: 'name',
  product_description: 'description',
  color_name: 'color',
  color: 'color',
  size_name: 'dimensions',
  compatible_devices: 'compatibleDevices',
  package_included: 'packageIncluded'
};

const CHINESE_PATTERN = /[\u3400-\u9fff]/;
const PRICE_PATTERN = /(?:[$€£¥]\s?\d|\b\d+(?:\.\d{1,2})?\s?(?:usd|eur|gbp|rmb|cny)\b)/i;
const PROMOTION_PATTERN = /\b(best|no\.?\s*1|guaranteed|sale|discount|coupon|deal|free shipping|limited time|lowest price|hot)\b|\d+\s?%/i;
const MEDICAL_PATTERN = /\b(cure|treat|therapy|healing|medical|clinical|pain relief|diagnose)\b/i;

function cleanText(value) {
  return sanitizeText(value ?? '').replace(/\s+/g, ' ').trim();
}

function isUnsafeCopy(value) {
  const text = cleanText(value);
  return !text || CHINESE_PATTERN.test(text) || PRICE_PATTERN.test(text) || PROMOTION_PATTERN.test(text) || MEDICAL_PATTERN.test(text);
}

function safeCopy(value) {
  const text = cleanText(value);
  return isUnsafeCopy(text) ? '' : text;
}

function joinSafeList(value) {
  const items = asArray(value).map(safeCopy).filter(Boolean);
  return items.join('; ');
}

function imagePath(task = {}, skuTask = {}, platformId, imageType, options, imagePaths, target) {
  const siblings = exportTargetsForPlatform(task, platformId);
  if (imagePaths instanceof Map) return imagePaths.get(exportImageKey(task.id, target.id, imageType)) || (siblings.length === 1 ? imagePaths.get(`${task.id}:${platformId}:${imageType}`) : '') || '';
  const image = latestImagesForExportTarget(task, target).get(imageType);
  if (!image || exportImageExclusion(image, options)) return '';
  const fileName = IMAGE_TYPE_ORDER.find(([type]) => type === imageType)?.[1] || `${safeSegment(imageType, 'image')}.jpg`;
  return [platformFolder(platformId), safeSegment(skuValue(task, skuTask), 'SKU'), structuredTargetFolder(target, siblings), fileName].filter(Boolean).join('/');
}

function recognitionStatus(task = {}, field) {
  const quality = task.recognitionQuality || {};
  const entries = [
    ['blocked_missing_evidence', [...asArray(quality.missingEvidenceFields), ...asArray(quality.blockedHighRiskFields), ...asArray(quality.blockedHighRisk)]],
    ['blocked_conflicted', asArray(quality.conflictFields)],
    ['blocked_inferred_only', asArray(quality.inferredOnlyFields)]
  ];
  for (const [status, items] of entries) {
    if (items.some((item) => (typeof item === 'string' ? item : item?.field) === field)) return status;
  }
  if (asArray(task.inferredCandidates).some((item) => item?.field === field)) return 'blocked_inferred_only';
  return '';
}

function valueForField(task = {}, field) {
  const info = task.productInfoConfirmed || {};
  return info[field];
}

function reviewStatus(task = {}) {
  if (!task.review) return 'noReview';
  if (task.normalizedReviewReport?.summary?.passed === true) return 'passed';
  if (task.review.overallStatus === 'passed') return 'passed';
  if (task.review.overallStatus === 'failed') return 'failed';
  return task.review.overallStatus || 'reviewed';
}

function fieldValue({ task, field, mapping, riskNotes }) {
  const sourceField = FIELD_ALIASES[field] || field;
  const blocked = recognitionStatus(task, sourceField);
  const raw = valueForField(task, sourceField);
  const highRisk = HIGH_RISK_FIELDS.has(sourceField);
  if (blocked) {
    mapping[field] = { source: `productInfoConfirmed.${sourceField}`, status: blocked, risk: highRisk ? 'high' : 'medium' };
    riskNotes.push(`${field}:${blocked}`);
    return '';
  }
  if (highRisk && (raw === undefined || raw === null || raw === '')) {
    mapping[field] = { source: `productInfoConfirmed.${sourceField}`, status: 'empty', risk: 'high' };
    return '';
  }
  const value = Array.isArray(raw) ? joinSafeList(raw) : safeCopy(raw);
  if (!value) {
    mapping[field] = { source: `productInfoConfirmed.${sourceField}`, status: raw ? 'blocked_high_risk' : 'empty', risk: highRisk ? 'high' : 'low' };
    if (raw) riskNotes.push(`${field}:unsafe_copy_removed`);
    return '';
  }
  mapping[field] = { source: `productInfoConfirmed.${sourceField}`, status: 'filled', risk: highRisk ? 'medium' : 'low' };
  return value;
}

function sellingPoints(task = {}) {
  return asArray(task.productInfoConfirmed?.sellingPoints)
    .map(safeCopy)
    .filter(Boolean)
    .slice(0, 5);
}

function imageColumns(task, skuTask, platformId, options, isAmazon, imagePaths, target) {
  const order = isAmazon
    ? ['main_image', 'feature_image', 'size_image', 'compatibility_image', 'package_image', 'lifestyle_image']
    : ['main_image', 'feature_image', 'size_image', 'compatibility_image', 'package_image', 'lifestyle_image'];
  const paths = order.map((type) => imagePath(task, skuTask, platformId, type, options, imagePaths, target));
  if (isAmazon) {
    return {
      main_image: paths[0] || '',
      other_image_1: paths[1] || '',
      other_image_2: paths[2] || '',
      other_image_3: paths[3] || '',
      other_image_4: paths[4] || '',
      other_image_5: paths[5] || ''
    };
  }
  return {
    main_image: paths[0] || '',
    gallery_image_1: paths[1] || '',
    gallery_image_2: paths[2] || '',
    gallery_image_3: paths[3] || '',
    gallery_image_4: paths[4] || '',
    gallery_image_5: paths[5] || ''
  };
}

export function buildPlatformListingRows({ platformId, batch = {}, taskById = new Map(), includeMockImages = true, includeRealSamples = false, imagePaths } = {}) {
  const fieldsBySku = Object.create(null);
  const rows = [];
  const missingRequiredFields = [];
  const blockedFields = [];
  const noReviewSku = [];
  const targetRows = [];
  const isAmazon = platformId === 'amazon';
  let columns = Object.hasOwn(PLATFORM_COLUMNS,platformId) ? PLATFORM_COLUMNS[platformId] : null;
  if (!columns) {
    return {
      columns: ['platform', 'placeholder_status', 'note'],
      rows: [{ platform: platformId, placeholder_status: 'reserved', note: 'Mapping placeholder for future platform template.' }],
      fieldsBySku,
      missingRequiredFields,
      blockedFields,
      noReviewSku
    };
  }
  const multiTarget = asArray(batch.skuTasks).some(sku => taskById.has(sku.taskId) && exportTargetsForPlatform(taskById.get(sku.taskId), platformId).length > 1);
  if (multiTarget) columns = [...columns, 'target_id', 'site', 'language'];
  for (const skuTask of asArray(batch.skuTasks)) {
    const task = taskById.get(skuTask.taskId);
    if (!task) continue;
    for (const target of exportTargetsForPlatform(task, platformId)) {
    const sku = skuValue(task, skuTask);
    const mapping = {};
    const riskNotes = [];
    const points = sellingPoints(task);
    const status = reviewStatus(task);
    if (status === 'noReview') {
      noReviewSku.push(sku);
      riskNotes.push('noReview');
    }
    const base = isAmazon
      ? {
          sku: safeCopy(sku) || safeSegment(sku, 'SKU'),
          product_title: fieldValue({ task, field: 'product_title', mapping, riskNotes }),
          brand: fieldValue({ task, field: 'brand', mapping, riskNotes }),
          category: fieldValue({ task, field: 'category', mapping, riskNotes }),
          bullet_point_1: points[0] || '',
          bullet_point_2: points[1] || '',
          bullet_point_3: points[2] || '',
          bullet_point_4: points[3] || '',
          bullet_point_5: points[4] || '',
          product_description: fieldValue({ task, field: 'product_description', mapping, riskNotes }),
          ...imageColumns(task, skuTask, platformId, { includeMockImages, includeRealSamples }, true, imagePaths, target),
          variation_theme: '',
          color_name: fieldValue({ task, field: 'color_name', mapping, riskNotes }),
          size_name: fieldValue({ task, field: 'size_name', mapping, riskNotes }),
          capacity: fieldValue({ task, field: 'capacity', mapping, riskNotes }),
          material: fieldValue({ task, field: 'material', mapping, riskNotes }),
          compatible_devices: fieldValue({ task, field: 'compatible_devices', mapping, riskNotes }),
          package_included: fieldValue({ task, field: 'package_included', mapping, riskNotes }),
          condition_type: 'new',
          review_status: status,
          risk_notes: ''
        }
      : {
          sku: safeCopy(sku) || safeSegment(sku, 'SKU'),
          product_name: fieldValue({ task, field: 'product_name', mapping, riskNotes }),
          category: fieldValue({ task, field: 'category', mapping, riskNotes }),
          product_description: fieldValue({ task, field: 'product_description', mapping, riskNotes }),
          selling_point_1: points[0] || '',
          selling_point_2: points[1] || '',
          selling_point_3: points[2] || '',
          selling_point_4: points[3] || '',
          selling_point_5: points[4] || '',
          ...imageColumns(task, skuTask, platformId, { includeMockImages, includeRealSamples }, false, imagePaths, target),
          variation_name: '',
          color: fieldValue({ task, field: 'color', mapping, riskNotes }),
          capacity: fieldValue({ task, field: 'capacity', mapping, riskNotes }),
          material: fieldValue({ task, field: 'material', mapping, riskNotes }),
          package_included: fieldValue({ task, field: 'package_included', mapping, riskNotes }),
          compatible_devices: fieldValue({ task, field: 'compatible_devices', mapping, riskNotes }),
          review_status: status,
          risk_notes: ''
        };
    for (const required of ['product_title', 'product_name', 'main_image']) {
      if (required in base && !base[required]) {
        missingRequiredFields.push({ sku, platform: platformId, targetId: target.id, field: required });
        riskNotes.push(`${required}:missing`);
      }
    }
    base.risk_notes = riskNotes.join('; ');
    if (multiTarget) Object.assign(base, { target_id: target.id, site: target.site, language: target.language });
    targetRows.push({ sku, taskId: task.id, targetId: target.id, site: target.site, language: target.language, fields: mapping });
    for (const [field, meta] of Object.entries(mapping)) {
      if (String(meta.status).startsWith('blocked')) blockedFields.push({ sku, platform: platformId, field: FIELD_ALIASES[field] || field, status: meta.status });
    }
    fieldsBySku[sku] = mapping;
    rows.push(sanitizeValue(base));
    }
  }
  return { columns, rows, fieldsBySku, missingRequiredFields, blockedFields, noReviewSku, targetRows };
}

export function rowsToCsv(rows = [], columns = []) {
  return toCsv(rows.map((row) => Object.fromEntries(columns.map((column) => [column, row[column] ?? '']))), columns);
}
