import { listBatchTasks } from './db.js';
import { refreshTaskIndex, legacyIndexStatus } from './taskCenterService.js';
import { platformDb, pageOptions } from './platformStore.js';
import { ownerSql } from './ownershipService.js';
import { pauseBatchQueue } from './batchQueueService.js';
import { pauseRunningCollections } from './collectionJobService.js';
import { getStorageDriver } from '../storage/index.js';
import { pauseRunningSkuPacks } from './skuPackService.js';

export function buildRecoveryItems({ batches = [], jobs = [], tasks = [] } = {}) {
  const result = [];
  for (const batch of batches) {
    if (['running', 'paused', 'pending'].includes(batch.queue?.status)) result.push({
      id: batch.id, type: 'batch', name: batch.name || batch.id, state: batch.queue.status,
      updatedAt: batch.updatedAt, href: `/batches/${encodeURIComponent(batch.id)}`,
      hint: '查看批量任务，确认执行模式后继续'
    });
  }
  for (const job of jobs) {
    if (['queued', 'pending', 'running', 'paused', 'failed', 'completed_with_errors'].includes(job.status)) result.push({
      id: job.id, type: job.type || 'collection', name: job.name || job.options?.name || job.id,
      state: job.status, updatedAt: job.updatedAt || job.createdAt,
      href: job.type === 'collection-job' || !job.type ? `/workbench/collection?jobId=${encodeURIComponent(job.id)}` : `/results/${encodeURIComponent(job.id)}`,
      hint: job.type === 'sku-pack' ? '打开图包恢复点，保留已完成 SKU，继续或重试失败 SKU' : '打开任务详情，选择断点继续或重试失败项'
    });
  }
  const batchTaskIds = new Set(batches.flatMap((batch) => (batch.skuTasks || []).map((item) => item.taskId)));
  for (const task of tasks) {
    if (!batchTaskIds.has(task.id) && ['failed', 'recognizing', 'generating', 'reviewing'].includes(task.status)) result.push({
      id: task.id, type: 'image', name: task.name || task.sku || task.id,
      state: task.status, updatedAt: task.updatedAt,
      href: `/tasks/${encodeURIComponent(task.id)}/product`, hint: '查看任务详情并手动确认重试'
    });
  }
  return result.sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
}

export async function getDesktopRuntime(query = {}) {
  await refreshTaskIndex();
  const { page, pageSize } = pageOptions({ ...query, pageSize: query.pageSize || 50 });
  const scope = ownerSql();
  const where = `WHERE ${scope.clause} AND ((kind='batch' AND state IN ('queued','running','paused')) OR (kind IN ('collection-job','sku-pack') AND state IN ('queued','running','paused','failed','partial')) OR (kind='image' AND state IN ('running','failed') AND coalesce(json_extract(summary,'$.parentBatchId'),'')=''))`;
  const db = platformDb(), total = db.prepare(`SELECT COUNT(*) AS n FROM task_index ${where}`).get(...scope.args).n;
  const records = db.prepare(`SELECT * FROM task_index ${where} ORDER BY updated_at DESC,id LIMIT ? OFFSET ?`).all(...scope.args, pageSize, (page - 1) * pageSize);
  const recovery = records.map((row) => ({ id: row.id, type: row.kind, name: row.title, state: row.state, updatedAt: row.updated_at, href: row.href,
    manifestRecovery: JSON.parse(row.summary).manifestRecovery,
    hint: row.kind === 'sku-pack' ? '从 SKU 恢复点继续，已完成 SKU 不重复' : row.kind === 'collection-job' ? '选择断点继续或重试失败商品' : '查看任务详情并手动确认继续' }));
  return { desktop: Boolean(process.env.APP_DESKTOP_VERSION), version: process.env.APP_DESKTOP_VERSION || null,
    storageDriver: getStorageDriver(), recovery, recoveryPagination: { page, pageSize, total, totalPages: Math.max(1, Math.ceil(total / pageSize)) },
    indexStatus: legacyIndexStatus(), recoveryPolicy: 'manual', updatedAt: new Date().toISOString() };
}

export async function pauseAllQueues() {
  const batches = (await listBatchTasks()).filter((batch) => batch.queue?.status === 'running');
  const results = await Promise.allSettled(batches.map((batch) => pauseBatchQueue(batch.id)));
  return { requested: batches.length, paused: results.filter((result) => result.status === 'fulfilled').length,
    failed: results.filter((result) => result.status === 'rejected').length,
    collections: pauseRunningCollections(), skuPacks: pauseRunningSkuPacks(), message: '已请求暂停，正在处理的条目或 SKU 完成后停止。' };
}
