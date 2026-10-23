// Display-only labels. Never translate arbitrary report text or request values.
export const reportDisplayLabels = {
  status: { passed: '通过', failed: '失败', pending: '待处理', missing: '缺失', partial: '部分完成', completed: '已完成', running: '运行中', skipped: '已跳过', blocked: '已阻止', present: '已生成', succeeded: '成功', paused: '已暂停', cancelled: '已取消', waiting_user: '等待人工', unknown: '未知', open: '待处理问题', investigating: '调查中', fixed: '已修复', verified: '已验证', wontFix: '暂不修复', available: '可用', ready: '就绪' },
  imageType: { main_image: '平台主图', feature_image: '核心卖点图', size_image: '尺寸/规格图', compatibility_image: '兼容设备图', package_image: '包装清单图', lifestyle_image: '使用场景图', detail_image: '细节图', variant_image: '变体图' },
  quality: { good: '良好', high: '高', medium: '中', low: '低', poor: '较差', unknown: '未知' },
  severity: { blocker: '阻断风险', fatal: '致命风险', high: '高风险', medium: '中风险', low: '低风险', info: '信息提示', mockInfo: 'mock 流程提示' },
  action: { removeText: '删除违规文案', editTextLayout: '调整文字排版', removeClaim: '删除未确认卖点', regenerateMock: '重新生成 mock 预览', confirmFieldEvidence: '人工确认证据', manualCheck: '人工复查', regenerateRealSample: '真实生图需单独确认', skipMockOnly: 'mock 流程提示', noActionNeeded: '无需处理' },
  module: { recognition: '商品识别', recognitionQuality: '识别质量', imagePlan: '图片方案', mockGeneration: '模拟图片生成', templateAudit: '模板验收', reviewReport: '审核报告', autoFix: '修正计划', batchStability: '批量稳定性', skuRetry: '单 SKU 重试', exportPackage: '资料包导出', listingCsv: '刊登 CSV', uploadReadiness: '上传预检', uploadPayloadPreview: '上传 Payload 预览', credentialSafety: '凭据安全', finalAcceptance: '最终验收', other: '其他' },
  riskKey: { recognitionRisk: '识别风险', reviewRisk: '审核风险', generationRisk: '生成风险' },
  readiness: { 'local-workbench': '本地工作台' }
};
export function reportDisplayLabel(group, value, t) {
  const labels = Object.hasOwn(reportDisplayLabels, group) ? reportDisplayLabels[group] : undefined;
  return typeof t === 'function' && labels && Object.hasOwn(labels, value) ? t(labels[value]) : value;
}
export function reportUi(t) {
  return t || ((text, params = {}) => String(text).replace(/\{(\w+)\}/g, (match, key) => Object.hasOwn(params, key) ? String(params[key]) : match));
}
