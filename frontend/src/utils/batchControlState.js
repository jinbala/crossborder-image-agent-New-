const resetFeedback = '导入状态已重置，请重新扫描目录并重新导入 SKU。';
const deleteFeedback = 'batch 记录已删除，本地图片未删除。';

const resetActions = new Set(['batch-reset-import', 'batch-delete']);

function summarizeBatchTask(batchTask = {}) {
  const skuTasks = Array.isArray(batchTask.skuTasks) ? batchTask.skuTasks : [];
  return {
    totalSku: batchTask.summary?.totalSku ?? skuTasks.length,
    waitingConfirmSku: batchTask.summary?.waitingConfirmSku ?? skuTasks.filter((sku) => ['recognized', 'pending_confirm', 'uploaded'].includes(sku.status) || ['recognized', 'pending_confirm', 'uploaded'].includes(sku.currentStep)).length,
    failedSku: batchTask.summary?.failedSku ?? skuTasks.filter((sku) => ['failed', 'error', 'partial_failed'].includes(sku.status) || ['failed', 'error', 'partial_failed'].includes(sku.queueStatus)).length,
    completedSku: batchTask.summary?.completedSku ?? skuTasks.filter((sku) => ['completed', 'done', 'exported'].includes(sku.status) || ['completed', 'done', 'exported'].includes(sku.queueStatus)).length
  };
}

function normalizeBatchListRow(batch = {}, currentBatchId = '') {
  const skuTasks = Array.isArray(batch.skuTasks) ? batch.skuTasks : [];
  const summary = {
    ...summarizeBatchTask(batch),
    ...(batch.summary || {})
  };
  return {
    ...batch,
    summary,
    templateName: batch.workflowTemplateSnapshot?.name || batch.templateSnapshot?.name || batch.templateName || batch.workflowTemplateName || '',
    skuIds: skuTasks.map((sku) => sku.skuId || sku.sku || sku.taskId).filter(Boolean),
    isCurrentBatch: Boolean(currentBatchId && batch.id === currentBatchId)
  };
}

export function buildBatchListRowsForBatchPage({ batches = [], batchTask = null } = {}) {
  const currentBatchId = batchTask?.id || '';
  const normalized = (Array.isArray(batches) ? batches : []).map((batch) => normalizeBatchListRow(batch, currentBatchId));
  if (!currentBatchId) return normalized;
  const currentRow = normalizeBatchListRow(batchTask, currentBatchId);
  const index = normalized.findIndex((batch) => batch.id === currentBatchId);
  if (index >= 0) {
    normalized[index] = {
      ...normalized[index],
      ...currentRow,
      summary: currentRow.summary,
      skuIds: currentRow.skuIds,
      templateName: currentRow.templateName || normalized[index].templateName,
      isCurrentBatch: true
    };
    return normalized;
  }
  return [currentRow, ...normalized];
}

export function buildSkuListRows({ batchTask = null, scanResult = null } = {}) {
  return buildSkuRowsForBatchPage({ batchTask, scanResult });
}

export function shouldRenderScanCandidates(batchTask) {
  return !batchTask?.id;
}

function hasScanCandidates(scanResult = null) {
  return Array.isArray(scanResult?.candidates) && scanResult.candidates.length > 0;
}

export function shouldShowResetImportStatusAction({ batchTask = null, scanResult = null } = {}) {
  return Boolean(batchTask?.id || hasScanCandidates(scanResult));
}

export function resetImportActionMode({ batchTask = null, scanResult = null } = {}) {
  if (batchTask?.id) return 'reset-current-batch';
  if (hasScanCandidates(scanResult)) return 'refresh-scan';
  return 'hidden';
}

export function buildSkuRowsForBatchPage({ batchTask = null, scanResult = null } = {}) {
  if (batchTask?.id) {
    return (batchTask.skuTasks || []).map((sku) => ({
      ...sku,
      sourceType: 'batch',
      rowSource: 'currentBatchTask',
      sourceLabel: '当前 batch SKU'
    }));
  }
  return (scanResult?.candidates || []).map((candidate) => ({
    ...candidate,
    skuId: candidate.skuId || candidate.folderName || candidate.displayName,
    displayName: candidate.displayName || candidate.folderName || candidate.skuId,
    imageCount: candidate.imageCount || 0,
    status: candidate.status || 'new',
    currentStep: candidate.status || 'new',
    queueStatus: candidate.status || 'new',
    sourceType: 'scan',
    rowSource: candidate.status === 'imported' ? 'importedElsewhere' : 'scanCandidate',
    sourceLabel: candidate.status === 'imported' ? '已导入到其他 batch' : '扫描发现 / 待导入',
    displayHint: candidate.status === 'imported'
      ? `已导入到其他 batch${candidate.existingBatchId ? `：${candidate.existingBatchId}` : ''}`
      : candidate.status === 'new'
        ? '可重新导入'
        : '扫描候选',
    taskId: null,
    folderPath: candidate.folderPath || '',
    warnings: candidate.warnings || [],
    errors: candidate.errors || []
  }));
}

export function batchControlStateTransition(action, response = {}, fallbackFeedback = '') {
  const result = response?.result || {};
  const shouldClear = resetActions.has(action) || result.clearClientState === true || result.batchInvalidated === true || ['reset', 'deleted'].includes(result.status);
  if (!shouldClear) {
    return {
      clearCurrentBatch: false,
      clearSkuTasks: false,
      clearReports: false,
      navigateToBatchList: false,
      feedback: fallbackFeedback
    };
  }
  return {
    clearCurrentBatch: true,
    clearSkuTasks: true,
    clearReports: true,
    batchInvalidated: true,
    navigateToBatchList: true,
    feedback: action === 'batch-delete' || result.status === 'deleted' ? deleteFeedback : resetFeedback
  };
}

export function shouldHideSkuListAfterBatchControl(batchTask) {
  return shouldRenderScanCandidates(batchTask);
}

export function shouldApplyBatchScopedResponse({
  requestBatchId = '',
  currentBatchId = '',
  requestGeneration = 0,
  currentGeneration = 0,
  batchInvalidated = false
} = {}) {
  if (batchInvalidated) return false;
  if (!requestBatchId || !currentBatchId) return false;
  if (String(requestBatchId) !== String(currentBatchId)) return false;
  return Number(requestGeneration) === Number(currentGeneration);
}
