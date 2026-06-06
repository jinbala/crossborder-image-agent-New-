import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { nanoid } from 'nanoid';
import archiver from 'archiver';
import fsSync from 'node:fs';
import { BATCH_STATUS, aggregateBatchStatus } from '../constants/batchStatus.js';
import { TASK_STATUS } from '../constants/taskStatus.js';
import {
  createBatchTask,
  createTask,
  getBatchTask,
  getTask,
  listBatchTasks,
  markImportedFolders,
  paths,
  updateBatchTask,
  updateTask
} from './db.js';
import { decodeOriginalFileName, getDisplayFileName, sanitizeStorageFileName } from '../utils/fileNameUtils.js';
import { normalizeTargets, targetSlug } from './targetService.js';
import { getProviders } from '../providers/index.js';
import { getReviewProvider } from '../providers/review/index.js';
import { toLegacyProductInfo } from '../providers/vision/normalizeVisionResult.js';
import { generateImagePlans } from './imagePlanService.js';
import { buildGenerationRequest } from './generationRequestService.js';
import { buildExportPrompts, buildMasterMetadata, buildTargetExportMetadata } from './exportService.js';
import { computeBatchAnalytics } from './batchAnalyticsService.js';

const SUPPORTED_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp']);
const MAX_IMAGE_COUNT = 15;
const MAX_IMAGE_SIZE = 10 * 1024 * 1024;
const MAX_SKU_TOTAL_SIZE = 100 * 1024 * 1024;

function nowIso() {
  return new Date().toISOString();
}

function resultForSku(sku, patch = {}) {
  return {
    skuId: sku.skuId,
    taskId: sku.taskId,
    action: patch.action,
    status: patch.status || sku.status,
    success: Boolean(patch.success),
    skipped: Boolean(patch.skipped),
    error: patch.error || null,
    message: patch.message || ''
  };
}

function supportedImageFile(fileName) {
  return SUPPORTED_EXTENSIONS.has(path.extname(fileName).toLowerCase());
}

async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function listSkuFolders(folderPath) {
  const resolved = path.resolve(folderPath);
  const stat = await fs.stat(resolved);
  if (!stat.isDirectory()) {
    const error = new Error('folderPath must be a directory');
    error.statusCode = 400;
    throw error;
  }
  const entries = await fs.readdir(resolved, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory())
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((entry) => ({
      folderName: entry.name,
      folderPath: path.join(resolved, entry.name)
    }));
}

async function createSourceImagesFromFolder({ folderPath, taskId }) {
  const entries = await fs.readdir(folderPath, { withFileTypes: true });
  const warnings = [];
  const imageEntries = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isFile()) continue;
    if (!supportedImageFile(entry.name)) {
      warnings.push({ code: 'UNSUPPORTED_FILE_SKIPPED', message: `Skipped unsupported file: ${entry.name}` });
      continue;
    }
    imageEntries.push(entry);
  }
  if (!imageEntries.length) {
    return { sourceImages: [], warnings: [...warnings, { code: 'EMPTY_SKU_FOLDER', message: 'No supported images found in SKU folder' }] };
  }
  if (imageEntries.length > MAX_IMAGE_COUNT) {
    return {
      sourceImages: [],
      warnings,
      error: { code: 'TOO_MANY_IMAGES', message: `最多只能导入 ${MAX_IMAGE_COUNT} 张商品图片` }
    };
  }
  const totalSize = await imageEntries.reduce(async (sumPromise, entry) => {
    const sum = await sumPromise;
    const stat = await fs.stat(path.join(folderPath, entry.name));
    return sum + stat.size;
  }, Promise.resolve(0));
  if (totalSize > MAX_SKU_TOTAL_SIZE) {
    return {
      sourceImages: [],
      warnings,
      error: { code: 'SKU_TOTAL_TOO_LARGE', message: '单个 SKU 图片总大小不能超过 100MB' }
    };
  }
  await fs.mkdir(paths.uploadDir, { recursive: true });
  const sourceImages = [];
  for (const [index, entry] of imageEntries.entries()) {
    const sourcePath = path.join(folderPath, entry.name);
    const stat = await fs.stat(sourcePath);
    if (stat.size > MAX_IMAGE_SIZE) {
      warnings.push({ code: 'IMAGE_TOO_LARGE_SKIPPED', message: `${entry.name} exceeds 10MB and was skipped` });
      continue;
    }
    let metadata;
    try {
      metadata = await sharp(sourcePath).metadata();
      if (!metadata.width || !metadata.height || !['jpeg', 'png', 'webp'].includes(metadata.format)) {
        warnings.push({ code: 'INVALID_IMAGE_SKIPPED', message: `${entry.name} is not a valid jpg/png/webp image` });
        continue;
      }
    } catch {
      warnings.push({ code: 'INVALID_IMAGE_SKIPPED', message: `${entry.name} is not a readable image` });
      continue;
    }
    const originalName = decodeOriginalFileName(entry.name);
    const displayName = getDisplayFileName(entry.name, index);
    const storageName = sanitizeStorageFileName(entry.name, `${Date.now()}-${nanoid(8)}`);
    const uploadPath = path.join(paths.uploadDir, storageName);
    await fs.copyFile(sourcePath, uploadPath);
    sourceImages.push({
      id: `${taskId}-source-${sourceImages.length + 1}`,
      role: sourceImages.length === 0 ? 'main' : 'source',
      imageIndex: sourceImages.length,
      fileName: storageName,
      storedName: storageName,
      originalName,
      displayName,
      filePath: path.relative(paths.rootDir, uploadPath).replaceAll('\\', '/'),
      url: `/uploads/${storageName}`,
      previewUrl: `/uploads/${storageName}`,
      mimeType: `image/${metadata.format === 'jpeg' ? 'jpeg' : metadata.format}`,
      size: stat.size,
      width: metadata.width,
      height: metadata.height,
      format: metadata.format
    });
  }
  if (!sourceImages.length && !warnings.some((warning) => warning.code === 'EMPTY_SKU_FOLDER')) {
    warnings.push({ code: 'NO_VALID_IMAGES', message: 'No valid images were imported for this SKU' });
  }
  return { sourceImages, warnings };
}

function buildBatchSummary(batchTask, tasks = []) {
  const taskById = Object.fromEntries(tasks.map((task) => [task.id, task]));
  const platforms = new Set();
  let totalImages = 0;
  for (const sku of batchTask.skuTasks || []) {
    totalImages += sku.imageCount || 0;
    const task = taskById[sku.taskId];
    for (const target of task?.targets || batchTask.defaultTargets || []) {
      if (target.platformId) platforms.add(target.platformId);
    }
  }
  return {
    totalSku: batchTask.skuTasks?.length || 0,
    completedSku: (batchTask.skuTasks || []).filter((sku) => ['completed', 'exported'].includes(sku.status)).length,
    failedSku: (batchTask.skuTasks || []).filter((sku) => sku.status === 'failed').length,
    waitingConfirmSku: (batchTask.skuTasks || []).filter((sku) => sku.status === 'recognized' || sku.currentStep === 'waiting_confirm').length,
    totalImages,
    platforms: [...platforms]
  };
}

export function defaultBatchQueue() {
  return {
    enabled: true,
    action: null,
    status: 'idle',
    concurrency: Number(process.env.BATCH_DEFAULT_CONCURRENCY || 2),
    startedAt: null,
    finishedAt: null,
    pausedAt: null,
    resumedAt: null,
    totalJobs: 0,
    pendingJobs: 0,
    runningJobs: 0,
    completedJobs: 0,
    failedJobs: 0,
    skippedJobs: 0
  };
}

export function defaultBatchLocks() {
  return {
    isRunning: false,
    lockedBy: null,
    lockedAt: null,
    expiresAt: null
  };
}

export function normalizeBatchTask(batchTask = {}) {
  return {
    ...batchTask,
    queue: {
      ...defaultBatchQueue(),
      ...(batchTask.queue || {})
    },
    locks: {
      ...defaultBatchLocks(),
      ...(batchTask.locks || {})
    },
    executionLogs: Array.isArray(batchTask.executionLogs) ? batchTask.executionLogs.slice(-500) : [],
    analytics: batchTask.analytics || null
  };
}

async function hydrateBatch(batchTask) {
  const normalizedBatch = normalizeBatchTask(batchTask);
  const tasks = [];
  for (const sku of normalizedBatch.skuTasks || []) {
    if (!sku.taskId) continue;
    const task = await getTask(sku.taskId);
    if (task) tasks.push(task);
  }
  return {
    ...normalizedBatch,
    summary: buildBatchSummary(normalizedBatch, tasks)
  };
}

async function saveBatchSkuTasks(batchId, skuTasks, statusFallback) {
  const batchTask = await updateBatchTask(batchId, (current) => ({
    skuTasks,
    status: aggregateBatchStatus(skuTasks, statusFallback || current.status || BATCH_STATUS.IMPORTED),
    summary: buildBatchSummary({ ...current, skuTasks })
  }));
  return hydrateBatch(batchTask);
}

export async function listBatches() {
  const batches = await listBatchTasks();
  return Promise.all(batches.map(hydrateBatch));
}

export async function getBatch(batchId) {
  const batchTask = await getBatchTask(batchId);
  if (!batchTask) return null;
  return hydrateBatch(batchTask);
}

export async function importBatchFolder({ folderPath, name, defaultTargets = [] }) {
  if (!folderPath) {
    const error = new Error('folderPath is required');
    error.statusCode = 400;
    throw error;
  }
  if (!(await pathExists(folderPath))) {
    const error = new Error('folderPath does not exist');
    error.statusCode = 400;
    throw error;
  }
  const skuFolders = await listSkuFolders(folderPath);
  return importBatchSkuFolders({
    skuFolders,
    name,
    defaultTargets,
    sourceType: 'folder_import',
    folderPath: path.resolve(folderPath)
  });
}

export async function importBatchSkuFolders({
  skuFolders = [],
  name,
  defaultTargets = [],
  sourceType = 'folder_import',
  folderPath = null
}) {
  const batchId = `batch-${nanoid(10)}`;
  const createdAt = nowIso();
  const skuTasks = [];
  const createdTasks = [];
  for (const folder of skuFolders) {
    const skuId = folder.folderName;
    const taskId = nanoid(12);
    const importResult = await createSourceImagesFromFolder({ folderPath: folder.folderPath, taskId });
    if (importResult.error || !importResult.sourceImages.length) {
      skuTasks.push({
        skuId,
        taskId: null,
        folderName: folder.folderName,
        sourceFolderPath: path.resolve(folder.folderPath),
        displayName: folder.folderName,
        imageCount: 0,
        status: 'failed',
        currentStep: 'import',
        error: importResult.error || { code: 'NO_VALID_IMAGES', message: 'No valid images found' },
        warnings: importResult.warnings || [],
        createdAt,
        updatedAt: createdAt
      });
      continue;
    }
    const task = await createTask({
      id: taskId,
      batchId,
      sku: skuId,
      status: TASK_STATUS.UPLOADED,
      sourceImages: importResult.sourceImages,
      originalImage: importResult.sourceImages[0],
      productInfoRaw: null,
      productInfoConfirmed: null,
      productInfo: null,
      visibleText: [],
      risks: [],
      confidence: {},
      fieldEvidence: {},
      inferredCandidates: [],
      targets: [],
      platform: 'Amazon',
      platformId: 'amazon',
      language: 'English',
      imagePlans: [],
      generatedImages: [],
      review: null,
      reviewResults: [],
      exports: [],
      exportFile: null,
      createdAt,
      updatedAt: createdAt
    });
    createdTasks.push(task);
    skuTasks.push({
      skuId,
      taskId,
      folderName: folder.folderName,
      sourceFolderPath: path.resolve(folder.folderPath),
      displayName: folder.folderName,
      imageCount: importResult.sourceImages.length,
      status: TASK_STATUS.UPLOADED,
      currentStep: 'uploaded',
      error: null,
      warnings: importResult.warnings || [],
      createdAt,
      updatedAt: createdAt
    });
  }
  const batchTask = await createBatchTask({
    id: batchId,
    name: name || `Batch ${batchId}`,
    status: BATCH_STATUS.IMPORTED,
    createdAt,
    updatedAt: createdAt,
    sourceType,
    folderPath: folderPath ? path.resolve(folderPath) : null,
    defaultTargets,
    skuTasks,
    summary: buildBatchSummary({ skuTasks, defaultTargets }),
    analytics: null
  });
  const importedRecords = skuTasks
    .filter((sku) => sku.taskId && sku.sourceFolderPath)
    .map((sku) => ({
      folderPath: sku.sourceFolderPath,
      folderName: sku.folderName,
      importedAt: createdAt,
      batchId,
      taskIds: [sku.taskId]
    }));
  if (importedRecords.length) {
    await markImportedFolders(importedRecords);
  }
  return {
    batchTask: await hydrateBatch(batchTask),
    createdTasks
  };
}

async function updateSkuFromTask(sku, task, patch = {}) {
  return {
    ...sku,
    taskId: task?.id || sku.taskId,
    status: patch.status || task?.status || sku.status,
    currentStep: patch.currentStep || task?.status || sku.currentStep,
    imageCount: task?.sourceImages?.length ?? sku.imageCount,
    error: patch.error === undefined ? null : patch.error,
    warnings: [...(sku.warnings || []), ...(patch.warnings || [])],
    updatedAt: nowIso()
  };
}

export async function recognizeBatch(batchId) {
  const batch = await getBatch(batchId);
  if (!batch) {
    const error = new Error('Batch task not found');
    error.statusCode = 404;
    throw error;
  }
  const providers = getProviders();
  const results = [];
  const skuTasks = [];
  for (const sku of batch.skuTasks || []) {
    if (!sku.taskId) {
      const result = resultForSku(sku, { action: 'recognize', skipped: true, message: 'SKU has no task due to import failure' });
      results.push(result);
      skuTasks.push(sku);
      continue;
    }
    const task = await getTask(sku.taskId);
    if (!task || task.status !== TASK_STATUS.UPLOADED) {
      const result = resultForSku(sku, { action: 'recognize', skipped: true, message: `Skipped: task status is ${task?.status || 'missing'}` });
      results.push(result);
      skuTasks.push(sku);
      continue;
    }
    try {
      const recognition = await providers.vision.recognize({ task, image: task.sourceImages?.[0], images: task.sourceImages || [] });
      if (recognition?.status !== 'success' && recognition?.status !== 'succeeded') {
        throw new Error(recognition.error?.message || 'Recognition failed');
      }
      const { productInfoRaw, visibleText, risks, confidence, notes = [], fieldEvidence = {}, inferredCandidates = [] } = recognition.data;
      const productInfoRawWithNotes = { ...productInfoRaw, notes: productInfoRaw?.notes || notes };
      const productInfoForForm = productInfoRawWithNotes.name
        ? productInfoRawWithNotes
        : toLegacyProductInfo(productInfoRawWithNotes, visibleText, risks);
      const updatedTask = await updateTask(task.id, () => ({
        productInfoRaw: productInfoRawWithNotes,
        productInfo: productInfoForForm,
        visibleText,
        risks,
        confidence,
        fieldEvidence,
        inferredCandidates,
        recognitionMeta: {
          provider: recognition.provider,
          model: recognition.model,
          durationMs: recognition.durationMs,
          status: recognition.status,
          error: recognition.error
        },
        sku: productInfoForForm.sku || task.sku,
        status: TASK_STATUS.RECOGNIZED
      }));
      const nextSku = await updateSkuFromTask(sku, updatedTask, { currentStep: 'waiting_confirm' });
      skuTasks.push(nextSku);
      results.push(resultForSku(nextSku, { action: 'recognize', success: true, message: 'Recognition completed' }));
    } catch (err) {
      const errorPayload = { code: err.payload?.code || err.code || 'RECOGNITION_FAILED', message: err.payload?.message || err.message };
      const failedSku = { ...sku, status: 'failed', currentStep: 'recognize', error: errorPayload, updatedAt: nowIso() };
      skuTasks.push(failedSku);
      results.push(resultForSku(failedSku, { action: 'recognize', success: false, error: errorPayload, message: errorPayload.message }));
    }
  }
  const batchTask = await saveBatchSkuTasks(batchId, skuTasks, BATCH_STATUS.WAITING_CONFIRM);
  return { batchTask, results };
}

export async function applyTargetsToBatch(batchId, defaultTargets = []) {
  const batch = await getBatch(batchId);
  if (!batch) {
    const error = new Error('Batch task not found');
    error.statusCode = 404;
    throw error;
  }
  const results = [];
  const skuTasks = [];
  let normalizedDefaults = defaultTargets;
  for (const sku of batch.skuTasks || []) {
    if (!sku.taskId) {
      results.push(resultForSku(sku, { action: 'apply-targets', skipped: true, message: 'SKU has no task due to import failure' }));
      skuTasks.push(sku);
      continue;
    }
    const task = await getTask(sku.taskId);
    if (!task || ![TASK_STATUS.CONFIRMED, TASK_STATUS.RULES_SELECTED].includes(task.status)) {
      results.push(resultForSku(sku, { action: 'apply-targets', skipped: true, message: `Skipped: task status is ${task?.status || 'missing'}` }));
      skuTasks.push(sku);
      continue;
    }
    const productInfo = task.productInfoConfirmed || task.productInfo || {};
    const targets = normalizeTargets(defaultTargets?.length ? defaultTargets : batch.defaultTargets, { productInfo, fallbackTask: task });
    normalizedDefaults = targets;
    const primaryTarget = targets[0];
    const updatedTask = await updateTask(task.id, () => ({
      targets,
      platform: primaryTarget.platformName,
      platformId: primaryTarget.platformId,
      site: primaryTarget.site,
      language: primaryTarget.language,
      category: primaryTarget.category,
      categoryId: primaryTarget.categoryId,
      status: TASK_STATUS.RULES_SELECTED
    }));
    const nextSku = await updateSkuFromTask(sku, updatedTask);
    skuTasks.push(nextSku);
    results.push(resultForSku(nextSku, { action: 'apply-targets', success: true, message: 'Targets applied' }));
  }
  const batchTask = await updateBatchTask(batchId, (current) => ({
    defaultTargets: normalizedDefaults?.length ? normalizedDefaults : current.defaultTargets,
    skuTasks,
    status: aggregateBatchStatus(skuTasks, BATCH_STATUS.IMPORTED),
    summary: buildBatchSummary({ ...current, skuTasks, defaultTargets: normalizedDefaults })
  }));
  return { batchTask: await hydrateBatch(batchTask), results };
}

export async function planBatch(batchId) {
  const batch = await getBatch(batchId);
  if (!batch) throw Object.assign(new Error('Batch task not found'), { statusCode: 404 });
  const results = [];
  const skuTasks = [];
  for (const sku of batch.skuTasks || []) {
    const task = sku.taskId ? await getTask(sku.taskId) : null;
    if (!task || ![TASK_STATUS.RULES_SELECTED, TASK_STATUS.PLANNED].includes(task.status)) {
      results.push(resultForSku(sku, { action: 'plan', skipped: true, message: `Skipped: task status is ${task?.status || 'missing'}` }));
      skuTasks.push(sku);
      continue;
    }
    try {
      const imagePlans = generateImagePlans(task);
      const updatedTask = await updateTask(task.id, () => ({
        imagePlans,
        generatedImages: [],
        reviewResults: [],
        review: null,
        exports: [],
        exportFile: null,
        status: TASK_STATUS.PLANNED
      }));
      const nextSku = await updateSkuFromTask(sku, updatedTask);
      skuTasks.push(nextSku);
      results.push(resultForSku(nextSku, { action: 'plan', success: true, message: `${imagePlans.length} plans created` }));
    } catch (err) {
      const errorPayload = { code: 'PLAN_FAILED', message: err.message };
      const failedSku = { ...sku, status: 'failed', currentStep: 'plan', error: errorPayload, updatedAt: nowIso() };
      skuTasks.push(failedSku);
      results.push(resultForSku(failedSku, { action: 'plan', error: errorPayload, message: err.message }));
    }
  }
  const batchTask = await saveBatchSkuTasks(batchId, skuTasks, BATCH_STATUS.PLANNING);
  return { batchTask, results };
}

export async function generateBatch(batchId, { mode = 'mock' } = {}) {
  const batch = await getBatch(batchId);
  if (!batch) throw Object.assign(new Error('Batch task not found'), { statusCode: 404 });
  const providers = getProviders();
  const results = [];
  const skuTasks = [];
  for (const sku of batch.skuTasks || []) {
    const task = sku.taskId ? await getTask(sku.taskId) : null;
    if (!task || ![TASK_STATUS.PLANNED, TASK_STATUS.GENERATED].includes(task.status)) {
      results.push(resultForSku(sku, { action: 'generate', skipped: true, message: `Skipped: task status is ${task?.status || 'missing'}` }));
      skuTasks.push(sku);
      continue;
    }
    try {
      const generatedImages = [];
      for (const [index, plan] of (task.imagePlans || []).entries()) {
        const result = await providers.image.generate({ task, plan, outputIndex: index + 1, mode });
        if (result.status !== 'succeeded') throw new Error(result.error || `Image generation failed for ${plan.id}`);
        generatedImages.push({ ...result.data, durationMs: result.durationMs, provider: result.provider, model: result.model, status: result.status });
      }
      const updatedTask = await updateTask(task.id, () => ({
        generatedImages,
        reviewResults: [],
        review: null,
        exports: [],
        exportFile: null,
        status: TASK_STATUS.GENERATED
      }));
      const nextSku = await updateSkuFromTask(sku, updatedTask);
      skuTasks.push(nextSku);
      results.push(resultForSku(nextSku, { action: 'generate', success: true, message: `${generatedImages.length} images generated` }));
    } catch (err) {
      const errorPayload = { code: 'GENERATE_FAILED', message: err.message };
      const failedSku = { ...sku, status: 'failed', currentStep: 'generate', error: errorPayload, updatedAt: nowIso() };
      skuTasks.push(failedSku);
      results.push(resultForSku(failedSku, { action: 'generate', error: errorPayload, message: err.message }));
    }
  }
  const batchTask = await saveBatchSkuTasks(batchId, skuTasks, BATCH_STATUS.GENERATING);
  return { batchTask, results };
}

export async function reviewBatch(batchId, { mode = 'mock' } = {}) {
  const batch = await getBatch(batchId);
  if (!batch) throw Object.assign(new Error('Batch task not found'), { statusCode: 404 });
  const reviewProvider = getReviewProvider(mode === 'real' ? 'real' : 'mock');
  const mockReviewProvider = getReviewProvider('mock');
  const results = [];
  const skuTasks = [];
  for (const sku of batch.skuTasks || []) {
    const task = sku.taskId ? await getTask(sku.taskId) : null;
    if (!task || ![TASK_STATUS.GENERATED, TASK_STATUS.REVIEWED].includes(task.status)) {
      results.push(resultForSku(sku, { action: 'review', skipped: true, message: `Skipped: task status is ${task?.status || 'missing'}` }));
      skuTasks.push(sku);
      continue;
    }
    try {
      const reviewResults = [];
      for (const image of task.generatedImages || []) {
        const plan = (task.imagePlans || []).find((item) => item.id === image.planId);
        const generationRequest = image.generationRequest || (plan ? buildGenerationRequest({ task, plan }) : null);
        let result = await reviewProvider.review({ task, image, plan, generationRequest });
        if ((result?.status !== 'success' && result?.status !== 'succeeded') && mode === 'real') {
          result = await mockReviewProvider.review({ task, image, plan, generationRequest, fallbackToMockReview: true, realReviewError: result.error });
        }
        if (result?.status !== 'success' && result?.status !== 'succeeded') throw new Error(result.error?.message || 'Review failed');
        reviewResults.push({ ...result.data, durationMs: result.durationMs, provider: result.provider, model: result.model });
      }
      const review = {
        reviewedAt: nowIso(),
        reviewMode: mode,
        overallStatus: reviewResults.every((item) => item.status === 'passed') ? 'passed' : 'failed',
        items: reviewResults
      };
      const updatedTask = await updateTask(task.id, () => ({ reviewResults, review, status: TASK_STATUS.REVIEWED }));
      const nextSku = await updateSkuFromTask(sku, updatedTask);
      skuTasks.push(nextSku);
      results.push(resultForSku(nextSku, { action: 'review', success: true, message: `${reviewResults.length} images reviewed` }));
    } catch (err) {
      const errorPayload = { code: 'REVIEW_FAILED', message: err.message };
      const failedSku = { ...sku, status: 'failed', currentStep: 'review', error: errorPayload, updatedAt: nowIso() };
      skuTasks.push(failedSku);
      results.push(resultForSku(failedSku, { action: 'review', error: errorPayload, message: err.message }));
    }
  }
  const batchTask = await saveBatchSkuTasks(batchId, skuTasks, BATCH_STATUS.REVIEWING);
  return { batchTask, results };
}

export async function createBatchExportZip(batchId) {
  const batch = await getBatch(batchId);
  if (!batch) throw Object.assign(new Error('Batch task not found'), { statusCode: 404 });
  const exportDir = path.join(paths.outputDir, batch.id);
  await fs.mkdir(exportDir, { recursive: true });
  const zipName = `${batch.id}_batch-export.zip`;
  const zipPath = path.join(exportDir, zipName);
  const exportedAt = nowIso();
  const skuSummaries = [];
  const taskMasterMetadata = [];
  await new Promise((resolve, reject) => {
    const output = fsSync.createWriteStream(zipPath);
    const archive = archiver('zip', { zlib: { level: 9 } });
    output.on('close', resolve);
    archive.on('error', reject);
    archive.pipe(output);
    (async () => {
      try {
        for (const sku of batch.skuTasks || []) {
          if (!sku.taskId) {
            skuSummaries.push({ skuId: sku.skuId, taskId: null, status: sku.status, error: sku.error });
            continue;
          }
          const task = await getTask(sku.taskId);
          if (!task || ![TASK_STATUS.REVIEWED, TASK_STATUS.EXPORTED].includes(task.status)) {
            skuSummaries.push({ skuId: sku.skuId, taskId: sku.taskId, status: task?.status || 'missing', skipped: true });
            continue;
          }
          const targets = normalizeTargets(task.targets || [], { productInfo: task.productInfoConfirmed || task.productInfo || {}, fallbackTask: task });
          const prompts = buildExportPrompts(task);
          for (const target of targets) {
            const folder = `${sku.skuId}/${targetSlug(target)}`;
            const targetMetadata = buildTargetExportMetadata(task, target.id);
            for (const image of targetMetadata.images || []) {
              if (image.filePath) {
                archive.file(path.join(paths.rootDir, image.filePath), { name: `${folder}/images/${image.fileName}` });
              }
            }
            archive.append(JSON.stringify(targetMetadata, null, 2), { name: `${folder}/metadata.json` });
            archive.append(JSON.stringify({
              ...prompts,
              targetId: target.id,
              generatedImages: targetMetadata.images
            }, null, 2), { name: `${folder}/prompts.json` });
            archive.append(JSON.stringify({
              reviewSummary: targetMetadata.reviewSummary,
              generatedImages: targetMetadata.images,
              reviewResults: targetMetadata.reviewResults
            }, null, 2), { name: `${folder}/review-report.json` });
            archive.append(JSON.stringify({
              packageName: zipName,
              createdAt: exportedAt,
              skuId: sku.skuId,
              targetId: target.id,
              files: (targetMetadata.images || []).map((image) => ({
                type: 'image',
                fileName: `images/${image.fileName}`,
                planId: image.planId,
                imageType: image.imageType,
                version: image.version
              }))
            }, null, 2), { name: `${folder}/manifest.json` });
          }
          taskMasterMetadata.push(buildMasterMetadata(task));
          skuSummaries.push({
            skuId: sku.skuId,
            taskId: sku.taskId,
            status: task.status,
            imageCount: task.generatedImages?.length || 0,
            platformCount: task.targets?.length || 1
          });
        }
        archive.append(JSON.stringify({
          batchId: batch.id,
          name: batch.name,
          exportedAt,
          workflowTemplateSnapshot: batch.workflowTemplateSnapshot || null,
          analytics: batch.analytics || await computeBatchAnalytics(batch),
          totalSku: batch.skuTasks?.length || 0,
          platforms: batch.summary?.platforms || [],
          skuTasks: batch.skuTasks,
          skuSummaries,
          taskMasterMetadata
        }, null, 2), { name: 'batch-master-metadata.json' });
        archive.finalize();
      } catch (err) {
        reject(err);
      }
    })();
  });
  const nextSkuTasks = (batch.skuTasks || []).map((sku) => (
    sku.taskId && skuSummaries.find((summary) => summary.taskId === sku.taskId && !summary.skipped)
      ? { ...sku, status: 'exported', currentStep: 'exported', updatedAt: nowIso() }
      : sku
  ));
  const batchTask = await updateBatchTask(batch.id, (current) => ({
    skuTasks: nextSkuTasks,
    status: aggregateBatchStatus(nextSkuTasks, BATCH_STATUS.COMPLETED),
    exportFile: {
      fileName: zipName,
      filePath: path.relative(paths.rootDir, zipPath).replaceAll('\\', '/'),
      createdAt: exportedAt,
      status: 'succeeded'
    },
    summary: buildBatchSummary({ ...current, skuTasks: nextSkuTasks })
  }));
  return {
    batchTask: await hydrateBatch(batchTask),
    exportFile: batchTask.exportFile,
    zipPath
  };
}
