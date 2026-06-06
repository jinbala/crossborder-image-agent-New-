export const BATCH_STATUS = Object.freeze({
  CREATED: 'created',
  IMPORTED: 'imported',
  RECOGNIZING: 'recognizing',
  WAITING_CONFIRM: 'waiting_confirm',
  PLANNING: 'planning',
  GENERATING: 'generating',
  REVIEWING: 'reviewing',
  EXPORTING: 'exporting',
  COMPLETED: 'completed',
  PARTIAL_FAILED: 'partial_failed',
  FAILED: 'failed',
  CANCELLED: 'cancelled'
});

export function aggregateBatchStatus(skuTasks = [], fallback = BATCH_STATUS.IMPORTED) {
  if (!skuTasks.length) return fallback;
  const failedCount = skuTasks.filter((sku) => sku.status === 'failed').length;
  const waitingConfirmCount = skuTasks.filter((sku) => sku.status === 'recognized' || sku.currentStep === 'waiting_confirm').length;
  const completedCount = skuTasks.filter((sku) => sku.status === 'exported' || sku.status === 'completed').length;
  if (failedCount === skuTasks.length) return BATCH_STATUS.FAILED;
  if (waitingConfirmCount > 0) return failedCount > 0 ? BATCH_STATUS.PARTIAL_FAILED : BATCH_STATUS.WAITING_CONFIRM;
  if (completedCount === skuTasks.length) return BATCH_STATUS.COMPLETED;
  if (failedCount > 0) return BATCH_STATUS.PARTIAL_FAILED;
  return fallback;
}
