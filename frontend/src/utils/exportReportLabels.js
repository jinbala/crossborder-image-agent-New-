// Display-only labels. Do not translate arbitrary warnings, file paths, fields,
// IDs or report bodies, even when their text happens to match a catalog key.
export const exportReportLabels = {
  source: {
    mock: 'mock 预览图', mockPreview: 'mock 预览图', real: '真实生成图', realGenerated: '真实生成图',
    generated: '生成图片（来源未验证）', fallbackMock: '回退 mock 图片', fallback_mock: '回退 mock 图片',
    realSample: '真实小样本', missing: '缺失'
  },
  status: {
    ready: '可用', missing: '缺失', blocked: '已阻止', warning: '有警告', noReview: '未审核', no_review: '未审核',
    accepted: '模拟接收', accepted_with_warnings: '模拟接收（含警告）', failed: '失败', succeeded: '成功',
    passed: '已通过', reviewed: '已审核', missingTask: '任务缺失',
    skipped: '已跳过', pending: '待处理', completed: '已完成', running: '运行中', paused: '已暂停', cancelled: '已取消'
  },
  card: {
    'SKU 总数': 'SKU 总数', '成功 SKU': '成功 SKU', '失败 SKU': '失败 SKU', '可导出图片': '可导出图片',
    '缺失图片': '缺失图片', 'mock 图片': 'mock 图片', '报告文件': '报告文件',
    'total SKU': 'SKU 总数', 'ready SKU': '可上传 SKU', 'blocked SKU': '被阻止 SKU', 'warning SKU': '有警告 SKU',
    'missing images': '缺失图片', 'missing fields': '缺失字段', 'noReview SKU': '未审核 SKU',
    'highRisk SKU': '高风险 SKU', 'mockImage SKU': '含 mock 图片的 SKU', canUploadNow: '当前可上传',
    'ready payload': '可用请求', 'warning payload': '有警告请求', 'blocked payload': '被阻止请求', 'mock images': '含 mock 图片的请求',
    accepted: '模拟接收', accepted_with_warnings: '模拟接收（含警告）', blocked: '已阻止', uploaded: '已上传',
    realNetworkCalled: '已调用真实网络', externalApiCalled: '已调用外部 API', realUploadEnabled: '真实上传已启用',
    readyForSandboxApi: '可进行沙箱 API 测试', readyForRealUpload: '可进行真实上传', platformsChecked: '已检查平台',
    criticalIssues: '严重问题数', warnings: '警告数'
  },
  severity: { fatal: '致命风险', critical: '严重', high: '高风险', medium: '中风险', low: '低风险', warning: '警告', info: '信息提示' }
};

export function exportReportText(t, source, values) {
  if (typeof t === 'function') return t(source, values);
  return source.replace(/\{([A-Za-z][A-Za-z0-9_]*)\}/g, (match, key) => Object.hasOwn(values || {}, key) ? String(values[key]) : match);
}

export function exportReportLabel(group, value, t) {
  const labels = Object.hasOwn(exportReportLabels, group) ? exportReportLabels[group] : null;
  return typeof t === 'function' && labels && Object.hasOwn(labels, value) ? t(labels[value]) : value;
}

export function exportReportCards(cards, t) {
  return cards.map(card => ({ ...card, label: exportReportLabel('card', card.label, t) }));
}

export function exportReportBoolean(value, t) {
  if (typeof t !== 'function') return String(value === true);
  return t(value === true ? '是' : value === false ? '否' : '未知');
}
