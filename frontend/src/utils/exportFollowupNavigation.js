function statusOf(sku = {}) {
  return sku.status || sku.currentStep || '';
}

function isPendingConfirmSku(sku = {}) {
  const status = statusOf(sku);
  return Boolean(sku.taskId) && (status === 'recognized' || status === 'waiting_confirm' || sku.currentStep === 'waiting_confirm');
}

export function findBatchContainingTask({ task = {}, batches = [] } = {}) {
  if (!task?.id || !Array.isArray(batches)) return null;
  if (task.batchId) {
    const directBatch = batches.find((batch) => batch.id === task.batchId);
    if (directBatch) return directBatch;
  }
  return batches.find((batch) => (batch.skuTasks || []).some((sku) => sku.taskId === task.id)) || null;
}

export function getPendingConfirmSkus(batchTask = {}) {
  return (batchTask?.skuTasks || []).filter(isPendingConfirmSku);
}

export function buildExportFollowupNavigation({ task = {}, batches = [] } = {}) {
  const batch = findBatchContainingTask({ task, batches });
  const batchId = batch?.id || task?.batchId || '';
  const pendingSkus = getPendingConfirmSkus(batch);
  const nextPendingSku = pendingSkus[0] || null;
  return {
    batchId,
    pendingCount: pendingSkus.length,
    nextPendingSku,
    nextPendingUrl: nextPendingSku?.taskId ? `/tasks/${nextPendingSku.taskId}/product` : '',
    pendingQueueUrl: batchId ? `/batches/${batchId}?focus=confirm` : ''
  };
}
