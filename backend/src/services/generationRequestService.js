export const GENERATION_REQUEST_VERSION = 'v1.8';
import { normalizeCompositeSettings } from './compositeSettingsService.js';
import { getForbiddenElements, platformRuleSnapshotForImage } from '../rules/platformRuleUtils.js';
import { categoryRuleSnapshotForImage } from '../rules/categoryRuleUtils.js';
import { normalizeTargets } from './targetService.js';

const chinesePattern = /[\u3400-\u9fff]/;
const highRiskFields = new Set(['capacity', 'certifications', 'warranty']);

const preferredModeByType = {
  main_image: 'product_preserve',
  feature_image: 'text_layout',
  size_image: 'text_layout',
  compatibility_image: 'text_layout',
  package_image: 'text_layout',
  lifestyle_image: 'background_replace',
  detail_image: 'product_preserve',
  variant_image: 'text_layout'
};

function asArray(value) {
  if (Array.isArray(value)) return value.filter((item) => item !== null && item !== undefined && String(item).trim() !== '');
  if (value === null || value === undefined || value === '') return [];
  return [value];
}

function unique(values) {
  return [...new Set(asArray(values).map((item) => String(item).trim()).filter(Boolean))];
}

function productName(product = {}) {
  return product.name || product.productName || '';
}

function confirmedFields(product = {}) {
  const keys = [
    'sku',
    'name',
    'productName',
    'category',
    'brand',
    'model',
    'colors',
    'color',
    'capacity',
    'dimensions',
    'material',
    'interfaceType',
    'compatibleDevices',
    'packageIncluded',
    'packageList',
    'sellingPoints',
    'visibleSpecs',
    'certifications',
    'warranty'
  ];
  return Object.fromEntries(keys.filter((key) => product[key] !== undefined).map((key) => [key, product[key]]));
}

function evidenceSummary(fieldEvidence = {}, plan = {}) {
  const sourceFields = new Set((plan.textBlocks || []).flatMap((block) => asArray(block.sourceFields)));
  const entries = {};
  for (const field of sourceFields) {
    const evidence = Array.isArray(fieldEvidence[field]) ? fieldEvidence[field] : [];
    entries[field] = {
      evidenceCount: evidence.length,
      sources: [...new Set(evidence.map((item) => item.source).filter(Boolean))],
      hasVisibleTextEvidence: evidence.some((item) => item.source === 'visible_text')
    };
  }
  return entries;
}

function inferSourceRole(image = {}) {
  const name = `${image.displayName || image.originalName || image.fileName || ''}`.toLowerCase();
  if (/main|主图/.test(name)) return 'main';
  if (/size|尺寸|spec|参数/.test(name)) return 'size';
  if (/package|包装/.test(name)) return 'package';
  if (/detail|细节/.test(name)) return 'detail';
  if (/feature|卖点/.test(name)) return 'reference';
  return image.imageIndex === 0 ? 'main' : 'unknown';
}

function normalizeSourceImages(sourceImages = []) {
  return sourceImages.map((image, index) => ({
    id: image.id || `source-${index + 1}`,
    imageIndex: image.imageIndex ?? index,
    displayName: image.displayName || image.originalName || image.fileName || `Image ${index + 1}`,
    url: image.url || image.previewUrl || '',
    filePath: image.filePath || '',
    role: image.role && image.role !== 'source' ? image.role : inferSourceRole(image)
  }));
}

function sourceDisplayName(image = {}, index = 0) {
  return image.displayName || image.originalName || image.fileName || `Image ${index + 1}`;
}

function productReferenceFromImage(image, index, reason) {
  return {
    enabled: true,
    sourceImageId: image.id || `source-${index + 1}`,
    imageIndex: image.imageIndex ?? index,
    displayName: sourceDisplayName(image, index),
    filePath: image.filePath || '',
    previewUrl: image.previewUrl || image.url || '',
    role: image.role && image.role !== 'source' ? image.role : inferSourceRole(image),
    reason,
    selectedBy: reason === 'user selected product reference' ? 'user' : 'auto'
  };
}

function selectProductReference(sourceImages = [], plan = {}) {
  if (!sourceImages.length) {
    return {
      enabled: false,
      sourceImageId: null,
      imageIndex: null,
      displayName: '',
      filePath: '',
      previewUrl: '',
      role: 'unknown',
      reason: 'no source images available',
      selectedBy: 'auto'
    };
  }

  const withIndex = sourceImages.map((image, index) => ({ image, index }));
  if (plan.productReferenceOverride?.sourceImageId) {
    const override = withIndex.find(({ image }) => image.id === plan.productReferenceOverride.sourceImageId);
    if (override) {
      return {
        ...productReferenceFromImage(override.image, override.index, 'user selected product reference'),
        override: plan.productReferenceOverride
      };
    }
  }

  const explicitMain = withIndex.find(({ image }) => image.role === 'main');
  if (explicitMain) return productReferenceFromImage(explicitMain.image, explicitMain.index, 'source image role is main');

  const filenameMain = withIndex.find(({ image, index }) => /main|主图|正面|front|product|涓诲浘/i.test(sourceDisplayName(image, index)));
  if (filenameMain) return productReferenceFromImage(filenameMain.image, filenameMain.index, 'filename indicates main product image');

  const lowest = [...withIndex].sort((a, b) => (a.image.imageIndex ?? a.index) - (b.image.imageIndex ?? b.index))[0];
  return productReferenceFromImage(lowest.image, lowest.index, 'lowest imageIndex fallback');
}

function textRole(block = {}, index) {
  const label = `${block.label || ''}`.toLowerCase();
  if (/headline|title/.test(label) || index === 0) return 'headline';
  if (/sub/.test(label)) return 'subheadline';
  if (/warning|risk/.test(label)) return 'warning';
  if (/label|size|capacity|interface|package/.test(label)) return 'label';
  return 'bullet';
}

function evidenceStatusForBlock(block = {}, fieldEvidence = {}) {
  const fields = asArray(block.sourceFields);
  if (!fields.length) return 'needs_confirmation';
  if (fields.some((field) => highRiskFields.has(field))) {
    const hasVisibleText = fields.some((field) => (fieldEvidence[field] || []).some((item) => item.source === 'visible_text'));
    return hasVisibleText ? 'has_visible_text_evidence' : 'blocked_without_visible_text';
  }
  const hasEvidence = fields.some((field) => Array.isArray(fieldEvidence[field]) && fieldEvidence[field].length > 0);
  return hasEvidence ? 'has_evidence' : 'needs_confirmation';
}

function normalizeTextBlocks({ plan, task }) {
  const language = plan.language || task.language || 'English';
  return (plan.textBlocks || []).map((block, index) => ({
    text: String(block.text || '').trim(),
    role: textRole(block, index),
    language,
    evidenceStatus: evidenceStatusForBlock(block, task.fieldEvidence || {}),
    sourceField: asArray(block.sourceFields)[0] || null,
    editable: true
  })).filter((block) => block.text);
}

function forbiddenElements(rule = {}) {
  return [
    ...(rule.forbiddenElements || rule.bannedElements || []),
    'Chinese text',
    'price',
    'discount',
    'watermark',
    'unconfirmed capacity',
    'unconfirmed certification',
    'unconfirmed warranty',
    'fake brand logo',
    'marketplace sensitive terms'
  ];
}

function allowedElements(rule = {}) {
  const elements = ['confirmed product appearance', 'confirmed accessories'];
  if (rule.textAllowed) elements.push('confirmed target-language text');
  if (rule.logoAllowed) elements.push('existing product logo only');
  return elements;
}

function ruleBackground(rule = {}, fallback = 'clean') {
  if (typeof rule.background === 'string') return rule.background;
  if (typeof rule.backgroundRule === 'string') return rule.backgroundRule;
  return rule.background?.recommended ||
    rule.backgroundRule?.recommended ||
    rule.backgroundRule?.allowed?.[0] ||
    rule.background?.allowed?.[0] ||
    fallback;
}

function layoutFor(plan = {}, rule = {}) {
  const background = ruleBackground(rule, 'clean');
  return {
    style: plan.type || plan.imageType,
    background: plan.background || background,
    composition: plan.layout || plan.goal || '',
    productPlacement: plan.type === 'main_image' ? 'centered product hero' : 'product-led composition',
    textPlacement: rule.textAllowed === false || plan.type === 'main_image' ? 'no text' : 'clean readable callouts',
    iconPlacement: ['feature_image', 'compatibility_image'].includes(plan.type) ? 'simple supporting icons' : 'none or minimal',
    aspectRatio: '1:1',
    outputSize: plan.size || rule.recommendedSize || '2000x2000'
  };
}

function visualInstructions(plan = {}, rule = {}) {
  const background = ruleBackground(rule, 'a clean compliant background');
  return {
    keepProductAppearance: true,
    preserveShape: true,
    preserveColor: true,
    preserveTexture: true,
    preservePorts: true,
    preserveLogo: true,
    backgroundInstruction: plan.type === 'lifestyle_image'
      ? 'Create a realistic lifestyle background while preserving the product.'
      : `Use ${plan.background || background}.`,
    lightingInstruction: 'Clean commercial lighting with accurate product color.',
    cameraAngle: plan.type === 'detail_image' ? 'close-up product detail angle' : 'front-facing marketplace composition',
    styleKeywords: ['clean ecommerce', 'product accurate', 'marketplace ready']
  };
}

function riskWarnings(plan = {}) {
  return Array.isArray(plan.riskWarnings) ? plan.riskWarnings : [];
}

function complianceNotes(plan = {}) {
  return Array.isArray(plan.complianceNotes) ? plan.complianceNotes : [];
}

function hasHighRisk(plan = {}) {
  return riskWarnings(plan).some((warning) => warning.level === 'high');
}

function textContainsUnconfirmedHighRisk(textBlocks = []) {
  return textBlocks.some((block) => {
    if (block.evidenceStatus === 'blocked_without_visible_text') return true;
    const field = block.sourceField || '';
    return highRiskFields.has(field) && !/visible_text/i.test(block.evidenceStatus || '');
  });
}

function textContainsCategoryClaim(text = '', claims = []) {
  const normalized = String(text || '').toLowerCase();
  return asArray(claims).some((claim) => normalized.includes(String(claim).toLowerCase()));
}

function categoryEvidenceRequirementForText(block = {}, categoryRule = {}) {
  const fields = asArray(block.sourceFields || block.sourceField);
  const text = String(block.text || '');
  const evidenceRequired = categoryRule.evidenceRequiredFields || {};
  const matchedField = fields.find((field) => evidenceRequired[field]) ||
    (/\b(up to\s*)?\d{2,5}\s?(mb\/s|gb\/s)|transfer speed|ultra fast|guaranteed speed\b/i.test(text) ? 'speed' : '') ||
    (/\b(warranty|guarantee)\b/i.test(text) ? 'warranty' : '') ||
    (/\b(ce|fcc|rohs|fda)\b/i.test(text) ? 'certifications' : '') ||
    (/\b(universal compatibility|all devices|wide compatibility)\b/i.test(text) ? 'compatibility' : '') ||
    (/\b(waterproof|shockproof|military grade|drop proof)\b/i.test(text) ? 'waterproof' : '');
  if (!matchedField) return null;
  const evidenceStatus = String(block.evidenceStatus || block.evidence || '').toLowerCase();
  if (/visible_text|confirmed|has_visible_text/.test(evidenceStatus)) return null;
  return {
    field: matchedField,
    requirement: evidenceRequired[matchedField] || 'visible_text',
    text
  };
}

function blockingIssues({ task, plan, textBlocks, rule, categoryRule }) {
  const issues = [];
  if (!normalizeSourceImages(task.sourceImages || []).length) issues.push('At least one source image is required.');
  if (!productName(task.productInfoConfirmed || {}) && !task.productInfoConfirmed?.category) {
    issues.push('Confirmed product name or category is required.');
  }
  if (plan.type === 'main_image' && textBlocks.length) issues.push('main_image cannot contain text blocks.');
  if (rule?.textAllowed === false && textBlocks.length) issues.push(`${plan.type} does not allow text under platform rules.`);
  if (textBlocks.some((block) => chinesePattern.test(block.text))) issues.push('Chinese text is not safe for real generation.');
  if (textContainsUnconfirmedHighRisk(textBlocks)) {
    issues.push('Text blocks contain unconfirmed capacity, certification, or warranty claims.');
  }
  for (const block of textBlocks) {
    const categoryRequirement = categoryEvidenceRequirementForText(block, categoryRule);
    if (categoryRequirement) {
      issues.push(`Category rule blocks ${categoryRequirement.field} claim without ${categoryRequirement.requirement} evidence.`);
    }
    if (textContainsCategoryClaim(block.text, categoryRule?.forbiddenClaimsWithoutEvidence || [])) {
      issues.push('Category rule blocks forbidden claim without evidence.');
    }
    if (/\b(universal compatibility|all devices)\b/i.test(block.text || '')) {
      issues.push('Category rule blocks broad compatibility wording without evidence.');
    }
  }
  if (hasHighRisk(plan)) issues.push('High risk warnings must be resolved before real generation.');
  return issues;
}

function promptFor({ task, plan, textBlocks, rule }) {
  const product = task.productInfoConfirmed || {};
  const text = textBlocks.map((block) => block.text).join('; ') || 'No text';
  const positivePrompt = [
    `Create a ${plan.type} marketplace image for ${productName(product) || product.category || 'the confirmed product'}.`,
    `Platform: ${plan.platform || task.platform || 'Marketplace'}.`,
    `Composition: ${plan.layout || plan.goal || 'clean ecommerce layout'}.`,
    `Background: ${plan.background || ruleBackground(rule, 'clean compliant background')}.`,
    'Preserve product shape, color, texture, ports, logo, and visible details.',
    `Allowed text: ${text}.`
  ].join(' ');
  const negativePrompt = [
    'No Chinese text.',
    'No price or discount.',
    'No watermark.',
    'No unconfirmed capacity.',
    'No unconfirmed certification.',
    'No unconfirmed warranty.',
    'Do not change product shape.',
    'Do not change product color.',
    'Do not add nonexistent ports.',
    'Do not add nonexistent accessories.',
    'No fake brand logo.',
    'No marketplace sensitive terms.',
    ...forbiddenElements(rule).map((item) => `No ${item}.`)
  ].join(' ');
  return {
    positivePrompt,
    negativePrompt,
    promptVersion: plan.promptVersion || 'v1.5'
  };
}

export function generationRequestSummary(request) {
  return {
    requestVersion: request.requestVersion,
    imageType: request.imageType,
    targetId: request.targetId,
    platformId: request.platformId,
    platformName: request.platformName,
    site: request.site,
    language: request.language,
    categoryId: request.categoryId,
    preferredMode: request.providerHints.preferredMode,
    safeForRealGeneration: request.providerHints.safeForRealGeneration,
    blockingIssues: request.providerHints.blockingIssues,
    positivePrompt: request.prompt.positivePrompt,
    negativePrompt: request.prompt.negativePrompt,
    textBlocks: request.textBlocks,
    forbiddenElements: request.compliance?.forbiddenElements || [],
    platformRuleSnapshot: request.compliance?.platformRulesSnapshot || null,
    categoryRuleSnapshot: request.categoryRuleSnapshot || request.compliance?.categoryRuleSnapshot || null
  };
}

export function buildGenerationRequest({ task, plan }) {
  const product = task.productInfoConfirmed || task.productInfo || {};
  const targets = normalizeTargets(task.targets || [], { productInfo: product, fallbackTask: task });
  const target = targets.find((item) => item.id === plan.targetId || item.targetId === plan.targetId) || targets[0] || {};
  const platformId = target.platformId || target.rulesSnapshot?.platformId || plan.platformId || task.platformId || task.platform;
  const imageRuleSnapshot = platformRuleSnapshotForImage({
    platformId,
    site: target.site || task.site,
    imageType: plan.type,
    language: plan.language || target.language || task.language
  });
  const categoryRuleSnapshot = categoryRuleSnapshotForImage({
    categoryId: plan.categoryId || target.categoryId || target.category || task.categoryId || task.category,
    imageType: plan.type,
    productInfoConfirmed: product
  });
  const rule = plan.rulesSnapshot || target.rulesSnapshot?.imageTypes?.[plan.type] || imageRuleSnapshot;
  const textBlocks = normalizeTextBlocks({ plan, task });
  const issues = blockingIssues({ task, plan, textBlocks, rule, categoryRule: categoryRuleSnapshot });
  const prompt = promptFor({ task, plan, textBlocks, rule });

  return {
    requestVersion: GENERATION_REQUEST_VERSION,
    taskId: task.id,
    planId: plan.id,
    targetId: plan.targetId || target.id,
    imageType: plan.type,
    platform: plan.platform || target.rulesSnapshot?.name || task.platform,
    platformId: plan.platformId || target.platformId,
    platformName: plan.platformName || target.platformName || target.rulesSnapshot?.name,
    site: plan.site || target.site || task.site,
    language: plan.language || target.language || task.language || 'English',
    category: target.category || task.category || product.category || 'general',
    categoryId: plan.categoryId || target.categoryId || target.category || task.categoryId || 'general',
    categoryRuleSnapshot,
    product: {
      name: productName(task.productInfoConfirmed || {}),
      category: task.productInfoConfirmed?.category || '',
      brand: task.productInfoConfirmed?.brand || '',
      model: task.productInfoConfirmed?.model || '',
      confirmedFields: confirmedFields(task.productInfoConfirmed || {}),
      evidenceSummary: evidenceSummary(task.fieldEvidence || {}, plan),
      excludedInferredCandidates: plan.excludedUnconfirmedFields || task.inferredCandidates || []
    },
    sourceImages: normalizeSourceImages(task.sourceImages || []),
    productReference: selectProductReference(task.sourceImages || [], plan),
    productReferenceOverride: plan.productReferenceOverride || null,
    compositeSettings: plan.type === 'lifestyle_image' ? normalizeCompositeSettings(plan.compositeSettings) : null,
    layout: layoutFor(plan, rule),
    textBlocks,
    visualInstructions: visualInstructions(plan, rule),
    compliance: {
      platformRulesSnapshot: imageRuleSnapshot,
      imageTypeRuleSnapshot: imageRuleSnapshot,
      categoryRuleSnapshot,
      forbiddenElements: getForbiddenElements({ platformId, imageType: plan.type }),
      allowedElements: allowedElements(rule),
      riskWarnings: riskWarnings(plan),
      complianceNotes: complianceNotes(plan),
      noChineseText: true,
      noPrice: true,
      noFakeCertification: true,
      noUnconfirmedSpecs: true
    },
    prompt,
    providerHints: {
      preferredMode: preferredModeByType[plan.type] || 'full_mock',
      requiresProductMask: false,
      requiresTextRendering: plan.type !== 'main_image' && textBlocks.length > 0,
      safeForRealGeneration: issues.length === 0,
      blockingIssues: issues
    }
  };
}
