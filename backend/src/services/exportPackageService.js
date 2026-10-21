import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { grantAsset } from './ownershipService.js';
import archiver from 'archiver';
import sharp from 'sharp';
import { createHash } from 'node:crypto';
import { getBatchTask, getTask, paths } from './db.js';
import { exportTargetsForPlatform, resolveExportImageTarget, exportImageKey, structuredTargetFolder, latestImagesForExportTarget, exportImageExclusion } from '../../../frontend/src/utils/exportTargets.js';
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

function imageTypeOf(image = {}) {
  return image.imageType || image.type || image.mockPreview?.type || image.mockPreview?.template?.templateType || '';
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

function buildImageRows({ task, skuTask, target, baseFolder, options = {} }) {
  const platformId = target.platformId, images = latestImagesForExportTarget(task, target);
  return IMAGE_TYPE_ORDER.map(([imageType, fileName]) => {
    const image = images.get(imageType);
    const sourceType = sourceTypeForImage(image || {});
    const exclusionCode = image ? exportImageExclusion(image, options) : null;
    const included = Boolean(image) && !exclusionCode;
    const template = image ? templateForImage(task, image) : {};
    const warnings = image
      ? [
          ...asArray(image.warnings),
          ...(exclusionCode === 'IMAGE_EXCLUDED_MOCK' ? ['当前导出选项未包含 mock 或回退 mock 图片，manifest 已标记 missing。'] : []),
          ...(exclusionCode === 'IMAGE_EXCLUDED_REAL_SAMPLE' ? ['当前导出选项未包含真实小样本，manifest 已标记 missing。'] : [])
        ]
      : ['图片缺失，manifest 已标记 missing。'];
    return sanitizeValue({
      sku: skuValue(task, skuTask),
      taskId: task.id || skuTask.taskId || '',
      platformId,
      targetId: target.id, site: target.site, language: target.language,
      imageType,
      fileName,
      sourceFilePath: image?.filePath || '',
      exists: Boolean(image && included),
      sourceType: image ? sourceType : 'missing',
      ...(exclusionCode ? { exclusionCode } : {}),
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

function buildSkuManifest({ task, skuTask, target, imageRows }) {
  return sanitizeValue({
    sku: skuValue(task, skuTask),
    taskId: task.id || skuTask.taskId || '',
    productName: task.productInfoConfirmed?.name || task.productInfo?.name || skuTask.displayName || '',
    platformId: target.platformId, targetId: target.id, site: target.site, language: target.language,
    placeholderTarget: Boolean(target.placeholder), reviewScope: 'task',
    categoryId: target.categoryId || task.categoryId || 'generic_ecommerce',
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
    imageErrorCount: imageRows.filter(image => image.errorCode).length,
    reportCount: includeReports ? REPORT_FILES.length + listingFileNamesForPlatforms(platforms).length : 0
  };
}

function packageWarnings(summary, failedSku) {
  const warnings = [];
  if (summary.missingImageCount > 0) warnings.push('部分图片缺失，导出不会中断，已在 manifest 中标记 missing。');
  if (summary.imageErrorCount > 0) warnings.push('部分源图读取或解码失败，请核对图片清单中的 errorCode 后修复源图并重新导出。');
  if (summary.mockImageCount > 0) warnings.push('mock 图片会在 manifest 中明确标记 sourceType=mock。');
  if (failedSku.length > 0) warnings.push('部分 SKU 已写入 failed-sku-report，请人工复查后再上架。');
  return warnings;
}

function safetySummary() {
  return {
    noPlatformUpload: true,
    noProviderCall: true,
    noDatabaseWrite: false,
    noTaskMutation: true,
    createsAssetGrants: true,
    sanitized: true,
    mockImagesMarked: true
  };
}

function checkedPackageFolder(platformId, sku, targetFolder = '') {
  const platform = platformFolder(platformId);
  for (const segment of [platform, sku, ...(targetFolder ? [targetFolder] : [])]) {
    if (typeof segment !== 'string' || segment.length > 200 || !segment || /^\.+$/.test(segment) || /[. ]$/.test(segment) || /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(segment) || /[\\/]/.test(segment)) {
      throw Object.assign(new Error('导出目录名不适用于 Windows：请调整 SKU 或平台名，避免点号目录、末尾点号、保留设备名或过长名称，再重新预览。'), { statusCode: 400, code: 'EXPORT_PATH_INVALID' });
    }
  }
  return [platform, sku, targetFolder].filter(Boolean).join('/');
}

async function packageModel(batchId, options = {}) {
  const normalized = normalizeOptions(options);
  const batch = await requireBatch(batchId);
  const tasks = await tasksForBatch(batch);
  const taskById = new Map(tasks.map((task) => [task.id, task]));
  const failedSku = failedSkuFrom(batch, taskById);
  const skuPackages = [];
  const usedFolders = new Set();
  const targetWarnings = [];

  for (const skuTask of asArray(batch.skuTasks)) {
    const task = taskById.get(skuTask.taskId);
    if (!task) continue;
    const sku = safeSegment(skuValue(task, skuTask), 'SKU');
    for (const image of asArray(task.generatedImages)) {
      if (image.status && !['succeeded','success','completed'].includes(image.status)) continue;
      const resolution = resolveExportImageTarget(task, image);
      if (!resolution.target) targetWarnings.push({ taskId: task.id, imageId: image.id || '', imageType: imageTypeOf(image), code: resolution.code });
    }
    for (const platformId of normalized.platforms) {
      const targets = exportTargetsForPlatform(task, platformId);
      for (const target of targets) {
        const folder = checkedPackageFolder(platformId, sku, structuredTargetFolder(target, targets));
        const folderKey = folder.toLowerCase();
        if (usedFolders.has(folderKey)) throw Object.assign(new Error('导出目录存在重名：请调整重复 SKU、平台名称或目标 ID 后重新预览；未覆盖任何已有图片。'), { statusCode: 409, code: 'EXPORT_PATH_COLLISION' });
        usedFolders.add(folderKey);
        const imageRows = buildImageRows({ task, skuTask, target, baseFolder: folder, options: normalized });
        skuPackages.push({ sku, skuTask: sanitizeValue(skuTask), task, platformId, target, folder, imageRows,
          manifest: buildSkuManifest({ task, skuTask, target, imageRows }) });
      }
    }
  }

  let sourceFilesChecked = 0;
  for (const image of skuPackages.flatMap(pkg => pkg.imageRows)) {
    if (!image.exists) continue;
    sourceFilesChecked++;
    try {
      const { bytes, input, meta } = await readExportSource(image.sourceFilePath);
      await input.stats(); // Full decode, including truncated-image checks; no output file.
      Object.assign(image, { sourceSha256: sha256(bytes), sourceFormat: meta.format, sourceBytes: bytes.length });
    } catch (error) {
      image.exists = false; image.errorCode = error.exportImageCode || 'IMAGE_DECODE_FAILED';
      image.warnings.push('源图预检失败，请按 errorCode 修复文件后重新预览。');
    }
  }
  const summary = summarize({
    batch,
    platforms: normalized.platforms,
    skuPackages,
    failedSku,
    includeReports: normalized.includeReports
  });
  const warnings = packageWarnings(summary, failedSku);
  if (targetWarnings.length) warnings.push('部分图片目标归属不明确，未借用到其他站点或语言；请核对 targetWarnings 后补齐归属。');

  return {
    batch,
    tasks,
    options: normalized,
    skuPackages,
    failedSku,
    summary,
    targetWarnings,
    preflight: { checkedAt: nowIso(), sourceFilesChecked, noSourceWrite: true },
    warnings,
    reports: normalized.includeReports
      ? buildReports({
          batch,
          tasks,
          failedSku,
          listingArtifacts: await buildListingArtifacts(batch.id, {
            platforms: normalized.platforms,
            includeMockImages: normalized.includeMockImages,
            includeRealSamples: normalized.includeRealSamples
          }, { snapshot: { batch, tasks } })
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
        sourceType: image.sourceType,
        targetId: image.targetId, site: image.site, language: image.language,
        ...(image.errorCode ? { errorCode: image.errorCode } : {}), ...(image.exclusionCode ? { exclusionCode: image.exclusionCode } : {})
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
    preflight: model.preflight,
    targetWarnings: model.targetWarnings,
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

const imageProblem = code => Object.assign(new Error(code), { exportImageCode: code });
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
export async function readExportSource(relativePath) {
  const source = safeSourcePath(relativePath);
  if (!source) throw imageProblem('SOURCE_PATH_REJECTED');
  let canonical, stat, bytes;
  try {
    canonical = await fs.realpath(source);
    const root = await fs.realpath(paths.rootDir), relative = path.relative(root, canonical);
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw imageProblem('SOURCE_PATH_REJECTED');
    stat = await fs.stat(canonical);
    if (!stat.isFile()) throw imageProblem('SOURCE_FILE_NOT_REGULAR');
    if (stat.size > 50 * 1024 * 1024) throw imageProblem('SOURCE_FILE_TOO_LARGE');
    bytes = await fs.readFile(canonical);
    if (bytes.length > 50 * 1024 * 1024) throw imageProblem('SOURCE_FILE_TOO_LARGE');
  } catch (error) { throw error.exportImageCode ? error : imageProblem(error.code === 'ENOENT' ? 'SOURCE_FILE_MISSING' : 'SOURCE_READ_FAILED'); }
  try {
    const input = sharp(bytes, { limitInputPixels: 40_000_000, failOn: 'warning' });
    const meta = await input.metadata();
    if ((meta.pages || 1) > 1) throw imageProblem('IMAGE_MULTIPAGE_UNSUPPORTED');
    if (!['jpeg', 'png', 'webp', 'avif', 'heif', 'tiff'].includes(meta.format)) throw imageProblem('IMAGE_FORMAT_UNSUPPORTED');
    return { bytes, input, meta, sourcePath: canonical };
  } catch (error) { throw error.exportImageCode ? error : imageProblem('IMAGE_DECODE_FAILED'); }
}

async function writeExportJpeg(relativePath, destination) {
  const { bytes, input } = await readExportSource(relativePath);
  let output, info;
  try { ({ data: output, info } = await input.rotate().flatten({ background: '#ffffff' }).toColourspace('srgb').jpeg({ quality: 95 }).toBuffer({ resolveWithObject: true })); }
  catch { throw imageProblem('IMAGE_DECODE_FAILED'); }
  let handle;
  try { handle = await fs.open(destination, 'wx'); await handle.writeFile(output); await handle.close(); handle = null; }
  catch {
    if (handle) {
      await handle.close().catch(() => {});
      try { await fs.unlink(destination); }
      catch { throw Object.assign(new Error('导出写入失败且未完成文件无法清理，请检查磁盘和权限后重试。'), { fatalExport: true }); }
    }
    throw imageProblem('OUTPUT_WRITE_FAILED');
  }
  return { sourceSha256: sha256(bytes), sha256: sha256(output), bytes: output.length, format: 'jpeg', width: info.width, height: info.height };
}

async function hashFile(file) {
  const hash = createHash('sha256'); let bytes = 0;
  for await (const chunk of fsSync.createReadStream(file)) { hash.update(chunk); bytes += chunk.length; }
  return { sha256: hash.digest('hex'), bytes };
}

async function zipDirectory(sourceDir, zipPath, packageId) {
  await new Promise((resolve, reject) => {
    const output = fsSync.createWriteStream(zipPath);
    const archive = archiver('zip', { zlib: { level: 9 } });
    let failed = false;
    const fail = error => { if (failed) return; failed = true; archive.abort(); output.destroy(); reject(error); };
    output.on('close', resolve);
    output.on('error', fail);
    archive.on('error', fail);
    archive.on('warning', fail);
    archive.pipe(output);
    archive.directory(sourceDir, packageId);
    archive.finalize().catch(fail);
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
  grantAsset(packageRoot, 'batch', batchId);
  grantAsset(zipPath, 'batch', batchId);
  await fs.mkdir(path.dirname(packageRoot), { recursive: true });
  await fs.mkdir(packageRoot, { recursive: false });

  for (const pkg of model.skuPackages) {
    const folderPath = path.join(packageRoot, pkg.folder);
    await fs.mkdir(folderPath, { recursive: true });
    for (const image of pkg.imageRows) {
      if (!image.exists) continue;
      try {
        Object.assign(image, await writeExportJpeg(image.sourceFilePath, path.join(folderPath, image.fileName)));
      } catch (error) {
        if (error.fatalExport) throw error;
        image.exists = false;
        image.errorCode = error.exportImageCode || 'OUTPUT_WRITE_FAILED';
        image.warnings = [...asArray(image.warnings), '图片导出失败，已在 manifest 中标记 missing；请按 errorCode 检查源图后重新导出。'];
      }
    }
    await writeJson(path.join(folderPath, 'manifest.json'), {
      ...pkg.manifest,
      images: pkg.imageRows.map(({ sourceFilePath, zipPath: _zipPath, ...image }) => image)
    });
  }

  // File I/O is authoritative: do not return the earlier optimistic preview.
  model.summary = summarize({ batch: model.batch, platforms: model.options.platforms, skuPackages: model.skuPackages, failedSku: model.failedSku, includeReports: model.options.includeReports });
  model.warnings = packageWarnings(model.summary, model.failedSku);
  if (model.targetWarnings.length) model.warnings.push('部分图片目标归属不明确，未借用到其他站点或语言；请核对 targetWarnings 后补齐归属。');
  if (model.options.includeReports) {
    const imagePaths = new Map(model.skuPackages.flatMap(pkg => pkg.imageRows.map(image => [exportImageKey(image.taskId, image.targetId, image.imageType), image.exists ? image.zipPath : ''])));
    model.reports = buildReports({ batch: model.batch, tasks: model.tasks, failedSku: model.failedSku,
      listingArtifacts: await buildListingArtifacts(model.batch.id, { platforms: model.options.platforms, includeMockImages: model.options.includeMockImages, includeRealSamples: model.options.includeRealSamples }, { imagePaths, snapshot: { batch: model.batch, tasks: model.tasks } }) });
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
      fileList.push({ path: image.zipPath, exists: image.exists, sourceType: image.sourceType, imageType: image.imageType, targetId:image.targetId,site:image.site,language:image.language, ...(image.sha256 ? { sha256: image.sha256, bytes: image.bytes } : {}), ...(image.errorCode ? { errorCode: image.errorCode } : {}), ...(image.exclusionCode ? { exclusionCode:image.exclusionCode } : {}) });
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
    targets: model.skuPackages.map(pkg => ({ taskId: pkg.task.id, sku: pkg.manifest.sku, targetId: pkg.target.id, platformId: pkg.platformId, site: pkg.target.site, language: pkg.target.language, folder: pkg.folder, placeholder: Boolean(pkg.target.placeholder) })),
    targetWarnings: model.targetWarnings,
    totalSku: model.summary.totalSku,
    successSku: model.summary.successSku,
    failedSku: model.summary.failedSku,
    missingImageCount: model.summary.missingImageCount,
    mockImageCount: model.summary.mockImageCount,
    realImageCount: model.summary.realImageCount,
    fallbackMockImageCount: model.summary.fallbackMockImageCount,
    realSampleImageCount: model.summary.realSampleImageCount,
    readyImageCount: model.summary.readyImageCount,
    totalExpectedImages: model.summary.totalExpectedImages,
    imageErrorCount: model.summary.imageErrorCount,
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
    ...(await hashFile(zipPath)),
    summary: model.summary,
    directoryTree: fileList.map(file => ({ path: file.path, status: file.exists ? 'ready' : 'missing', sourceType: file.sourceType, targetId:file.targetId,site:file.site,language:file.language, ...(file.errorCode ? { errorCode: file.errorCode } : {}), ...(file.exclusionCode ? { exclusionCode:file.exclusionCode } : {}) })),
    preflight:model.preflight,targetWarnings:model.targetWarnings,
    warnings: model.warnings,
    failedSku: model.failedSku
  });
}
