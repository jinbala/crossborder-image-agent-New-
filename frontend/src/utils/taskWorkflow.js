export const TASK_STATUS = {
  UPLOADED: 'uploaded',
  RECOGNIZED: 'recognized',
  CONFIRMED: 'confirmed',
  RULES_SELECTED: 'rules_selected',
  PLANNED: 'planned',
  GENERATED: 'generated',
  REVIEWED: 'reviewed',
  EXPORTED: 'exported'
};

export const TASK_STEPS = [
  { status: TASK_STATUS.UPLOADED, label: '上传图片' },
  { status: TASK_STATUS.RECOGNIZED, label: 'AI 识别' },
  { status: TASK_STATUS.CONFIRMED, label: '商品确认' },
  { status: TASK_STATUS.RULES_SELECTED, label: '平台规则' },
  { status: TASK_STATUS.PLANNED, label: '图片方案' },
  { status: TASK_STATUS.GENERATED, label: '图片生成' },
  { status: TASK_STATUS.REVIEWED, label: '合规审核' },
  { status: TASK_STATUS.EXPORTED, label: '导出图片包' }
];

export const ACTION_ALLOWED_STATUSES = {
  recognize: [TASK_STATUS.UPLOADED],
  confirmProduct: [TASK_STATUS.RECOGNIZED, TASK_STATUS.CONFIRMED],
  selectRules: [TASK_STATUS.CONFIRMED, TASK_STATUS.RULES_SELECTED],
  createPlans: [TASK_STATUS.RULES_SELECTED, TASK_STATUS.PLANNED],
  generateImages: [TASK_STATUS.PLANNED, TASK_STATUS.GENERATED],
  reviewImages: [TASK_STATUS.GENERATED, TASK_STATUS.REVIEWED],
  exportImages: [TASK_STATUS.REVIEWED, TASK_STATUS.EXPORTED]
};

const statusLabels = {
  uploaded: '已上传',
  recognized: '已识别',
  confirmed: '已确认',
  rules_selected: '已选择平台规则',
  planned: '已生成图片方案',
  generated: '已生成图片',
  reviewed: '已完成合规审核',
  exported: '已导出'
};

export function statusIndex(status) {
  return TASK_STEPS.findIndex((step) => step.status === status);
}

export function canRunAction(status, action) {
  return ACTION_ALLOWED_STATUSES[action]?.includes(status) || false;
}

export function actionDisabledReason(status, action, t = (text, values = {}) => text.replace(/\{(\w+)\}/g, (_, key) => values[key] ?? `{${key}}`)) {
  if (canRunAction(status, action)) return '';
  const allowed = ACTION_ALLOWED_STATUSES[action] || [];
  const currentLabel = statusLabels[status] ? t(statusLabels[status]) : status || t('未知状态');
  const allowedLabels = allowed.map((item) => t(statusLabels[item] || item)).join(t(' 或 '));
  return t('当前状态为“{current}”，需要状态为“{allowed}”时才能操作。', { current: currentLabel, allowed: allowedLabels });
}

export function friendlyStatusError(message) {
  if (!message || !/requires task status/i.test(message)) return message;
  return `当前步骤暂时不能执行，请先完成前置流程。${message}`;
}
