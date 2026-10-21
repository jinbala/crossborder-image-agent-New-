export const BATCH_GUIDE_STEPS = [
  {
    id: 'import',
    title: '导入 SKU',
    description: '从扫描目录或本地文件夹导入 SKU 图片。',
    nextAction: 'scan_or_import'
  },
  {
    id: 'template',
    title: '选择工作流模板',
    description: '选择平台、Provider、并发和重试策略预设。',
    nextAction: 'apply_template'
  },
  {
    id: 'recognize',
    title: '批量识别',
    description: '使用 Vision Provider 识别每个 SKU 的商品信息。',
    nextAction: 'start_recognize_queue'
  },
  {
    id: 'confirm',
    title: '人工确认商品信息',
    description: '逐个检查识别结果，确认 productInfoConfirmed。',
    nextAction: 'open_pending_confirm_sku'
  },
  {
    id: 'targets',
    title: '应用多平台目标',
    description: '为 SKU 应用 Amazon、Temu、Noon、Ozon、Rakuten 等平台目标。',
    nextAction: 'apply_targets'
  },
  {
    id: 'plan',
    title: '生成图片方案',
    description: '按平台规则和类目规则生成图片方案。',
    nextAction: 'start_plan_queue'
  },
  {
    id: 'generate',
    title: '生成图片预览',
    description: '生成 mock / 程序化排版 / lifestyle 真实图。',
    nextAction: 'start_generate_queue'
  },
  {
    id: 'review',
    title: '审核图片',
    description: '执行 mock 或真实视觉审核，检查平台和类目风险。',
    nextAction: 'start_review_queue'
  },
  {
    id: 'export',
    title: '导出图片包',
    description: '导出多 SKU、多平台 ZIP 图片包和报告。',
    nextAction: 'export_batch'
  }
];

const STEP_INDEX = Object.fromEntries(BATCH_GUIDE_STEPS.map((step, index) => [step.id, index]));
// Also imported by the backend SOP generator: default output stays Chinese,
// with no dependency on browser state or the frontend translation catalog.
const originalText = (source, values = {}) => source.replace(/\{([A-Za-z][A-Za-z0-9_]*)\}/g, (match, key) => Object.hasOwn(values, key) ? String(values[key]) : match);

function countBy(skuTasks = [], predicate) {
  return skuTasks.filter(predicate).length;
}

function statusOf(sku = {}) {
  return sku.status || sku.currentStep || '';
}

function hasStatus(skuTasks, statuses) {
  return skuTasks.some((sku) => statuses.includes(statusOf(sku)) || statuses.includes(sku.currentStep));
}

function classifyCounts(skuTasks = []) {
  return {
    total: skuTasks.length,
    failed: countBy(skuTasks, (sku) => statusOf(sku) === 'failed' || sku.queueStatus === 'failed'),
    retryable: countBy(skuTasks, (sku) => Boolean(sku.retryable)),
    requiresUserAction: countBy(skuTasks, (sku) => Boolean(sku.requiresUserAction)),
    waitingConfirm: countBy(skuTasks, (sku) => ['recognized', 'waiting_confirm'].includes(statusOf(sku)) || sku.currentStep === 'waiting_confirm'),
    confirmed: countBy(skuTasks, (sku) => statusOf(sku) === 'confirmed'),
    uploaded: countBy(skuTasks, (sku) => statusOf(sku) === 'uploaded'),
    rulesSelected: countBy(skuTasks, (sku) => statusOf(sku) === 'rules_selected'),
    planned: countBy(skuTasks, (sku) => statusOf(sku) === 'planned'),
    generated: countBy(skuTasks, (sku) => statusOf(sku) === 'generated'),
    reviewed: countBy(skuTasks, (sku) => ['reviewed', 'exported'].includes(statusOf(sku)))
  };
}

function determineCurrentStep(batchTask = {}, counts) {
  const skuTasks = batchTask.skuTasks || [];
  if (!skuTasks.length) return 'import';
  if (!batchTask.workflowTemplateSnapshot) return 'template';
  if (counts.uploaded > 0 || hasStatus(skuTasks, ['imported'])) return 'recognize';
  if (counts.waitingConfirm > 0) return 'confirm';
  if (counts.confirmed > 0) return 'targets';
  if (counts.rulesSelected > 0) return 'plan';
  if (counts.planned > 0) return 'generate';
  if (counts.generated > 0) return 'review';
  if (counts.reviewed > 0) return 'export';
  if (counts.failed > 0) return 'recognize';
  return 'import';
}

function progressForStep(stepId, batchTask, counts, t) {
  if (stepId === 'import') return counts.total ? t('已导入 {count} 个 SKU', { count: counts.total }) : t('尚未导入 SKU');
  if (stepId === 'template') return batchTask.workflowTemplateSnapshot ? t('已选择：{name}', { name: batchTask.workflowTemplateSnapshot.name }) : t('未选择工作流模板');
  if (stepId === 'recognize') return counts.uploaded ? t('{count} 个 SKU 待识别', { count: counts.uploaded }) : t('识别步骤已完成或无可处理 SKU');
  if (stepId === 'confirm') return counts.waitingConfirm ? t('{count} 个 SKU 等待人工确认', { count: counts.waitingConfirm }) : t('暂无待确认 SKU');
  if (stepId === 'targets') return counts.confirmed ? t('{count} 个 SKU 待应用平台 targets', { count: counts.confirmed }) : t('暂无待应用平台的 SKU');
  if (stepId === 'plan') return counts.rulesSelected ? t('{count} 个 SKU 待生成方案', { count: counts.rulesSelected }) : t('暂无待生成方案 SKU');
  if (stepId === 'generate') return counts.planned ? t('{count} 个 SKU 待生成图片', { count: counts.planned }) : t('暂无待生成图片 SKU');
  if (stepId === 'review') return counts.generated ? t('{count} 个 SKU 待审核', { count: counts.generated }) : t('暂无待审核 SKU');
  if (stepId === 'export') return counts.reviewed ? t('{count} 个 SKU 可导出', { count: counts.reviewed }) : t('完成审核后即可导出');
  return '';
}

function buildBlockingReasons(stepId, batchTask, counts, t) {
  const reasons = [];
  if (stepId !== 'import' && !counts.total) reasons.push(t('请先导入至少 1 个 SKU。'));
  if (!batchTask.workflowTemplateSnapshot && STEP_INDEX[stepId] > STEP_INDEX.template) reasons.push(t('建议先选择工作流模板。'));
  if (counts.requiresUserAction > 0) reasons.push(t('{count} 个 SKU 需要人工处理错误后再继续。', { count: counts.requiresUserAction }));
  return reasons;
}

function actionLabel(action) {
  return {
    scan_or_import: '扫描或导入 SKU',
    apply_template: '应用工作流模板',
    start_recognize_queue: '开始批量识别队列',
    open_pending_confirm_sku: '打开下一个待确认 SKU',
    apply_targets: '应用平台 targets',
    start_plan_queue: '开始方案队列',
    start_generate_queue: '开始生成队列',
    start_review_queue: '开始审核队列',
    export_batch: '导出批量 ZIP'
  }[action] || action;
}

function buildWarnings(counts, skuTasks = [], t) {
  const warnings = [];
  if (counts.failed > 0) {
    const byCategory = skuTasks.reduce((map, sku) => {
      const key = sku.lastErrorCategory || sku.error?.category || 'unknown';
      if (statusOf(sku) === 'failed' || sku.queueStatus === 'failed') map[key] = (map[key] || 0) + 1;
      return map;
    }, Object.create(null));
    warnings.push({
      code: 'FAILED_SKUS',
      level: 'warn',
      message: t('{count} 个 SKU 失败：{categories}', { count: counts.failed, categories: Object.entries(byCategory).map(([key, value]) => `${key} ${value}`).join(' / ') })
    });
  }
  if (counts.retryable > 0) {
    warnings.push({
      code: 'RETRYABLE_FAILURES',
      level: 'warn',
      message: t('{count} 个失败可重试，建议先重试可重试失败。', { count: counts.retryable })
    });
  }
  if (counts.requiresUserAction > 0) {
    warnings.push({
      code: 'REQUIRES_USER_ACTION',
      level: 'error',
      message: t('{count} 个 SKU 需要人工处理，例如补 API Key、确认商品信息或修复图片。', { count: counts.requiresUserAction })
    });
  }
  return warnings;
}

export function getNextPendingConfirmSku(batchTask = {}) {
  return (batchTask.skuTasks || []).find((sku) => (
    sku.taskId && (statusOf(sku) === 'recognized' || sku.currentStep === 'waiting_confirm')
  )) || null;
}

export function getBatchGuideState(batchTask = {}, t = originalText) {
  const skuTasks = Array.isArray(batchTask.skuTasks) ? batchTask.skuTasks : [];
  const counts = classifyCounts(skuTasks);
  const currentStepId = determineCurrentStep(batchTask, counts);
  const currentIndex = STEP_INDEX[currentStepId] ?? 0;
  const warnings = buildWarnings(counts, skuTasks, t);
  const steps = BATCH_GUIDE_STEPS.map((step, index) => {
    const blockingReasons = buildBlockingReasons(step.id, batchTask, counts, t);
    const isCurrent = step.id === currentStepId;
    let status = 'pending';
    if (index < currentIndex) status = 'done';
    if (index === currentIndex) status = blockingReasons.length ? 'blocked' : 'current';
    if (index === currentIndex + 1 && !blockingReasons.length) status = 'available';
    const secondaryActions = [];
    if (isCurrent && counts.retryable > 0) {
      secondaryActions.push({ id: 'retry_failed', label: t('重试可重试失败'), action: 'retry_failed' });
    }
    if (isCurrent && counts.requiresUserAction > 0) {
      secondaryActions.push({ id: 'show_user_actions', label: t('查看人工处理项'), action: 'show_user_actions' });
    }
    return {
      ...step,
      title: t(step.title),
      description: t(step.description),
      status,
      progressText: progressForStep(step.id, batchTask, counts, t),
      blockingReasons,
      primaryAction: { id: step.nextAction, label: t(actionLabel(step.nextAction)), action: step.nextAction },
      secondaryActions
    };
  });
  const currentStep = steps.find((step) => step.id === currentStepId);
  return {
    currentStepId,
    counts,
    steps,
    recommendedNextAction: currentStep?.primaryAction || null,
    warnings
  };
}
