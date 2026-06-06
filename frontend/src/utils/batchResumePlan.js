function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function sanitizeText(value) {
  return String(value)
    .replace(/\b[A-Z0-9_]*API[_-]?KEY\b\s*[:=]\s*[^\s"',，。；;]+/gi, '[api-key-removed]')
    .replace(/\b(provider[_-]?secret|api[_-]?key|secret)\b\s*[:=]\s*[^\s"',，。；;]+/gi, '[secret-removed]')
    .replace(/\b(?:sk|rk|ak)-[A-Za-z0-9_-]{6,}\b/g, '[secret-removed]')
    .replace(/[A-Z]:\\[^\s"',，。；;]+/gi, '[local-path-removed]')
    .replace(/\.env(?:\.[\w.-]+)?/gi, '[env-file-removed]')
    .replace(/\b[\w.-]*\.sqlite\b/gi, '[sqlite-path-removed]')
    .replace(/\bnode_modules\b/gi, '[node-modules-removed]');
}

export function sanitizeBatchResumePlan(value) {
  if (Array.isArray(value)) return value.map(sanitizeBatchResumePlan);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value)
      .filter(([key]) => !/apiKey|api_key|secret|token|password|absolutePath|sourceFolderPath|folderPath/i.test(key))
      .map(([key, item]) => [key, sanitizeBatchResumePlan(item)]));
  }
  if (typeof value === 'string') return sanitizeText(value);
  return value;
}

const groupLabels = {
  waiting: '待开始识别',
  safeMockRetry: '可安全 mock 重试',
  manualRequired: '需人工处理',
  blocked: '已阻止',
  noReview: '未审核',
  completed: '已完成'
};

function groupSection(plan, key) {
  return {
    key,
    title: groupLabels[key],
    rows: asArray(plan.resumeGroups?.[key])
  };
}

export function getBatchResumePlanDisplayModel(plan) {
  if (!plan) {
    return {
      emptyText: '暂无批量恢复计划预览，请先选择一个 batch。',
      summaryCards: [],
      groupSections: {
        safeMockRetry: groupSection({}, 'safeMockRetry'),
        manualRequired: groupSection({}, 'manualRequired'),
        waiting: groupSection({}, 'waiting'),
        blocked: groupSection({}, 'blocked'),
        noReview: groupSection({}, 'noReview'),
        completed: groupSection({}, 'completed')
      },
      orderedRows: [],
      warnings: [],
      recommendations: [],
      safetyNotice: '当前仅为批量恢复计划预览，不会自动恢复整批。请逐个 SKU 执行安全重试。'
    };
  }
  const summary = plan.summary || {};
  const groupSections = {
    safeMockRetry: groupSection(plan, 'safeMockRetry'),
    manualRequired: groupSection(plan, 'manualRequired'),
    waiting: groupSection(plan, 'waiting'),
    blocked: groupSection(plan, 'blocked'),
    noReview: groupSection(plan, 'noReview'),
    completed: groupSection(plan, 'completed')
  };
  return {
    emptyText: summary.totalSku === 0 ? '当前 batch 暂无 SKU。' : '',
    summaryCards: [
      { label: '可安全 mock 重试', value: summary.recoverableSku || 0 },
      { label: '需人工处理', value: summary.manualOnlySku || 0 },
      { label: '待开始识别 SKU', value: summary.waitingSku || 0 },
      { label: 'blocked SKU', value: summary.blockedSku || 0 },
      { label: '未审核 SKU', value: summary.noReviewSku || 0 },
      { label: '已完成 SKU', value: summary.completedSku || 0 },
      { label: '预计重试动作', value: summary.estimatedRetryActions || 0 },
      { label: '付费 API 风险', value: summary.paidApiRiskCount || 0 }
    ],
    groupSections,
    orderedRows: asArray(plan.orderedPlan),
    warnings: asArray(plan.warnings),
    recommendations: asArray(plan.recommendations),
    safetyNotice: '当前仅为批量恢复计划预览，不会自动恢复整批。请逐个 SKU 执行安全重试。涉及真实 Provider 或 Image2 的步骤当前不会自动执行。',
    nextSuggestedAction: plan.nextSuggestedAction || ''
  };
}

export function buildBatchResumePlanDownload({
  plan,
  batchId,
  timestamp = new Date().toISOString().replace(/[:.]/g, '-')
} = {}) {
  const safePlan = sanitizeBatchResumePlan(plan || {});
  const safeBatchId = String(batchId || safePlan.meta?.batchId || 'batch').replace(/[^a-zA-Z0-9_-]+/g, '-');
  return {
    fileName: `batch-resume-plan-${safeBatchId}-${timestamp}.json`,
    mimeType: 'application/json',
    json: JSON.stringify({
      meta: safePlan.meta || {},
      summary: safePlan.summary || {},
      resumeGroups: safePlan.resumeGroups || {},
      orderedPlan: safePlan.orderedPlan || [],
      warnings: safePlan.warnings || [],
      recommendations: safePlan.recommendations || [],
      nextSuggestedAction: safePlan.nextSuggestedAction || ''
    }, null, 2)
  };
}

export function downloadBatchResumePlanJson({ plan, batchId } = {}) {
  const download = buildBatchResumePlanDownload({ plan, batchId });
  const blob = new Blob([download.json], { type: download.mimeType });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = download.fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
  return download;
}
