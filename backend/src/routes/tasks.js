import express from 'express';
import multer from 'multer';
import path from 'node:path';
import fs from 'node:fs/promises';
import sharp from 'sharp';
import { nanoid } from 'nanoid';
import { asyncHandler } from '../utils/asyncHandler.js';
import { paths, createTask, getTask, listTasks, updateTask } from '../services/db.js';
import { generateImagePlans } from '../services/imagePlanService.js';
import { createExportZip } from '../services/exportService.js';
import { TASK_STATUS, TASK_TRANSITIONS, assertTaskStatus } from '../constants/taskStatus.js';
import { getPlatformRuleSnapshot, listPlatformRules, normalizePlatformId } from '../rules/platformRules.js';
import { getProviders } from '../providers/index.js';
import { getReviewProvider } from '../providers/review/index.js';
import { getProviderConfigSummary } from '../config/env.js';
import { decodeOriginalFileName, getDisplayFileName, sanitizeStorageFileName } from '../utils/fileNameUtils.js';
import { toLegacyProductInfo } from '../providers/vision/normalizeVisionResult.js';
import { refreshImagePlanPrompt } from '../prompts/imagePromptFactory.js';
import { buildGenerationRequest, generationRequestSummary } from '../services/generationRequestService.js';
import { extractSubjectWithFallback } from '../providers/matting/index.js';
import { normalizeCompositeSettings } from '../services/compositeSettingsService.js';
import { buildTextLayout, isProgrammaticTextLayoutType, normalizeTextLayoutOverride } from '../services/textLayoutService.js';
import { normalizeTargets } from '../services/targetService.js';
import { analyzeRecognitionQuality } from '../services/recognitionQualityService.js';
import { analyzeTemplateSet } from '../services/templateAuditService.js';
import { buildReviewReport } from '../services/reviewReportService.js';
import { buildAutoFixPlan } from '../services/autoFixPlanService.js';
import { executeApprovedAutoFixPlan, refreshPostFixValidation } from '../services/autoFixExecutionService.js';

const router = express.Router();
const MAX_IMAGE_COUNT = 15;
const MAX_TOTAL_UPLOAD_SIZE = 100 * 1024 * 1024;

const storage = multer.diskStorage({
  destination: (_req, _file, callback) => {
    fs.mkdir(paths.uploadDir, { recursive: true })
      .then(() => callback(null, paths.uploadDir))
      .catch(callback);
  },
  filename: (_req, file, callback) => {
    callback(null, sanitizeStorageFileName(file.originalname, `${Date.now()}-${nanoid(8)}`));
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, _file, callback) => callback(null, true)
});

async function requireTask(taskId) {
  const task = await getTask(taskId);
  if (!task) {
    const error = new Error('Task not found');
    error.statusCode = 404;
    throw error;
  }
  return task;
}

function withRecognitionQuality(task) {
  return {
    ...task,
    recognitionQuality: analyzeRecognitionQuality(task),
    normalizedReviewReport: buildReviewReport(task)
  };
}

async function validateUploadedImage(file) {
  try {
    const metadata = await sharp(file.path).metadata();
    if (!metadata.width || !metadata.height || !['jpeg', 'png', 'webp'].includes(metadata.format)) {
      throw new Error('Unsupported or invalid image file');
    }
    return metadata;
  } catch (error) {
    await fs.rm(file.path, { force: true });
    error.statusCode = 400;
    throw error;
  }
}

function currentProductInfo(task) {
  return task.productInfoConfirmed || task.productInfoRaw || task.productInfo;
}

function isProviderSuccess(result) {
  return result?.status === 'success' || result?.status === 'succeeded';
}

function cleanString(value, fallback = '') {
  if (value === undefined || value === null) return fallback;
  return String(value).trim();
}

function normalizeTextBlocks(value) {
  if (!Array.isArray(value)) return undefined;
  return value
    .map((block, index) => ({
      id: cleanString(block.id, `text-${index + 1}`),
      label: cleanString(block.label, 'Text'),
      text: cleanString(block.text),
      sourceFields: Array.isArray(block.sourceFields) ? block.sourceFields.map((field) => cleanString(field)).filter(Boolean) : []
    }))
    .filter((block) => block.text);
}

function normalizeRiskWarnings(value) {
  if (!Array.isArray(value)) return undefined;
  return value
    .map((warning) => ({
      field: cleanString(warning.field, 'general'),
      level: cleanString(warning.level, 'medium'),
      message: cleanString(warning.message || warning)
    }))
    .filter((warning) => warning.message);
}

function normalizeComplianceNotes(value) {
  if (!Array.isArray(value)) return undefined;
  return value.map((item) => cleanString(item)).filter(Boolean);
}

function allowedPlanEditStatuses() {
  return [TASK_STATUS.PLANNED, TASK_STATUS.GENERATED, TASK_STATUS.REVIEWED];
}

function allowedSingleGenerateStatuses() {
  return [TASK_STATUS.PLANNED, TASK_STATUS.GENERATED, TASK_STATUS.REVIEWED];
}

function allowedReferenceStatuses() {
  return [TASK_STATUS.PLANNED, TASK_STATUS.GENERATED, TASK_STATUS.REVIEWED];
}

function buildImagePlanPatch(body, existing) {
  const patch = {};
  if (body.title !== undefined) patch.title = cleanString(body.title, existing.title);
  if (body.goal !== undefined) {
    patch.goal = cleanString(body.goal, existing.goal);
    patch.description = patch.goal;
  }
  if (body.layout !== undefined) patch.layout = cleanString(body.layout, existing.layout);
  const textBlocks = normalizeTextBlocks(body.textBlocks);
  if (textBlocks) patch.textBlocks = textBlocks;
  const riskWarnings = normalizeRiskWarnings(body.riskWarnings);
  if (riskWarnings) patch.riskWarnings = riskWarnings;
  const complianceNotes = normalizeComplianceNotes(body.complianceNotes);
  if (complianceNotes) patch.complianceNotes = complianceNotes;
  if (body.compositeSettings !== undefined) {
    patch.compositeSettings = normalizeCompositeSettings({
      ...(existing.compositeSettings || {}),
      ...(body.compositeSettings || {})
    });
  }
  return patch;
}

async function updateSingleImagePlan(req, res) {
  const current = await requireTask(req.params.id);
  assertTaskStatus(current, allowedPlanEditStatuses(), 'Image plan editing');
  const planIndex = (current.imagePlans || []).findIndex((plan) => plan.id === req.params.planId);
  if (planIndex === -1) {
    const error = new Error('Image plan not found');
    error.statusCode = 404;
    throw error;
  }

  const existing = current.imagePlans[planIndex];
  const updatedPlan = {
    ...existing,
    ...buildImagePlanPatch(req.body, existing),
    version: (existing.version || 1) + 1,
    editedByUser: true,
    editedAt: new Date().toISOString()
  };
  updatedPlan.prompt = refreshImagePlanPrompt({
    plan: updatedPlan,
    productInfo: current.productInfoConfirmed,
    target: current.targets?.find((target) => target.id === updatedPlan.targetId) || current.targets?.[0]
  });
  const generationRequest = buildGenerationRequest({ task: current, plan: updatedPlan });
  updatedPlan.generationRequestSummary = generationRequestSummary(generationRequest);
  updatedPlan.textLayout = buildTextLayout({ task: current, plan: updatedPlan, generationRequest });
  const imagePlans = current.imagePlans.map((plan, index) => (index === planIndex ? updatedPlan : plan));
  const task = await updateTask(req.params.id, () => ({ imagePlans }));
  res.json({ task });
}

function requirePlanAndSource(task, planId, sourceImageId) {
  const planIndex = (task.imagePlans || []).findIndex((plan) => plan.id === planId);
  if (planIndex === -1) {
    const error = new Error('Image plan not found');
    error.statusCode = 404;
    throw error;
  }
  const plan = task.imagePlans[planIndex];
  if (plan.type !== 'lifestyle_image') {
    const error = new Error('Only lifestyle_image supports product reference selection');
    error.statusCode = 400;
    throw error;
  }
  const sourceImage = (task.sourceImages || []).find((image) => image.id === sourceImageId);
  if (!sourceImage) {
    const error = new Error('sourceImageId must belong to task.sourceImages');
    error.statusCode = 400;
    throw error;
  }
  return { plan, planIndex, sourceImage };
}

function productReferenceOverrideFromSource(sourceImage) {
  return {
    sourceImageId: sourceImage.id,
    imageIndex: sourceImage.imageIndex ?? 0,
    displayName: sourceImage.displayName || sourceImage.originalName || sourceImage.fileName || sourceImage.id,
    setByUser: true,
    setAt: new Date().toISOString()
  };
}

async function copyMattingPreviewFile(taskId, filePath, suffix) {
  if (!filePath) return null;
  const previewDir = path.join(paths.outputDir, taskId, 'matting-preview');
  await fs.mkdir(previewDir, { recursive: true });
  const fileName = `${Date.now()}-${nanoid(6)}-${suffix}.png`;
  const targetPath = path.join(previewDir, fileName);
  await fs.copyFile(filePath, targetPath);
  return {
    filePath: path.relative(paths.rootDir, targetPath).replaceAll('\\', '/'),
    previewUrl: `/outputs/${taskId}/matting-preview/${fileName}`
  };
}

router.get('/', asyncHandler(async (_req, res) => {
  const tasks = await listTasks();
  res.json({ tasks });
}));

router.get('/platform-rules', asyncHandler(async (_req, res) => {
  res.json(listPlatformRules());
}));

router.get('/provider-config', asyncHandler(async (_req, res) => {
  res.json(getProviderConfigSummary());
}));

router.get('/:id/template-audit', asyncHandler(async (req, res) => {
  const task = await requireTask(req.params.id);
  res.json({ templateAudit: analyzeTemplateSet(withRecognitionQuality(task)) });
}));

router.get('/:id/auto-fix-plan', asyncHandler(async (req, res) => {
  const task = await requireTask(req.params.id);
  const normalizedReviewReport = buildReviewReport(task);
  res.json({
    autoFixPlan: buildAutoFixPlan({
      task,
      normalizedReviewReport,
      fixSuggestions: normalizedReviewReport.fixSuggestions
    })
  });
}));

router.post('/:id/auto-fix-plan/execute', asyncHandler(async (req, res) => {
  const task = await requireTask(req.params.id);
  const normalizedReviewReport = buildReviewReport(task);
  const autoFixPlan = buildAutoFixPlan({
    task,
    normalizedReviewReport,
    fixSuggestions: normalizedReviewReport.fixSuggestions
  });
  const executionResult = executeApprovedAutoFixPlan({
    task,
    autoFixPlan,
    approvedActionIds: req.body?.approvedActionIds || [],
    options: {
      mode: req.body?.mode || 'textLayoutOnly',
      confirmExecute: req.body?.confirmExecute === true,
      confirmSave: req.body?.confirmSave === true,
      persist: req.body?.persist === true,
      dryRun: req.body?.dryRun === true
    }
  });
  if (req.body?.persist === true) {
    if (executionResult.summary.executedCount > 0) {
      try {
        const savedTask = await updateTask(req.params.id, () => ({
          imagePlans: executionResult.patchedImagePlans
        }));
        executionResult.persisted = true;
        executionResult.savedAt = new Date().toISOString();
        executionResult.summary.savedCount = executionResult.executedActions.length;
        executionResult.savedImagePlans = executionResult.patchedImagePlans;
        executionResult.warnings = [
          '文字修正已保存到图片方案。',
          '本次没有重新生成图片、没有重新审核、没有调用真实 Provider。'
        ];
        executionResult.nextSuggestedAction = '文字修正已保存到图片方案，请重新生成 mock 图片并再次审核。';
        refreshPostFixValidation(executionResult);
        res.json({ executionResult, task: withRecognitionQuality(savedTask) });
        return;
      } catch (error) {
        executionResult.status = 'partial';
        executionResult.failedActions.push({
          actionId: 'persist-image-plans',
          reason: error.message || '保存图片方案失败。'
        });
        executionResult.summary.failedCount = executionResult.failedActions.length;
        executionResult.nextSuggestedAction = '保存失败，原任务数据未确认写入。请检查错误原因后重试。';
      }
    }
  }
  res.json({ executionResult });
}));

router.get('/:id', asyncHandler(async (req, res) => {
  const task = await requireTask(req.params.id);
  res.json({ task: withRecognitionQuality(task) });
}));

router.post('/upload', upload.any(), asyncHandler(async (req, res) => {
  const files = req.files || [];
  const invalidField = files.find((file) => !['image', 'images'].includes(file.fieldname));
  if (invalidField) {
    await Promise.all(files.map((file) => fs.rm(file.path, { force: true })));
    const error = new Error('仅支持 image 或 images 文件字段');
    error.statusCode = 400;
    throw error;
  }
  if (!files.length) {
    const error = new Error('Image file is required');
    error.statusCode = 400;
    throw error;
  }
  if (files.length > MAX_IMAGE_COUNT) {
    await Promise.all(files.map((file) => fs.rm(file.path, { force: true })));
    const error = new Error(`最多只能上传 ${MAX_IMAGE_COUNT} 张商品图片`);
    error.statusCode = 400;
    throw error;
  }
  const totalSize = files.reduce((sum, file) => sum + file.size, 0);
  if (totalSize > MAX_TOTAL_UPLOAD_SIZE) {
    await Promise.all(files.map((file) => fs.rm(file.path, { force: true })));
    const error = new Error('图片总大小不能超过 100MB');
    error.statusCode = 400;
    throw error;
  }
  const metadataList = [];
  for (const file of files) {
    metadataList.push(await validateUploadedImage(file));
  }
  const now = new Date().toISOString();
  const id = nanoid(12);
  const sourceImages = files.map((file, index) => {
    const originalName = decodeOriginalFileName(file.originalname);
    const displayName = getDisplayFileName(file.originalname, index);
    return {
    id: `${id}-source-${index + 1}`,
    role: 'source',
    imageIndex: index,
    fileName: file.filename,
    storedName: file.filename,
    originalName,
    displayName,
    filePath: path.relative(paths.rootDir, file.path).replaceAll('\\', '/'),
    url: `/uploads/${file.filename}`,
    previewUrl: `/uploads/${file.filename}`,
    mimeType: file.mimetype,
    size: file.size,
    width: metadataList[index].width,
    height: metadataList[index].height,
    format: metadataList[index].format
    };
  });
  const task = await createTask({
    id,
    sku: `SKU-${id.slice(0, 6).toUpperCase()}`,
    status: TASK_STATUS.UPLOADED,
    sourceImages,
    originalImage: sourceImages[0],
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
    language: 'English',
    imagePlans: [],
    generatedImages: [],
    review: null,
    reviewResults: [],
    exports: [],
    exportFile: null,
    createdAt: now,
    updatedAt: now
  });
  res.status(201).json({ task });
}));

router.post('/:id/recognize', asyncHandler(async (req, res) => {
  const current = await requireTask(req.params.id);
  assertTaskStatus(current, TASK_TRANSITIONS.recognize, 'Recognition');
  if (process.env.DEBUG_PROVIDER_CONFIG === 'true') {
    console.log('[provider-config]', getProviderConfigSummary());
  }
  const providers = getProviders();
  const recognition = await providers.vision.recognize({ task: current, image: current.sourceImages?.[0], images: current.sourceImages || [] });
  if (!isProviderSuccess(recognition)) {
    const error = new Error(recognition.error?.message || recognition.error || 'Recognition failed');
    error.statusCode = 502;
    error.payload = recognition.error || {
      code: 'UNKNOWN_ERROR',
      message: 'Recognition failed'
    };
    throw error;
  }
  const { productInfoRaw, visibleText, risks, confidence, notes = [], fieldEvidence = {}, inferredCandidates = [] } = recognition.data;
  const productInfoRawWithNotes = {
    ...productInfoRaw,
    notes: productInfoRaw?.notes || notes
  };
  const productInfoForForm = productInfoRawWithNotes.name
    ? productInfoRawWithNotes
    : toLegacyProductInfo(productInfoRawWithNotes, visibleText, risks);
  const task = await updateTask(req.params.id, () => ({
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
      error: recognition.error,
      rawResponsePreview: recognition.rawResponsePreview,
      batchCount: recognition.metadata?.batchCount,
      batchSize: recognition.metadata?.batchSize,
      retryCount: recognition.metadata?.retryCount,
      recognitionMode: recognition.metadata?.recognitionMode,
      imageMaxWidth: recognition.metadata?.imageMaxWidth,
      imageQuality: recognition.metadata?.imageQuality,
      imageCountOriginal: recognition.metadata?.imageCountOriginal,
      imageCountSent: recognition.metadata?.imageCountSent,
      imageCountSkipped: recognition.metadata?.imageCountSkipped,
      partialSuccess: recognition.metadata?.partialSuccess,
      failedBatches: recognition.metadata?.failedBatches,
      batches: recognition.metadata?.batches,
      preprocess: recognition.metadata?.preprocess
    },
    recognitionProvider: {
      provider: recognition.provider,
      model: recognition.model,
      durationMs: recognition.durationMs,
      status: recognition.status,
      error: recognition.error,
      batchCount: recognition.metadata?.batchCount,
      partialSuccess: recognition.metadata?.partialSuccess
    },
    sku: productInfoForForm.sku,
    status: TASK_STATUS.RECOGNIZED
  }));
  res.json({ task: withRecognitionQuality(task) });
}));

router.patch('/:id/product', asyncHandler(async (req, res) => {
  const current = await requireTask(req.params.id);
  assertTaskStatus(current, TASK_TRANSITIONS.confirmProduct, 'Product confirmation');
  const productInfo = req.body.productInfo;
  if (!productInfo?.name) {
    const error = new Error('Product info with name is required');
    error.statusCode = 400;
    throw error;
  }
  const task = await updateTask(req.params.id, () => ({
    productInfoConfirmed: productInfo,
    productInfo,
    sku: productInfo.sku,
    status: TASK_STATUS.CONFIRMED
  }));
  res.json({ task });
}));

router.post('/:id/platforms', asyncHandler(async (req, res) => {
  const current = await requireTask(req.params.id);
  assertTaskStatus(current, TASK_TRANSITIONS.selectRules, 'Platform rule selection');
  const productInfo = currentProductInfo(current) || {};
  const rawTargets = Array.isArray(req.body?.targets) && req.body.targets.length
    ? req.body.targets
    : [{
        platform: req.body.platform,
        platformId: req.body.platformId,
        site: req.body.site,
        language: req.body.language || 'English',
        category: req.body.category || productInfo.category || 'general',
        categoryId: req.body.categoryId
      }];
  const targets = normalizeTargets(rawTargets, { productInfo, fallbackTask: current });
  const primaryTarget = targets[0];
  const task = await updateTask(req.params.id, () => ({
    targets,
    platform: primaryTarget.platformName,
    platformId: primaryTarget.platformId,
    site: primaryTarget.site,
    language: primaryTarget.language,
    category: primaryTarget.category,
    categoryId: primaryTarget.categoryId,
    status: TASK_STATUS.RULES_SELECTED
  }));
  res.json({ task });
}));

router.post('/:id/image-plans', asyncHandler(async (req, res) => {
  const current = await requireTask(req.params.id);
  assertTaskStatus(current, TASK_TRANSITIONS.createPlans, 'Image plan generation');
  const imagePlans = generateImagePlans(current);
  const task = await updateTask(req.params.id, () => ({
    imagePlans,
    generatedImages: [],
    reviewResults: [],
    review: null,
    exports: [],
    exportFile: null,
    status: TASK_STATUS.PLANNED
  }));
  res.json({ task });
}));

router.patch('/:id/image-plans/:planId', asyncHandler(async (req, res) => {
  await updateSingleImagePlan(req, res);
}));

router.post('/:id/plans/:planId', asyncHandler(updateSingleImagePlan));

router.post('/:id/plans/:planId/text-layout', asyncHandler(async (req, res) => {
  const current = await requireTask(req.params.id);
  assertTaskStatus(current, allowedPlanEditStatuses(), 'Text layout editing');
  const planIndex = (current.imagePlans || []).findIndex((plan) => plan.id === req.params.planId);
  if (planIndex === -1) {
    const error = new Error('Image plan not found');
    error.statusCode = 404;
    throw error;
  }
  const existing = current.imagePlans[planIndex];
  if (!isProgrammaticTextLayoutType(existing.type)) {
    const error = new Error('Only programmatic text layout image types support layout editing');
    error.statusCode = 400;
    throw error;
  }
  const textLayoutOverride = normalizeTextLayoutOverride({
    task: current,
    plan: existing,
    textLayoutOverride: req.body?.textLayoutOverride || {}
  });
  const updatedPlan = {
    ...existing,
    textLayoutOverride,
    textLayout: textLayoutOverride,
    editedByUser: true,
    editedAt: new Date().toISOString(),
    layoutEditedByUser: true,
    layoutEditedAt: textLayoutOverride.layoutEditedAt,
    version: (existing.version || 1) + 1
  };
  updatedPlan.generationRequestSummary = generationRequestSummary(buildGenerationRequest({ task: current, plan: updatedPlan }));
  const imagePlans = current.imagePlans.map((plan, index) => (index === planIndex ? updatedPlan : plan));
  const task = await updateTask(req.params.id, () => ({ imagePlans, exports: [], exportFile: null }));
  res.json({ task });
}));

router.delete('/:id/plans/:planId/text-layout', asyncHandler(async (req, res) => {
  const current = await requireTask(req.params.id);
  assertTaskStatus(current, allowedPlanEditStatuses(), 'Text layout restore');
  const planIndex = (current.imagePlans || []).findIndex((plan) => plan.id === req.params.planId);
  if (planIndex === -1) {
    const error = new Error('Image plan not found');
    error.statusCode = 404;
    throw error;
  }
  const existing = current.imagePlans[planIndex];
  if (!isProgrammaticTextLayoutType(existing.type)) {
    const error = new Error('Only programmatic text layout image types support layout editing');
    error.statusCode = 400;
    throw error;
  }
  const restoredPlan = {
    ...existing,
    textLayoutOverride: undefined,
    layoutEditedByUser: false,
    layoutEditedAt: null,
    editedByUser: true,
    editedAt: new Date().toISOString(),
    version: (existing.version || 1) + 1
  };
  restoredPlan.textLayout = buildTextLayout({ task: current, plan: { ...restoredPlan, textLayoutOverride: undefined } });
  restoredPlan.generationRequestSummary = generationRequestSummary(buildGenerationRequest({ task: current, plan: restoredPlan }));
  const imagePlans = current.imagePlans.map((plan, index) => (index === planIndex ? restoredPlan : plan));
  const task = await updateTask(req.params.id, () => ({ imagePlans, exports: [], exportFile: null }));
  res.json({ task });
}));

router.post('/:id/plans/:planId/reference', asyncHandler(async (req, res) => {
  const current = await requireTask(req.params.id);
  assertTaskStatus(current, allowedReferenceStatuses(), 'Product reference selection');
  const { planIndex, sourceImage } = requirePlanAndSource(current, req.params.planId, req.body?.sourceImageId);
  const productReferenceOverride = productReferenceOverrideFromSource(sourceImage);
  const updatedPlan = {
    ...current.imagePlans[planIndex],
    productReferenceOverride,
    editedByUser: true,
    referenceEditedAt: productReferenceOverride.setAt,
    version: (current.imagePlans[planIndex].version || 1) + 1
  };
  updatedPlan.generationRequestSummary = generationRequestSummary(buildGenerationRequest({ task: current, plan: updatedPlan }));
  const imagePlans = current.imagePlans.map((plan, index) => (index === planIndex ? updatedPlan : plan));
  const task = await updateTask(req.params.id, () => ({ imagePlans }));
  res.json({
    task,
    message: '参考图已变更，建议重新生成此图。'
  });
}));

router.post('/:id/plans/:planId/matting-preview', asyncHandler(async (req, res) => {
  const current = await requireTask(req.params.id);
  assertTaskStatus(current, allowedReferenceStatuses(), 'Matting preview');
  const requestedSourceId = req.body?.sourceImageId || current.imagePlans?.find((plan) => plan.id === req.params.planId)?.productReferenceOverride?.sourceImageId;
  const { plan, sourceImage } = requirePlanAndSource(current, req.params.planId, requestedSourceId || current.sourceImages?.[0]?.id);
  const generationRequest = buildGenerationRequest({ task: current, plan: { ...plan, productReferenceOverride: productReferenceOverrideFromSource(sourceImage) } });
  const result = await extractSubjectWithFallback({
    providerName: process.env.MATTING_PROVIDER || 'sharp',
    task: current,
    sourceImage,
    generationRequest
  });
  if (result.status !== 'success') {
    const error = new Error(result.error?.message || 'Matting preview failed');
    error.statusCode = 502;
    error.payload = result.error;
    throw error;
  }
  const subjectPng = await copyMattingPreviewFile(current.id, result.output?.subjectPngPath, 'subject');
  const mask = await copyMattingPreviewFile(current.id, result.output?.maskPath, 'mask');
  const previewMeta = {
    mattingPreviewUsed: true,
    mattingPreviewUpdatedAt: new Date().toISOString(),
    mattingPreviewSourceImageId: sourceImage.id,
    mattingPreviewProvider: result.provider,
    mattingPreviewEdgeQuality: result.metadata?.edgeQuality || 'unknown'
  };
  const imagePlans = current.imagePlans.map((item) => (
    item.id === plan.id ? { ...item, ...previewMeta } : item
  ));
  const task = await updateTask(current.id, () => ({ imagePlans }));
  res.json({
    task,
    preview: {
      status: result.status,
      sourceImageId: sourceImage.id,
      sourceDisplayName: sourceImage.displayName || sourceImage.fileName,
      mattingProvider: result.provider,
      mattingModel: result.model,
      mattingMethod: result.method,
      confidence: result.metadata?.confidence ?? 0,
      edgeQuality: result.metadata?.edgeQuality || 'unknown',
      backgroundType: result.metadata?.backgroundType || 'unknown',
      warnings: result.metadata?.warnings || [],
      mattingFallbackToSharp: Boolean(result.metadata?.mattingFallbackToSharp),
      externalMattingError: result.metadata?.externalMattingError || null,
      subjectPng,
      mask
    }
  });
}));

router.post('/:id/generate', asyncHandler(async (req, res) => {
  const current = await requireTask(req.params.id);
  assertTaskStatus(current, TASK_TRANSITIONS.generateImages, 'Image generation');
  const providers = getProviders();
  const generatedImages = [];
  for (const [index, plan] of current.imagePlans.entries()) {
    const result = await providers.image.generate({ task: current, plan, outputIndex: index + 1 });
    if (result.status !== 'succeeded') {
      const error = new Error(result.error || `Image generation failed for ${plan.id}`);
      error.statusCode = 502;
      throw error;
    }
    generatedImages.push({
      ...result.data,
      durationMs: result.durationMs,
      provider: result.provider,
      model: result.model,
      status: result.status
    });
  }
  const task = await updateTask(req.params.id, () => ({
    generatedImages,
    reviewResults: [],
    review: null,
    exports: [],
    exportFile: null,
    status: TASK_STATUS.GENERATED
  }));
  res.json({ task });
}));

router.post('/:id/generate/:planId', asyncHandler(async (req, res) => {
  const current = await requireTask(req.params.id);
  assertTaskStatus(current, allowedSingleGenerateStatuses(), 'Single image generation');
  const planIndex = (current.imagePlans || []).findIndex((plan) => plan.id === req.params.planId);
  if (planIndex === -1) {
    const error = new Error('Image plan not found');
    error.statusCode = 404;
    throw error;
  }
  const plan = current.imagePlans[planIndex];
  let planForGeneration = plan;
  let imagePlansForUpdate = current.imagePlans;
  if (req.body?.compositeSettings && plan.type === 'lifestyle_image') {
    planForGeneration = {
      ...plan,
      compositeSettings: normalizeCompositeSettings({
        ...(plan.compositeSettings || {}),
        ...req.body.compositeSettings
      }),
      editedByUser: true,
      editedAt: new Date().toISOString()
    };
    planForGeneration.generationRequestSummary = generationRequestSummary(buildGenerationRequest({ task: current, plan: planForGeneration }));
    imagePlansForUpdate = current.imagePlans.map((item, index) => (index === planIndex ? planForGeneration : item));
  }
  const existingIndex = (current.generatedImages || []).findIndex((image) => image.planId === plan.id);
  const existingImage = existingIndex >= 0 ? current.generatedImages[existingIndex] : null;
  const nextVersion = (existingImage?.version || 0) + 1;
  const providers = getProviders();
  const result = await providers.image.generate({
    task: current,
    plan: planForGeneration,
    outputIndex: existingIndex >= 0 ? existingIndex + 1 : planIndex + 1,
    version: nextVersion,
    regenerate: Boolean(existingImage),
    mode: req.body?.mode || 'mock',
    realMode: req.body?.realMode || 'auto'
  });
  if (result.status !== 'succeeded') {
    const error = new Error(result.error || `Image generation failed for ${plan.id}`);
    error.statusCode = 502;
    throw error;
  }
  const nextImage = {
    ...result.data,
    durationMs: result.durationMs,
    provider: result.provider,
    model: result.model,
    status: result.status
  };
  const generatedImages = [...(current.generatedImages || [])];
  if (existingIndex >= 0) generatedImages[existingIndex] = nextImage;
  else generatedImages.push(nextImage);
  const reviewResults = (current.reviewResults || []).map((item) => {
    if (item.planId === plan.id || item.imageId === existingImage?.id) {
      return {
        ...item,
        stale: true,
        staleReason: 'Image was regenerated after this review result.'
      };
    }
    return item;
  });
  const review = current.review
    ? {
        ...current.review,
        hasStaleResults: reviewResults.some((item) => item.stale),
        items: (current.review.items || []).map((item) => (
          item.planId === plan.id || item.imageId === existingImage?.id
            ? { ...item, stale: true, staleReason: 'Image was regenerated after this review result.' }
            : item
        ))
      }
    : current.review;
  const task = await updateTask(req.params.id, () => ({
    generatedImages,
    reviewResults,
    review,
    exports: [],
    exportFile: null,
    imagePlans: imagePlansForUpdate,
    status: current.status === TASK_STATUS.REVIEWED ? TASK_STATUS.REVIEWED : TASK_STATUS.GENERATED
  }));
  res.json({ task });
}));

router.post('/:id/review', asyncHandler(async (req, res) => {
  const current = await requireTask(req.params.id);
  assertTaskStatus(current, TASK_TRANSITIONS.reviewImages, 'Compliance review');
  const mode = req.body?.mode === 'real' ? 'real' : 'mock';
  const reviewProvider = getReviewProvider(mode);
  const mockReviewProvider = getReviewProvider('mock');
  const reviewResults = [];
  for (const image of current.generatedImages) {
    const plan = (current.imagePlans || []).find((item) => item.id === image.planId);
    const generationRequest = image.generationRequest || (plan ? buildGenerationRequest({ task: current, plan }) : null);
    let result = await reviewProvider.review({ task: current, image, plan, generationRequest });
    if (!isProviderSuccess(result)) {
      if (mode === 'real') {
        const fallback = await mockReviewProvider.review({
          task: current,
          image,
          plan,
          generationRequest,
          fallbackToMockReview: true,
          realReviewError: result.error
        });
        result = fallback;
      } else {
        const error = new Error(result.error?.message || result.error || `Review failed for ${image.id}`);
        error.statusCode = 502;
        throw error;
      }
    }
    reviewResults.push({
      ...result.data,
      durationMs: result.durationMs,
      provider: result.provider,
      model: result.model
    });
  }
  const review = {
    reviewedAt: new Date().toISOString(),
    reviewMode: mode,
    overallStatus: reviewResults.every((item) => item.status === 'passed') ? 'passed' : 'failed',
    items: reviewResults
  };
  const task = await updateTask(req.params.id, () => ({
    reviewResults,
    review,
    status: TASK_STATUS.REVIEWED
  }));
  res.json({ task: withRecognitionQuality(task) });
}));

router.get('/:id/export', asyncHandler(async (req, res) => {
  const current = await requireTask(req.params.id);
  assertTaskStatus(current, TASK_TRANSITIONS.exportImages, 'Export');
  const exportFile = await createExportZip({ ...current, exportTargetId: req.query.targetId || req.query.platformTargetId });
  await updateTask(req.params.id, () => ({
    exports: [...(current.exports || []), exportFile],
    exportFile,
    status: TASK_STATUS.EXPORTED
  }));
  res.download(path.join(paths.rootDir, exportFile.filePath), exportFile.fileName);
}));

export default router;
