const ALLOWED_ACTION_TYPES = new Set(['removeText', 'removeClaim', 'editTextLayout']);
const PROMOTION_PATTERN = /[\u4e00-\u9fff]|\$|¥|€|£|\b(price|discount|coupon|sale|free shipping|promo|promotion|off)\b|[0-9]+%/i;
const CLAIM_PHRASE_PATTERN = /\b(best|no\.?\s*1|guaranteed|ultimate|perfect|top rated|world'?s best)\b/gi;

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

function sanitizeValue(value) {
  if (Array.isArray(value)) return value.map(sanitizeValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value)
      .filter(([key]) => !/apiKey|api_key|secret|token|password|absolutePath|sourceFolderPath/i.test(key))
      .map(([key, item]) => [key, sanitizeValue(item)]));
  }
  if (typeof value === 'string') return sanitizeText(value);
  return value;
}

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function summarizePlans(imagePlans = []) {
  const plans = asArray(imagePlans);
  const textBlockCount = plans.reduce((sum, plan) => sum + asArray(plan.textBlocks).length, 0);
  const textElementCount = plans.reduce((sum, plan) => sum + asArray(plan.textLayout?.textElements).length, 0);
  return {
    planCount: plans.length,
    textBlockCount,
    textElementCount,
    imagePlanSummary: `${plans.length} imagePlans / ${textBlockCount} textBlocks`,
    textLayoutSummary: `${textElementCount} textLayout textElements`
  };
}

function allPlanActions(autoFixPlan = {}) {
  return [
    ...asArray(autoFixPlan.plannedActions),
    ...asArray(autoFixPlan.blockedActions),
    ...asArray(autoFixPlan.manualActions),
    ...asArray(autoFixPlan.mockOnlyActions),
    ...asArray(autoFixPlan.noActionNeededActions)
  ];
}

function actionById(autoFixPlan = {}) {
  return new Map(allPlanActions(autoFixPlan).map((action) => [action.actionId, action]));
}

function isBlockedBucket(action = {}, autoFixPlan = {}) {
  const id = action.actionId;
  return asArray(autoFixPlan.blockedActions).some((item) => item.actionId === id) ||
    asArray(autoFixPlan.manualActions).some((item) => item.actionId === id);
}

function isSkippedBucket(action = {}, autoFixPlan = {}) {
  const id = action.actionId;
  return asArray(autoFixPlan.mockOnlyActions).some((item) => item.actionId === id) ||
    asArray(autoFixPlan.noActionNeededActions).some((item) => item.actionId === id);
}

function normalizeSpaces(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

function planImageType(plan = {}) {
  return plan.type || plan.imageType || plan.templateType || '';
}

function planMatchesAction(plan = {}, action = {}) {
  const imageType = action.target?.imageType || action.imageType || '';
  return !imageType || planImageType(plan) === imageType;
}

function textOf(item = {}) {
  return String(item.text || item.label || '');
}

function itemMatchesRemoveText(item = {}, action = {}) {
  const text = textOf(item);
  if (action.target?.textBlockId && item.id === action.target.textBlockId) return true;
  return PROMOTION_PATTERN.test(text);
}

function removePhrases(text) {
  return normalizeSpaces(String(text || '').replace(CLAIM_PHRASE_PATTERN, ''));
}

function addDiff(diff, {
  targetType,
  imageType,
  changeType,
  before,
  after,
  reason,
  sourceActionId
}) {
  diff.push({
    targetType,
    imageType,
    changeType,
    before,
    after,
    reason,
    sourceActionId
  });
}

function filterPlanTextBlocks(plan, action, matcher, diff, reason, changeType = 'removeTextBlock') {
  const imageType = planImageType(plan);
  let changed = false;
  if (Array.isArray(plan.textBlocks)) {
    const kept = [];
    for (const block of plan.textBlocks) {
      if (matcher(block, action)) {
        changed = true;
        addDiff(diff, {
          targetType: 'imagePlan',
          imageType,
          changeType,
          before: textOf(block),
          after: '',
          reason,
          sourceActionId: action.actionId
        });
      } else {
        kept.push(block);
      }
    }
    plan.textBlocks = kept;
  }

  if (Array.isArray(plan.textLayout?.textElements)) {
    const kept = [];
    for (const element of plan.textLayout.textElements) {
      if (matcher(element, action)) {
        changed = true;
        addDiff(diff, {
          targetType: 'textLayout',
          imageType,
          changeType,
          before: textOf(element),
          after: '',
          reason,
          sourceActionId: action.actionId
        });
      } else {
        kept.push(element);
      }
    }
    plan.textLayout = { ...plan.textLayout, textElements: kept };
  }

  if (Array.isArray(plan.generationRequest?.textBlocks)) {
    const kept = [];
    for (const block of plan.generationRequest.textBlocks) {
      if (matcher(block, action)) {
        changed = true;
        addDiff(diff, {
          targetType: 'imagePlan',
          imageType,
          changeType,
          before: textOf(block),
          after: '',
          reason,
          sourceActionId: action.actionId
        });
      } else {
        kept.push(block);
      }
    }
    plan.generationRequest = { ...plan.generationRequest, textBlocks: kept };
  }
  return changed;
}

function executeRemoveText(patchedImagePlans, action) {
  const diff = [];
  for (const plan of patchedImagePlans.filter((item) => planMatchesAction(item, action))) {
    filterPlanTextBlocks(plan, action, itemMatchesRemoveText, diff, action.title || '删除违规文案');
  }
  return diff;
}

function executeRemoveClaim(patchedImagePlans, action) {
  const diff = [];
  for (const plan of patchedImagePlans.filter((item) => planMatchesAction(item, action))) {
    const imageType = planImageType(plan);
    const updateCollection = (items, targetType) => asArray(items).map((item) => {
      if (action.target?.textBlockId && item.id !== action.target.textBlockId) return item;
      const before = textOf(item);
      const after = removePhrases(before);
      if (after !== before) {
        addDiff(diff, {
          targetType,
          imageType,
          changeType: 'removePhrase',
          before,
          after,
          reason: action.title || '删除无证据 claim',
          sourceActionId: action.actionId
        });
        return { ...item, text: after };
      }
      return item;
    }).filter((item) => textOf(item));

    if (Array.isArray(plan.textBlocks)) plan.textBlocks = updateCollection(plan.textBlocks, 'imagePlan');
    if (Array.isArray(plan.textLayout?.textElements)) {
      plan.textLayout = { ...plan.textLayout, textElements: updateCollection(plan.textLayout.textElements, 'textLayout') };
    }
  }
  return diff;
}

function canClearMainImageText(task = {}, plan = {}, action = {}) {
  const imageType = action.target?.imageType || planImageType(plan);
  const platformId = String(plan.platformId || task.platformId || task.targets?.[0]?.platformId || '').toLowerCase();
  return action.actionType === 'editTextLayout' && imageType === 'main_image' && platformId === 'amazon';
}

function executeEditTextLayout(task, patchedImagePlans, action) {
  const diff = [];
  for (const plan of patchedImagePlans.filter((item) => planMatchesAction(item, action))) {
    if (!canClearMainImageText(task, plan, action)) continue;
    const imageType = planImageType(plan);
    for (const block of asArray(plan.textBlocks)) {
      addDiff(diff, {
        targetType: 'imagePlan',
        imageType,
        changeType: 'clearMainImageText',
        before: textOf(block),
        after: '',
        reason: action.title || '清空 Amazon 主图文字',
        sourceActionId: action.actionId
      });
    }
    for (const element of asArray(plan.textLayout?.textElements)) {
      addDiff(diff, {
        targetType: 'textLayout',
        imageType,
        changeType: 'clearMainImageText',
        before: textOf(element),
        after: '',
        reason: action.title || '清空 Amazon 主图文字',
        sourceActionId: action.actionId
      });
    }
    plan.textBlocks = [];
    if (plan.textLayout) plan.textLayout = { ...plan.textLayout, textElements: [] };
  }
  return diff;
}

function blockReason(action = {}) {
  if (action.actionType === 'regenerateRealSample') return '该操作会产生真实生图成本，当前版本禁止自动执行。';
  if (action.actionType === 'regenerateMock') return '当前版本禁止自动重生成图片。';
  if (action.actionType === 'editTextLayout') return '当前版本仅允许 Amazon main_image 清空文字，禁止复杂排版调整。';
  if (action.actionType === 'confirmFieldEvidence') return '该操作涉及人工确认证据，不能自动执行。';
  if (action.actionType === 'manualCheck') return '该操作需要人工复查，不能自动执行。';
  return '该 actionType 不在本阶段 allowlist 中，不能自动执行。';
}

export function buildPostFixValidation({ persisted = false, savedCount = 0 } = {}) {
  const needsManualValidation = persisted === true && savedCount > 0;
  return {
    postFixStatus: {
      persisted: persisted === true,
      needsRegenerateMock: needsManualValidation,
      needsReviewAgain: needsManualValidation,
      autoRegenerateTriggered: false,
      autoReviewTriggered: false
    },
    nextValidationChecklist: {
      statusText: needsManualValidation
        ? '文字修正已保存到图片方案，但已生成图片和审核结果不会自动更新。请手动重新生成 mock 图片并再次执行审核。'
        : '当前只是文字修正预览或没有保存任何修正，不会触发重新生成或重新审核。',
      shouldRegenerateMock: needsManualValidation,
      shouldRunReviewAgain: needsManualValidation,
      shouldCompareIssueCounts: needsManualValidation,
      manualSteps: needsManualValidation
        ? ['重新生成 mock 图片', '再次执行审核', '对比修正前后的 fatal/high 问题数量', '导出新的审核报告用于人工验收']
        : ['确认需要保存的低风险文字修正', '保存后再手动重新生成 mock 图片并再次审核'],
      expectedImprovements: needsManualValidation
        ? ['中文文案相关问题应减少', '价格/促销词相关问题应减少', 'Amazon 主图文字问题应减少']
        : []
    }
  };
}

export function refreshPostFixValidation(result = {}) {
  const validation = buildPostFixValidation({
    persisted: result.persisted === true,
    savedCount: result.summary?.savedCount || 0
  });
  result.postFixStatus = validation.postFixStatus;
  result.nextValidationChecklist = validation.nextValidationChecklist;
  return result;
}

function summarize(result) {
  result.summary.executedCount = result.executedActions.length;
  result.summary.skippedCount = result.skippedActions.length;
  result.summary.blockedCount = result.blockedActions.length;
  result.summary.failedCount = result.failedActions.length;
  result.status = result.failedActions.length > 0 ? 'partial' : 'completed';
  if (result.executedActions.length === 0 && result.blockedActions.length > 0) result.status = 'failed';
}

export function executeApprovedAutoFixPlan({
  task = {},
  autoFixPlan = {},
  approvedActionIds = [],
  options = {}
} = {}) {
  if (options.confirmExecute !== true) {
    const error = new Error('confirmExecute=true is required before executing text fixes.');
    error.statusCode = 400;
    throw error;
  }
  if (!Array.isArray(approvedActionIds) || approvedActionIds.length === 0) {
    const error = new Error('approvedActionIds must not be empty.');
    error.statusCode = 400;
    throw error;
  }
  if (options.persist === true && options.confirmSave !== true) {
    const error = new Error('confirmSave=true is required before saving text fixes.');
    error.statusCode = 400;
    throw error;
  }

  const patchedImagePlans = clone(asArray(task.imagePlans));
  const beforeSnapshot = summarizePlans(task.imagePlans);
  const actions = actionById(autoFixPlan);
  const result = {
    status: 'completed',
    persisted: false,
    savedAt: null,
    executedAt: new Date().toISOString(),
    summary: {
      approvedCount: approvedActionIds.length,
      executedCount: 0,
      savedCount: 0,
      skippedCount: 0,
      blockedCount: 0,
      failedCount: 0
    },
    executedActions: [],
    skippedActions: [],
    blockedActions: [],
    failedActions: [],
    diff: [],
    beforeSnapshot,
    afterSnapshot: beforeSnapshot,
    patchedImagePlans,
    savedImagePlans: [],
    warnings: [
      '当前为局部修正结果预览，尚未写入任务数据。',
      '本次不会重新生成图片、不会重新审核、不会调用真实 Provider。'
    ],
    nextSuggestedAction: '当前为局部修正结果预览，尚未写入任务数据。文字修正已生成，请重新生成 mock 图片并再次审核。'
  };

  for (const actionId of approvedActionIds) {
    const action = actions.get(actionId);
    if (!action) {
      result.skippedActions.push({ actionId, reason: '未找到该修正动作，已跳过。' });
      continue;
    }
    if (isSkippedBucket(action, autoFixPlan)) {
      result.skippedActions.push({ actionId, actionType: action.actionType, title: action.title, reason: '该动作无需执行。' });
      continue;
    }
    if (isBlockedBucket(action, autoFixPlan) || !ALLOWED_ACTION_TYPES.has(action.actionType)) {
      result.blockedActions.push({ actionId, actionType: action.actionType, title: action.title, reason: blockReason(action) });
      continue;
    }

    let diff = [];
    if (action.actionType === 'removeText') diff = executeRemoveText(patchedImagePlans, action);
    if (action.actionType === 'removeClaim') diff = executeRemoveClaim(patchedImagePlans, action);
    if (action.actionType === 'editTextLayout') {
      const targetPlans = patchedImagePlans.filter((item) => planMatchesAction(item, action));
      if (!targetPlans.some((plan) => canClearMainImageText(task, plan, action))) {
        result.blockedActions.push({ actionId, actionType: action.actionType, title: action.title, reason: blockReason(action) });
        continue;
      }
      diff = executeEditTextLayout(task, patchedImagePlans, action);
    }

    if (!diff.length) {
      result.skippedActions.push({ actionId, actionType: action.actionType, title: action.title, reason: '未匹配到可安全修改的文字块，已跳过。' });
      continue;
    }
    result.diff.push(...diff);
    result.executedActions.push({ actionId, actionType: action.actionType, title: action.title, diffCount: diff.length });
  }

  summarize(result);
  result.afterSnapshot = summarizePlans(patchedImagePlans);
  refreshPostFixValidation(result);
  return sanitizeValue(result);
}
