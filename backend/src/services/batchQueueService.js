import { nanoid } from 'nanoid';
import { BATCH_STATUS, aggregateBatchStatus } from '../constants/batchStatus.js';
import { TASK_STATUS } from '../constants/taskStatus.js';
import { getBatchTask, getTask, updateBatchTask, updateTask } from './db.js';
import { defaultBatchLocks, defaultBatchQueue, getBatch, normalizeBatchTask } from './batchTaskService.js';
import { getProviders } from '../providers/index.js';
import { getReviewProvider } from '../providers/review/index.js';
import { toLegacyProductInfo } from '../providers/vision/normalizeVisionResult.js';
import { generateImagePlans } from './imagePlanService.js';
import { buildGenerationRequest } from './generationRequestService.js';
import { refreshBatchAnalytics } from './batchAnalyticsService.js';
import { classifyError, isRetryableError, getUserActionSuggestion } from '../utils/errorClassifier.js';
import { getUserSettings } from './userSettingsService.js';
import { normalizeTargets } from './targetService.js';

const controllers = new Map();

function nowIso() {
  return new Date().toISOString();
}

function numberEnv(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

export function batchQueueConfig() {
  return {
    defaultConcurrency: numberEnv('BATCH_DEFAULT_CONCURRENCY', 2),
    maxConcurrency: numberEnv('BATCH_MAX_CONCURRENCY', 4),
    jobTimeoutMs: numberEnv('BATCH_JOB_TIMEOUT_MS', 600000),
    lockTtlMs: numberEnv('BATCH_LOCK_TTL_MS', 900000),
    autoRetryEnabled: ['1', 'true', 'yes', 'on'].includes(String(process.env.BATCH_AUTO_RETRY_ENABLED || 'false').toLowerCase()),
    maxRetryPerJob: numberEnv('BATCH_MAX_RETRY_PER_JOB', 1),
    retryDelayMs: numberEnv('BATCH_RETRY_DELAY_MS', 5000),
    retryBackoff: process.env.BATCH_RETRY_BACKOFF || 'linear',
    retryableCodes: String(process.env.BATCH_RETRYABLE_CODES || 'JOB_TIMEOUT,HTTP_ERROR,PARSE_ERROR,PROVIDER_RATE_LIMIT,ECONNRESET')
      .split(',')
      .map((code) => code.trim().toUpperCase())
      .filter(Boolean)
  };
}

function clampConcurrency(value) {
  const config = batchQueueConfig();
  const parsed = Number(value);
  const requested = Number.isFinite(parsed) && parsed > 0 ? parsed : config.defaultConcurrency;
  return Math.max(1, Math.min(requested, config.maxConcurrency));
}

export function resolveBatchConcurrency(value, userSettings = null) {
  const requested = value === undefined || value === null || value === ''
    ? userSettings?.defaults?.batchConcurrency
    : value;
  return clampConcurrency(requested);
}

function queueCounts(skuTasks = [], action = null) {
  return skuTasks.reduce((counts, sku) => {
    if (sku.queueAction && action && sku.queueAction !== action) return counts;
    if (sku.queueStatus === 'pending') counts.pendingJobs += 1;
    else if (sku.queueStatus === 'running') counts.runningJobs += 1;
    else if (sku.queueStatus === 'completed') counts.completedJobs += 1;
    else if (sku.queueStatus === 'failed') counts.failedJobs += 1;
    else if (sku.queueStatus === 'skipped') counts.skippedJobs += 1;
    return counts;
  }, {
    pendingJobs: 0,
    runningJobs: 0,
    completedJobs: 0,
    failedJobs: 0,
    skippedJobs: 0
  });
}

function queueStatusFromCounts(counts, cancelled = false) {
  if (cancelled) return 'cancelled';
  if (counts.failedJobs > 0 && counts.completedJobs + counts.skippedJobs === 0) return 'failed';
  if (counts.failedJobs > 0) return 'partial_failed';
  return 'completed';
}

function trimLogs(logs = []) {
  return logs.slice(-500);
}

async function appendLog(batchId, log) {
  const entry = {
    id: `log-${nanoid(8)}`,
    timestamp: nowIso(),
    level: log.level || 'info',
    action: log.action || null,
    skuId: log.skuId || null,
    taskId: log.taskId || null,
    message: log.message || '',
    error: log.error || null,
    durationMs: log.durationMs ?? null
  };
  await updateBatchTask(batchId, (current) => ({
    executionLogs: trimLogs([...(current.executionLogs || []), entry])
  }));
  return entry;
}

async function writeQueueState(batchId, patch = {}) {
  return updateBatchTask(batchId, (current) => {
    const normalized = normalizeBatchTask(current);
    const queue = {
      ...normalized.queue,
      ...patch
    };
    return { queue };
  });
}

async function setSkuQueueState(batchId, skuId, patch, queuePatch = {}) {
  return updateBatchTask(batchId, (current) => {
    const normalized = normalizeBatchTask(current);
    const skuTasks = (normalized.skuTasks || []).map((sku) => (
      sku.skuId === skuId
        ? { ...sku, ...patch, updatedAt: nowIso() }
        : sku
    ));
    const counts = queueCounts(skuTasks, normalized.queue.action);
    return {
      skuTasks,
      queue: {
        ...normalized.queue,
        ...counts,
        ...queuePatch
      },
      status: aggregateBatchStatus(skuTasks, normalized.status)
    };
  });
}

async function acquireLock(batchId, { action, concurrency, lockId }) {
  const config = batchQueueConfig();
  const now = Date.now();
  const lockedAt = new Date(now).toISOString();
  const expiresAt = new Date(now + config.lockTtlMs).toISOString();
  let tookExpiredLock = false;
  const batchTask = await updateBatchTask(batchId, (current) => {
    const normalized = normalizeBatchTask(current);
    const lock = normalized.locks || defaultBatchLocks();
    if (lock.isRunning && lock.expiresAt && new Date(lock.expiresAt).getTime() > now) {
      const error = new Error(`Batch queue is already running: ${normalized.queue?.action || 'unknown'}`);
      error.statusCode = 409;
      throw error;
    }
    tookExpiredLock = Boolean(lock.isRunning);
    const skuTasks = (normalized.skuTasks || []).map((sku) => ({
      ...sku,
      queueAction: action,
      queueStatus: ['failed', 'completed', 'skipped'].includes(sku.queueStatus) ? sku.queueStatus : 'pending',
      retryCount: sku.retryCount || 0,
      maxRetry: batchQueueConfig().maxRetryPerJob
    }));
    const counts = queueCounts(skuTasks, action);
    return {
      skuTasks,
      locks: {
        isRunning: true,
        lockedBy: lockId,
        lockedAt,
        expiresAt
      },
      queue: {
        ...defaultBatchQueue(),
        ...normalized.queue,
        action,
        status: 'running',
        concurrency,
        startedAt: lockedAt,
        finishedAt: null,
        pausedAt: null,
        resumedAt: null,
        totalJobs: skuTasks.length,
        ...counts
      }
    };
  });
  if (tookExpiredLock) {
    await appendLog(batchId, { level: 'warn', action, message: '旧队列锁已过期，当前请求已接管执行。' });
  }
  await appendLog(batchId, { level: 'info', action, message: `开始批量${action}，并发数 ${concurrency}` });
  return normalizeBatchTask(batchTask);
}

async function releaseLock(batchId, { action, cancelled = false } = {}) {
  const batchTask = await updateBatchTask(batchId, (current) => {
    const normalized = normalizeBatchTask(current);
    const counts = queueCounts(normalized.skuTasks || [], action || normalized.queue.action);
    const status = queueStatusFromCounts(counts, cancelled);
    return {
      locks: defaultBatchLocks(),
      queue: {
        ...normalized.queue,
        ...counts,
        status,
        finishedAt: nowIso()
      },
      status: status === 'completed' ? aggregateBatchStatus(normalized.skuTasks || [], BATCH_STATUS.COMPLETED) : BATCH_STATUS.PARTIAL_FAILED
    };
  });
  await appendLog(batchId, { level: cancelled ? 'warn' : 'success', action, message: cancelled ? '队列已取消。' : '队列执行完成。' });
  if (!cancelled) {
    try {
      await refreshBatchAnalytics(batchId);
    } catch (err) {
      await appendLog(batchId, { level: 'warn', action: 'analytics', message: `analytics refresh failed: ${err.message}` });
    }
  }
  return normalizeBatchTask(batchTask);
}

function shouldSkip(action, task) {
  if (action === 'prepare' && task && ![
    TASK_STATUS.UPLOADED,
    TASK_STATUS.RECOGNIZED,
    TASK_STATUS.CONFIRMED,
    TASK_STATUS.RULES_SELECTED,
    TASK_STATUS.PLANNED
  ].includes(task.status)) return `status ${task.status} cannot run prepare`;
  if (!task) return '任务不存在';
  if (action === 'recognize' && task.status !== TASK_STATUS.UPLOADED) return `状态为 ${task.status}，不能识别`;
  if (action === 'plan' && ![TASK_STATUS.RULES_SELECTED, TASK_STATUS.PLANNED].includes(task.status)) return `状态为 ${task.status}，不能生成方案`;
  if (action === 'generate' && ![TASK_STATUS.PLANNED, TASK_STATUS.GENERATED].includes(task.status)) return `状态为 ${task.status}，不能生成图片`;
  if (action === 'review' && ![TASK_STATUS.GENERATED, TASK_STATUS.REVIEWED].includes(task.status)) return `状态为 ${task.status}，不能审核`;
  return '';
}

function providerMode(mode = 'mock') {
  return ['real', 'real-test', 'real_test'].includes(String(mode || '').toLowerCase()) ? 'real-test' : 'mock';
}

function imageGenerationMode(mode = 'mock') {
  return providerMode(mode) === 'real-test' ? 'real-test' : 'mock';
}

async function executeRecognize(task, { mode = 'mock' } = {}) {
  const providers = getProviders(providerMode(mode));
  const recognition = await providers.vision.recognize({ task, image: task.sourceImages?.[0], images: task.sourceImages || [] });
  if (recognition?.status !== 'success' && recognition?.status !== 'succeeded') {
    throw new Error(recognition.error?.message || 'Recognition failed');
  }
  const { productInfoRaw, visibleText, risks, confidence, notes = [], fieldEvidence = {}, inferredCandidates = [] } = recognition.data;
  const productInfoRawWithNotes = { ...productInfoRaw, notes: productInfoRaw?.notes || notes };
  const productInfoForForm = productInfoRawWithNotes.name
    ? productInfoRawWithNotes
    : toLegacyProductInfo(productInfoRawWithNotes, visibleText, risks);
  return updateTask(task.id, () => ({
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
}

function productInfoForConfirmation(task = {}, sku = {}) {
  const raw = task.productInfo || toLegacyProductInfo(task.productInfoRaw || {}, task.visibleText || [], task.risks || []);
  const name = raw.name || raw.productName || task.productInfoRaw?.productName || sku.displayName || sku.skuId || task.sku || 'Imported SKU';
  return {
    ...raw,
    name,
    sku: raw.sku || task.sku || sku.skuId || '',
    category: raw.category || task.category || 'general',
    packageIncluded: raw.packageIncluded || raw.packageList || [],
    packageList: raw.packageList || raw.packageIncluded || [],
    sellingPoints: raw.sellingPoints || []
  };
}

async function executePrepare({ task, sku, batchId, defaultTargets = [], mode = 'mock' }) {
  let current = task;

  if (current.status === TASK_STATUS.UPLOADED) {
    await setSkuQueueState(batchId, sku.skuId, { status: 'recognizing', currentStep: 'recognizing' });
    current = await executeRecognize(current, { mode });
  }

  if (current.status === TASK_STATUS.RECOGNIZED) {
    const productInfoConfirmed = productInfoForConfirmation(current, sku);
    await setSkuQueueState(batchId, sku.skuId, { status: 'confirmed', currentStep: 'confirmed' });
    current = await updateTask(current.id, () => ({
      productInfoConfirmed,
      productInfo: productInfoConfirmed,
      sku: productInfoConfirmed.sku || current.sku,
      status: TASK_STATUS.CONFIRMED
    }));
  }

  if (current.status === TASK_STATUS.CONFIRMED) {
    const productInfo = current.productInfoConfirmed || current.productInfo || {};
    const targets = normalizeTargets(defaultTargets?.length ? defaultTargets : current.targets || [], {
      productInfo,
      fallbackTask: current
    });
    const primaryTarget = targets[0];
    await setSkuQueueState(batchId, sku.skuId, { status: 'rules_selected', currentStep: 'rules_selected' });
    current = await updateTask(current.id, () => ({
      targets,
      platform: primaryTarget.platformName,
      platformId: primaryTarget.platformId,
      site: primaryTarget.site,
      language: primaryTarget.language,
      category: primaryTarget.category,
      categoryId: primaryTarget.categoryId,
      status: TASK_STATUS.RULES_SELECTED
    }));
  }

  if (current.status === TASK_STATUS.RULES_SELECTED) {
    await setSkuQueueState(batchId, sku.skuId, { status: 'planning', currentStep: 'planning' });
    current = await executePlan(current);
  }

  return current;
}

async function executePlan(task) {
  const imagePlans = generateImagePlans(task);
  return updateTask(task.id, () => ({
    imagePlans,
    generatedImages: [],
    reviewResults: [],
    review: null,
    exports: [],
    exportFile: null,
    status: TASK_STATUS.PLANNED
  }));
}

function planImageMetadata({ task, sku, batchId, plan, result = {}, status = 'failed', error = null, retryCount = 0 }) {
  const data = result.data || {};
  return {
    ...data,
    id: data.id || `${plan.id}-image`,
    batchId,
    skuTaskId: sku?.skuId || task.sku || task.id,
    taskId: task.id,
    planId: plan.id,
    targetId: data.targetId || plan.targetId,
    platformId: data.platformId || plan.platformId,
    platform: data.platform || data.platformName || plan.platform || plan.platformName || plan.platformId,
    platformName: data.platformName || plan.platformName,
    imageType: data.imageType || plan.type,
    type: data.type || plan.type,
    title: data.title || plan.title,
    prompt: data.prompt ?? plan.prompt ?? '',
    promptPreview: data.promptPreview || String(data.prompt ?? plan.prompt ?? '').slice(0, 500),
    provider: result.provider || data.provider || 'mock',
    model: result.model || data.model || 'mock-image-v0.3',
    outputPath: data.outputPath || data.filePath || null,
    imageUrl: data.imageUrl || data.previewUrl || data.url || null,
    status,
    error,
    retryCount,
    durationMs: result.durationMs ?? data.durationMs ?? null
  };
}

async function executeGenerate(task, { mode = 'mock', batchId = null, sku = null } = {}) {
  const providers = getProviders(providerMode(mode));
  const generatedImages = [];
  const plans = task.imagePlans || [];
  const maxRetriesPerImage = 2;
  let failedCount = 0;

  for (const [index, plan] of plans.entries()) {
    let retryCount = 0;
    let lastResult = null;
    let lastError = null;
    while (retryCount <= maxRetriesPerImage) {
      try {
        lastResult = await providers.image.generate({ task, plan, outputIndex: index + 1, mode: imageGenerationMode(mode) });
        if (lastResult.status === 'succeeded') break;
        lastError = lastResult.error || `Image generation failed for ${plan.id}`;
      } catch (error) {
        lastError = { code: error.code || 'IMAGE_GENERATION_FAILED', message: error.message };
        lastResult = { provider: 'unknown', model: 'unknown', durationMs: null, data: null };
      }
      if (retryCount >= maxRetriesPerImage) break;
      retryCount += 1;
    }

    if (lastResult?.status === 'succeeded') {
      generatedImages.push(planImageMetadata({
        task,
        sku,
        batchId,
        plan,
        result: lastResult,
        status: lastResult.status,
        retryCount
      }));
    } else {
      failedCount += 1;
      const errorPayload = typeof lastError === 'object' && lastError
        ? lastError
        : { code: 'IMAGE_GENERATION_FAILED', message: String(lastError || `Image generation failed for ${plan.id}`) };
      generatedImages.push(planImageMetadata({
        task,
        sku,
        batchId,
        plan,
        result: lastResult || {},
        status: 'failed',
        error: errorPayload,
        retryCount: maxRetriesPerImage
      }));
    }

    if (batchId && sku?.skuId) {
      await setSkuQueueState(batchId, sku.skuId, {
        status: 'generating',
        currentStep: 'generating',
        generationProgress: {
          total: plans.length,
          completed: generatedImages.length - failedCount,
          failed: failedCount,
          current: generatedImages.length,
          currentPlanId: plan.id
        }
      });
    }
  }
  if (plans.length > 0 && failedCount === plans.length) {
    await updateTask(task.id, () => ({
      generatedImages,
      reviewResults: [],
      review: null,
      exports: [],
      exportFile: null,
      generationMeta: {
        status: 'failed',
        totalPlans: plans.length,
        successCount: 0,
        failedCount,
        mode,
        batchId,
        skuTaskId: sku?.skuId || null,
        generatedAt: nowIso()
      }
    }));
    const error = new Error('All image plans failed to generate');
    error.code = 'IMAGE_GENERATION_FAILED';
    error.generatedImages = generatedImages;
    throw error;
  }
  return updateTask(task.id, () => ({
    generatedImages,
    reviewResults: [],
    review: null,
    exports: [],
    exportFile: null,
    status: TASK_STATUS.GENERATED,
    generationMeta: {
      status: failedCount > 0 ? 'partial_failed' : 'success',
      totalPlans: plans.length,
      successCount: generatedImages.length - failedCount,
      failedCount,
      mode,
      batchId,
      skuTaskId: sku?.skuId || null,
      generatedAt: nowIso()
    }
  }));
}

async function executeReview(task, { mode = 'mock' } = {}) {
  const reviewProvider = getReviewProvider(providerMode(mode) === 'real-test' ? 'real' : 'mock');
  const mockReviewProvider = getReviewProvider('mock');
  const reviewResults = [];
  for (const image of task.generatedImages || []) {
    const plan = (task.imagePlans || []).find((item) => item.id === image.planId);
    const generationRequest = image.generationRequest || (plan ? buildGenerationRequest({ task, plan }) : null);
    let result = await reviewProvider.review({ task, image, plan, generationRequest });
    if ((result?.status !== 'success' && result?.status !== 'succeeded') && providerMode(mode) === 'real-test') {
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
  return updateTask(task.id, () => ({ reviewResults, review, status: TASK_STATUS.REVIEWED }));
}

async function executeSkuAction({ batchId, action, sku, mode, defaultTargets = [] }) {
  if (!sku.taskId) {
    return { status: 'skipped', message: 'SKU 导入失败，没有可执行 task。' };
  }
  const task = await getTask(sku.taskId);
  const skipReason = shouldSkip(action, task);
  if (skipReason) {
    return { status: 'skipped', message: skipReason, task };
  }
  let updatedTask;
  if (action === 'recognize') updatedTask = await executeRecognize(task, { mode });
  else if (action === 'prepare') updatedTask = await executePrepare({ task, sku, batchId, defaultTargets, mode });
  else if (action === 'plan') updatedTask = await executePlan(task);
  else if (action === 'generate') updatedTask = await executeGenerate(task, { mode, batchId, sku });
  else if (action === 'review') updatedTask = await executeReview(task, { mode });
  else throw new Error(`Unsupported batch queue action: ${action}`);
  return { status: 'completed', task: updatedTask };
}

function withTimeout(promise, timeoutMs) {
  let timeoutId;
  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      const error = new Error('该 SKU 处理超时，可稍后重试。');
      error.code = 'JOB_TIMEOUT';
      reject(error);
    }, timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timeoutId));
}

async function runSkuJobLegacy({ batchId, action, sku, mode }) {
  const started = Date.now();
  await setSkuQueueState(batchId, sku.skuId, {
    queueStatus: 'running',
    queueAction: action,
    lastQueueError: null,
    lastDurationMs: null
  });
  await appendLog(batchId, { level: 'info', action, skuId: sku.skuId, taskId: sku.taskId, message: `${sku.skuId} 开始 ${action}` });
  try {
    const result = await withTimeout(executeSkuAction({ batchId, action, sku, mode }), batchQueueConfig().jobTimeoutMs);
    const durationMs = Date.now() - started;
    const queueStatus = result.status === 'skipped' ? 'skipped' : 'completed';
    const taskStatus = result.task?.status || sku.status;
    await setSkuQueueState(batchId, sku.skuId, {
      status: taskStatus,
      currentStep: action === 'recognize' && taskStatus === TASK_STATUS.RECOGNIZED ? 'waiting_confirm' : taskStatus,
      imageCount: result.task?.sourceImages?.length ?? sku.imageCount,
      queueStatus,
      queueAction: action,
      error: null,
      lastQueueError: null,
      lastDurationMs: durationMs
    });
    await appendLog(batchId, {
      level: queueStatus === 'skipped' ? 'warn' : 'success',
      action,
      skuId: sku.skuId,
      taskId: sku.taskId,
      message: result.message || `${sku.skuId} ${action} 完成`,
      durationMs
    });
  } catch (err) {
    const durationMs = Date.now() - started;
    const errorPayload = { code: err.code || `${action.toUpperCase()}_FAILED`, message: err.message };
    await setSkuQueueState(batchId, sku.skuId, {
      status: 'failed',
      currentStep: action,
      queueStatus: 'failed',
      queueAction: action,
      error: errorPayload,
      lastQueueError: errorPayload,
      lastDurationMs: durationMs
    });
    await appendLog(batchId, { level: 'error', action, skuId: sku.skuId, taskId: sku.taskId, message: `${sku.skuId} ${action} 失败：${err.message}`, error: errorPayload, durationMs });
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function retryDelay(config, retryCount) {
  if (config.retryBackoff === 'exponential') return config.retryDelayMs * (2 ** Math.max(0, retryCount - 1));
  return config.retryDelayMs;
}

async function runSkuJob({ batchId, action, sku, mode, defaultTargets = [] }) {
  const started = Date.now();
  const config = batchQueueConfig();
  let retryCount = Number(sku.retryCount || 0);
  await setSkuQueueState(batchId, sku.skuId, {
    queueStatus: 'running',
    queueAction: action,
    lastQueueError: null,
    lastDurationMs: null,
    retryCount,
    maxRetry: config.maxRetryPerJob
  });
  await appendLog(batchId, { level: 'info', action, skuId: sku.skuId, taskId: sku.taskId, message: `${sku.skuId} 开始 ${action}` });

  while (true) {
    try {
      if (retryCount > 0) {
        await appendLog(batchId, { level: 'info', action, skuId: sku.skuId, taskId: sku.taskId, message: `${sku.skuId} retry_started: 第 ${retryCount} 次重试` });
      }
      const result = await withTimeout(executeSkuAction({ batchId, action, sku, mode, defaultTargets }), config.jobTimeoutMs);
      const durationMs = Date.now() - started;
      const queueStatus = result.status === 'skipped' ? 'skipped' : 'completed';
      const taskStatus = result.task?.status || sku.status;
      await setSkuQueueState(batchId, sku.skuId, {
        status: taskStatus,
        currentStep: action === 'recognize' && taskStatus === TASK_STATUS.RECOGNIZED ? 'waiting_confirm' : taskStatus,
        imageCount: result.task?.sourceImages?.length ?? sku.imageCount,
        queueStatus,
        queueAction: action,
        error: null,
        classifiedError: null,
        lastQueueError: null,
        lastErrorCategory: null,
        lastErrorCode: null,
        lastUserActionType: null,
        retryable: false,
        requiresUserAction: false,
        retryCount,
        lastRetryAt: retryCount > 0 ? nowIso() : sku.lastRetryAt || null,
        lastDurationMs: durationMs
      });
      await appendLog(batchId, {
        level: queueStatus === 'skipped' ? 'warn' : 'success',
        action,
        skuId: sku.skuId,
        taskId: sku.taskId,
        message: retryCount > 0 ? `${sku.skuId} retry_success: 第 ${retryCount} 次重试成功` : (result.message || `${sku.skuId} ${action} 完成`),
        durationMs
      });
      return;
    } catch (err) {
      const classifiedError = classifyError(err, { action, skuId: sku.skuId, taskId: sku.taskId });
      const canAutoRetry = config.autoRetryEnabled &&
        isRetryableError(classifiedError) &&
        config.retryableCodes.includes(classifiedError.errorCode) &&
        retryCount < config.maxRetryPerJob;
      if (canAutoRetry) {
        retryCount += 1;
        await setSkuQueueState(batchId, sku.skuId, {
          retryCount,
          maxRetry: config.maxRetryPerJob,
          lastRetryAt: nowIso(),
          classifiedError,
          lastErrorCategory: classifiedError.errorCategory,
          lastErrorCode: classifiedError.errorCode,
          retryable: true,
          requiresUserAction: false
        });
        await appendLog(batchId, {
          level: 'warn',
          action,
          skuId: sku.skuId,
          taskId: sku.taskId,
          message: `${sku.skuId} retry_scheduled: ${classifiedError.errorCode} 可重试，准备第 ${retryCount} 次重试`,
          error: { code: classifiedError.errorCode, message: classifiedError.message },
          classifiedError
        });
        await delay(retryDelay(config, retryCount));
        continue;
      }

      const durationMs = Date.now() - started;
      const errorPayload = { code: classifiedError.errorCode, message: classifiedError.message };
      await setSkuQueueState(batchId, sku.skuId, {
        status: 'failed',
        currentStep: action,
        queueStatus: 'failed',
        queueAction: action,
        error: errorPayload,
        classifiedError,
        lastQueueError: errorPayload,
        lastErrorCategory: classifiedError.errorCategory,
        lastErrorCode: classifiedError.errorCode,
        lastUserActionType: classifiedError.userActionType,
        retryable: classifiedError.retryable,
        requiresUserAction: classifiedError.requiresUserAction,
        retryCount,
        maxRetry: config.maxRetryPerJob,
        lastErrorAt: nowIso(),
        lastDurationMs: durationMs
      });
      await appendLog(batchId, {
        level: 'error',
        action,
        skuId: sku.skuId,
        taskId: sku.taskId,
        message: `${sku.skuId} ${action} 失败：${classifiedError.message} ${getUserActionSuggestion(classifiedError)}`,
        error: errorPayload,
        classifiedError,
        durationMs
      });
      return;
    }
  }
}

function retryFilterMatches(sku, filter = 'retryable') {
  if (filter === 'all') return sku.queueStatus === 'failed' || sku.status === 'failed';
  if (filter === 'retryable') return Boolean(sku.retryable);
  if (filter === 'timeout') return sku.lastErrorCategory === 'timeout' || sku.lastErrorCode === 'JOB_TIMEOUT';
  if (filter === 'parse_error') return sku.lastErrorCode === 'PARSE_ERROR' || sku.lastErrorCode === 'INVALID_JSON';
  if (filter === 'provider') return sku.lastErrorCategory === 'provider' || sku.lastErrorCategory === 'network';
  if (filter === 'config') return sku.lastErrorCategory === 'config';
  return Boolean(sku.retryable);
}

async function processQueue({ batchId, action, concurrency, mode, controller, retryFailedOnly, retryFilter = 'retryable' }) {
  try {
    let batch = await getBatchTask(batchId);
    batch = normalizeBatchTask(batch);
    const resumePendingOnly = batch.queue?.status === 'paused';
    const jobs = (batch.skuTasks || [])
      .filter((sku) => {
        if (retryFailedOnly) return retryFilterMatches(sku, retryFilter);
        if (resumePendingOnly) return sku.queueStatus === 'pending';
        return true;
      })
      .map((sku) => ({ ...sku, queueStatus: 'pending', queueAction: action }));
    const jobSkuIds = new Set(jobs.map((sku) => sku.skuId));
    await updateBatchTask(batchId, (current) => {
      const normalized = normalizeBatchTask(current);
      const skuTasks = (normalized.skuTasks || []).map((sku) => (
        jobSkuIds.has(sku.skuId)
          ? { ...sku, queueStatus: 'pending', queueAction: action, lastQueueError: null }
          : sku
      ));
      const counts = queueCounts(skuTasks, action);
      return { skuTasks, queue: { ...normalized.queue, totalJobs: jobs.length, ...counts } };
    });

    let cursor = 0;
    let running = 0;
    await new Promise((resolve) => {
      const launch = () => {
        if (controller.cancelled) {
          if (running === 0) resolve();
          return;
        }
        if (controller.paused) {
          if (running === 0) resolve();
          return;
        }
        while (running < concurrency && cursor < jobs.length && !controller.paused && !controller.cancelled) {
          const sku = jobs[cursor];
          cursor += 1;
          running += 1;
          runSkuJob({ batchId, action, sku, mode, defaultTargets: batch.defaultTargets || [] })
            .catch(() => {})
            .finally(() => {
              running -= 1;
              launch();
            });
        }
        if (cursor >= jobs.length && running === 0) resolve();
      };
      launch();
    });

    const latest = normalizeBatchTask(await getBatchTask(batchId));
    if (controller.paused) {
      await writeQueueState(batchId, { status: 'paused', pausedAt: nowIso() });
      await appendLog(batchId, { level: 'warn', action, message: '队列已暂停，新 SKU 不再启动。' });
      return;
    }
    await releaseLock(batchId, { action, cancelled: controller.cancelled });
    const finalBatch = normalizeBatchTask(await getBatchTask(batchId));
    const counts = queueCounts(finalBatch.skuTasks || [], action);
    await appendLog(batchId, {
      level: counts.failedJobs > 0 ? 'warn' : 'success',
      action,
      message: `批量${action}完成：成功 ${counts.completedJobs}，失败 ${counts.failedJobs}，跳过 ${counts.skippedJobs}`
    });
  } finally {
    if (!controller.paused) controllers.delete(batchId);
  }
}

export async function runBatchQueue({ batchId, action, concurrency, mode = 'mock', waitForCompletion = false, retryFailedOnly = false, retryFilter = 'retryable' } = {}) {
  if (!['recognize', 'prepare', 'plan', 'generate', 'review'].includes(action)) {
    const error = new Error('Unsupported queue action');
    error.statusCode = 400;
    throw error;
  }
  const lockId = `queue-${nanoid(8)}`;
  const userSettings = await getUserSettings();
  const safeConcurrency = resolveBatchConcurrency(concurrency, userSettings);
  const batch = await acquireLock(batchId, { action, concurrency: safeConcurrency, lockId });
  const controller = {
    batchId,
    action,
    paused: false,
    cancelled: false,
    lockId
  };
  controllers.set(batchId, controller);
  const promise = processQueue({ batchId, action, concurrency: safeConcurrency, mode, controller, retryFailedOnly, retryFilter });
  controller.promise = promise;
  if (waitForCompletion) await promise;
  return getBatch(batchId);
}

export async function pauseBatchQueue(batchId) {
  const controller = controllers.get(batchId);
  if (controller) controller.paused = true;
  const batchTask = await writeQueueState(batchId, { status: 'paused', pausedAt: nowIso() });
  await appendLog(batchId, { level: 'warn', action: batchTask.queue?.action, message: '收到暂停请求，运行中的 SKU 会先完成。' });
  return getBatch(batchId);
}

export async function resumeBatchQueue(batchId) {
  const batch = normalizeBatchTask(await getBatchTask(batchId));
  if (!batch?.queue?.action) return getBatch(batchId);
  const existing = controllers.get(batchId);
  if (existing) {
    existing.paused = false;
    await writeQueueState(batchId, { status: 'running', resumedAt: nowIso() });
    await appendLog(batchId, { level: 'info', action: batch.queue.action, message: '队列已恢复。' });
    processQueue({
      batchId,
      action: batch.queue.action,
      concurrency: batch.queue.concurrency || batchQueueConfig().defaultConcurrency,
      mode: 'mock',
      controller: existing,
      retryFailedOnly: false
    }).catch(() => {});
    return getBatch(batchId);
  }
  await updateBatchTask(batchId, () => ({ locks: defaultBatchLocks() }));
  return runBatchQueue({
    batchId,
    action: batch.queue.action,
    concurrency: batch.queue.concurrency,
    mode: 'mock',
    waitForCompletion: false
  });
}

export async function cancelBatchQueue(batchId) {
  const controller = controllers.get(batchId);
  if (controller) controller.cancelled = true;
  const batchTask = await updateBatchTask(batchId, (current) => {
    const normalized = normalizeBatchTask(current);
    return {
      locks: defaultBatchLocks(),
      queue: {
        ...normalized.queue,
        status: 'cancelled',
        finishedAt: nowIso()
      },
      status: BATCH_STATUS.CANCELLED
    };
  });
  await appendLog(batchId, { level: 'warn', action: batchTask.queue?.action, message: '队列已取消。' });
  controllers.delete(batchId);
  return getBatch(batchId);
}

export async function retryFailedJobs({ batchId, action, concurrency, mode = 'mock', waitForCompletion = false, filter = 'retryable' } = {}) {
  const batch = normalizeBatchTask(await getBatchTask(batchId));
  if (filter === 'all') {
    await appendLog(batchId, { level: 'warn', action: action || batch.queue?.action || 'recognize', message: '手动重试 all：非 retryable 错误也会被纳入重试。' });
  }
  return runBatchQueue({
    batchId,
    action: action || batch.queue?.action || 'recognize',
    concurrency: concurrency || batch.queue?.concurrency,
    mode,
    waitForCompletion,
    retryFailedOnly: true,
    retryFilter: filter || 'retryable'
  });
}

export async function getBatchQueueLogs(batchId) {
  const batch = await getBatch(batchId);
  if (!batch) {
    const error = new Error('Batch task not found');
    error.statusCode = 404;
    throw error;
  }
  return {
    batchId,
    logs: batch.executionLogs || [],
    queue: batch.queue || defaultBatchQueue()
  };
}
