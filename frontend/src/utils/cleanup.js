export const CLEANUP_GROUP_OPTIONS = [
  { value: 'visionTmp', label: '临时视觉文件 .vision-tmp', defaultChecked: true },
  { value: 'testResults', label: '测试结果 backend/test-results', defaultChecked: true },
  { value: 'oldOutputs', label: '旧输出 outputs', defaultChecked: false },
  { value: 'exportZips', label: '旧导出 ZIP', defaultChecked: true },
  { value: 'oldBackups', label: '旧备份 backups', defaultChecked: false },
  { value: 'tempMatting', label: '临时抠图文件', defaultChecked: true },
  { value: 'oldMockImages', label: '旧 mock 图片', defaultChecked: true },
  { value: 'orphanUploads', label: '孤儿 uploads', defaultChecked: false, caution: '谨慎：第一版只标记高风险，默认不会删除。' }
];

const SUPPORTED_GROUPS = new Set(CLEANUP_GROUP_OPTIONS.map((option) => option.value));

export function normalizeCleanupPayload(input = {}) {
  const safeInput = input && typeof input === 'object' && !('currentTarget' in input) && !('nativeEvent' in input)
    ? input
    : {};
  const days = Number(safeInput.olderThanDays);
  const olderThanDays = Number.isFinite(days) && days >= 0 ? Math.floor(days) : 30;
  const groups = Array.isArray(safeInput.groups)
    ? [...new Set(safeInput.groups.map(String).filter((group) => SUPPORTED_GROUPS.has(group)))]
    : CLEANUP_GROUP_OPTIONS.filter((option) => option.defaultChecked).map((option) => option.value);
  const payload = { olderThanDays, groups };
  if (safeInput.confirm === true) payload.confirm = true;
  return payload;
}

export function formatCleanupBytes(bytes = 0) {
  const value = Number(bytes);
  if (!Number.isFinite(value) || value <= 0) return '0 B';
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(2)} KB`;
  if (value < 1024 * 1024 * 1024) return `${(value / 1024 / 1024).toFixed(2)} MB`;
  return `${(value / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export function cleanupRiskLabel(riskLevel) {
  if (riskLevel === 'safe') return '安全';
  if (riskLevel === 'caution') return '谨慎';
  if (riskLevel === 'risky') return '高风险';
  return '未知';
}

export function cleanupRunDisabled(preview) {
  if (!preview?.groups?.length) return true;
  return !preview.groups.some((group) => group.files?.some((file) => file.deletable));
}

export function cleanupPreviewStats(preview) {
  const files = (preview?.groups || []).flatMap((group) => group.files || []);
  const deletable = files.filter((file) => file.deletable);
  return {
    totalFiles: files.length,
    deletableFiles: deletable.length,
    deletableBytes: deletable.reduce((sum, file) => sum + Number(file.sizeBytes || 0), 0)
  };
}

export function cleanupEmptyPreviewMessage(preview, summary = null, selectedGroups = []) {
  if (!preview) return '';
  const groups = preview.groups || [];
  const hasNoFiles = Number(preview.totalFiles || 0) === 0 ||
    Number(preview.totalBytes || 0) === 0 ||
    groups.every((group) => !group.files?.length);
  if (!hasNoFiles) return '';

  const selected = new Set(Array.isArray(selectedGroups) ? selectedGroups : []);
  const summaryHasSelectedFiles = (summary?.groups || []).some((group) => (
    selected.has(group.groupName) && Number(group.fileCount || 0) > 0
  ));
  if (summaryHasSelectedFiles) {
    return '目录中存在运行文件，但没有超过当前时间阈值，因此不会被清理。';
  }

  return '当前没有符合时间条件的可清理文件。这通常表示这些运行文件还没有超过当前时间阈值，因此系统不会清理。你可以尝试切换到 30 天前 / 90 天前，或稍后再清理。';
}
