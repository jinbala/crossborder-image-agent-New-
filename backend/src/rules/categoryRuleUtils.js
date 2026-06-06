import { CATEGORY_RULE_VERSION, categoryRuleRegistry } from './categoryRules.js';

function asText(value) {
  if (Array.isArray(value)) return value.join(' ');
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') return Object.values(value).map(asText).join(' ');
  return String(value);
}

function normalizeCategoryId(categoryId) {
  const normalized = String(categoryId || '').trim().toLowerCase().replace(/[\s-]+/g, '_');
  return categoryRuleRegistry[normalized] ? normalized : '';
}

export function detectCategoryFromProductInfo(productInfoConfirmed = {}) {
  const haystack = [
    productInfoConfirmed.category,
    productInfoConfirmed.productName,
    productInfoConfirmed.name,
    productInfoConfirmed.title,
    productInfoConfirmed.model,
    productInfoConfirmed.visibleSpecs
  ].map(asText).join(' ').toLowerCase();

  for (const [categoryId, rule] of Object.entries(categoryRuleRegistry)) {
    if (categoryId === 'general') continue;
    if ((rule.aliases || []).some((alias) => haystack.includes(String(alias).toLowerCase()))) {
      return categoryId;
    }
  }
  if (/\bssd\b|hard\s?drive|hard\s?disk|storage|usb-c|type-c/i.test(haystack)) {
    return 'electronics_storage';
  }
  if (/electronics?|gadget|device/i.test(haystack)) return 'electronics_general';
  return 'general';
}

export function getCategoryRule({ categoryId, productInfoConfirmed } = {}) {
  const detected = normalizeCategoryId(categoryId) || detectCategoryFromProductInfo(productInfoConfirmed || {});
  return categoryRuleRegistry[detected] || categoryRuleRegistry.general;
}

export function getCriticalFields(categoryId) {
  return [...(getCategoryRule({ categoryId }).criticalFields || [])];
}

export function getEvidenceRequiredFields(categoryId) {
  return { ...(getCategoryRule({ categoryId }).evidenceRequiredFields || {}) };
}

export function getRiskyClaims(categoryId) {
  return [...(getCategoryRule({ categoryId }).riskyClaims || [])];
}

export function getForbiddenClaimsWithoutEvidence(categoryId) {
  return [...(getCategoryRule({ categoryId }).forbiddenClaimsWithoutEvidence || [])];
}

export function categoryRuleSnapshotForImage({ categoryId, imageType, productInfoConfirmed } = {}) {
  const rule = getCategoryRule({ categoryId, productInfoConfirmed });
  return {
    categoryId: rule.categoryId,
    categoryName: rule.categoryName,
    imageType,
    criticalFields: [...(rule.criticalFields || [])],
    highRiskFields: [...(rule.highRiskFields || [])],
    evidenceRequiredFields: { ...(rule.evidenceRequiredFields || {}) },
    riskyClaims: [...(rule.riskyClaims || [])],
    forbiddenClaimsWithoutEvidence: [...(rule.forbiddenClaimsWithoutEvidence || [])],
    imageTypeGuidance: rule.imageTypeGuidance?.[imageType] || null,
    ruleVersion: CATEGORY_RULE_VERSION,
    notes: [...(rule.notes || [])]
  };
}

export function summarizeCategoryRulesForPrompt({ categoryId, productInfoConfirmed, imageType } = {}) {
  const snapshot = categoryRuleSnapshotForImage({ categoryId, productInfoConfirmed, imageType });
  return [
    `Category: ${snapshot.categoryName} (${snapshot.categoryId})`,
    `Critical fields: ${snapshot.criticalFields.join(', ') || 'none'}`,
    `High-risk fields: ${snapshot.highRiskFields.join(', ') || 'none'}`,
    `Evidence required fields: ${JSON.stringify(snapshot.evidenceRequiredFields)}`,
    `Risky claims: ${snapshot.riskyClaims.join(', ') || 'none'}`,
    `Forbidden claims without evidence: ${snapshot.forbiddenClaimsWithoutEvidence.join(', ') || 'none'}`,
    `Guidance: ${snapshot.imageTypeGuidance?.note || '-'}`
  ].join('\n');
}

