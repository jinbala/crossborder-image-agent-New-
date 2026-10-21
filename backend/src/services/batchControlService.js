import { BATCH_STATUS } from '../constants/batchStatus.js';
import {
  deleteBatchTaskRecord,
  getBatchTask,
  removeImportedFoldersForBatch,
  updateBatchTask
} from './db.js';
import { cancelBatchQueue } from './batchQueueService.js';

function nowIso() {
  return new Date().toISOString();
}

function notFound() {
  const error = new Error('Batch task not found');
  error.statusCode = 404;
  return error;
}

function resultFor(batchId, status, affectedSku, warnings = []) {
  const result = {
    batchId,
    status,
    affectedSku,
    deletedFiles: false,
    originalFoldersPreserved: true,
    warnings,
    nextSuggestedAction: status === 'reset' || status === 'deleted'
      ? '可以重新扫描目录并重新导入 SKU。'
      : '当前 batch 已取消，后续队列不会继续启动。'
  };
  if (status === 'reset' || status === 'deleted') {
    result.clearClientState = true;
    result.clearClientReports = true;
    result.batchInvalidated = true;
    result.currentBatch = null;
    result.clearClientReportKeys = [
      'batchStabilityReport',
      'batchResumePlan',
      'batchReviewReport',
      'exportPackagePreview',
      'listingCsvPreview',
      'uploadReadinessReport',
      'uploadPayloadPreview',
      'sandboxReport'
    ];
  }
  return result;
}

export async function cancelBatch(batchId) {
  const current = await getBatchTask(batchId);
  if (!current) throw notFound();
  const batchTask = await cancelBatchQueue(batchId);
  return {
    ...resultFor(batchId, 'cancelled', (batchTask.skuTasks || []).length),
    batchTask
  };
}

export async function deleteBatch(batchId, options = {}) {
  const current = await getBatchTask(batchId);
  if (!current) throw notFound();
  if (current.queue?.status === 'running' || current.locks?.isRunning) {
    await cancelBatchQueue(batchId, { waitForCompletion: true });
  }
  const deleted = await deleteBatchTaskRecord(batchId, {
    deleteTasks: options.deleteTasks !== false,
    resetImportedFolders: true
  });
  return resultFor(batchId, 'deleted', (deleted.batch.skuTasks || []).length, [
    '已删除小程序内 batch/task 记录；本地原始 SKU 图片文件夹未删除。'
  ]);
}

export async function resetBatchImportState(batchId) {
  const current = await getBatchTask(batchId);
  if (!current) throw notFound();
  const removedCount = await removeImportedFoldersForBatch(batchId);
  const batchTask = await updateBatchTask(batchId, (batch) => ({
    status: batch.status === BATCH_STATUS.CANCELLED ? batch.status : BATCH_STATUS.IMPORTED,
    importResetAt: nowIso(),
    skuTasks: (batch.skuTasks || []).map((sku) => ({
      ...sku,
      importResetAt: nowIso()
    }))
  }));
  return {
    ...resultFor(batchId, 'reset', removedCount || (current.skuTasks || []).length, [
      '已重置导入状态；本地原始 SKU 图片文件夹未删除。'
    ]),
    resetBatchId: batchTask.id
  };
}
