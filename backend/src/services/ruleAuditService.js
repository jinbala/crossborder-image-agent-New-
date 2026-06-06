import { getEffectiveRules } from './platformCategoryRuleService.js';

const CHINESE_PATTERN = /[\u3400-\u9fff]/;
const PRICE_PATTERN = /(?:[$€£¥]\s?\d|\b\d+(?:\.\d{1,2})?\s?(?:usd|eur|gbp|rmb|cny)\b)/i;

function asArray(value) {
  if (Array.isArray(value)) return value.filter((item) => item !== null && item !== undefined && String(item).trim() !== '');
  if (value === null || value === undefined || value === '') return [];
  return [value];
}

function blockFields(block = {}) {
  return [
    ...asArray(block.sourceFields),
    block.sourceField,
    block.field
  ].filter(Boolean);
}

function normalizeText(value) {
  return String(value || '').trim();
}

function textBlocksForPlan(imagePlan = {}) {
  return [
    ...asArray(imagePlan.textBlocks),
    ...asArray(imagePlan.generationRequest?.textBlocks),
    ...asArray(imagePlan.mockPreview?.usedTextBlocks)
  ];
}

function riskItems(recognitionQuality = {}, key) {
  return asArray(recognitionQuality[key]).map((item) => (
    typeof item === 'string' ? { field: item } : item
  )).filter((item) => item?.field);
}

function recognitionStatusMap(recognitionQuality = {}) {
  const map = new Map();
  for (const field of riskItems(recognitionQuality, 'missingEvidenceFields')) {
    map.set(field.field, 'missingEvidence');
  }
  for (const field of riskItems(recognitionQuality, 'blockedHighRiskFields')) {
    map.set(field.field, 'blockedHighRisk');
  }
  for (const field of riskItems(recognitionQuality, 'blockedHighRisk')) {
    map.set(field.field, 'blockedHighRisk');
  }
  for (const field of riskItems(recognitionQuality, 'conflictFields')) {
    map.set(field.field, 'conflicted');
  }
  for (const field of riskItems(recognitionQuality, 'inferredOnlyFields')) {
    map.set(field.field, 'inferredOnly');
  }
  for (const field of asArray(recognitionQuality.fields)) {
    if (field?.field && field.status && !map.has(field.field)) map.set(field.field, field.status);
  }
  return map;
}

function issue({ code, severity = 'warning', message, fieldKey = null, imageType, ruleSource = 'combined', suggestion }) {
  return {
    code,
    severity,
    message,
    fieldKey,
    imageType,
    ruleSource,
    suggestion
  };
}

function wordPattern(word) {
  const escaped = String(word).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`\\b${escaped}\\b`, 'i');
}

function includesWord(text, word) {
  if (String(word).includes(' ')) return text.toLowerCase().includes(String(word).toLowerCase());
  return wordPattern(word).test(text);
}

function backgroundValue(imagePlan = {}) {
  return imagePlan.backgroundStyle ||
    imagePlan.background ||
    imagePlan.templateSeed?.backgroundStyle ||
    imagePlan.mockPreview?.template?.backgroundStyle ||
    '';
}

function iconHints(imagePlan = {}) {
  return [
    ...asArray(imagePlan.iconHints),
    ...asArray(imagePlan.templateSeed?.iconHints),
    ...asArray(imagePlan.mockPreview?.template?.iconHints)
  ];
}

function reasonMessage(status) {
  if (status === 'conflicted') return '字段存在冲突证据，不能自动进入图片文案。';
  if (status === 'inferredOnly') return '字段来自 AI 推测，不能自动进入图片文案。';
  if (status === 'blockedHighRisk') return '高风险字段缺少必要证据，不能进入图片文案。';
  return '字段缺少可靠证据，不能进入图片文案。';
}

export function auditImagePlanAgainstRules({
  imagePlan = {},
  productInfo = {},
  recognitionQuality = {},
  inferredCandidates = [],
  platformId = 'amazon',
  categoryId = 'generic_ecommerce'
} = {}) {
  const effectiveRules = getEffectiveRules(platformId, categoryId || productInfo.categoryId || productInfo.category);
  const imageType = imagePlan.imageType || imagePlan.type || 'unknown';
  const issues = [];
  const warnings = [];
  const blockedFields = [];
  const cautionFields = [];
  const textBlocks = textBlocksForPlan(imagePlan);
  const statusByField = recognitionStatusMap(recognitionQuality);
  const inferredCandidateFields = new Set(asArray(inferredCandidates).map((item) => item.field).filter(Boolean));

  if (imageType === 'main_image') {
    if (!effectiveRules.effectiveMainImageRules.textAllowed && textBlocks.some((block) => normalizeText(block.text))) {
      issues.push(issue({
        code: 'MAIN_IMAGE_TEXT_NOT_ALLOWED',
        severity: 'error',
        message: 'Amazon 主图不允许出现文字、卖点或说明文案。',
        imageType,
        ruleSource: 'platform',
        suggestion: '请移除主图文字，保留白底产品主体。'
      }));
    }
    if (effectiveRules.effectiveMainImageRules.backgroundStrict && backgroundValue(imagePlan) !== 'pure_white') {
      issues.push(issue({
        code: 'MAIN_IMAGE_BACKGROUND_NOT_WHITE',
        severity: 'error',
        message: 'Amazon 主图必须使用 pure_white 白底。',
        imageType,
        ruleSource: 'platform',
        suggestion: '请将主图背景改为 pure_white。'
      }));
    }
    if (!effectiveRules.effectiveMainImageRules.iconsAllowed && iconHints(imagePlan).length) {
      issues.push(issue({
        code: 'MAIN_IMAGE_ICON_NOT_ALLOWED',
        severity: 'error',
        message: 'Amazon 主图不允许出现图标。',
        imageType,
        ruleSource: 'platform',
        suggestion: '请移除主图 iconHints。'
      }));
    }
  }

  for (const block of textBlocks) {
    const text = normalizeText(block.text);
    if (!text) continue;
    if (!effectiveRules.effectiveTextRules.allowChinese && CHINESE_PATTERN.test(text)) {
      issues.push(issue({
        code: 'TEXT_CONTAINS_CHINESE',
        severity: 'error',
        message: '图片文案包含中文，当前平台规则不允许。',
        imageType,
        ruleSource: 'platform',
        suggestion: '请改为清楚、简短的英文文案。'
      }));
    }
    if (!effectiveRules.effectiveTextRules.priceAllowed && PRICE_PATTERN.test(text)) {
      issues.push(issue({
        code: 'TEXT_CONTAINS_PRICE',
        severity: 'error',
        message: '图片文案包含价格信息，平台图片不允许出现价格。',
        imageType,
        ruleSource: 'platform',
        suggestion: '请移除价格、币种和金额。'
      }));
    }
    for (const word of effectiveRules.effectiveBannedWords) {
      if (includesWord(text, word)) {
        issues.push(issue({
          code: 'TEXT_CONTAINS_BANNED_WORD',
          severity: 'error',
          message: `图片文案包含禁用词或高风险词：${word}`,
          imageType,
          ruleSource: 'combined',
          suggestion: '请删除价格、促销、绝对化或无证据声明。'
        }));
      }
    }
    for (const word of effectiveRules.effectiveCautionWords) {
      if (includesWord(text, word)) {
        const caution = issue({
          code: 'TEXT_CONTAINS_CAUTION_WORD',
          severity: 'warning',
          message: `图片文案包含谨慎词：${word}`,
          imageType,
          ruleSource: 'combined',
          suggestion: '即使有证据，也建议人工确认后再使用。'
        });
        warnings.push(caution);
        cautionFields.push({ fieldKey: word, reason: 'cautionWord', imageType });
      }
    }

    for (const field of blockFields(block)) {
      if (!effectiveRules.effectiveHighRiskFields.includes(field)) continue;
      if (inferredCandidateFields.has(field)) {
        issues.push(issue({
          code: 'HIGH_RISK_FIELD_INFERRED_CANDIDATE',
          severity: 'error',
          message: `${field} 来自 inferredCandidates，不能自动进入图片文案。`,
          fieldKey: field,
          imageType,
          ruleSource: 'category',
          suggestion: '请使用图片文字证据或人工确认后的字段。'
        }));
        blockedFields.push({ fieldKey: field, reason: 'inferredCandidate', imageType, text });
        continue;
      }
      const status = statusByField.get(field);
      if (['missingEvidence', 'blockedHighRisk', 'conflicted', 'inferredOnly', 'needsManualConfirm'].includes(status)) {
        const code = status === 'conflicted' ? 'HIGH_RISK_FIELD_CONFLICT' : 'HIGH_RISK_FIELD_WITHOUT_EVIDENCE';
        const item = issue({
          code,
          severity: status === 'needsManualConfirm' ? 'warning' : 'error',
          message: `${field} 属于高风险字段。${reasonMessage(status)}`,
          fieldKey: field,
          imageType,
          ruleSource: 'category',
          suggestion: '请补充可见文字证据或人工确认后再使用。'
        });
        issues.push(item);
        blockedFields.push({ fieldKey: field, reason: status, imageType, text });
      }
    }
  }

  const passed = issues.every((item) => item.severity !== 'error');
  return {
    passed,
    platformId: effectiveRules.platformId,
    categoryId: effectiveRules.categoryId,
    issues,
    warnings,
    blockedFields,
    cautionFields,
    recommendations: [
      ...effectiveRules.recommendations,
      passed ? '规则审计未发现阻断项，仍建议人工查看图片效果。' : '规则审计发现阻断项，请先修正文案或补充证据。'
    ]
  };
}
