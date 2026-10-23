const EMPTY_TEXT = '暂无可生成修正计划的审核报告，请先执行审核。';

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

export function sanitizeAutoFixPlan(value) {
  if (Array.isArray(value)) return value.map(sanitizeAutoFixPlan);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value)
      .filter(([key]) => !/apiKey|api_key|secret|token|password|absolutePath/i.test(key))
      .map(([key, item]) => [key, sanitizeAutoFixPlan(item)]));
  }
  if (typeof value === 'string') return sanitizeText(value);
  return value;
}

function asActionRows(actions, t) {
  return asArray(actions).map((item) => ({
    ...item,
    actionTypeLabel: actionTypeLabel(item.actionType, t),
    selectable: false
  }));
}

function actionTypeLabel(actionType, t) {
  const labels = {
    removeText: '删除违规文案',
    editTextLayout: '调整文字排版',
    removeClaim: '删除未确认卖点',
    regenerateMock: '重新生成 mock 预览',
    confirmFieldEvidence: '人工确认证据',
    manualCheck: '人工复查',
    regenerateRealSample: '真实生图需单独确认',
    skipMockOnly: 'mock 流程提示',
    noActionNeeded: '无需处理'
  };
  return Object.hasOwn(labels, actionType) ? (t || (value => value))(labels[actionType]) : actionType || '-';
}

function isSelectablePlannedAction(action = {}) {
  if (action.actionType === 'removeText' || action.actionType === 'removeClaim') return true;
  return action.actionType === 'editTextLayout' && (action.target?.imageType || action.imageType) === 'main_image';
}

export function getAutoFixPlanDisplayModel(plan, t) {
  const ui = t || (value => value);
  if (!plan) {
    return {
      emptyText: ui(EMPTY_TEXT),
      summaryCards: [],
      plannedActions: [],
      manualActions: [],
      blockedActions: [],
      mockOnlyActions: [],
      noActionNeededActions: [],
      warnings: [],
      nextSuggestedAction: ui(EMPTY_TEXT)
    };
  }
  const summary = plan.summary || {};
  const plannedActions = asArray(plan.plannedActions).map((item) => ({
    ...item,
    actionTypeLabel: actionTypeLabel(item.actionType, t),
    selectable: isSelectablePlannedAction(item)
  }));
  return {
    emptyText: summary.totalFixSuggestions ? '' : ui(EMPTY_TEXT),
    summaryCards: [
      { label: '可自动修正候选', value: summary.autoFixCandidateCount || 0 },
      { label: '需人工确认', value: summary.manualConfirmRequiredCount || 0 },
      { label: 'mock 提示', value: summary.mockOnlyCount || 0 },
      { label: '无需处理', value: summary.noActionNeededCount || 0 },
      { label: '被阻止的自动操作', value: summary.blockedActionCount || 0 }
    ].map(card => ({ ...card, label: ui(card.label) })),
    plannedActions,
    manualActions: asActionRows(plan.manualActions, t),
    blockedActions: asActionRows(plan.blockedActions, t),
    mockOnlyActions: asActionRows(plan.mockOnlyActions, t),
    noActionNeededActions: asActionRows(plan.noActionNeededActions, t),
    warnings: asArray(plan.warnings),
    nextSuggestedAction: plan.nextSuggestedAction || ui(EMPTY_TEXT)
  };
}

export function getAutoFixExecutionDisplayModel(executionResult, t) {
  const ui = t || (value => value);
  if (!executionResult) {
    return {
      emptyText: ui('暂无修正执行结果。'),
      summaryCards: [],
      executedActions: [],
      skippedActions: [],
      blockedActions: [],
      failedActions: [],
      diffRows: [],
      hasPatchedImagePlans: false,
      postFixStatus: null,
      nextValidationChecklist: null,
      warnings: [],
      nextSuggestedAction: ''
    };
  }
  const summary = executionResult.summary || {};
  return {
    emptyText: '',
    persisted: executionResult.persisted === true,
    summaryCards: [
      { label: '执行数量', value: summary.executedCount || 0 },
      { label: '保存数量', value: summary.savedCount || 0 },
      { label: '跳过数量', value: summary.skippedCount || 0 },
      { label: '阻止数量', value: summary.blockedCount || 0 },
      { label: '失败数量', value: summary.failedCount || 0 }
    ].map(card => ({ ...card, label: ui(card.label) })),
    executedActions: asArray(executionResult.executedActions),
    skippedActions: asArray(executionResult.skippedActions),
    blockedActions: asArray(executionResult.blockedActions),
    failedActions: asArray(executionResult.failedActions),
    diffRows: asArray(executionResult.diff),
    hasPatchedImagePlans: asArray(executionResult.patchedImagePlans).length > 0,
    hasSavedImagePlans: asArray(executionResult.savedImagePlans).length > 0,
    postFixStatus: executionResult.postFixStatus || null,
    nextValidationChecklist: executionResult.nextValidationChecklist || null,
    beforeSnapshot: executionResult.beforeSnapshot || null,
    afterSnapshot: executionResult.afterSnapshot || null,
    warnings: asArray(executionResult.warnings),
    nextSuggestedAction: executionResult.nextSuggestedAction || ''
  };
}

export function buildAutoFixPlanDownload({ plan, taskId, timestamp = new Date().toISOString().replace(/[:.]/g, '-') } = {}) {
  const safePlan = sanitizeAutoFixPlan(plan || {});
  const safeTaskId = String(taskId || safePlan.meta?.taskId || 'task').replace(/[^a-zA-Z0-9_-]+/g, '-');
  return {
    fileName: `auto-fix-plan-${safeTaskId}-${timestamp}.json`,
    mimeType: 'application/json',
    json: JSON.stringify(safePlan, null, 2)
  };
}

export function buildAutoFixExecutionDownload({ executionResult, taskId, timestamp = new Date().toISOString().replace(/[:.]/g, '-') } = {}) {
  const safeResult = sanitizeAutoFixPlan(executionResult || {});
  const safeTaskId = String(taskId || 'task').replace(/[^a-zA-Z0-9_-]+/g, '-');
  return {
    fileName: `auto-fix-execution-${safeTaskId}-${timestamp}.json`,
    mimeType: 'application/json',
    json: JSON.stringify(safeResult, null, 2)
  };
}

export function downloadAutoFixPlanJson({ plan, taskId } = {}) {
  const download = buildAutoFixPlanDownload({ plan, taskId });
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

export function downloadAutoFixExecutionJson({ executionResult, taskId } = {}) {
  const download = buildAutoFixExecutionDownload({ executionResult, taskId });
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
