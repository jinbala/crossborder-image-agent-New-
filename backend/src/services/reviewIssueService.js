const SEVERITY_ORDER = {
  fatal: 0,
  high: 1,
  medium: 2,
  low: 3,
  info: 4,
  mockInfo: 5
};

const FIELD_LABELS = {
  capacity: '容量',
  dimensions: '尺寸',
  interfaceType: '接口类型',
  certifications: '认证',
  warranty: '保修',
  material: '材质',
  model: '型号',
  brand: '品牌',
  packageIncluded: '包装清单',
  compatibleDevices: '兼容设备',
  speed: '速度'
};

const SUGGESTIONS = {
  chinese: '请删除图片中的中文，跨境图片默认只允许英文或目标站点允许语言。',
  promotion: '请删除价格、折扣、coupon、sale、free shipping 等促销信息，避免平台规则风险。',
  mainImageText: 'Amazon 主图应保持白底无文字，请将文字移至辅图。',
  capacity: '容量属于高风险字段，请先确认有图片或文字证据，再用于图片文案。',
  certifications: '认证信息必须有明确证据，不建议在图片中使用未确认认证。',
  warranty: '保修信息必须有明确证据，不建议在图片中使用未确认保修。',
  interfaceType: '接口字段存在冲突，请人工核对正确接口类型。',
  subjectPreserve: '真实生成可能改变产品外观，请人工检查接口、孔位、纹理和主体轮廓。',
  mock: '当前图片为 mock 预览图，仅用于流程测试，不代表真实平台上传结果。',
  generic: '请人工复核该问题，并根据平台规则修正后再进入导出。'
};

function asArray(value) {
  if (Array.isArray(value)) return value;
  if (value === null || value === undefined || value === '') return [];
  return [value];
}

function normalizeCode(issue = {}) {
  return String(issue.code || issue.type || issue.ruleId || 'UNKNOWN_ISSUE')
    .trim()
    .replace(/[^a-zA-Z0-9_]+/g, '_')
    .replace(/_{2,}/g, '_')
    .toUpperCase();
}

function lowerText(...values) {
  return values.map((value) => String(value || '')).join(' ').toLowerCase();
}

function categoryFor(issue = {}, code = '') {
  const raw = String(issue.category || '').toLowerCase();
  const text = lowerText(code, issue.type, issue.message, issue.fieldKey, issue.field);
  if (/mock/.test(text) || raw === 'source') return 'mock';
  if (/platform|main_image|background/.test(text) || raw === 'platform') return 'platform';
  if (/chinese|price|promotion|text|coupon|sale/.test(text) || raw === 'text') return 'text';
  if (/capacity|certification|warranty|evidence|field|interface|conflict|inferred/.test(text) || ['evidence', 'category'].includes(raw)) return 'field';
  if (/subject|distort|preserve|real_generation/.test(text)) return 'realGeneration';
  if (/matting|edge/.test(text)) return 'matting';
  if (/provider|fallback/.test(text)) return 'provider';
  if (raw) return raw;
  return 'unknown';
}

function severityFor(issue = {}, category = 'unknown') {
  const text = lowerText(issue.code, issue.type, issue.message, issue.fieldKey, issue.field);
  if (/mock_preview|mock only|mock/.test(text) && !/chinese|price|promotion|capacity|certification|warranty|main_image_text/.test(text)) return 'mockInfo';
  if (/main_image_text|main image.*text|chinese|price|promotion|coupon|sale|free shipping|conflict|conflicted|unconfirmed_capacity|unconfirmed_certification|unconfirmed_warranty/.test(text)) return 'fatal';
  if (/main_image.*background|non_white|not white|subject_preserve|distort|matting|edge|provider.*fallback|fallback_mock|interface|dimensions|package|compatible/.test(text)) return 'high';
  const level = String(issue.severity || issue.level || '').toLowerCase();
  if (['fatal', 'high', 'medium', 'low', 'info', 'mockinfo'].includes(level)) return level === 'mockinfo' ? 'mockInfo' : level;
  if (category === 'mock') return 'mockInfo';
  return 'medium';
}

function suggestionFor(issue = {}, code = '', category = '') {
  const text = lowerText(code, issue.type, issue.message, issue.fieldKey, issue.field);
  if (/chinese/.test(text)) return SUGGESTIONS.chinese;
  if (/price|promotion|coupon|sale|free shipping|discount/.test(text)) return SUGGESTIONS.promotion;
  if (/main_image_text|main image.*text/.test(text)) return SUGGESTIONS.mainImageText;
  if (/capacity/.test(text)) return SUGGESTIONS.capacity;
  if (/certification|certifications|certified/.test(text)) return SUGGESTIONS.certifications;
  if (/warranty|guarantee/.test(text)) return SUGGESTIONS.warranty;
  if (/interface|conflict/.test(text)) return SUGGESTIONS.interfaceType;
  if (/subject|distort|preserve|real_generation/.test(text)) return SUGGESTIONS.subjectPreserve;
  if (category === 'mock') return SUGGESTIONS.mock;
  return issue.fixSuggestion || issue.suggestion || SUGGESTIONS.generic;
}

function fieldKeyFor(issue = {}) {
  const text = lowerText(issue.fieldKey, issue.field, issue.type, issue.code, issue.message);
  return Object.keys(FIELD_LABELS).find((key) => text.includes(key.toLowerCase())) || issue.fieldKey || issue.field || '';
}

function issueTextFromCode(code) {
  return String(code || 'UNKNOWN_ISSUE').replaceAll('_', ' ');
}

export function normalizeReviewIssue(issue = {}, context = {}) {
  const source = issue.source || context.source || 'reviewProvider';
  const code = normalizeCode(issue);
  const fieldKey = fieldKeyFor(issue);
  const category = categoryFor(issue, code);
  const severity = severityFor(issue, category);
  const isMockOnly = severity === 'mockInfo';
  return {
    code,
    severity,
    category,
    imageType: issue.imageType || issue.typeImage || context.imageType || '',
    fieldKey,
    fieldLabel: FIELD_LABELS[fieldKey] || issue.fieldLabel || '',
    message: String(issue.message || issueTextFromCode(code)),
    suggestion: suggestionFor(issue, code, category),
    source,
    isRealComplianceRisk: !isMockOnly,
    isMockOnly,
    canAutoFixLater: Boolean(!isMockOnly && ['text', 'field', 'platform'].includes(category)),
    requiresManualConfirm: Boolean(!isMockOnly && ['fatal', 'high'].includes(severity)),
    evidence: asArray(issue.evidence),
    rawLevel: issue.level || issue.severity || ''
  };
}

export function normalizeReviewIssues(issues = [], context = {}) {
  return asArray(issues)
    .map((issue) => normalizeReviewIssue(issue, context))
    .sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
}

function groupKeyFor(issue = {}) {
  if (issue.isMockOnly) return `mock:${issue.code}`;
  if (issue.fieldKey) return `field:${issue.fieldKey}:${issue.code}`;
  return `${issue.code}:${issue.imageType || 'all'}`;
}

export function groupReviewIssues(issues = []) {
  const groups = new Map();
  for (const issue of normalizeReviewIssues(issues)) {
    const key = groupKeyFor(issue);
    const existing = groups.get(key) || {
      groupKey: key,
      severity: issue.severity,
      title: issue.fieldLabel ? `${issue.fieldLabel}字段问题` : issue.message,
      count: 0,
      imageTypes: [],
      messages: [],
      suggestion: issue.suggestion,
      items: []
    };
    existing.count += 1;
    if (issue.imageType && !existing.imageTypes.includes(issue.imageType)) existing.imageTypes.push(issue.imageType);
    if (issue.message && !existing.messages.includes(issue.message)) existing.messages.push(issue.message);
    existing.items.push(issue);
    if (SEVERITY_ORDER[issue.severity] < SEVERITY_ORDER[existing.severity]) existing.severity = issue.severity;
    groups.set(key, existing);
  }
  return [...groups.values()].sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
}

export function severityRank(severity) {
  return SEVERITY_ORDER[severity] ?? 99;
}
