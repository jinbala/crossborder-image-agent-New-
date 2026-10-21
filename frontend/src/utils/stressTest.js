export const STRESS_TEST_MODES = {
  mockOnly: {
    id: 'mockOnly',
    label: 'mockOnly：全链路 Mock 压测',
    description: '不调用真实 AI，用 Mock 识别、Mock 生成、Mock 审核验证批量链路稳定性。',
    enabled: true,
    costWarning: '不调用真实 Provider，不产生 AI 费用。'
  },
  realVisionMockGenerate: {
    id: 'realVisionMockGenerate',
    label: 'realVisionMockGenerate：真实识别 + Mock 生成',
    description: '调用当前配置的真实商品识别 Provider，图片生成和审核仍使用 mock。',
    enabled: true,
    costWarning: '此模式会调用真实商品识别 Provider，可能产生 API 成本。图片生成和审核仍使用 mock，不会调用真实生图。'
  },
  optionalRealReview: {
    id: 'optionalRealReview',
    label: 'optionalRealReview：真实识别 + Mock 生成 + 真实审核',
    description: '后续小步接入；默认关闭，本阶段不会产生真实审核费用。',
    enabled: false,
    costWarning: '本阶段不会调用真实 Provider，也不会产生真实审核费用。'
  }
};

export const STRESS_TEST_MODE_OPTIONS = Object.values(STRESS_TEST_MODES);

function normalizeInt(value, fallback, max = 100) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(Math.floor(parsed), max);
}

export function normalizeStressTestPayload(input = {}) {
  const mode = STRESS_TEST_MODES[input.mode] ? input.mode : 'mockOnly';
  const payload = {
    mode,
    skuCount: normalizeInt(input.skuCount, 3),
    concurrency: normalizeInt(input.concurrency, 1, 2),
    exportZip: Boolean(input.exportZip)
  };
  if (input.batchId) payload.batchId = String(input.batchId);
  if (input.confirmPaidApi === true) payload.confirmPaidApi = true;
  return payload;
}

export function formatStressDuration(ms = 0, t = null) {
  const value = Number(ms) || 0;
  if (value < 1000) return `${Math.round(value)} ms`;
  return `${(value / 1000).toFixed(2)} ${t ? t('秒') : '秒'}`;
}

export function stressStatusLabel(status) {
  return {
    pending: '等待中',
    running: '运行中',
    completed: '已完成',
    failed: '失败',
    partial: '部分完成'
  }[status] || status || '未知';
}

export function stressSkuStatusLabel(status) {
  return {
    completed: '完成',
    failed: '失败',
    skipped: '跳过',
    running: '运行中',
    pending: '等待中'
  }[status] || status || '未知';
}

export function stressReportStats(report) {
  const providerStats = report?.providerStats || [];
  const failedSkuList = report?.errors?.failedSkuList || [];
  const estimatedCost = providerStats.reduce((sum, item) => sum + Number(item.estimatedCost || 0), 0);
  const visionStats = providerStats.find((item) => item.providerType === 'vision' && !String(item.providerName || '').startsWith('Mock '));
  const costNotice = report?.costNotice || '';
  return {
    providerCallCount: providerStats.reduce((sum, item) => sum + Number(item.callCount || 0), 0),
    visionCallCount: Number(visionStats?.callCount || 0),
    visionSuccessCount: Number(visionStats?.successCount || 0),
    visionFailureCount: Number(visionStats?.failureCount || 0),
    visionAverageDurationMs: Number(visionStats?.averageDurationMs || 0),
    visionAverageDurationText: formatStressDuration(visionStats?.averageDurationMs || 0),
    estimatedCost,
    estimatedCostText: `USD ${estimatedCost.toFixed(4)}`,
    costPlaceholder: estimatedCost === 0 && /估算占位|尚未接入真实价格表/.test(`${costNotice} ${visionStats?.costNote || ''}`),
    costNotice,
    failedSkuText: failedSkuList.length ? failedSkuList.join(', ') : '无',
    hasFailures: failedSkuList.length > 0
  };
}

export function createStressReportDownload(report) {
  const stressTestId = report?.summary?.stressTestId || 'stress-test';
  if (report?.summary?.mode === 'realVisionMockGenerate') {
    const timestamp = new Date(report.generatedAt || Date.now()).toISOString().replace(/[:.]/g, '-');
    return {
      fileName: `stress-test-report-${timestamp}.json`,
      mimeType: 'application/json;charset=utf-8',
      content: JSON.stringify(report || {}, null, 2)
    };
  }
  return {
    fileName: `${stressTestId}-report.json`,
    mimeType: 'application/json;charset=utf-8',
    content: JSON.stringify(report || {}, null, 2)
  };
}
