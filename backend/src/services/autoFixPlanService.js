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

function productName(task = {}) {
  return task.productInfoConfirmed?.name || task.productInfo?.name || task.productInfoRaw?.name || '';
}

function skuFor(task = {}) {
  return task.productInfoConfirmed?.sku || task.productInfo?.sku || task.sku || '';
}

function riskLevelFor(suggestion = {}) {
  if (['fatal', 'high'].includes(suggestion.severity)) return 'high';
  if (suggestion.severity === 'medium') return 'medium';
  return 'low';
}

function targetFor(suggestion = {}) {
  return {
    imageType: suggestion.imageType || '',
    fieldKey: suggestion.fieldKey || null,
    textBlockId: suggestion.textBlockId || null,
    scope: suggestion.actionType === 'manualCheck' || suggestion.actionType === 'confirmFieldEvidence'
      ? 'manualOnly'
      : suggestion.targetScope || 'imagePlan'
  };
}

function previewChangeFor(suggestion = {}) {
  const changeTypeByAction = {
    removeText: 'remove',
    editTextLayout: 'move',
    removeClaim: 'remove',
    regenerateMock: 'replace'
  };
  return {
    before: suggestion.previewBefore || suggestion.description || '',
    after: suggestion.previewAfter || '',
    changeType: changeTypeByAction[suggestion.actionType] || 'flagOnly'
  };
}

function plannedActionFrom(suggestion = {}, index = 0) {
  return {
    actionId: `plan-${String(index + 1).padStart(3, '0')}`,
    sourceSuggestionId: suggestion.suggestionId || '',
    issueCode: suggestion.issueCode || 'UNKNOWN_ISSUE',
    actionType: suggestion.actionType,
    target: targetFor(suggestion),
    title: suggestion.title || suggestion.actionLabel || suggestion.actionType,
    description: suggestion.actionType === 'regenerateMock'
      ? `${suggestion.description || '后续可在用户确认后重新生成 mock 图。'} 后续可在用户确认后重新生成 mock 图。`
      : suggestion.description || '',
    recommendedSteps: asArray(suggestion.recommendedSteps),
    dryRunOnly: true,
    canExecuteLater: true,
    requiresManualConfirm: Boolean(suggestion.requiresManualConfirm),
    riskLevel: riskLevelFor(suggestion),
    previewChange: previewChangeFor(suggestion)
  };
}

function blockedActionFrom(suggestion = {}, index = 0) {
  const isRealSample = suggestion.actionType === 'regenerateRealSample';
  return {
    actionId: `blocked-${String(index + 1).padStart(3, '0')}`,
    sourceSuggestionId: suggestion.suggestionId || '',
    issueCode: suggestion.issueCode || 'UNKNOWN_ISSUE',
    actionType: suggestion.actionType,
    title: suggestion.title || suggestion.actionLabel || suggestion.actionType,
    reason: isRealSample
      ? '真实生图相关修正会产生成本，不能自动执行，必须由用户单独确认。'
      : '该问题涉及高风险字段证据确认，不能自动修正。',
    requiresManualConfirm: true,
    fieldKey: suggestion.fieldKey || '',
    fieldLabel: suggestion.fieldLabel || suggestion.fieldKey || '',
    recommendedSteps: asArray(suggestion.recommendedSteps),
    riskLevel: riskLevelFor(suggestion),
    dryRunOnly: true,
    canExecuteLater: false
  };
}

function manualActionFrom(suggestion = {}, index = 0) {
  return {
    actionId: `manual-${String(index + 1).padStart(3, '0')}`,
    sourceSuggestionId: suggestion.suggestionId || '',
    issueCode: suggestion.issueCode || 'UNKNOWN_ISSUE',
    actionType: suggestion.actionType,
    title: suggestion.title || suggestion.actionLabel || suggestion.actionType,
    description: suggestion.description || '',
    fieldKey: suggestion.fieldKey || '',
    fieldLabel: suggestion.fieldLabel || suggestion.fieldKey || '',
    reason: '该问题需要人工判断，当前阶段不会自动修正。',
    recommendedSteps: asArray(suggestion.recommendedSteps),
    requiresManualConfirm: true,
    dryRunOnly: true,
    riskLevel: riskLevelFor(suggestion)
  };
}

function simpleActionFrom(prefix, suggestion = {}, index = 0) {
  return {
    actionId: `${prefix}-${String(index + 1).padStart(3, '0')}`,
    sourceSuggestionId: suggestion.suggestionId || '',
    issueCode: suggestion.issueCode || 'UNKNOWN_ISSUE',
    actionType: suggestion.actionType,
    title: suggestion.title || suggestion.actionLabel || suggestion.actionType,
    description: suggestion.description || '',
    recommendedSteps: asArray(suggestion.recommendedSteps),
    dryRunOnly: true,
    riskLevel: riskLevelFor(suggestion)
  };
}

function emptyPlan(task = {}, warning = '暂无可生成修正计划的审核报告，请先执行审核。') {
  return sanitizeValue({
    meta: {
      taskId: task.id || '',
      sku: skuFor(task),
      productName: productName(task),
      generatedAt: new Date().toISOString(),
      mode: 'dryRun',
      source: 'fixSuggestions',
      planVersion: 'v1'
    },
    summary: {
      totalFixSuggestions: 0,
      autoFixCandidateCount: 0,
      manualConfirmRequiredCount: 0,
      mockOnlyCount: 0,
      noActionNeededCount: 0,
      plannedActionCount: 0,
      blockedActionCount: 0,
      requiresUserConfirmation: true
    },
    plannedActions: [],
    blockedActions: [],
    manualActions: [],
    mockOnlyActions: [],
    noActionNeededActions: [],
    warnings: [warning],
    nextSuggestedAction: '暂无可生成修正计划的审核报告，请先执行审核。'
  });
}

export function buildAutoFixPlan({
  task = {},
  normalizedReviewReport = null,
  fixSuggestions = normalizedReviewReport?.fixSuggestions
} = {}) {
  const suggestions = asArray(fixSuggestions);
  if (!normalizedReviewReport || suggestions.length === 0) {
    return emptyPlan(task);
  }

  const plannedActions = [];
  const blockedActions = [];
  const manualActions = [];
  const mockOnlyActions = [];
  const noActionNeededActions = [];

  for (const suggestion of suggestions) {
    if (['removeText', 'editTextLayout', 'removeClaim', 'regenerateMock'].includes(suggestion.actionType)) {
      plannedActions.push(plannedActionFrom(suggestion, plannedActions.length));
    } else if (['confirmFieldEvidence', 'regenerateRealSample'].includes(suggestion.actionType)) {
      blockedActions.push(blockedActionFrom(suggestion, blockedActions.length));
    } else if (suggestion.actionType === 'manualCheck') {
      manualActions.push(manualActionFrom(suggestion, manualActions.length));
    } else if (suggestion.actionType === 'skipMockOnly') {
      mockOnlyActions.push(simpleActionFrom('mock', suggestion, mockOnlyActions.length));
    } else if (suggestion.actionType === 'noActionNeeded') {
      noActionNeededActions.push(simpleActionFrom('none', suggestion, noActionNeededActions.length));
    } else {
      manualActions.push(manualActionFrom({ ...suggestion, actionType: suggestion.actionType || 'manualCheck' }, manualActions.length));
    }
  }

  const plan = {
    meta: {
      taskId: task.id || normalizedReviewReport?.meta?.taskId || '',
      sku: skuFor(task) || normalizedReviewReport?.meta?.sku || '',
      productName: productName(task),
      generatedAt: new Date().toISOString(),
      mode: 'dryRun',
      source: 'fixSuggestions',
      planVersion: 'v1'
    },
    summary: {
      totalFixSuggestions: suggestions.length,
      autoFixCandidateCount: suggestions.filter((item) => item.canAutoFixLater).length,
      manualConfirmRequiredCount: suggestions.filter((item) => item.requiresManualConfirm).length,
      mockOnlyCount: mockOnlyActions.length,
      noActionNeededCount: noActionNeededActions.length,
      plannedActionCount: plannedActions.length,
      blockedActionCount: blockedActions.length,
      requiresUserConfirmation: true
    },
    plannedActions,
    blockedActions,
    manualActions,
    mockOnlyActions,
    noActionNeededActions,
    warnings: [
      '当前仅生成修正计划，不会自动修改图片方案、文字排版或生成结果。',
      '需要人工确认的字段不会自动修正。',
      '真实生图相关修正不会自动执行，避免产生额外成本。'
    ],
    nextSuggestedAction: '请人工确认修正计划。确认前不会修改任何图片方案或生成结果。'
  };

  return sanitizeValue(plan);
}
