import {exportReportText} from './exportReportLabels.js';

function isEventLike(value) {
  if (!value || typeof value !== 'object') return false;
  return Boolean(value.currentTarget || value.nativeEvent || value.target?.nodeType || value.target?.__reactFiber);
}

function asPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || isEventLike(value)) return {};
  return value;
}

export function normalizeImportScanPayload(input = {}) {
  const safeInput = asPlainObject(input);
  const rootDir = typeof safeInput.rootDir === 'string' ? safeInput.rootDir.trim() : '';
  return rootDir ? { rootDir } : {};
}

export function normalizeImportScannedFoldersPayload(input = {}) {
  const safeInput = asPlainObject(input);
  return {
    folderPaths: Array.isArray(safeInput.folderPaths)
      ? safeInput.folderPaths.filter((item) => typeof item === 'string' && item.trim()).map((item) => item.trim())
      : [],
    batchName: typeof safeInput.batchName === 'string' ? safeInput.batchName : '',
    defaultTargets: Array.isArray(safeInput.defaultTargets) ? safeInput.defaultTargets : [],
    templateId: typeof safeInput.templateId === 'string' && safeInput.templateId ? safeInput.templateId : undefined
  };
}

export function normalizeImportBatchFolderPayload(input = {}) {
  const safeInput = asPlainObject(input);
  return {
    folderPath: typeof safeInput.folderPath === 'string' ? safeInput.folderPath : '',
    name: typeof safeInput.name === 'string' ? safeInput.name : '',
    defaultTargets: Array.isArray(safeInput.defaultTargets) ? safeInput.defaultTargets : [],
    templateId: typeof safeInput.templateId === 'string' && safeInput.templateId ? safeInput.templateId : undefined
  };
}

export function buildScanSummaryMessage(scanResult, t) {
  const candidates = Array.isArray(scanResult?.candidates) ? scanResult.candidates : [];
  const total = scanResult?.summary?.totalFolders ?? candidates.length;
  return exportReportText(t, '扫描完成，共发现 {count} 个 SKU 文件夹', {count:total});
}

export function getScanFeedbackDisplay(feedback, t) {
  if (feedback?.status === 'scanning') return {text:exportReportText(t,'正在扫描导入目录...'),isError:false};
  if (feedback?.status === 'completed') return {text:buildScanSummaryMessage({summary:{totalFolders:feedback.totalFolders}},t),isError:false};
  if (feedback?.status === 'failed') return {text:exportReportText(t,'扫描失败：{message}',{message:feedback.message || ''}),isError:true};
  return {text:'',isError:false};
}

export function hasScanCandidates(scanResult) {
  return Array.isArray(scanResult?.candidates) && scanResult.candidates.length > 0;
}

export function getScanCandidateDisplay(candidate = {}, options = {}, t) {
  const status = candidate.status || 'new';
  if (status === 'new') {
    return {
      status,
      label: exportReportText(t, '可导入'),
      hint: exportReportText(t, '扫描发现，可导入到当前 batch'),
      selectable: true
    };
  }
  if (status === 'imported') {
    const isCurrentBatch = Boolean(options.currentBatchId && candidate.existingBatchId === options.currentBatchId);
    return {
      status,
      label: exportReportText(t, isCurrentBatch ? '已导入当前 batch' : candidate.existingBatchId ? '已导入到其他 batch' : '已导入'),
      hint: isCurrentBatch
        ? exportReportText(t, '已导入当前 batch')
        : candidate.existingBatchId
          ? exportReportText(t, '已导入到其他 batch：{id}', {id:candidate.existingBatchId})
        : exportReportText(t, '已导入，不能重复导入'),
      selectable: false
    };
  }
  if (status === 'skipped') {
    return {
      status,
      label: exportReportText(t, '已跳过'),
      hint: candidate.reason || exportReportText(t, '本次导入已跳过'),
      selectable: false
    };
  }
  if (['empty', 'invalid', 'too_many_images', 'too_large'].includes(status)) {
    return {
      status,
      label: exportReportText(t, '无效 / 空文件夹'),
      hint: candidate.errors?.[0]?.message || candidate.warnings?.[0]?.message || exportReportText(t, '请检查 SKU 文件夹和图片数量'),
      selectable: false
    };
  }
  return {
    status,
    label: status,
    hint: candidate.reason || '',
    selectable: false
  };
}
