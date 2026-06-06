import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import archiver from 'archiver';
import { getBatchTask, getTask, paths } from './db.js';
import { normalizeTargets } from './targetService.js';
import { buildBatchReviewReport } from './batchReviewReportService.js';
import { buildReviewReport } from './reviewReportService.js';
import { analyzeTemplateSet } from './templateAuditService.js';
import { buildListingArtifacts, listingFileNamesForPlatforms } from './listingExportService.js';
import {
  IMAGE_TYPE_ORDER,
  asArray,
  csvEscape,
  imageTypeFileName,
  normalizePlatforms,
  platformFolder,
  safeSegment,
  sanitizeValue,
  skuValue,
  sourceTypeForImage,
  toCsv
} from './exportManifestService.js';

const REPORT_FILES = [
  'review-report.json',
  'review-report.csv',
  'product-info-confirmed.json',
  'generation-log.json',
  'cost-report.json',
  'failed-sku-report.json',
  'failed-sku-report.csv',
  'template-audit-summary.json',
  'rule-audit-summary.json'
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
    includeReports: options.includeReports !== false,
    includeMockImages: options.includeMockImages !== false,
    includeRealSamples: options.includeRealSamples === true,
    format: 'zip',
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

function targetPlatformId(target = {}) {
  return String(target.platformId || target.platform || '').toLowerCase();
}

function targetsForTask(task = {}) {
  return normalizeTargets(task.targets || [], {
    productInfo: task.productInfoConfirmed || task.productInfo || {},
    fallbackTask: task
  });
}

function imageTypeOf(image = {}) {
  return image.imageType || image.type || image.mockPreview?.type || image.mockPreview?.template?.templateType || '';
}

function imagePlatformId(image = {}, task = {}) {
  if (image.platformId || image.platform) return String(image.platformId || image.platform).toLowerCase();
  const plan = asArray(task.imagePlans).find((item) => item.id === image.planId);
  if (plan?.platformId || plan?.platform) return String(plan.platformId || plan.platform).toLowerCase();
  if (plan?.targetId) {
    const target = targetsForTask(task).find((item) => item.id === plan.targetId || item.targetId === plan.targetId);
    if (target) return targetPlatformId(target);
  }
  const target = targetsForTask(task)[0];
  return targetPlatformId(target) || String(task.platformId || task.platform || 'amazon').toLowerCase();
}

function latestImages(task = {}) {
  const byKey = new Map();
  for (const image of asArray(task.generatedImages)) {
    if (image.status && !['succeeded', 'success', 'completed'].includes(image.status)) continue;
    const key = `${imagePlatformId(image, task)}:${imageTypeOf(image)}`;
    byKey.set(key, image);
  }
  return byKey;
}

function templateForImage(task = {}, image = {}) {
  const plan = asArray(task.imagePlans).find((item) => item.id === image.planId) || {};
  return image.mockPreview?.template || image.templateSeed || plan.templateSeed || {};
}

function reviewStatusForTask(task = {}) {
  if (task.review?.overallStatus) return task.review.overallStatus;
  if (task.status === 'reviewed' || task.status === 'exported') return 'reviewed';
  return task.status || 'unknown';
}

function safeProductInfo(task = {}) {
  return sanitizeValue(task.productInfoConfirmed || {});
}

function templateAuditSummary(task = {}) {
  const audit = analyzeTemplateSet(task);
  return sanitizeValue({
    meta: audit.meta,
    imageTypeCoverage: audit.imageTypeCoverage,
    templateDiversity: audit.templateDiversity,
    textSafety: audit.textSafety,
    fieldSafety: audit.fieldSafety,
    amazonMainImageCheck: audit.amazonMainImageCheck,
    recommendations: audit.recommendations
  });
}

function ruleAuditSummary(task = {}) {
  return sanitizeValue(analyzeTemplateSet(task).ruleAuditSummary || null);
}

function recognitionQualitySummary(task = {}) {
  const quality = task.recognitionQuality || {};
  return sanitizeValue({
    summary: quality.summary || null,
    confirmedWithEvidence: quality.confirmedWithEvidence || quality.summary?.confirmedWithEvidence || 0,
    needsManualConfirm: quality.needsManualConfirm || quality.summary?.needsManualConfirm || 0,
    inferredOnly: quality.inferredOnly || quality.summary?.inferredOnly || 0,
    conflicted: quality.conflicted || quality.summary?.conflicted || 0,
    blockedHighRisk: quality.blockedHighRisk || quality.blockedHighRiskFields || []
  });
}

function buildImageRows({ task, skuTask, platformId, baseFolder, options = {} }) {
  const images = latestImages(task);
  return IMAGE_TYPE_ORDER.map(([imageType, fileName]) => {
    const image = images.get(`${platformId}:${imageType}`);
    const sourceType = sourceTypeForImage(image || {});
    const included = Boolean(image) &&
      (sourceType !== 'mock' || options.includeMockImages) &&
      (sourceType !== 'realSample' || options.includeRealSamples);
    const template = image ? templateForImage(task, image) : {};
    const warnings = image
      ? [
          ...asArray(image.warnings),
          ...(!included && sourceType === 'mock' ? ['当前导出选项未包含 mock 图片，manifest 已标记 missing。'] : []),
          ...(!included && sourceType === 'realSample' ? ['当前导出选项未包含真实小样本，manifest 已标记 missing。'] : [])
        ]
      : ['图片缺失，manifest 已标记 missing。'];
    return sanitizeValue({
      sku: skuValue(task, skuTask),
      taskId: task.id || skuTask.taskId || '',
      platformId,
      imageType,
      fileName,
      sourceFilePath: image?.filePath || '',
      exists: Boolean(image && included),
      sourceType: image ? sourceType : 'missing',
      reviewStatus: reviewStatusForTask(task),
      templateName: template.templateName || image?.templateName || '',
      layoutStyle: template.layoutStyle || image?.layoutStyle || '',
      ruleAuditStatus: ruleAuditSummary(task)?.passed === false ? 'hasIssues' : 'passed',
      warnings,
      zipPath: `${baseFolder}/${fileName}`,
      provider: image?.provider || '',
      model: image?.model || '',
      generatedAt: image?.generatedAt || ''
    });
  });
}

function failedSkuFrom(batch = {}, taskById = new Map()) {
  return asArray(batch.skuTasks)
    .filter((skuTask) => !skuTask.taskId || skuTask.status === 'failed' || !taskById.has(skuTask.taskId))
    .map((skuTask) => sanitizeValue({
      sku: skuTask.skuId || skuTask.displayName || '',
      taskId: skuTask.taskId || '',
      failedStep: skuTask.currentStep || skuTask.status || 'unknown',
      errorMessage: skuTask.error?.message || skuTask.error || (skuTask.taskId ? '任务数据缺失。' : '未创建单 SKU task。'),
      canRetry: Boolean(skuTask.taskId),
      requiresManualAction: true,
      nextSuggestedAction: skuTask.taskId ? '请回到批量任务页查看单 SKU 重试计划。' : '请先检查导入目录并重新创建该 SKU 任务。'
    }));
}

function buildSkuManifest({ task, skuTask, platformId, imageRows }) {
  return sanitizeValue({
    sku: skuValue(task, skuTask),
    taskId: task.id || skuTask.taskId || '',
    productName: task.productInfoConfirmed?.name || task.productInfo?.name || skuTask.displayName || '',
    platformId,
    categoryId: task.categoryId || targetsForTask(task).find((target) => targetPlatformId(target) === platformId)?.categoryId || 'generic_ecommerce',
    images: imageRows.map(({ sourceFilePath, zipPath, ...image }) => image),
    productInfoConfirmed: safeProductInfo(task),
    recognitionQualitySummary: recognitionQualitySummary(task),
    templateAuditSummary: templateAuditSummary(task),
    ruleAuditSummary: ruleAuditSummary(task),
    reviewSummary: task.review ? buildReviewReport(task).summary : null
  });
}

function buildReviewCsv(batchReviewReport = {}) {
  const rows = asArray(batchReviewReport.skuReports).map((item) => ({
    sku: item.sku,
    taskId: item.taskId,
    platform: item.report?.meta?.platformId || '',
    reviewStatus: item.status,
    fatalCount: item.fatalCount,
    highCount: item.highCount,
    mediumCount: item.mediumCount,
    lowCount: item.lowCount,
    mockInfoCount: item.mockInfoCount,
    realComplianceIssueCount: item.realComplianceIssueCount,
    topIssues: asArray(item.topIssues).map((issue) => issue.title || issue.groupKey).join(' | '),
    nextSuggestedAction: item.nextSuggestedAction
  }));
  return toCsv(rows, [
    'sku',
    'taskId',
    'platform',
    'reviewStatus',
    'fatalCount',
    'highCount',
    'mediumCount',
    'lowCount',
    'mockInfoCount',
    'realComplianceIssueCount',
    'topIssues',
    'nextSuggestedAction'
  ]);
}

function buildFailedCsv(failedSku = []) {
  return toCsv(failedSku, ['sku', 'taskId', 'failedStep', 'errorMessage', 'canRetry', 'requiresManualAction', 'nextSuggestedAction']);
}

function buildReports({ batch, tasks, failedSku, listingArtifacts }) {
  const batchReviewReport = buildBatchReviewReport(batch, tasks);
  const productInfoConfirmed = tasks.map((task) => sanitizeValue({
    sku: skuValue(task),
    taskId: task.id,
    productInfoConfirmed: task.productInfoConfirmed || {},
    recognitionQuality: recognitionQualitySummary(task),
    highRiskFieldEvidenceStatus: task.recognitionQuality?.blockedHighRiskFields || task.recognitionQuality?.blockedHighRisk || []
  }));
  const generationLog = tasks.flatMap((task) => asArray(task.generatedImages).map((image) => sanitizeValue({
    taskId: task.id,
    sku: skuValue(task),
    generatedImages: image.fileName || image.id,
    imageType: imageTypeOf(image),
    provider: image.provider || '',
    model: image.model || '',
    sourceType: sourceTypeForImage(image),
    generatedAt: image.generatedAt || '',
    warnings: asArray(image.warnings)
  })));
  const templateAuditSummaryRows = tasks.map((task) => sanitizeValue({
    taskId: task.id,
    sku: skuValue(task),
    templateAuditSummary: templateAuditSummary(task)
  }));
  const ruleAuditSummaryRows = tasks.map((task) => sanitizeValue({
    taskId: task.id,
    sku: skuValue(task),
    ruleAuditSummary: ruleAuditSummary(task)
  }));
  const reports = {
    'review-report.json': { batchReviewReport },
    'review-report.csv': buildReviewCsv(batchReviewReport),
    'product-info-confirmed.json': { items: productInfoConfirmed },
    'generation-log.json': { items: generationLog },
    'cost-report.json': {
      currency: 'USD',
      estimatedTotalCost: 0,
      costNotice: '当前为估算占位，后续可接入真实价格表。',
      items: []
    },
    'failed-sku-report.json': { failedSku },
    'failed-sku-report.csv': buildFailedCsv(failedSku),
    'template-audit-summary.json': { items: templateAuditSummaryRows },
    'rule-audit-summary.json': { items: ruleAuditSummaryRows }
  };
  for (const [fileName, content] of Object.entries(listingArtifacts?.files || {})) {
    reports[`listing-csv/${fileName}`] = content;
  }
  return reports;
}

function summarize({ batch, platforms, skuPackages, failedSku, includeReports }) {
  const imageRows = skuPackages.flatMap((item) => item.imageRows);
  const readyImageCount = imageRows.filter((image) => image.exists).length;
  const missingImageCount = imageRows.filter((image) => !image.exists).length;
  const mockImageCount = imageRows.filter((image) => image.exists && image.sourceType === 'mock').length;
  const realImageCount = imageRows.filter((image) => image.exists && image.sourceType === 'real').length;
  const fallbackMockImageCount = imageRows.filter((image) => image.exists && image.sourceType === 'fallbackMock').length;
  const realSampleImageCount = imageRows.filter((image) => image.exists && image.sourceType === 'realSample').length;
  const totalSku = asArray(batch.skuTasks).length;
  return {
    totalSku,
    successSku: Math.max(0, totalSku - failedSku.length),
    failedSku: failedSku.length,
    platformCount: platforms.length,
    totalExpectedImages: imageRows.length,
    readyImageCount,
    missingImageCount,
    mockImageCount,
    realImageCount,
    fallbackMockImageCount,
    realSampleImageCount,
    reportCount: includeReports ? REPORT_FILES.length + listingFileNamesForPlatforms(platforms).length : 0
  };
}

function safetySummary() {
  return {
    noPlatformUpload: true,
    noProviderCall: true,
    noDatabaseWrite: true,
    sanitized: true,
    mockImagesMarked: true
  };
}

async function packageModel(batchId, options = {}) {
  const normalized = normalizeOptions(options);
  const batch = await requireBatch(batchId);
  const tasks = await tasksForBatch(batch);
  const taskById = new Map(tasks.map((task) => [task.id, task]));
  const failedSku = failedSkuFrom(batch, taskById);
  const skuPackages = [];

  for (const skuTask of asArray(batch.skuTasks)) {
    const task = taskById.get(skuTask.taskId);
    if (!task) continue;
    const sku = safeSegment(skuValue(task, skuTask), 'SKU');
    for (const platformId of normalized.platforms) {
      const folder = `${platformFolder(platformId)}/${sku}`;
      const imageRows = buildImageRows({ task, skuTask, platformId, baseFolder: folder, options: normalized });
      skuPackages.push({
        sku,
        skuTask: sanitizeValue(skuTask),
        task,
        platformId,
        folder,
        imageRows,
        manifest: buildSkuManifest({ task, skuTask, platformId, imageRows })
      });
    }
  }

  const summary = summarize({
    batch,
    platforms: normalized.platforms,
    skuPackages,
    failedSku,
    includeReports: normalized.includeReports
  });
  const warnings = [];
  if (summary.missingImageCount > 0) warnings.push('部分图片缺失，导出不会中断，已在 manifest 中标记 missing。');
  if (summary.mockImageCount > 0) warnings.push('mock 图片会在 manifest 中明确标记 sourceType=mock。');
  if (failedSku.length > 0) warnings.push('部分 SKU 已写入 failed-sku-report，请人工复查后再上架。');

  return {
    batch,
    tasks,
    options: normalized,
    skuPackages,
    failedSku,
    summary,
    warnings,
    reports: normalized.includeReports
      ? buildReports({
          batch,
          tasks,
          failedSku,
          listingArtifacts: await buildListingArtifacts(batch.id, {
            platforms: normalized.platforms,
            includeMockImages: normalized.includeMockImages
          })
        })
      : {}
  };
}

export async function buildExportPackagePreview(batchId, options = {}) {
  const model = await packageModel(batchId, options);
  const directoryTree = [];
  for (const pkg of model.skuPackages) {
    for (const image of pkg.imageRows) {
      directoryTree.push({
        path: image.zipPath,
        status: image.exists ? 'ready' : 'missing',
        sourceType: image.sourceType
      });
    }
    directoryTree.push({ path: `${pkg.folder}/manifest.json`, status: 'ready', sourceType: 'manifest' });
  }
  if (model.options.includeReports) {
    [...REPORT_FILES, ...listingFileNamesForPlatforms(model.options.platforms).map((file) => `listing-csv/${file}`)]
      .forEach((file) => directoryTree.push({ path: `reports/${file}`, status: 'ready', sourceType: 'report' }));
  }
  return sanitizeValue({
    batchId,
    mode: 'preview',
    platforms: model.options.platforms,
    summary: model.summary,
    warnings: model.warnings,
    reports: model.options.includeReports ? REPORT_FILES : [],
    directoryTree,
    failedSku: model.failedSku
  });
}

function safeOutputPath(...segments) {
  const resolved = path.resolve(paths.outputDir, ...segments);
  const root = path.resolve(paths.outputDir);
  if (!(resolved === root || resolved.startsWith(`${root}${path.sep}`))) {
    const error = new Error('Export package path escapes safe outputs directory');
    error.statusCode = 400;
    throw error;
  }
  return resolved;
}

function safeSourcePath(relativePath = '') {
  if (!relativePath || path.isAbsolute(relativePath)) return null;
  const resolved = path.resolve(paths.rootDir, relativePath);
  const root = path.resolve(paths.rootDir);
  if (!(resolved === root || resolved.startsWith(`${root}${path.sep}`))) return null;
  return resolved;
}

async function writeJson(filePath, value) {
  await fs.writeFile(filePath, `${JSON.stringify(sanitizeValue(value), null, 2)}\n`, 'utf8');
}

async function zipDirectory(sourceDir, zipPath, packageId) {
  await new Promise((resolve, reject) => {
    const output = fsSync.createWriteStream(zipPath);
    const archive = archiver('zip', { zlib: { level: 9 } });
    output.on('close', resolve);
    archive.on('error', reject);
    archive.pipe(output);
    archive.directory(sourceDir, packageId);
    archive.finalize();
  });
}

export async function createStructuredExportPackage(batchId, options = {}) {
  if (options.confirmExport !== true) {
    const error = new Error('confirmExport=true is required to create export package');
    error.statusCode = 400;
    throw error;
  }
  const model = await packageModel(batchId, options);
  const packageId = safeSegment(`export-package-${batchId}-${timestampSafe()}`, 'export-package');
  const packageRoot = safeOutputPath('export-packages', packageId);
  const zipPath = safeOutputPath('export-packages', `${packageId}.zip`);
  await fs.mkdir(path.dirname(packageRoot), { recursive: true });
  await fs.mkdir(packageRoot, { recursive: false });

  for (const pkg of model.skuPackages) {
    const folderPath = path.join(packageRoot, pkg.folder);
    await fs.mkdir(folderPath, { recursive: true });
    for (const image of pkg.imageRows) {
      if (!image.exists) continue;
      const sourcePath = safeSourcePath(image.sourceFilePath);
      if (!sourcePath) {
        image.exists = false;
        image.warnings = [...asArray(image.warnings), '图片路径未通过安全校验，已跳过复制。'];
        continue;
      }
      try {
        await fs.copyFile(sourcePath, path.join(folderPath, image.fileName));
      } catch {
        image.exists = false;
        image.warnings = [...asArray(image.warnings), '图片文件读取失败，已在 manifest 中标记 missing。'];
      }
    }
    await writeJson(path.join(folderPath, 'manifest.json'), {
      ...pkg.manifest,
      images: pkg.imageRows.map(({ sourceFilePath, zipPath: _zipPath, ...image }) => image)
    });
  }

  if (model.options.includeReports) {
    const reportsDir = path.join(packageRoot, 'reports');
    await fs.mkdir(reportsDir, { recursive: true });
    for (const [fileName, content] of Object.entries(model.reports)) {
      const reportPath = path.join(reportsDir, fileName);
      await fs.mkdir(path.dirname(reportPath), { recursive: true });
      if (typeof content === 'string') {
        await fs.writeFile(reportPath, content, 'utf8');
      } else {
        await writeJson(reportPath, content);
      }
    }
  }

  const fileList = [];
  for (const pkg of model.skuPackages) {
    for (const image of pkg.imageRows) {
      fileList.push({ path: image.zipPath, exists: image.exists, sourceType: image.sourceType, imageType: image.imageType });
    }
    fileList.push({ path: `${pkg.folder}/manifest.json`, exists: true, sourceType: 'manifest' });
  }
  if (model.options.includeReports) {
    [...REPORT_FILES, ...listingFileNamesForPlatforms(model.options.platforms).map((file) => `listing-csv/${file}`)]
      .forEach((file) => fileList.push({ path: `reports/${file}`, exists: true, sourceType: 'report' }));
  }

  const reviewReport = model.reports['review-report.json']?.batchReviewReport || {};
  const rootManifest = sanitizeValue({
    packageId,
    batchId,
    generatedAt: nowIso(),
    platforms: model.options.platforms,
    totalSku: model.summary.totalSku,
    successSku: model.summary.successSku,
    failedSku: model.summary.failedSku,
    missingImageCount: model.summary.missingImageCount,
    mockImageCount: model.summary.mockImageCount,
    realImageCount: model.summary.realImageCount,
    fallbackMockImageCount: model.summary.fallbackMockImageCount,
    realSampleImageCount: model.summary.realSampleImageCount,
    reviewSummary: reviewReport.summary || null,
    costSummary: model.reports['cost-report.json'] || null,
    safetySummary: safetySummary(),
    files: fileList
  });
  await writeJson(path.join(packageRoot, 'manifest.json'), rootManifest);
  await zipDirectory(packageRoot, zipPath, packageId);

  const relativePath = path.relative(paths.rootDir, zipPath).replaceAll('\\', '/');
  return sanitizeValue({
    packageId,
    batchId,
    zipFile: `${packageId}.zip`,
    relativePath,
    summary: model.summary,
    warnings: model.warnings,
    failedSku: model.failedSku
  });
}
