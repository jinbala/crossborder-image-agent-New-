import { SQLITE_INDEX_TABLES } from './schema.js';

function boolInt(value) {
  return value ? 1 : 0;
}

function nowIso() {
  return new Date().toISOString();
}

function latestGeneratedImages(task = {}) {
  const byPlan = new Map();
  for (const image of task.generatedImages || []) {
    const key = image.planId || image.id;
    const current = byPlan.get(key);
    if (!current || (image.version || 1) >= (current.version || 1)) byPlan.set(key, image);
  }
  return [...byPlan.values()];
}

function riskLevelOf(review = {}) {
  return review.riskLevel || review.data?.riskLevel || 'low';
}

function passOf(review = {}) {
  return review.pass === true || review.status === 'passed' || review.data?.pass === true;
}

function imageTypeOf(imageOrReview = {}) {
  return imageOrReview.imageType || imageOrReview.type || imageOrReview.generationRequestSummary?.imageType || 'unknown';
}

function providerKey({ batchId, taskId, providerType, provider, model, action }) {
  return [batchId, taskId || 'batch', providerType, provider || 'unknown', model || 'unknown', action || 'unknown'].join('::');
}

function addProviderUsage(map, payload) {
  const id = providerKey(payload);
  const current = map.get(id) || {
    id,
    ...payload,
    callCount: 0,
    totalDurationMs: 0,
    estimatedCost: 0
  };
  current.callCount += 1;
  current.totalDurationMs += Number(payload.durationMs || 0);
  map.set(id, current);
}

async function tasksForBatch(store, batchTask = {}) {
  const tasks = [];
  for (const sku of batchTask.skuTasks || []) {
    if (!sku.taskId) continue;
    const task = await store.getTask(sku.taskId);
    if (task) tasks.push(task);
  }
  return tasks;
}

export function clearIndexTables(store) {
  const db = store.getDatabase();
  for (const table of SQLITE_INDEX_TABLES) {
    db.prepare(`DELETE FROM ${table}`).run();
  }
}

export function syncBatchSkuIndex(batchTask, store) {
  const db = store.getDatabase();
  const insert = db.prepare(`
    INSERT OR REPLACE INTO batch_sku_index (
      batch_id, task_id, sku_id, folder_name, status, current_step, queue_status,
      last_error_code, last_error_category, retryable, requires_user_action, updated_at
    ) VALUES (
      @batch_id, @task_id, @sku_id, @folder_name, @status, @current_step, @queue_status,
      @last_error_code, @last_error_category, @retryable, @requires_user_action, @updated_at
    )
  `);
  const transaction = db.transaction(() => {
    db.prepare('DELETE FROM batch_sku_index WHERE batch_id = ?').run(batchTask.id);
    for (const sku of batchTask.skuTasks || []) {
      insert.run({
        batch_id: batchTask.id,
        task_id: sku.taskId || `missing:${sku.skuId || sku.folderName || Math.random()}`,
        sku_id: sku.skuId || null,
        folder_name: sku.folderName || null,
        status: sku.status || null,
        current_step: sku.currentStep || null,
        queue_status: sku.queueStatus || null,
        last_error_code: sku.lastErrorCode || sku.classifiedError?.errorCode || sku.error?.code || null,
        last_error_category: sku.lastErrorCategory || sku.classifiedError?.errorCategory || null,
        retryable: boolInt(sku.retryable || sku.classifiedError?.retryable),
        requires_user_action: boolInt(sku.requiresUserAction || sku.classifiedError?.requiresUserAction),
        updated_at: sku.updatedAt || batchTask.updatedAt || nowIso()
      });
    }
  });
  transaction();
}

export function syncBatchQueueIndex(batchTask, store) {
  const queue = batchTask.queue || {};
  const locks = batchTask.locks || {};
  store.getDatabase().prepare(`
    INSERT OR REPLACE INTO batch_queue_index (
      batch_id, queue_status, action, concurrency, pending_jobs, running_jobs,
      completed_jobs, failed_jobs, skipped_jobs, locked, locked_at, updated_at
    ) VALUES (
      @batch_id, @queue_status, @action, @concurrency, @pending_jobs, @running_jobs,
      @completed_jobs, @failed_jobs, @skipped_jobs, @locked, @locked_at, @updated_at
    )
  `).run({
    batch_id: batchTask.id,
    queue_status: queue.status || 'idle',
    action: queue.action || null,
    concurrency: Number(queue.concurrency || 0),
    pending_jobs: Number(queue.pendingJobs || 0),
    running_jobs: Number(queue.runningJobs || 0),
    completed_jobs: Number(queue.completedJobs || 0),
    failed_jobs: Number(queue.failedJobs || 0),
    skipped_jobs: Number(queue.skippedJobs || 0),
    locked: boolInt(locks.isRunning),
    locked_at: locks.lockedAt || null,
    updated_at: batchTask.updatedAt || nowIso()
  });
}

export function syncBatchAnalyticsIndex(batchTask, store) {
  const analytics = batchTask.analytics || {};
  const sku = analytics.sku || {};
  const images = analytics.images || {};
  const review = analytics.review || {};
  const cost = analytics.cost || {};
  store.getDatabase().prepare(`
    INSERT OR REPLACE INTO batch_analytics_index (
      batch_id, total_sku, completed_sku, failed_sku, waiting_confirm_sku,
      total_images, real_generated_count, mock_preview_count,
      high_risk_count, medium_risk_count, low_risk_count, estimated_cost, updated_at
    ) VALUES (
      @batch_id, @total_sku, @completed_sku, @failed_sku, @waiting_confirm_sku,
      @total_images, @real_generated_count, @mock_preview_count,
      @high_risk_count, @medium_risk_count, @low_risk_count, @estimated_cost, @updated_at
    )
  `).run({
    batch_id: batchTask.id,
    total_sku: Number(sku.total ?? batchTask.skuTasks?.length ?? 0),
    completed_sku: Number(sku.completed || 0),
    failed_sku: Number(sku.failed || 0),
    waiting_confirm_sku: Number(sku.waitingConfirm || 0),
    total_images: Number(images.totalGenerated || 0),
    real_generated_count: Number(images.realGeneratedCount || 0),
    mock_preview_count: Number(images.mockPreviewCount || 0),
    high_risk_count: Number(review.highRiskCount || 0),
    medium_risk_count: Number(review.mediumRiskCount || 0),
    low_risk_count: Number(review.lowRiskCount || 0),
    estimated_cost: Number(cost.estimatedTotal || 0),
    updated_at: analytics.updatedAt || batchTask.updatedAt || nowIso()
  });
}

export function syncProviderUsageIndexes(batchTask, tasks = [], store) {
  const map = new Map();
  for (const task of tasks) {
    if (task.recognitionMeta?.provider) {
      addProviderUsage(map, {
        batchId: batchTask.id,
        taskId: task.id,
        providerType: 'vision',
        provider: task.recognitionMeta.provider,
        model: task.recognitionMeta.model,
        action: 'recognize',
        durationMs: task.recognitionMeta.durationMs
      });
    }
    for (const image of latestGeneratedImages(task)) {
      addProviderUsage(map, {
        batchId: batchTask.id,
        taskId: task.id,
        providerType: 'image',
        provider: image.provider || (image.isRealGenerated ? 'real' : 'mock'),
        model: image.model,
        action: 'generate',
        durationMs: image.durationMs
      });
      if (image.mattingProvider) {
        addProviderUsage(map, {
          batchId: batchTask.id,
          taskId: task.id,
          providerType: 'matting',
          provider: image.mattingProvider,
          model: image.mattingModel,
          action: 'matting',
          durationMs: image.mattingDurationMs || image.durationMs
        });
      }
    }
    for (const review of task.reviewResults || []) {
      addProviderUsage(map, {
        batchId: batchTask.id,
        taskId: task.id,
        providerType: 'review',
        provider: review.provider || (review.isRealReview ? 'real' : 'mock'),
        model: review.model,
        action: 'review',
        durationMs: review.durationMs
      });
    }
  }
  const db = store.getDatabase();
  const insert = db.prepare(`
    INSERT OR REPLACE INTO provider_usage_index (
      id, batch_id, task_id, provider_type, provider, model, action,
      call_count, total_duration_ms, estimated_cost, updated_at
    ) VALUES (
      @id, @batch_id, @task_id, @provider_type, @provider, @model, @action,
      @call_count, @total_duration_ms, @estimated_cost, @updated_at
    )
  `);
  const transaction = db.transaction(() => {
    db.prepare('DELETE FROM provider_usage_index WHERE batch_id = ?').run(batchTask.id);
    for (const usage of map.values()) {
      insert.run({
        id: usage.id,
        batch_id: usage.batchId,
        task_id: usage.taskId || null,
        provider_type: usage.providerType,
        provider: usage.provider || 'unknown',
        model: usage.model || 'unknown',
        action: usage.action || null,
        call_count: usage.callCount,
        total_duration_ms: usage.totalDurationMs,
        estimated_cost: usage.estimatedCost,
        updated_at: batchTask.updatedAt || nowIso()
      });
    }
  });
  transaction();
}

export function syncReviewRiskIndexes(batchTask, tasks = [], store) {
  const db = store.getDatabase();
  const insert = db.prepare(`
    INSERT OR REPLACE INTO review_risk_index (
      id, batch_id, task_id, image_id, plan_id, platform_id, image_type,
      risk_level, pass, issue_count, high_issue_count, medium_issue_count,
      low_issue_count, updated_at
    ) VALUES (
      @id, @batch_id, @task_id, @image_id, @plan_id, @platform_id, @image_type,
      @risk_level, @pass, @issue_count, @high_issue_count, @medium_issue_count,
      @low_issue_count, @updated_at
    )
  `);
  const transaction = db.transaction(() => {
    db.prepare('DELETE FROM review_risk_index WHERE batch_id = ?').run(batchTask.id);
    for (const task of tasks) {
      for (const [index, review] of (task.reviewResults || []).entries()) {
        const issues = review.issues || review.data?.issues || [];
        const counts = issues.reduce((summary, issue) => {
          if (issue.level === 'high') summary.high += 1;
          else if (issue.level === 'medium') summary.medium += 1;
          else summary.low += 1;
          return summary;
        }, { high: 0, medium: 0, low: 0 });
        const imageId = review.imageId || review.generatedImageId || review.image?.id || `review-${index}`;
        insert.run({
          id: [batchTask.id, task.id, imageId, review.planId || index].join('::'),
          batch_id: batchTask.id,
          task_id: task.id,
          image_id: imageId,
          plan_id: review.planId || null,
          platform_id: review.platformId || null,
          image_type: imageTypeOf(review),
          risk_level: riskLevelOf(review),
          pass: boolInt(passOf(review)),
          issue_count: issues.length,
          high_issue_count: counts.high,
          medium_issue_count: counts.medium,
          low_issue_count: counts.low,
          updated_at: task.updatedAt || batchTask.updatedAt || nowIso()
        });
      }
    }
  });
  transaction();
}

export async function syncBatchIndexes(batchTask, store) {
  if (!batchTask?.id) return;
  syncBatchSkuIndex(batchTask, store);
  syncBatchQueueIndex(batchTask, store);
  syncBatchAnalyticsIndex(batchTask, store);
  const tasks = await tasksForBatch(store, batchTask);
  syncProviderUsageIndexes(batchTask, tasks, store);
  syncReviewRiskIndexes(batchTask, tasks, store);
}

export async function syncTaskIndexes(task, store) {
  if (!task?.batchId) return;
  const batchTask = await store.getBatchTask(task.batchId);
  if (batchTask) await syncBatchIndexes(batchTask, store);
}

export async function rebuildAllIndexes({ store }) {
  await store.init();
  clearIndexTables(store);
  const batches = await store.getBatchTasks();
  const tasks = await store.getTasks();
  for (const batch of batches) {
    await syncBatchIndexes(batch, store);
  }
  const db = store.getDatabase();
  return {
    batchCount: batches.length,
    taskCount: tasks.length,
    batchSkuIndexRows: db.prepare('SELECT COUNT(*) AS count FROM batch_sku_index').get().count,
    providerUsageIndexRows: db.prepare('SELECT COUNT(*) AS count FROM provider_usage_index').get().count,
    reviewRiskIndexRows: db.prepare('SELECT COUNT(*) AS count FROM review_risk_index').get().count
  };
}
