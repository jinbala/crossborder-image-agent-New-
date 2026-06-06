import { IMAGE_TEMPLATE_TYPES } from './imageTemplateStyleService.js';
import { auditImagePlanAgainstRules } from './ruleAuditService.js';
import { getEffectiveRules } from './platformCategoryRuleService.js';

const CHINESE_PATTERN = /[\u3400-\u9fff]/;
const PRICE_PATTERN = /(?:[$€£¥]\s?\d|\b\d+(?:\.\d{1,2})?\s?(?:usd|eur|gbp|rmb|cny)\b)/i;
const PROMOTION_PATTERN = /\b(price|sale|discount|off|coupon|deal|best|no\.?\s*1|guaranteed|free shipping|limited time)\b|\d+\s?%/i;

function asArray(value) {
  if (Array.isArray(value)) return value.filter((item) => item !== null && item !== undefined && String(item).trim() !== '');
  if (value === null || value === undefined || value === '') return [];
  return [value];
}

function cleanText(value) {
  if (value === null || value === undefined) return '';
  return String(value).trim();
}

function sanitizeText(value) {
  return cleanText(value)
    .replace(/[A-Z]:\\[^\s"',，。；;]+/gi, '[local-path-removed]')
    .replace(/\b[\w.-]*\.sqlite\b/gi, '[sqlite-path-removed]')
    .replace(/\bnode_modules\b/gi, '[node-modules-removed]')
    .replace(/\.env(?:\.[\w.-]+)?/gi, '[env-file-removed]')
    .replace(/\b[A-Z0-9_]*API[_-]?KEY\b\s*[:=]\s*[^\s"',，。；;]+/gi, '[api-key-removed]')
    .replace(/\b(?:sk|rk|ak)-[A-Za-z0-9_-]{6,}\b/g, '[secret-removed]')
    .replace(/\b(provider[_-]?secret|api[_-]?key|secret)\b\s*[:=]\s*[^\s"',，。；;]+/gi, '[secret-removed]');
}

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
  speed: '速度',
  waterproof: '防水',
  shockproof: '防摔',
  medicalClaims: '医疗声明',
  sellingPoints: '卖点'
};

const IMAGE_TYPE_LABELS = {
  main_image: '平台主图',
  feature_image: '核心卖点图',
  size_image: '尺寸/规格图',
  compatibility_image: '兼容设备图',
  package_image: '包装清单图',
  lifestyle_image: '使用场景图',
  detail_image: '细节图',
  variant_image: '容量/颜色/规格变体图'
};

function sanitizeValue(value) {
  if (Array.isArray(value)) return value.map(sanitizeValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, sanitizeValue(item)]));
  }
  if (typeof value === 'string') return sanitizeText(value);
  return value;
}

function fieldLabel(fieldKey) {
  return FIELD_LABELS[fieldKey] || fieldKey || '';
}

function taskFromInput(input) {
  if (Array.isArray(input)) return { generatedImages: input };
  return input && typeof input === 'object' ? input : {};
}

function productInfo(task = {}) {
  return task.productInfoConfirmed || task.productInfo || task.productInfoRaw || {};
}

function imageTypeOf(item = {}) {
  return item.imageType || item.type || item.mockPreview?.type || item.mockPreview?.template?.templateType || item.templateType || '';
}

function planById(task = {}) {
  return new Map(asArray(task.imagePlans).map((plan) => [plan.id, plan]));
}

function templateFrom(item = {}, plan = {}) {
  const template = item.mockPreview?.template || item.templateSeed || plan.templateSeed || {};
  return {
    templateType: template.templateType || imageTypeOf(item) || imageTypeOf(plan),
    templateName: template.templateName || item.templateName || plan.templateName || '',
    layoutStyle: template.layoutStyle || item.layoutStyle || plan.layoutStyle || '',
    variantId: template.variantId || item.variantId || plan.templateSeed?.variantId || '',
    layoutSeed: template.layoutSeed || item.layoutSeed || plan.templateSeed?.layoutSeed || '',
    backgroundStyle: template.backgroundStyle || item.backgroundStyle || plan.backgroundStyle || item.background || '',
    productPlacement: template.productPlacement || item.productPlacement || plan.productPlacement || '',
    iconHints: asArray(template.iconHints || item.iconHints || plan.iconHints),
    safetyNotes: asArray(template.safetyNotes || item.safetyNotes || plan.safetyNotes),
    allowedTextBlocks: asArray(template.allowedTextBlocks || item.allowedTextBlocks || plan.allowedTextBlocks)
  };
}

function textBlocksFrom(item = {}) {
  return [
    ...asArray(item.textBlocks),
    ...asArray(item.generationRequest?.textBlocks),
    ...asArray(item.mockPreview?.usedTextBlocks)
  ];
}

function collectTemplateText(template = {}) {
  return [
    template.templateName,
    template.layoutStyle,
    template.backgroundStyle,
    template.productPlacement,
    ...asArray(template.iconHints),
    ...asArray(template.safetyNotes)
  ].map(cleanText).filter(Boolean);
}

function collectTextEntries(task = {}) {
  const plans = planById(task);
  const entries = [];
  const pushText = ({ text, source, imageType, field = null }) => {
    const value = sanitizeText(text);
    if (value) entries.push({ text: value, source, imageType, field });
  };
  const collectItem = (item = {}, fallbackPlan = {}) => {
    const imageType = imageTypeOf(item) || imageTypeOf(fallbackPlan);
    const template = templateFrom(item, fallbackPlan);
    for (const block of textBlocksFrom(item)) {
      const fields = asArray(block.sourceFields || block.sourceField || block.field);
      if (fields.length) {
        fields.forEach((field) => pushText({ text: block.text, source: 'textBlock', imageType, field }));
      } else {
        pushText({ text: block.text, source: 'textBlock', imageType });
      }
    }
    pushText({ text: item.prompt, source: 'prompt', imageType });
    pushText({ text: item.promptPreview, source: 'promptPreview', imageType });
    collectTemplateText(template).forEach((text) => pushText({ text, source: 'template', imageType }));
  };

  for (const image of asArray(task.generatedImages)) {
    collectItem(image, plans.get(image.planId) || {});
  }
  for (const plan of asArray(task.imagePlans)) {
    collectItem(plan, plan);
  }
  return entries;
}

function typeCoverage(task = {}) {
  const plans = planById(task);
  const images = asArray(task.generatedImages);
  return IMAGE_TEMPLATE_TYPES.map((imageType) => {
    const image = images.find((item) => imageTypeOf(item) === imageType);
    const plan = image ? plans.get(image.planId) : asArray(task.imagePlans).find((item) => imageTypeOf(item) === imageType);
    const source = image || plan || {};
    const template = templateFrom(source, plan || {});
    const exists = Boolean(image);
    return {
      imageType,
      exists,
      templateName: template.templateName || null,
      layoutStyle: template.layoutStyle || null,
      variantId: template.variantId || null,
      layoutSeed: template.layoutSeed || null,
      status: exists ? 'present' : 'missing'
    };
  });
}

function uniqueCount(values) {
  return new Set(values.map(cleanText).filter(Boolean)).size;
}

function diversityFromCoverage(coverage = []) {
  const present = coverage.filter((item) => item.exists);
  const count = present.length || 1;
  const signatures = new Map();
  for (const item of present) {
    const signature = [item.templateName, item.layoutStyle, item.variantId].map(cleanText).join('|');
    signatures.set(signature, [...(signatures.get(signature) || []), item.imageType]);
  }
  const repeatedTemplates = [...signatures.entries()]
    .filter(([, types]) => types.length > 1)
    .map(([signature, imageTypes]) => ({ signature, imageTypes, count: imageTypes.length }));
  const uniqueTemplateNames = uniqueCount(present.map((item) => item.templateName));
  const uniqueLayoutStyles = uniqueCount(present.map((item) => item.layoutStyle));
  const uniqueVariantIds = uniqueCount(present.map((item) => item.variantId));
  const diversityScore = Math.round(((uniqueTemplateNames + uniqueLayoutStyles + uniqueVariantIds) / (count * 3)) * 100);
  const diversityLevel = diversityScore >= 80 ? 'high' : diversityScore >= 50 ? 'medium' : 'low';
  const warnings = [];
  if (repeatedTemplates.length) warnings.push(`发现 ${repeatedTemplates.length} 组模板签名重复，建议重新生成不同 version。`);
  if (diversityLevel === 'low') warnings.push('模板差异化偏低，8 类图可能看起来过于相似。');
  return {
    uniqueTemplateNames,
    uniqueLayoutStyles,
    uniqueVariantIds,
    repeatedTemplates,
    diversityScore,
    diversityLevel,
    warnings
  };
}

function textSafetyFromEntries(entries = []) {
  const nonEnglishTextBlocks = [];
  const riskyTextBlocks = [];
  for (const entry of entries) {
    const containsChinese = CHINESE_PATTERN.test(entry.text);
    const containsPrice = PRICE_PATTERN.test(entry.text);
    const containsPromotion = PROMOTION_PATTERN.test(entry.text);
    if (containsChinese) nonEnglishTextBlocks.push({ ...entry, reason: 'contains_chinese' });
    if (containsPrice || containsPromotion) {
      riskyTextBlocks.push({
        ...entry,
        reason: containsPrice ? 'contains_price' : 'contains_promotion'
      });
    }
  }
  return {
    containsChinese: nonEnglishTextBlocks.length > 0,
    containsPrice: riskyTextBlocks.some((item) => item.reason === 'contains_price'),
    containsPromotionWords: riskyTextBlocks.some((item) => item.reason === 'contains_promotion'),
    containsBannedWords: riskyTextBlocks.length > 0,
    nonEnglishTextBlocks,
    riskyTextBlocks
  };
}

function valuesForRiskItem(item = {}) {
  return [
    ...asArray(item.value),
    ...asArray(item.values),
    ...asArray(item.conflictValues)
  ].map(cleanText).filter(Boolean);
}

function riskItems(task = {}, key) {
  return asArray(task.recognitionQuality?.[key]).map((item) => (
    typeof item === 'string' ? { field: item } : item
  )).filter((item) => item?.field);
}

function fieldEntryUsed(entry, item) {
  if (entry.field && entry.field === item.field) return true;
  const values = valuesForRiskItem(item).map((value) => value.toLowerCase());
  if (!values.length) return false;
  const text = entry.text.toLowerCase();
  return values.some((value) => value && text.includes(value.toLowerCase()));
}

function fieldSafetyFromEntries(task = {}, entries = []) {
  const inferredCandidates = asArray(task.inferredCandidates).filter((item) => item?.field);
  const missingEvidenceFields = riskItems(task, 'missingEvidenceFields');
  const conflictedFields = riskItems(task, 'conflictFields');
  const blockedHighRiskFields = [
    ...riskItems(task, 'blockedHighRiskFields'),
    ...riskItems(task, 'blockedHighRisk')
  ];
  const checks = [
    ['inferredCandidate', inferredCandidates],
    ['missingEvidence', missingEvidenceFields],
    ['conflicted', conflictedFields],
    ['blockedHighRisk', blockedHighRiskFields]
  ];
  const unsafeFields = [];
  for (const [reason, items] of checks) {
    for (const item of items) {
      for (const entry of entries) {
        if (fieldEntryUsed(entry, item)) {
          unsafeFields.push({
            field: item.field,
            reason,
            imageType: entry.imageType,
            source: entry.source,
            text: entry.text
          });
        }
      }
    }
  }
  const warnings = [];
  if (unsafeFields.length) warnings.push(`发现 ${unsafeFields.length} 处未确认或高风险字段进入模板文案，请检查字段过滤。`);
  return {
    usesInferredCandidates: unsafeFields.some((item) => item.reason === 'inferredCandidate'),
    usesBlockedHighRiskFields: unsafeFields.some((item) => item.reason === 'blockedHighRisk'),
    usesConflictedFields: unsafeFields.some((item) => item.reason === 'conflicted'),
    usesMissingEvidenceFields: unsafeFields.some((item) => item.reason === 'missingEvidence'),
    unsafeFields,
    warnings
  };
}

function amazonMainImage(task = {}) {
  const plans = planById(task);
  const mainImage = asArray(task.generatedImages).find((image) => imageTypeOf(image) === 'main_image');
  const mainPlan = mainImage ? plans.get(mainImage.planId) : asArray(task.imagePlans).find((plan) => imageTypeOf(plan) === 'main_image');
  const source = mainImage || mainPlan || {};
  const template = templateFrom(source, mainPlan || {});
  const textBlocks = [
    ...textBlocksFrom(source),
    ...textBlocksFrom(mainPlan || {})
  ].filter((block) => cleanText(block.text));
  const isPureWhite = template.backgroundStyle === 'pure_white' || source.background === 'pure_white' || mainPlan?.background === 'pure_white';
  const hasTextBlocks = textBlocks.length > 0;
  const hasIcons = template.iconHints.length > 0;
  const warnings = [];
  if (!isPureWhite) warnings.push('Amazon 主图不是 pure_white 白底。');
  if (hasTextBlocks) warnings.push('Amazon 主图包含文字块，主图应保持无文字。');
  if (hasIcons) warnings.push('Amazon 主图包含图标，主图应保持无图标。');
  return {
    isPureWhite,
    hasTextBlocks,
    hasIcons,
    productPlacement: template.productPlacement || null,
    pass: isPureWhite && !hasTextBlocks && !hasIcons,
    warnings
  };
}

function recommendationsFor({ coverage, diversity, textSafety, fieldSafety, mainImageCheck }) {
  const recommendations = [];
  const missing = coverage.filter((item) => !item.exists).map((item) => item.imageType);
  if (missing.length) recommendations.push(`缺少 ${missing.join(', ')}，建议先补齐 8 类 mock 图片。`);
  else recommendations.push('8 类 mock 图片已全部生成。');

  if (mainImageCheck.pass) recommendations.push('Amazon 主图通过白底无文字检查。');
  else recommendations.push('Amazon 主图未通过检查，请确认白底、无文字、无图标。');

  if (!textSafety.containsChinese && !textSafety.containsPrice && !textSafety.containsPromotionWords) {
    recommendations.push('未发现中文、价格或促销词。');
  } else {
    recommendations.push('发现中文、价格或促销词，请先清理图片文案。');
  }

  if (fieldSafety.unsafeFields.length) {
    recommendations.push('发现未确认字段进入文案，请检查 imagePlanService 字段过滤。');
  } else {
    recommendations.push('未发现 inferredCandidates、缺证据、冲突或高风险字段进入图片文案。');
  }

  if (diversity.diversityLevel === 'high') recommendations.push('模板差异化良好，可进入人工视觉验收。');
  else recommendations.push('模板差异化不足，建议重新生成不同 version 后再验收。');
  return recommendations;
}

function normalizePlatformId(task = {}) {
  const target = asArray(task.targets)[0] || {};
  const value = task.platformId || target.platformId || task.platform || target.platform || 'amazon';
  return String(value).trim().toLowerCase().replace(/[\s-]+/g, '_') || 'amazon';
}

function normalizeCategoryId(task = {}) {
  const target = asArray(task.targets)[0] || {};
  const info = productInfo(task);
  const value = task.categoryId || target.categoryId || task.category || info.categoryId || info.category || 'generic_ecommerce';
  return String(value).trim().toLowerCase().replace(/[\s-]+/g, '_') || 'generic_ecommerce';
}

function contextWarnings(task = {}) {
  const warnings = [];
  const target = asArray(task.targets)[0] || {};
  const info = productInfo(task);
  if (!(task.platformId || target.platformId || task.platform || target.platform)) {
    warnings.push('暂无平台规则上下文，请先选择平台规则。');
  }
  if (!(task.categoryId || target.categoryId || task.category || info.categoryId || info.category)) {
    warnings.push('未选择类目，当前使用通用跨境规则。');
  }
  return warnings;
}

function auditSources(task = {}) {
  const plans = planById(task);
  const generatedImages = asArray(task.generatedImages);
  const sources = generatedImages.map((image) => {
    const plan = plans.get(image.planId) || {};
    const imageType = imageTypeOf(image) || imageTypeOf(plan);
    return {
      id: image.id || plan.id || `${imageType}-generated`,
      planId: image.planId || plan.id,
      imageType,
      type: imageType,
      platformId: image.platformId || plan.platformId,
      categoryId: image.categoryId || plan.categoryId,
      background: image.background || plan.background,
      backgroundStyle: image.backgroundStyle || plan.backgroundStyle,
      templateSeed: image.templateSeed || image.mockPreview?.template || plan.templateSeed,
      mockPreview: image.mockPreview || plan.mockPreview,
      iconHints: asArray(image.iconHints).length ? image.iconHints : plan.iconHints,
      textBlocks: [
        ...asArray(plan.textBlocks),
        ...asArray(image.textBlocks),
        ...asArray(image.mockPreview?.usedTextBlocks)
      ],
      generationRequest: image.generationRequest || plan.generationRequest
    };
  });
  const generatedPlanIds = new Set(generatedImages.map((image) => image.planId).filter(Boolean));
  for (const plan of asArray(task.imagePlans)) {
    if (generatedPlanIds.has(plan.id)) continue;
    sources.push({
      ...plan,
      imageType: imageTypeOf(plan),
      type: imageTypeOf(plan)
    });
  }
  return sources.filter((source) => imageTypeOf(source));
}

function severityCounts(items = []) {
  return items.reduce((counts, item) => {
    if (item.severity === 'error') counts.error += 1;
    else if (item.severity === 'info') counts.info += 1;
    else counts.warning += 1;
    return counts;
  }, { error: 0, warning: 0, info: 0 });
}

function messageForIssue(item = {}) {
  const field = item.fieldKey ? `${fieldLabel(item.fieldKey)} ${item.fieldKey}` : '';
  const messages = {
    MAIN_IMAGE_TEXT_NOT_ALLOWED: 'Amazon 主图不允许出现文字、卖点或说明文案。',
    MAIN_IMAGE_BACKGROUND_NOT_WHITE: 'Amazon 主图必须使用 pure_white 白底。',
    MAIN_IMAGE_ICON_NOT_ALLOWED: 'Amazon 主图不允许出现 icon 或图标。',
    TEXT_CONTAINS_CHINESE: '图片文案包含中文，当前平台规则不允许。',
    TEXT_CONTAINS_PRICE: '图片文案包含价格信息，平台图片不允许出现价格。',
    TEXT_CONTAINS_BANNED_WORD: '图片文案包含禁用词、促销词或绝对化表达。',
    TEXT_CONTAINS_CAUTION_WORD: '图片文案包含谨慎词，需要人工确认有证据后再使用。',
    HIGH_RISK_FIELD_INFERRED_CANDIDATE: `${field} 来自 AI 推测候选，不允许进入图片文案。`,
    HIGH_RISK_FIELD_CONFLICT: `${field} 存在识别冲突，不允许自动进入图片文案。`,
    HIGH_RISK_FIELD_WITHOUT_EVIDENCE: `${field} 属于高风险字段，缺少证据时不允许进入图片文案。`
  };
  return messages[item.code] || sanitizeText(item.message || '发现规则风险。');
}

function suggestionForIssue(item = {}) {
  const suggestions = {
    MAIN_IMAGE_TEXT_NOT_ALLOWED: '请移除主图文字，保留白底产品主体。',
    MAIN_IMAGE_BACKGROUND_NOT_WHITE: '请将主图背景改为 pure_white 白底。',
    MAIN_IMAGE_ICON_NOT_ALLOWED: '请移除主图 icon、角标或徽章。',
    TEXT_CONTAINS_CHINESE: '请改为清楚、简短的英文文案。',
    TEXT_CONTAINS_PRICE: '请移除价格、币种、折扣和金额。',
    TEXT_CONTAINS_BANNED_WORD: '请删除价格、促销、绝对化或无证据声明。',
    TEXT_CONTAINS_CAUTION_WORD: '请确认有图片证据或人工确认后再使用。',
    HIGH_RISK_FIELD_INFERRED_CANDIDATE: '请使用图片文字证据或人工确认后的字段。',
    HIGH_RISK_FIELD_CONFLICT: '请先人工确认冲突字段，再决定是否用于文案。',
    HIGH_RISK_FIELD_WITHOUT_EVIDENCE: '请补充可见文字证据或人工确认后再使用。'
  };
  return suggestions[item.code] || sanitizeText(item.suggestion || '请人工复查该风险。');
}

function normalizeIssue(item = {}, fallbackImageType = 'unknown') {
  const fieldKey = item.fieldKey || null;
  return sanitizeValue({
    code: item.code || 'RULE_AUDIT_NOTICE',
    severity: item.severity || 'warning',
    message: messageForIssue(item),
    fieldKey,
    fieldLabel: fieldKey ? fieldLabel(fieldKey) : null,
    imageType: item.imageType || fallbackImageType,
    imageTypeLabel: IMAGE_TYPE_LABELS[item.imageType || fallbackImageType] || item.imageType || fallbackImageType,
    ruleSource: item.ruleSource || 'combined',
    suggestion: suggestionForIssue(item)
  });
}

function normalizeFieldItem(item = {}) {
  const fieldKey = item.fieldKey || item.field || '';
  return sanitizeValue({
    ...item,
    fieldKey,
    fieldLabel: fieldLabel(fieldKey),
    labelText: fieldKey ? `${fieldLabel(fieldKey)} ${fieldKey}` : ''
  });
}

function effectiveRulesSummary(effectiveRules = {}) {
  const mainRules = effectiveRules.effectiveMainImageRules || {};
  const secondaryRules = effectiveRules.effectiveSecondaryImageRules || {};
  return sanitizeValue({
    platformId: effectiveRules.platformId,
    platformName: effectiveRules.platformName,
    categoryId: effectiveRules.categoryId,
    categoryName: effectiveRules.categoryName,
    mainImageText: [
      mainRules.background === 'pure_white' ? '白底' : `背景：${mainRules.background || '简洁背景'}`,
      mainRules.textAllowed === false ? '无文字' : '',
      mainRules.iconsAllowed === false ? '无 icon' : '',
      mainRules.priceAllowed === false ? '不允许价格/促销' : ''
    ].filter(Boolean).join('，'),
    secondaryImageText: [
      secondaryRules.textAllowed ? '允许英文卖点' : '',
      secondaryRules.chineseAllowed === false ? '不允许中文' : '',
      secondaryRules.priceAllowed === false ? '不允许价格' : '',
      secondaryRules.promotionAllowed === false ? '不允许促销词' : '',
      secondaryRules.absoluteClaimsAllowed === false ? '不允许绝对化词' : ''
    ].filter(Boolean).join('，'),
    highRiskFields: asArray(effectiveRules.effectiveHighRiskFields).map((fieldKey) => ({
      fieldKey,
      fieldLabel: fieldLabel(fieldKey),
      labelText: `${fieldLabel(fieldKey)} ${fieldKey}`
    })),
    bannedWords: asArray(effectiveRules.effectiveBannedWords),
    cautionWords: asArray(effectiveRules.effectiveCautionWords)
  });
}

function buildRuleAuditSummary(task = {}) {
  const platformId = normalizePlatformId(task);
  const categoryId = normalizeCategoryId(task);
  const effectiveRules = getEffectiveRules(platformId, categoryId);
  const sources = auditSources(task);
  const context = contextWarnings(task);

  if (!sources.length) {
    return sanitizeValue({
      passed: true,
      platformId: effectiveRules.platformId,
      categoryId: effectiveRules.categoryId,
      issueCount: 0,
      errorCount: 0,
      warningCount: 0,
      infoCount: 0,
      issueCounts: { error: 0, warning: 0, info: 0 },
      issues: [],
      warnings: [],
      blockedFields: [],
      cautionFields: [],
      recommendations: [...context, '暂无可审计的图片方案，请先生成图片方案或 mock 图片。'].filter(Boolean),
      effectiveRulesSummary: effectiveRulesSummary(effectiveRules),
      imagePlanRuleAudit: [],
      contextWarnings: context,
      emptyStateText: '暂无可审计的图片方案，请先生成图片方案或 mock 图片。'
    });
  }

  const perImage = sources.map((source) => {
    const imageType = imageTypeOf(source);
    const audit = auditImagePlanAgainstRules({
      imagePlan: source,
      productInfo: productInfo(task),
      recognitionQuality: task.recognitionQuality || {},
      inferredCandidates: task.inferredCandidates || [],
      platformId: source.platformId || platformId,
      categoryId: source.categoryId || categoryId
    });
    const combinedIssues = [
      ...asArray(audit.issues),
      ...asArray(audit.warnings)
    ].map((item) => normalizeIssue(item, imageType));
    const counts = severityCounts(combinedIssues);
    return sanitizeValue({
      imageType,
      imageTypeLabel: IMAGE_TYPE_LABELS[imageType] || imageType,
      passed: audit.passed,
      issueCount: combinedIssues.length,
      errorCount: counts.error,
      warningCount: counts.warning,
      infoCount: counts.info,
      issues: combinedIssues,
      blockedFields: asArray(audit.blockedFields).map(normalizeFieldItem),
      cautionFields: asArray(audit.cautionFields).map(normalizeFieldItem),
      recommendations: asArray(audit.recommendations).map(sanitizeText)
    });
  });

  const issues = perImage.flatMap((item) => item.issues);
  const counts = severityCounts(issues);
  const blockedFields = perImage.flatMap((item) => item.blockedFields);
  const cautionFields = perImage.flatMap((item) => item.cautionFields);
  const recommendations = [
    ...context,
    ...new Set(perImage.flatMap((item) => item.recommendations)),
    counts.error > 0 ? '规则审计发现阻断项，请先修正文案或补充证据。' : '规则审计未发现阻断项，仍建议人工查看图片效果。'
  ].filter(Boolean);

  return sanitizeValue({
    passed: counts.error === 0,
    platformId: effectiveRules.platformId,
    categoryId: effectiveRules.categoryId,
    issueCount: issues.length,
    errorCount: counts.error,
    warningCount: counts.warning,
    infoCount: counts.info,
    issueCounts: counts,
    issues,
    warnings: issues.filter((item) => item.severity === 'warning'),
    blockedFields,
    cautionFields,
    recommendations,
    effectiveRulesSummary: effectiveRulesSummary(effectiveRules),
    imagePlanRuleAudit: perImage,
    contextWarnings: context,
    emptyStateText: ''
  });
}

export function analyzeTemplateSet(input = {}) {
  const task = taskFromInput(input);
  const info = productInfo(task);
  const coverage = typeCoverage(task);
  const entries = collectTextEntries(task);
  const templateDiversity = diversityFromCoverage(coverage);
  const textSafety = textSafetyFromEntries(entries);
  const fieldSafety = fieldSafetyFromEntries(task, entries);
  const amazonMainImageCheck = amazonMainImage(task);
  const report = {
    meta: {
      taskId: task.id || null,
      sku: info.sku || task.sku || null,
      productName: info.productName || info.name || task.productName || null,
      platform: task.platform || task.platformName || task.platformId || null,
      generatedAt: new Date().toISOString(),
      imageCount: asArray(task.generatedImages).length,
      expectedImageTypes: [...IMAGE_TEMPLATE_TYPES]
    },
    imageTypeCoverage: coverage,
    templateDiversity,
    textSafety,
    fieldSafety,
    amazonMainImageCheck,
    ruleAuditSummary: buildRuleAuditSummary(task),
    recommendations: []
  };
  report.recommendations = recommendationsFor({
    coverage,
    diversity: templateDiversity,
    textSafety,
    fieldSafety,
    mainImageCheck: amazonMainImageCheck
  });
  return report;
}
