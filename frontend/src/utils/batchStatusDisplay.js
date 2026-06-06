function asArray(value) {
  return Array.isArray(value) ? value : [];
}

const queueStatusLabels = {
  new: '可重新导入',
  imported: '已导入到其他 batch',
  uploaded: '已上传图片',
  recognized: '已识别',
  confirmed: '已确认',
  planned: '已生成方案',
  generated: '已生成图片',
  reviewed: '已审核',
  exported: '已导出',
  blocked: '已阻止',
  cancelled: '已取消',
  failed: '失败',
  completed: '已完成',
  running: '运行中',
  pending: '待处理'
};

function normalizeText(value) {
  return String(value || '').trim();
}

function skuKeys(sku = {}) {
  return new Set([
    sku.taskId,
    sku.id,
    sku.skuId,
    sku.sku,
    sku.displayName
  ].map(normalizeText).filter(Boolean));
}

function rowMatchesSku(row = {}, sku = {}) {
  const keys = skuKeys(sku);
  return [
    row.taskId,
    row.id,
    row.skuId,
    row.sku,
    row.displayName
  ].map(normalizeText).some((value) => value && keys.has(value));
}

function findBlockedResumeRow(sku, batchResumePlan) {
  return asArray(batchResumePlan?.resumeGroups?.blocked).find((row) => rowMatchesSku(row, sku)) || null;
}

function findStabilityFailureRow(sku, batchStabilityReport) {
  return asArray(batchStabilityReport?.failures).find((row) => rowMatchesSku(row, sku)) || null;
}

function hasAnyStatus(sku = {}, statuses = []) {
  const values = [sku.queueStatus, sku.status, sku.currentStep].map(normalizeText);
  return statuses.some((status) => values.includes(status));
}

function firstMatchingStatus(sku = {}, statuses = []) {
  const values = [sku.queueStatus, sku.status, sku.currentStep].map(normalizeText);
  return statuses.find((status) => values.includes(status)) || '';
}

function isScanCandidate(sku = {}) {
  return (sku.rowSource === 'scanCandidate' || sku.rowSource === 'importedElsewhere' || sku.sourceType === 'scan') && !sku.taskId;
}

function isFreshCurrentBatchPendingRecognition(sku = {}) {
  if (!sku.taskId) return false;
  if (!(sku.rowSource === 'currentBatchTask' || sku.sourceType === 'batch')) return false;
  if (hasAnyStatus(sku, ['failed', 'partial_failed', 'error', 'blocked', 'cancelled', 'canceled', 'completed', 'done', 'running', 'recognizing', 'planning', 'generating', 'reviewing', 'exporting'])) {
    return false;
  }
  if (sku.error || sku.lastQueueError || sku.failedStep || sku.retryResult) return false;
  const values = [sku.queueStatus, sku.status, sku.currentStep, sku.queueAction].map((value) => normalizeText(value).toLowerCase()).filter(Boolean);
  if (!values.length) return true;
  const firstRunValues = new Set(['pending', 'idle', 'new', 'imported', 'uploaded', 'upload', 'recognition', 'recognize', 'pending_recognition', '待识别', '已导入']);
  return values.some((value) => firstRunValues.has(value));
}

function display(status, reason = '') {
  const label = queueStatusLabels[status] || queueStatusLabels.pending;
  return {
    status,
    label,
    text: `${status} / ${label}`,
    reason: normalizeText(reason)
  };
}

export function getSkuDisplayQueueStatus(sku = {}, batchStabilityReport = null, batchResumePlan = null) {
  if (isFreshCurrentBatchPendingRecognition(sku)) {
    return display('pending');
  }

  const blockedRow = findBlockedResumeRow(sku, batchResumePlan);
  if (blockedRow) {
    return display('blocked', blockedRow.blockedReason || blockedRow.reason || blockedRow.suggestion);
  }

  if (findStabilityFailureRow(sku, batchStabilityReport) || hasAnyStatus(sku, ['failed', 'partial_failed', 'error'])) {
    return display('failed');
  }

  if (hasAnyStatus(sku, ['cancelled', 'canceled'])) {
    return display('cancelled');
  }

  if (hasAnyStatus(sku, ['completed', 'done'])) {
    return display('completed');
  }

  if (hasAnyStatus(sku, ['running', 'recognizing', 'planning', 'generating', 'reviewing', 'exporting'])) {
    return display('running');
  }

  if (isScanCandidate(sku) && hasAnyStatus(sku, ['new'])) {
    return display('new');
  }

  const workflowStatus = firstMatchingStatus(sku, ['imported', 'uploaded', 'recognized', 'confirmed', 'planned', 'generated', 'reviewed', 'exported']);
  if (workflowStatus) {
    return display(workflowStatus);
  }

  return display('pending');
}

export function getSkuDisplayQueueHint(sku = {}, batchStabilityReport = null, batchResumePlan = null) {
  const displayStatus = getSkuDisplayQueueStatus(sku, batchStabilityReport, batchResumePlan);
  if (displayStatus.status === 'pending' && isFreshCurrentBatchPendingRecognition(sku)) {
    return '等待开始批量识别；真实识别可能产生 API 成本，请确认后启动。';
  }
  if (displayStatus.status === 'blocked') {
    return displayStatus.reason
      ? `已阻止：${displayStatus.reason}`
      : '已阻止：请先查看批量恢复计划';
  }
  if (sku.rowSource === 'importedElsewhere') {
    return sku.displayHint || '已导入到其他 batch，请先处理对应 batch 后再重新导入';
  }
  return '';
}
