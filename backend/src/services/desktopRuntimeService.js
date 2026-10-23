import { listBatchTasks } from './db.js';
import { refreshTaskIndex, legacyIndexStatus, normalizedState, indexedTaskState } from './taskCenterService.js';
import { platformDb, pageOptions } from './platformStore.js';
import { ownerSql } from './ownershipService.js';
import { getStorageDriver } from '../storage/index.js';

const recoveryKinds = ['batch', 'image', 'collection-job', 'sku-pack', 'image-pack', 'collection-plan', 'studio', 'listing-dry-run', 'pricing-preview', 'template-fill', 'commerce-sandbox'];
const recoveryStates = ['queued', 'running', 'waiting_user', 'paused', 'failed', 'partial'];
function recoveryHint(kind, state) {
  if (state === 'waiting_user') return '查看已保存的预览或计划，核对后手动确认；不会自动执行';
  if (kind === 'sku-pack') return '从 SKU 恢复点继续，已完成 SKU 不重复';
  if (kind === 'collection-job') return '选择断点继续或重试失败商品';
  if (kind === 'commerce-sandbox') return '仅本地模拟：核对差异并重新确认审批；不会写入真实店铺';
  return '查看任务详情并手动确认继续';
}

export function buildRecoveryItems({ batches = [], jobs = [], tasks = [] } = {}) {
  const result = [];
  for (const batch of batches) {
    const state = indexedTaskState(batch);
    if (recoveryStates.includes(state)) result.push({
      id: batch.id, type: 'batch', name: batch.name || batch.id, state,
      updatedAt: batch.updatedAt, href: `/batches/${encodeURIComponent(batch.id)}`,
      hint: recoveryHint('batch', state)
    });
  }
  for (const job of jobs) {
    const kind = job.type || 'collection-job', state = normalizedState(job.status || job.state);
    if (recoveryKinds.includes(kind) && recoveryStates.includes(state)) result.push({
      id: job.id, type: kind, name: job.name || job.options?.name || job.id,
      state, updatedAt: job.updatedAt || job.createdAt,
      href: kind === 'collection-job' ? `/workbench/collection?jobId=${encodeURIComponent(job.id)}` : kind === 'commerce-sandbox' ? `/commerce-sandbox/${encodeURIComponent(job.id)}` : `/results/${encodeURIComponent(job.id)}`,
      hint: recoveryHint(kind, state)
    });
  }
  const batchTaskIds = new Set(batches.flatMap((batch) => (batch.skuTasks || []).map((item) => item.taskId)));
  for (const task of tasks) {
    const state = normalizedState(task.status);
    if (!batchTaskIds.has(task.id) && !task.batchId && recoveryStates.includes(state)) result.push({
      id: task.id, type: 'image', name: task.name || task.sku || task.id,
      state, updatedAt: task.updatedAt,
      href: `/tasks/${encodeURIComponent(task.id)}/product`, hint: recoveryHint('image', state)
    });
  }
  return result.sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
}

export async function getDesktopRuntime(query = {}) {
  await refreshTaskIndex();
  const { page, pageSize } = pageOptions({ ...query, pageSize: query.pageSize || 50 });
  const scope = ownerSql();
  const where = `WHERE ${scope.clause} AND kind IN (${recoveryKinds.map(() => '?').join(',')}) AND state IN (${recoveryStates.map(() => '?').join(',')}) AND (kind!='image' OR coalesce(json_extract(summary,'$.parentBatchId'),'')='')`;
  const args = [...scope.args, ...recoveryKinds, ...recoveryStates];
  const db = platformDb(), total = db.prepare(`SELECT COUNT(*) AS n FROM task_index ${where}`).get(...args).n;
  const records = db.prepare(`SELECT * FROM task_index ${where} ORDER BY updated_at DESC,id LIMIT ? OFFSET ?`).all(...args, pageSize, (page - 1) * pageSize);
  const recovery = records.map((row) => ({ id: row.id, type: row.kind, name: row.title, state: row.state, updatedAt: row.updated_at, href: row.href,
    manifestRecovery: JSON.parse(row.summary).manifestRecovery,
    hint: recoveryHint(row.kind, row.state) }));
  return { desktop: Boolean(process.env.APP_DESKTOP_VERSION), version: process.env.APP_DESKTOP_VERSION || null,
    storageDriver: getStorageDriver(), recovery, recoveryPagination: { page, pageSize, total, totalPages: Math.max(1, Math.ceil(total / pageSize)) },
    indexStatus: legacyIndexStatus(), recoveryPolicy: 'manual', updatedAt: new Date().toISOString() };
}

export async function pauseAllQueues() {
  const [{ pauseBatchQueue }, { pauseRunningCollections }, { pauseRunningSkuPacks }, { pauseRunningImagePacks }] = await Promise.all([
    import('./batchQueueService.js'), import('./collectionJobService.js'),
    import('./skuPackService.js'), import('./imagePackRecoveryService.js')
  ]);
  const batches = (await listBatchTasks()).filter((batch) => batch.queue?.status === 'running');
  const results = await Promise.allSettled(batches.map((batch) => pauseBatchQueue(batch.id)));
  return { requested: batches.length, paused: results.filter((result) => result.status === 'fulfilled').length,
    failed: results.filter((result) => result.status === 'rejected').length,
    collections: pauseRunningCollections(), skuPacks: pauseRunningSkuPacks(), imagePacks: pauseRunningImagePacks(), message: '已请求暂停，正在处理的条目或 SKU 完成后停止。' };
}
