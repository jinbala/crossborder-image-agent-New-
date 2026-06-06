import fs from 'node:fs/promises';
import path from 'node:path';
import { getBatchTask, getTask, paths } from './db.js';
import {
  asArray,
  normalizePlatforms,
  safeSegment,
  sanitizeValue
} from './exportManifestService.js';
import {
  buildPlatformListingRows,
  rowsToCsv
} from './listingFieldMapperService.js';

const LISTING_FILES = [
  'amazon-listing.csv',
  'temu-listing.csv',
  'noon-listing.csv',
  'ozon-listing.csv',
  'rakuten-listing.csv',
  'listing-field-mapping.json',
  'listing-export-summary.json'
];

function nowIso() {
  return new Date().toISOString();
}

function timestampSafe(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, '-');
}

function normalizeOptions(options = {}) {
  return {
    platforms: normalizePlatforms(options.platforms),
    sourcePackageId: options.sourcePackageId || '',
    includeMockImages: options.includeMockImages !== false,
    confirmExport: options.confirmExport === true
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

function failedSkuFrom(batch = {}, taskById = new Map()) {
  return asArray(batch.skuTasks)
    .filter((skuTask) => !skuTask.taskId || skuTask.status === 'failed' || !taskById.has(skuTask.taskId))
    .map((skuTask) => sanitizeValue({
      sku: skuTask.skuId || skuTask.displayName || '',
      taskId: skuTask.taskId || '',
      failedStep: skuTask.currentStep || skuTask.status || 'unknown',
      errorMessage: skuTask.error?.message || skuTask.error || 'Task is missing.',
      canRetry: Boolean(skuTask.taskId),
      requiresManualAction: true
    }));
}

function recommendationsFor(summary = {}) {
  const recommendations = ['CSV generated for manual review only. It will not be uploaded automatically.'];
  if (summary.noReviewSku?.length) recommendations.push('Some SKU have no review. Review them before platform handoff.');
  if (summary.blockedFields?.length) recommendations.push('Some high-risk fields were left blank because evidence is missing or conflicted.');
  if (summary.missingRequiredFields?.length) recommendations.push('Some required listing fields are blank. Fill them manually before upload.');
  recommendations.push('Check platform template fields against the latest seller-center requirements.');
  return recommendations;
}

export async function buildListingArtifacts(batchId, options = {}) {
  const normalized = normalizeOptions(options);
  const batch = await requireBatch(batchId);
  const tasks = await tasksForBatch(batch);
  const taskById = new Map(tasks.map((task) => [task.id, task]));
  const rowsByPlatform = {};
  const files = {};
  const mapping = {
    batchId,
    generatedAt: nowIso(),
    platforms: {}
  };
  const summary = {
    batchId,
    generatedAt: nowIso(),
    platforms: normalized.platforms,
    totalSku: asArray(batch.skuTasks).length,
    rowsByPlatform,
    missingRequiredFields: [],
    blockedFields: [],
    noReviewSku: [],
    failedSku: failedSkuFrom(batch, taskById),
    warnings: [],
    recommendations: []
  };

  for (const platformId of normalized.platforms) {
    const platformRows = buildPlatformListingRows({
      platformId,
      batch,
      taskById,
      includeMockImages: normalized.includeMockImages
    });
    rowsByPlatform[platformId] = platformRows.rows.length;
    files[`${platformId}-listing.csv`] = rowsToCsv(platformRows.rows, platformRows.columns);
    mapping.platforms[platformId] = {
      platform: platformId,
      fields: Object.assign({}, ...Object.values(platformRows.fieldsBySku || {}))
    };
    summary.missingRequiredFields.push(...platformRows.missingRequiredFields);
    summary.blockedFields.push(...platformRows.blockedFields);
    summary.noReviewSku.push(...platformRows.noReviewSku);
  }
  summary.noReviewSku = [...new Set(summary.noReviewSku)];
  if (summary.failedSku.length) summary.warnings.push('Some SKU failed before listing export and are excluded from CSV rows.');
  if (summary.blockedFields.length) summary.warnings.push('Blocked high-risk fields were left blank in CSV.');
  if (summary.noReviewSku.length) summary.warnings.push('Some SKU are marked noReview and must not be treated as passed.');
  summary.recommendations = recommendationsFor(summary);
  files['listing-field-mapping.json'] = `${JSON.stringify(sanitizeValue(mapping), null, 2)}\n`;
  files['listing-export-summary.json'] = `${JSON.stringify(sanitizeValue(summary), null, 2)}\n`;

  return sanitizeValue({
    batchId,
    options: normalized,
    files,
    summary,
    mapping,
    warnings: summary.warnings
  });
}

export async function buildListingCsvPreview(batchId, options = {}) {
  const artifacts = await buildListingArtifacts(batchId, options);
  return sanitizeValue({
    batchId,
    mode: 'preview',
    platforms: artifacts.options.platforms,
    files: Object.keys(artifacts.files).map((fileName) => ({
      platform: fileName.endsWith('.csv') ? fileName.replace('-listing.csv', '') : 'metadata',
      fileName,
      relativePath: `outputs/listing-csv/preview/${fileName}`
    })),
    summary: artifacts.summary,
    warnings: artifacts.warnings
  });
}

function safeOutputPath(...segments) {
  const resolved = path.resolve(paths.outputDir, ...segments);
  const root = path.resolve(paths.outputDir);
  if (!(resolved === root || resolved.startsWith(`${root}${path.sep}`))) {
    const error = new Error('Listing export path escapes safe outputs directory');
    error.statusCode = 400;
    throw error;
  }
  return resolved;
}

export async function createListingCsvExport(batchId, options = {}) {
  if (options.confirmExport !== true) {
    const error = new Error('confirmExport=true is required to create listing CSV export');
    error.statusCode = 400;
    throw error;
  }
  const artifacts = await buildListingArtifacts(batchId, options);
  const exportId = safeSegment(`listing-csv-${batchId}-${timestampSafe()}`, 'listing-csv');
  const exportRoot = safeOutputPath('listing-csv', exportId);
  await fs.mkdir(path.dirname(exportRoot), { recursive: true });
  await fs.mkdir(exportRoot, { recursive: false });
  for (const [fileName, content] of Object.entries(artifacts.files)) {
    await fs.writeFile(path.join(exportRoot, safeSegment(fileName, 'listing-file')), content, 'utf8');
  }
  const relativePath = path.relative(paths.rootDir, exportRoot).replaceAll('\\', '/');
  const files = Object.keys(artifacts.files).map((fileName) => ({
    platform: fileName.endsWith('.csv') ? fileName.replace('-listing.csv', '') : 'metadata',
    fileName,
    relativePath: `${relativePath}/${fileName}`
  }));
  return sanitizeValue({
    exportId,
    batchId,
    relativePath,
    files,
    summary: artifacts.summary,
    warnings: artifacts.warnings
  });
}

export function listingFileNamesForPlatforms(platforms = []) {
  const platformFiles = normalizePlatforms(platforms).map((platformId) => `${platformId}-listing.csv`);
  return [...platformFiles, 'listing-field-mapping.json', 'listing-export-summary.json']
    .filter((fileName) => LISTING_FILES.includes(fileName));
}
