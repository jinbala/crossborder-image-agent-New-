// Display-only projections. Never use these labels as request values or export
// keys, and never send arbitrary report text to the translation function.
export const batchReportLabels = {
  guideStatus: { done: '已完成', current: '当前步骤', blocked: '被阻塞', available: '可执行', pending: '待开始' },
  step: {
    upload: '上传', recognition: '识别', productConfirm: '商品确认', platformRules: '平台规则',
    imagePlan: '图片方案', imageGeneration: '图片生成', review: '审核', export: '导出'
  },
  severity: { fatal: '致命风险', high: '高风险', medium: '中风险', low: '低风险', info: '信息提示', mockInfo: 'mock 流程提示' },
  action: {
    removeText: '删除违规文案', removeClaim: '删除未确认卖点', confirmFieldEvidence: '核对字段证据',
    editTextLayout: '调整文字排版', regenerateMock: '重新生成 mock 预览',
    regenerateRealSample: '重新生成真实小样本', manualCheck: '人工复查',
    skipMockOnly: 'mock 流程提示', noActionNeeded: '无需处理'
  },
  imageType: {
    main_image: '主图', feature_image: '卖点图', detail_image: '细节图', lifestyle_image: '场景图',
    size_image: '尺寸图', package_image: '包装图', variant_image: '变种图', compatibility_image: '兼容性图'
  },
  result: { completed: '已完成', failed: '失败', skipped: '已跳过', blocked: '已阻止', running: '运行中', pending: '待处理' },
  snapshot: { imagePlanCount: '方案数量', generatedImageCount: '生成图片数量', reviewResultCount: '审核结果数量' },
  mode: { mockOnly: '仅 mock', mock: '模拟模式', real: '真实模式', 'real-test': '真实小样本模式' }
};
export function batchReportLabel(group, value, t) {
  const labels = Object.hasOwn(batchReportLabels, group) ? batchReportLabels[group] : undefined;
  return typeof t === 'function' && labels && Object.hasOwn(labels, value) ? t(labels[value]) : value;
}
