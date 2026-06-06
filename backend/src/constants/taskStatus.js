export const TASK_STATUS = Object.freeze({
  UPLOADED: 'uploaded',
  RECOGNIZED: 'recognized',
  CONFIRMED: 'confirmed',
  RULES_SELECTED: 'rules_selected',
  PLANNED: 'planned',
  GENERATED: 'generated',
  REVIEWED: 'reviewed',
  EXPORTED: 'exported'
});

export const TASK_STATUS_LABELS = Object.freeze(Object.values(TASK_STATUS));

export const TASK_TRANSITIONS = Object.freeze({
  recognize: [TASK_STATUS.UPLOADED],
  confirmProduct: [TASK_STATUS.RECOGNIZED, TASK_STATUS.CONFIRMED],
  selectRules: [TASK_STATUS.CONFIRMED, TASK_STATUS.RULES_SELECTED],
  createPlans: [TASK_STATUS.RULES_SELECTED, TASK_STATUS.PLANNED],
  generateImages: [TASK_STATUS.PLANNED, TASK_STATUS.GENERATED],
  reviewImages: [TASK_STATUS.GENERATED, TASK_STATUS.REVIEWED],
  exportImages: [TASK_STATUS.REVIEWED, TASK_STATUS.EXPORTED]
});

export function assertTaskStatus(task, allowedStatuses, action) {
  if (allowedStatuses.includes(task.status)) {
    return;
  }

  const error = new Error(
    `${action} requires task status ${allowedStatuses.join(' or ')}, but current status is ${task.status}`
  );
  error.statusCode = 409;
  throw error;
}
