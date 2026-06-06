import { nanoid } from 'nanoid';
import { getBatchTask, getTask, listBatchTasks, updateBatchTask } from './db.js';
import { getProviderCallCost, getProviderCostConfig } from '../config/providerCostConfig.js';
import { getUserSettings } from './userSettingsService.js';
import { getStorageDriver, getStore } from '../storage/index.js';

function nowIso() {
  return new Date().toISOString();
}

function emptyProviderStats() {
  return {};
}

function incrementProvider(stats, provider, model, durationMs = 0) {
  const key = provider || 'unknown';
  if (!stats[key]) {
    stats[key] = {
      calls: 0,
      durationMs: 0,
      models: {}
    };
  }
  stats[key].calls += 1;
  stats[key].durationMs += Number(durationMs) || 0;
  const modelKey = model || 'unknown';
  stats[key].models[modelKey] = (stats[key].models[modelKey] || 0) + 1;
}

function settingsCostPerCall(settingsCost = {}, action, provider) {
  const bucket = settingsCost?.[action] || {};
  const value = bucket?.[provider];
  if (typeof value === 'number') return value;
  if (typeof value === 'string') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  if (value && typeof value === 'object') {
    const parsed = Number(value.perCall);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function addCost(cost, action, provider, calls = 1, settingsCost = null) {
  const perCallFromSettings = settingsCostPerCall(settingsCost, action, provider);
  const perCall = perCallFromSettings ?? getProviderCallCost(action, provider);
  const amount = perCall * calls;
  cost.byAction[action] = (cost.byAction[action] || 0) + amount;
  if (!cost.byProvider[provider || 'unknown']) cost.byProvider[provider || 'unknown'] = 0;
  cost.byProvider[provider || 'unknown'] += amount;
  cost.estimatedTotal += amount;
}

function riskLevelOf(review = {}) {
  return review.riskLevel || review.data?.riskLevel || 'low';
}

function isReviewPass(review = {}) {
  return review.pass === true || review.status === 'passed' || review.data?.pass === true;
}

function imageTypeOf(image = {}) {
  return image.imageType || image.type || image.generationRequestSummary?.imageType || 'unknown';
}

function latestGeneratedImages(task = {}) {
  const byPlan = new Map();
  for (const image of task.generatedImages || []) {
    const key = image.planId || image.id;
    const current = byPlan.get(key);
    if (!current || (image.version || 1) >= (current.version || 1)) {
      byPlan.set(key, image);
    }
  }
  return [...byPlan.values()];
}

async function tasksForBatch(batchTask = {}) {
  const tasks = [];
  for (const sku of batchTask.skuTasks || []) {
    if (!sku.taskId) continue;
    try {
      const task = await getTask(sku.taskId);
      if (task) tasks.push(task);
    } catch {
      // Keep analytics resilient for partially corrupt old batch data.
    }
  }
  return tasks;
}

export function computeProviderUsage(tasks = []) {
  const providers = {
    vision: emptyProviderStats(),
    image: emptyProviderStats(),
    review: emptyProviderStats(),
    matting: emptyProviderStats()
  };
  for (const task of tasks) {
    const meta = task.recognitionMeta;
    if (meta?.provider) incrementProvider(providers.vision, meta.provider, meta.model, meta.durationMs);
    for (const image of latestGeneratedImages(task)) {
      incrementProvider(providers.image, image.provider || (image.isRealGenerated ? 'real' : 'mock'), image.model, image.durationMs);
      if (image.mattingProvider) incrementProvider(providers.matting, image.mattingProvider, image.mattingModel, image.mattingDurationMs || image.durationMs);
    }
    for (const review of task.reviewResults || []) {
      incrementProvider(providers.review, review.provider || (review.isRealReview ? 'real' : 'mock'), review.model, review.durationMs);
    }
  }
  return providers;
}

export function computeImageSourceStats(tasks = []) {
  const images = tasks.flatMap(latestGeneratedImages);
  return images.reduce((summary, image) => {
    summary.totalGenerated += 1;
    const type = imageTypeOf(image);
    summary.byImageType[type] = (summary.byImageType[type] || 0) + 1;
    if (image.fallbackToMock) summary.fallbackMockCount += 1;
    if (image.isRealGenerated) summary.realGeneratedCount += 1;
    if (image.isMockPreview || image.provider === 'mock') summary.mockPreviewCount += 1;
    return summary;
  }, {
    totalGenerated: 0,
    mockPreviewCount: 0,
    realGeneratedCount: 0,
    fallbackMockCount: 0,
    byImageType: {}
  });
}

export function computeReviewStats(tasks = []) {
  return tasks.flatMap((task) => task.reviewResults || []).reduce((summary, review) => {
    summary.totalReviewed += 1;
    if (isReviewPass(review)) summary.passCount += 1;
    else summary.failCount += 1;
    const risk = riskLevelOf(review);
    if (risk === 'high') summary.highRiskCount += 1;
    else if (risk === 'medium') summary.mediumRiskCount += 1;
    else summary.lowRiskCount += 1;
    if (review.fallbackToMockReview) summary.fallbackReviewCount += 1;
    if (review.isRealReview) summary.realReviewCount += 1;
    else summary.mockReviewCount += 1;
    return summary;
  }, {
    totalReviewed: 0,
    passCount: 0,
    failCount: 0,
    highRiskCount: 0,
    mediumRiskCount: 0,
    lowRiskCount: 0,
    mockReviewCount: 0,
    realReviewCount: 0,
    fallbackReviewCount: 0
  });
}

export function computeDurationStats(batchTask = {}, tasks = []) {
  const taskById = new Map(tasks.map((task) => [task.id, task]));
  const durations = [];
  for (const sku of batchTask.skuTasks || []) {
    const logs = (batchTask.executionLogs || []).filter((log) => log.skuId === sku.skuId && Number.isFinite(Number(log.durationMs)));
    let total = logs.reduce((sum, log) => sum + Number(log.durationMs || 0), 0);
    const task = taskById.get(sku.taskId);
    if (!total && task) {
      total += Number(task.recognitionMeta?.durationMs || 0);
      total += latestGeneratedImages(task).reduce((sum, image) => sum + Number(image.durationMs || 0), 0);
      total += (task.reviewResults || []).reduce((sum, review) => sum + Number(review.durationMs || 0), 0);
    }
    if (total > 0) durations.push({ skuId: sku.skuId, taskId: sku.taskId, durationMs: total });
  }
  const totalMs = durations.reduce((sum, item) => sum + item.durationMs, 0);
  const sorted = [...durations].sort((a, b) => a.durationMs - b.durationMs);
  return {
    totalMs,
    averagePerSkuMs: durations.length ? Math.round(totalMs / durations.length) : 0,
    slowestSku: sorted.at(-1) || null,
    fastestSku: sorted[0] || null
  };
}

export function estimateBatchCost(_batchTask = {}, tasks = [], userSettings = null) {
  const cost = {
    currency: userSettings?.cost?.currency || 'USD',
    estimatedTotal: 0,
    byProvider: {},
    byAction: {
      vision: 0,
      image: 0,
      review: 0,
      matting: 0
    },
    notes: ['Cost is a local estimate based on user settings or per-call environment variables. It is not a provider bill.']
  };
  const settingsCost = userSettings?.cost || null;
  getProviderCostConfig();
  for (const task of tasks) {
    if (task.recognitionMeta?.provider) addCost(cost, 'vision', task.recognitionMeta.provider, 1, settingsCost);
    for (const image of latestGeneratedImages(task)) {
      addCost(cost, 'image', image.provider || (image.isRealGenerated ? 'real' : 'mock'), 1, settingsCost);
      if (image.mattingProvider) addCost(cost, 'matting', image.mattingProvider, 1, settingsCost);
    }
    for (const review of task.reviewResults || []) {
      addCost(cost, 'review', review.provider || (review.isRealReview ? 'real' : 'mock'), 1, settingsCost);
    }
  }
  cost.estimatedTotal = Number(cost.estimatedTotal.toFixed(6));
  for (const action of Object.keys(cost.byAction)) cost.byAction[action] = Number(cost.byAction[action].toFixed(6));
  for (const provider of Object.keys(cost.byProvider)) cost.byProvider[provider] = Number(cost.byProvider[provider].toFixed(6));
  return cost;
}

function computeSkuStats(batchTask = {}) {
  const skuTasks = batchTask.skuTasks || [];
  return {
    total: skuTasks.length,
    completed: skuTasks.filter((sku) => ['completed', 'exported', 'reviewed', 'generated'].includes(sku.status)).length,
    failed: skuTasks.filter((sku) => sku.status === 'failed').length,
    waitingConfirm: skuTasks.filter((sku) => sku.status === 'recognized' || sku.currentStep === 'waiting_confirm').length,
    skipped: skuTasks.filter((sku) => sku.queueStatus === 'skipped').length
  };
}

export function computeFailureSummary(batchTask = {}) {
  return (batchTask.skuTasks || []).reduce((summary, sku) => {
    if (sku.status !== 'failed' && sku.queueStatus !== 'failed' && !sku.classifiedError) return summary;
    const category = sku.lastErrorCategory || sku.classifiedError?.errorCategory || 'unknown';
    const code = sku.lastErrorCode || sku.classifiedError?.errorCode || sku.error?.code || 'UNKNOWN_ERROR';
    const actionType = sku.lastUserActionType || sku.classifiedError?.userActionType || null;
    summary.totalFailed += 1;
    summary.byCategory[category] = (summary.byCategory[category] || 0) + 1;
    summary.byCode[code] = (summary.byCode[code] || 0) + 1;
    if (sku.retryable || sku.classifiedError?.retryable) summary.retryableCount += 1;
    if (sku.requiresUserAction || sku.classifiedError?.requiresUserAction) summary.requiresUserActionCount += 1;
    if (actionType) summary.userActionTypes[actionType] = (summary.userActionTypes[actionType] || 0) + 1;
    return summary;
  }, {
    totalFailed: 0,
    byCategory: {},
    byCode: {},
    retryableCount: 0,
    requiresUserActionCount: 0,
    userActionTypes: {}
  });
}

function analyticsWarnings(analytics) {
  const warnings = [];
  if (analytics.sku.failed > 0) warnings.push({ code: 'FAILED_SKU', message: `${analytics.sku.failed} 个 SKU 失败，建议查看日志并重试。` });
  if (analytics.images.fallbackMockCount > 0) warnings.push({ code: 'FALLBACK_MOCK', message: '存在真实生成失败后回退 mock 的图片。' });
  if (analytics.review.highRiskCount > 0) warnings.push({ code: 'HIGH_RISK_REVIEW', message: '存在 high risk 审核结果，需要人工复核。' });
  if (analytics.images.realGeneratedCount > analytics.review.realReviewCount + analytics.review.mockReviewCount && analytics.images.realGeneratedCount > 0) {
    warnings.push({ code: 'REAL_IMAGE_NOT_REVIEWED', message: '存在真实生成图片尚未审核。' });
  }
  return warnings;
}

export async function computeBatchAnalytics(batchTask) {
  const batch = batchTask || {};
  const tasks = await tasksForBatch(batch);
  const userSettings = await getUserSettings();
  const analytics = {
    updatedAt: nowIso(),
    analyticsSource: 'object_scan',
    templateId: batch.workflowTemplateSnapshot?.id || null,
    templateName: batch.workflowTemplateSnapshot?.name || null,
    sku: computeSkuStats(batch),
    images: computeImageSourceStats(tasks),
    review: computeReviewStats(tasks),
    providers: computeProviderUsage(tasks),
    duration: computeDurationStats(batch, tasks),
    cost: estimateBatchCost(batch, tasks, userSettings),
    failureSummary: computeFailureSummary(batch),
    warnings: []
  };
  analytics.warnings = analyticsWarnings(analytics);
  return analytics;
}

function tryGetSqliteSummaryFromIndex() {
  if (getStorageDriver() !== 'sqlite') return null;
  const store = getStore();
  const db = store.getDatabase();
  const rows = db.prepare(`
    SELECT
      b.id,
      b.status,
      b.name,
      b.updated_at,
      a.batch_id AS analytics_batch_id,
      a.total_sku,
      a.completed_sku,
      a.failed_sku,
      a.high_risk_count,
      a.estimated_cost
    FROM batch_tasks b
    LEFT JOIN batch_analytics_index a ON a.batch_id = b.id
    ORDER BY b.updated_at DESC
  `).all();
  if (rows.some((row) => !row.analytics_batch_id)) return null;
  const summary = rows.reduce((acc, row) => {
    const totalSku = Number(row.total_sku || 0);
    const completedSku = Number(row.completed_sku || 0);
    const failedSku = Number(row.failed_sku || 0);
    const highRiskCount = Number(row.high_risk_count || 0);
    const estimatedCost = Number(row.estimated_cost || 0);
    acc.batchCount += 1;
    acc.totalSku += totalSku;
    acc.completedSku += completedSku;
    acc.failedSku += failedSku;
    acc.estimatedTotalCost += estimatedCost;
    if (highRiskCount > 0) acc.highRiskBatchCount += 1;
    acc.recentBatches.push({
      id: row.id,
      name: row.name,
      status: row.status,
      updatedAt: row.updated_at,
      totalSku,
      failedSku,
      highRiskCount,
      estimatedCost
    });
    return acc;
  }, {
    analyticsSource: 'sqlite_index',
    batchCount: 0,
    totalSku: 0,
    completedSku: 0,
    failedSku: 0,
    estimatedTotalCost: 0,
    highRiskBatchCount: 0,
    recentBatches: []
  });
  summary.estimatedTotalCost = Number(summary.estimatedTotalCost.toFixed(6));
  return summary;
}

function trimLogs(logs = []) {
  return logs.slice(-500);
}

export async function refreshBatchAnalytics(batchId) {
  const batchTask = await getBatchTask(batchId);
  if (!batchTask) {
    const error = new Error('Batch task not found');
    error.statusCode = 404;
    throw error;
  }
  const startedAt = nowIso();
  const analytics = await computeBatchAnalytics(batchTask);
  const completedAt = nowIso();
  const updated = await updateBatchTask(batchId, (current) => ({
    analytics,
    executionLogs: trimLogs([
      ...(current.executionLogs || []),
      { id: `log-${nanoid(8)}`, timestamp: startedAt, level: 'info', action: 'analytics', skuId: null, taskId: null, message: 'analytics_refresh_started', error: null, durationMs: null },
      { id: `log-${nanoid(8)}`, timestamp: completedAt, level: 'success', action: 'analytics', skuId: null, taskId: null, message: 'analytics_refresh_completed', error: null, durationMs: null },
      { id: `log-${nanoid(8)}`, timestamp: completedAt, level: 'info', action: 'analytics', skuId: null, taskId: null, message: `cost_estimated: ${analytics.cost.currency} ${analytics.cost.estimatedTotal}`, error: null, durationMs: null },
      { id: `log-${nanoid(8)}`, timestamp: completedAt, level: 'info', action: 'analytics', skuId: null, taskId: null, message: `provider_usage_summary: vision ${Object.keys(analytics.providers.vision).length}, image ${Object.keys(analytics.providers.image).length}, review ${Object.keys(analytics.providers.review).length}`, error: null, durationMs: null }
    ])
  }));
  return updated.analytics;
}

export async function getBatchAnalytics(batchId) {
  const batchTask = await getBatchTask(batchId);
  if (!batchTask) {
    const error = new Error('Batch task not found');
    error.statusCode = 404;
    throw error;
  }
  return batchTask.analytics || computeBatchAnalytics(batchTask);
}

export async function getAllBatchAnalyticsSummary() {
  try {
    const indexed = tryGetSqliteSummaryFromIndex();
    if (indexed) return indexed;
  } catch {
    // Fall back to object scan if indexes are missing, stale, or unreadable.
  }
  const batches = await listBatchTasks();
  const analyticsList = await Promise.all(batches.map(async (batch) => ({
    batch,
    analytics: batch.analytics || await computeBatchAnalytics(batch)
  })));
  return analyticsList.reduce((summary, item) => {
    summary.batchCount += 1;
    summary.totalSku += item.analytics.sku.total || 0;
    summary.completedSku += item.analytics.sku.completed || 0;
    summary.failedSku += item.analytics.sku.failed || 0;
    summary.estimatedTotalCost += item.analytics.cost.estimatedTotal || 0;
    if ((item.analytics.review.highRiskCount || 0) > 0) summary.highRiskBatchCount += 1;
    summary.recentBatches.push({
      id: item.batch.id,
      name: item.batch.name,
      status: item.batch.status,
      updatedAt: item.batch.updatedAt,
      totalSku: item.analytics.sku.total,
      failedSku: item.analytics.sku.failed,
      highRiskCount: item.analytics.review.highRiskCount,
      estimatedCost: item.analytics.cost.estimatedTotal
    });
    return summary;
  }, {
    analyticsSource: 'object_scan',
    batchCount: 0,
    totalSku: 0,
    completedSku: 0,
    failedSku: 0,
    estimatedTotalCost: 0,
    highRiskBatchCount: 0,
    recentBatches: []
  });
}
