const SEVERITY_ORDER = {
  fatal: 0,
  high: 1,
  medium: 2,
  low: 3,
  info: 4,
  mockInfo: 5
};

const ACTION_LABELS = {
  removeText: '删除违规文案',
  removeClaim: '删除未确认卖点',
  confirmFieldEvidence: '核对字段证据',
  editTextLayout: '调整文字排版',
  regenerateMock: '重新生成 mock 预览',
  regenerateRealSample: '重新生成真实小样本',
  manualCheck: '人工复查',
  skipMockOnly: 'mock 流程提示',
  noActionNeeded: '无需处理'
};

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function lowerText(...values) {
  return values.map((value) => String(value || '')).join(' ').toLowerCase();
}

function severityRank(severity) {
  return SEVERITY_ORDER[severity] ?? 99;
}

function normalizeSeverity(issue = {}) {
  const text = lowerText(issue.code, issue.message, issue.type, issue.fieldKey);
  if (issue.severity === 'mockInfo' || issue.isMockOnly) return 'mockInfo';
  if (/main_image_text|chinese|price|promotion|coupon|sale|discount|unconfirmed_capacity|unconfirmed_certification|unconfirmed_warranty/.test(text)) return 'fatal';
  if (/background|non_white|subject|preserve|matting|edge|interface|dimension|conflict/.test(text)) return 'high';
  return issue.severity || 'medium';
}

function actionFor(issue = {}) {
  const text = lowerText(issue.code, issue.message, issue.category, issue.fieldKey, issue.fieldLabel);
  if (issue.isMockOnly || issue.severity === 'mockInfo' || /mock/.test(text)) return 'skipMockOnly';
  if ((issue.severity === 'info' || issue.category === 'info') && !issue.isRealComplianceRisk) return 'noActionNeeded';
  if (/main_image_text|main image.*text/.test(text)) return 'editTextLayout';
  if (/chinese|price|promotion|coupon|sale|discount|free shipping/.test(text)) return 'removeText';
  if (/background|non_white|not white/.test(text)) return 'regenerateMock';
  if (/unconfirmed|capacity|certification|warranty|speed|evidence/.test(text)) return 'confirmFieldEvidence';
  if (/conflict|interface|dimension/.test(text)) return 'manualCheck';
  if (/subject|preserve|distort|realgeneration/.test(text)) return 'manualCheck';
  if (/matting|edge/.test(text)) return 'manualCheck';
  if (issue.canAutoFixLater) return 'removeClaim';
  return issue.requiresManualConfirm ? 'manualCheck' : 'manualCheck';
}

function templateFor(actionType, issue = {}) {
  const fieldLabel = issue.fieldLabel || issue.fieldKey || '字段';
  const templates = {
    removeText: /price|promotion|coupon|sale|discount|free shipping/i.test(lowerText(issue.code, issue.message))
      ? {
          title: '删除价格或促销信息',
          description: '图片中检测到价格、折扣或促销信息，可能触发平台合规风险。',
          recommendedSteps: ['返回图片方案或文字排版区域。', '删除价格、折扣、coupon、sale、free shipping 等促销词。', '重新生成并再次审核。']
        }
      : {
          title: '删除中文文案',
          description: '图片中检测到中文文案，跨境图片默认不允许中文。',
          recommendedSteps: ['返回图片方案或文字排版区域。', '删除中文文案或替换为英文。', '重新生成并再次审核。']
        },
    editTextLayout: {
      title: 'Amazon 主图移除所有文字',
      description: 'Amazon 主图要求白底、无文字、无图标，请移除主图文字。',
      recommendedSteps: ['打开图片方案或文字排版区域。', '将主图文字全部移除，必要时移动到辅图。', '重新生成主图并再次审核。']
    },
    regenerateMock: {
      title: 'Amazon 主图改为白底',
      description: '主图背景不符合白底要求，建议重新生成或人工检查背景。',
      recommendedSteps: ['回到图片生成页面。', '确认主图使用纯白背景模板。', '重新生成 mock 预览并再次审核。']
    },
    confirmFieldEvidence: {
      title: '核对高风险字段证据',
      description: `${fieldLabel} 属于高风险字段，需要先确认图片或文字证据。`,
      recommendedSteps: ['返回商品确认页。', `核对 ${fieldLabel} 的图片证据或 OCR 文本证据。`, '确认无误后再用于图片文案。']
    },
    manualCheck: {
      title: /subject|preserve|distort/i.test(lowerText(issue.code, issue.message))
        ? '人工检查产品主体保真'
        : /matting|edge/i.test(lowerText(issue.code, issue.message))
          ? '检查抠图边缘'
          : '人工核对冲突字段',
      description: '该问题需要人工判断，当前阶段不会自动修正。',
      recommendedSteps: ['打开对应 SKU 和图片。', '人工核对问题描述、字段证据和图片细节。', '确认后再决定是否重新生成或调整文案。']
    },
    removeClaim: {
      title: '删除未确认卖点',
      description: '图片文案包含未确认或证据不足的卖点。',
      recommendedSteps: ['返回图片方案。', '删除缺少证据的卖点。', '重新生成并再次审核。']
    },
    skipMockOnly: {
      title: 'mock 流程提示，无需作为真实违规处理',
      description: '该提示仅来自 mock 预览或流程测试，不代表真实平台上传失败。',
      recommendedSteps: ['记录该提示。', '继续人工验收真实合规风险。']
    },
    noActionNeeded: {
      title: '无需处理',
      description: '该项为信息提示或审核通过状态，当前无需处理。',
      recommendedSteps: ['继续人工复核后续流程。']
    }
  };
  return templates[actionType] || templates.manualCheck;
}

function canAutoFixLater(actionType, issue = {}) {
  if (['removeText', 'editTextLayout', 'regenerateMock', 'removeClaim'].includes(actionType)) return true;
  if (actionType === 'skipMockOnly' || actionType === 'noActionNeeded') return false;
  return Boolean(issue.canAutoFixLater);
}

function requiresManualConfirm(actionType, issue = {}) {
  if (['confirmFieldEvidence', 'manualCheck'].includes(actionType)) return true;
  if (['removeText', 'editTextLayout', 'regenerateMock', 'removeClaim'].includes(actionType)) return false;
  if (actionType === 'skipMockOnly' || actionType === 'noActionNeeded') return false;
  return Boolean(issue.requiresManualConfirm);
}

export function buildFixSuggestions({ issues = [] } = {}) {
  const suggestions = asArray(issues).map((issue, index) => {
    const severity = normalizeSeverity(issue);
    const actionType = actionFor({ ...issue, severity });
    const template = templateFor(actionType, issue);
    const isMockOnly = actionType === 'skipMockOnly';
    const noAction = actionType === 'noActionNeeded';
    return {
      suggestionId: `fix-${String(index + 1).padStart(3, '0')}`,
      issueCode: issue.code || issue.type || 'UNKNOWN_ISSUE',
      severity,
      imageType: issue.imageType || '',
      fieldKey: issue.fieldKey || '',
      fieldLabel: issue.fieldLabel || '',
      actionType,
      actionLabel: ACTION_LABELS[actionType] || actionType,
      title: template.title,
      description: template.description,
      recommendedSteps: template.recommendedSteps,
      canAutoFixLater: canAutoFixLater(actionType, issue),
      requiresManualConfirm: requiresManualConfirm(actionType, issue),
      isMockOnly,
      isRealComplianceRisk: Boolean(!isMockOnly && !noAction && issue.isRealComplianceRisk !== false),
      priority: severityRank(severity) + (requiresManualConfirm(actionType, issue) ? 0.1 : 0.2),
      count: issue.count || 1,
      affectedImageTypes: issue.imageType ? [issue.imageType] : []
    };
  });
  return suggestions.sort((a, b) => a.priority - b.priority);
}

export function buildFixSummary(fixSuggestions = []) {
  const summary = {
    total: fixSuggestions.length,
    autoFixCandidateCount: 0,
    manualConfirmRequiredCount: 0,
    mockOnlyCount: 0,
    noActionNeededCount: 0,
    byActionType: {},
    bySeverity: {}
  };
  for (const suggestion of fixSuggestions) {
    if (suggestion.canAutoFixLater) summary.autoFixCandidateCount += 1;
    if (suggestion.requiresManualConfirm) summary.manualConfirmRequiredCount += 1;
    if (suggestion.isMockOnly) summary.mockOnlyCount += 1;
    if (suggestion.actionType === 'noActionNeeded') summary.noActionNeededCount += 1;
    summary.byActionType[suggestion.actionType] = (summary.byActionType[suggestion.actionType] || 0) + 1;
    summary.bySeverity[suggestion.severity] = (summary.bySeverity[suggestion.severity] || 0) + 1;
  }
  return summary;
}
