// Display-only mappings. Unknown values, protocol tokens and business data are returned unchanged.
export const maintenanceStatusLabels = Object.freeze({
  healthy: '正常', ready: '已就绪', warning: '有警告', error: '有错误', failed: '失败',
  not_started: '未开始', running: '执行中', completed: '已完成', passed: '通过',
  migrated: '已迁移', verified: '已验证', unknown: '未知', true: '是', false: '否'
});
export const settingFieldLabels = Object.freeze({
  visionProvider: '识别服务', imageProvider: '生图服务', backgroundProvider: '背景服务', reviewProvider: '审核服务', mattingProvider: '抠图服务',
  requireHumanConfirmation: '要求人工确认', preventAutoRealGeneration: '阻止自动真实生图', preventAutoRealReview: '阻止自动真实审核',
  showMockWarnings: '显示模拟结果提示', showApiCostWarnings: '显示 API 费用提示'
});
export const cleanupSafetyLabels = Object.freeze({ safe: '可安全清理', caution: '谨慎', risky: '高风险', unknown: '未知' });
export function maintenanceLabel(value, labels, t) {
  const key = String(value ?? 'unknown');
  return Object.hasOwn(labels, key) ? t(labels[key]) : key;
}
