import { maxRiskLevel, normalizeReviewResult } from './normalizeReviewResult.js';
import { getForbiddenElements, getRuleSeverity, isTextAllowed, platformRuleSnapshotForImage } from '../../rules/platformRuleUtils.js';
import { categoryRuleSnapshotForImage } from '../../rules/categoryRuleUtils.js';

const chinesePattern = /[\u3400-\u9fff]/;
const pricePattern = /([$€£¥]|USD|EUR|AED|SAR|JPY|RUB|\d+\.\d{2})/i;
const promotionPattern = /\b(discount|coupon|sale|best seller|no\.?\s*1|limited time|free shipping|% off)\b|\d+\s?%/i;
const certificationPattern = /\b(fda|ce|fcc|rohs|certified|certification|warranty|guarantee|waterproof|medical|health)\b/i;

function asArray(value) {
  if (Array.isArray(value)) return value;
  if (value === null || value === undefined || value === '') return [];
  return [value];
}

function issue(type, level, message, evidence = [], meta = {}) {
  return {
    type,
    category: meta.category || 'general',
    level,
    message,
    evidence: asArray(evidence).map(String),
    imageArea: '',
    ruleId: meta.ruleId || type,
    platformId: meta.platformId || '',
    imageType: meta.imageType || '',
    categoryId: meta.categoryId || '',
    fixSuggestion: meta.fixSuggestion || `Fix: ${message}`
  };
}

function collectImageText({ image = {}, plan = {} }) {
  const layoutText = asArray(image.textLayout?.textElements || plan.textLayout?.textElements)
    .filter((item) => item.visible !== false)
    .map((item) => item.text);
  const planText = asArray(plan.textBlocks).map((item) => item.text);
  return [...layoutText, ...planText, image.title, image.fileName].filter(Boolean).join(' ');
}

function hasVisibleTextEvidence(task, field, value) {
  const evidence = task.fieldEvidence?.[field];
  if (!Array.isArray(evidence) || !evidence.length) return false;
  const expected = String(value || '').toLowerCase();
  return evidence.some((item) => {
    const text = String(item.text || item.value || '').toLowerCase();
    return item.source === 'visible_text' && (!expected || text.includes(expected));
  });
}

function hasAnyEvidence(task, field, value) {
  const evidence = task.fieldEvidence?.[field];
  if (!Array.isArray(evidence) || !evidence.length) return false;
  if (!value) return true;
  const expected = String(value || '').toLowerCase();
  return evidence.some((item) => {
    const text = String(item.text || item.value || '').toLowerCase();
    return !expected || text.includes(expected);
  });
}

function categoryFromTask(task = {}) {
  return task.categoryId || task.targets?.[0]?.categoryId || task.targets?.[0]?.category;
}

function textContainsAny(text, values = []) {
  const normalized = String(text || '').toLowerCase();
  return asArray(values).some((value) => normalized.includes(String(value).toLowerCase()));
}

export function runRuleBasedReviewChecks({ task = {}, image = {}, plan = {}, generationRequest = null } = {}) {
  const issues = [];
  const text = collectImageText({ image, plan });
  const imageType = image.type || plan.type || generationRequest?.imageType;
  const platformId = task.platformId || plan.platformId || plan.platform || task.platform || generationRequest?.platform;
  const platformRule = platformRuleSnapshotForImage({ platformId, imageType, language: plan.language || task.language });
  const categoryRule = generationRequest?.categoryRuleSnapshot || categoryRuleSnapshotForImage({
    categoryId: categoryFromTask(task),
    imageType,
    productInfoConfirmed: task.productInfoConfirmed || task.productInfo || {}
  });
  const meta = (category, type) => ({
    category,
    ruleId: `${platformRule.platformId}.${imageType}.${type}`,
    platformId: platformRule.platformId,
    imageType,
    categoryId: categoryRule.categoryId
  });
  const categoryMeta = (type, level = 'high') => ({
    category: 'category',
    ruleId: `${categoryRule.categoryId}.${imageType}.${type}`,
    platformId: platformRule.platformId,
    imageType,
    categoryId: categoryRule.categoryId,
    fixSuggestion: level === 'high'
      ? 'Remove the claim or add visible/user-confirmed evidence before using it in image copy.'
      : 'Use a narrower confirmed claim or ask the seller to confirm the detail.'
  });
  const textLayout = image.textLayout || plan.textLayout || plan.textLayoutOverride;

  if (image.isMockPreview || image.provider === 'mock') {
    issues.push(issue('mock_preview', getRuleSeverity({ platformId, imageType, issueType: 'sourceMock' }), 'Mock preview image cannot be used as a final marketplace upload.', [image.fileName], meta('source', 'sourceMock')));
  }
  if (image.fallbackToMock) {
    issues.push(issue('fallback_mock', 'medium', 'Real generation failed and this image fell back to mock preview.', [image.realGenerationError?.message || 'fallback mock'], meta('source', 'fallbackMock')));
  }
  if (image.realGenerationMode === 'text_to_image' || image.productGeneratedByAI) {
    issues.push(issue('subject_preserve_risk', 'high', 'Text-to-image generation does not guarantee product appearance fidelity.', [], meta('source', 'subjectPreserve')));
  }
  if (image.preserveQuality?.subjectPreserveRisk === 'high') {
    issues.push(issue('subject_preserve_risk', 'high', 'Product subject preserve risk is high.', [], meta('source', 'subjectPreserve')));
  }

  if (isTextAllowed({ platformId, imageType }) === false && asArray(plan.textBlocks).length) {
    issues.push(issue('main_image_text', getRuleSeverity({ platformId, imageType, issueType: 'text' }), 'This image type does not allow text blocks under platform rules.', [], meta('platform', 'text')));
  }
  if (imageType === 'main_image' && image.realGenerationMode === 'text_to_image') {
    issues.push(issue('main_image_scene_background', getRuleSeverity({ platformId, imageType, issueType: 'nonWhiteBackground' }), 'Main image appears to use generated scene background.', [], meta('platform', 'background')));
  }

  if (chinesePattern.test(text)) issues.push(issue('chinese_text', getRuleSeverity({ platformId, imageType, issueType: 'chineseText' }), 'Chinese text detected or planned in image text.', [text.match(chinesePattern)?.[0] || 'Chinese text'], meta('text', 'chineseText')));
  if (pricePattern.test(text)) issues.push(issue('price_text', getRuleSeverity({ platformId, imageType, issueType: 'price' }), 'Price text detected or planned in image.', [text], meta('text', 'price')));
  if (promotionPattern.test(text)) issues.push(issue('promotion_text', getRuleSeverity({ platformId, imageType, issueType: 'promotion' }), 'Promotion or marketplace-sensitive text detected.', [text], meta('text', 'promotion')));
  if (certificationPattern.test(text)) issues.push(issue('unconfirmed_certification_or_claim', getRuleSeverity({ platformId, imageType, issueType: 'unconfirmedCertification' }), 'Certification, warranty, waterproof, medical, or health claim needs explicit confirmation.', [text], meta('evidence', 'unconfirmedCertification')));

  for (const candidate of asArray(task.inferredCandidates)) {
    const value = String(candidate.value || '');
    if (value && text.toLowerCase().includes(value.toLowerCase())) {
      issues.push(issue('inferred_candidate_used', 'high', `Unconfirmed inferred candidate used in image text: ${value}`, [value], meta('evidence', 'inferredCandidate')));
    }
  }
  for (const value of asArray(task.productInfoConfirmed?.capacity)) {
    if (text.toLowerCase().includes(String(value).toLowerCase()) && !hasVisibleTextEvidence(task, 'capacity', value)) {
      issues.push(issue('unconfirmed_capacity', getRuleSeverity({ platformId, imageType, issueType: 'unconfirmedCapacity' }), `Capacity "${value}" appears without visible text evidence.`, [value], meta('evidence', 'unconfirmedCapacity')));
    }
  }

  if (categoryRule.categoryId === 'electronics_storage' || categoryRule.categoryId === 'electronics_general') {
    for (const value of asArray(task.productInfoConfirmed?.capacity)) {
      if (value && text.toLowerCase().includes(String(value).toLowerCase()) && !hasVisibleTextEvidence(task, 'capacity', value)) {
        issues.push(issue('category_unconfirmed_capacity', 'high', `Electronics storage capacity "${value}" needs visible text evidence.`, [value], categoryMeta('capacity')));
      }
    }
    if (/\b(up to\s*)?\d{2,5}\s?(mb\/s|gb\/s|m\/s)|transfer speed|ultra fast|guaranteed speed\b/i.test(text) && !hasVisibleTextEvidence(task, 'speed')) {
      issues.push(issue('category_unconfirmed_speed', 'high', 'Electronics speed or transfer-rate claim appears without visible evidence.', [text], categoryMeta('speed')));
    }
    if (/\b(universal compatibility|all devices|wide compatibility)\b/i.test(text) && !hasAnyEvidence(task, 'compatibleDevices')) {
      issues.push(issue('category_universal_compatibility', 'medium', 'Broad compatibility claim appears without clear evidence.', [text], categoryMeta('compatibility', 'medium')));
    }
    if (/\b(warranty|guarantee|5-year warranty|year warranty)\b/i.test(text) && !hasVisibleTextEvidence(task, 'warranty')) {
      issues.push(issue('category_unconfirmed_warranty', 'high', 'Warranty or guarantee claim appears without visible evidence.', [text], categoryMeta('warranty')));
    }
    if (/\b(ce|fcc|rohs|fda)\s*(certified|certification|approved)?\b/i.test(text) && !hasVisibleTextEvidence(task, 'certifications')) {
      issues.push(issue('category_unconfirmed_certification', 'high', 'Certification claim appears without visible evidence.', [text], categoryMeta('certifications')));
    }
    if (/\b(waterproof|shockproof|drop proof|military grade)\b/i.test(text) && !hasVisibleTextEvidence(task, 'waterproof') && !hasVisibleTextEvidence(task, 'shockproof')) {
      issues.push(issue('category_unconfirmed_durability_claim', 'high', 'Waterproof, shockproof, drop-proof, or military-grade claim appears without visible evidence.', [text], categoryMeta('durability')));
    }
    if (imageType === 'package_image' && !asArray(task.productInfoConfirmed?.packageIncluded || task.productInfoConfirmed?.packageList).length) {
      issues.push(issue('category_missing_package_confirmation', 'medium', 'Package image requires confirmed package contents.', [], categoryMeta('packageIncluded', 'medium')));
    }
    if (imageType === 'size_image' && !asArray(task.productInfoConfirmed?.dimensions || task.productInfoConfirmed?.sizes || task.productInfoConfirmed?.visibleSpecs).length) {
      issues.push(issue('category_missing_size_confirmation', 'medium', 'Size image requires confirmed dimensions or visible specs.', [], categoryMeta('dimensions', 'medium')));
    }
    if (imageType === 'compatibility_image' && /\ball devices\b/i.test(text)) {
      issues.push(issue('category_overbroad_compatibility', 'medium', 'Compatibility image should not generalize to all devices.', [text], categoryMeta('compatibility', 'medium')));
    }
  }

  for (const claim of categoryRule.forbiddenClaimsWithoutEvidence || []) {
    if (claim && textContainsAny(text, [claim]) && !hasAnyEvidence(task, 'certifications') && !hasAnyEvidence(task, 'warranty') && !hasAnyEvidence(task, 'speed')) {
      issues.push(issue('category_forbidden_claim_without_evidence', 'high', `Category claim requires evidence before use: ${claim}`, [claim], categoryMeta('forbiddenClaim')));
    }
  }

  for (const blocking of asArray(textLayout?.blockingIssues)) {
    issues.push(issue('text_layout_blocking_issue', 'high', blocking.message || blocking.code || 'Text layout blocking issue', [blocking.text || blocking.code || ''], meta('layout', 'textLayoutBlocking')));
  }
  for (const warning of asArray(textLayout?.warnings)) {
    issues.push(issue('text_layout_warning', 'medium', warning.message || warning.code || 'Text layout warning', [warning.text || warning.code || ''], meta('layout', 'textLayoutWarning')));
  }
  if (asArray(textLayout?.textElements).filter((item) => item.visible !== false).length > 8) {
    issues.push(issue('too_much_text', 'medium', 'Image may contain too much text for clear marketplace reading.', [], meta('layout', 'tooMuchText')));
  }
  if (asArray(textLayout?.textElements).some((item) => Number(item.fontSize || 0) < 22 && item.visible !== false)) {
    issues.push(issue('small_text', 'medium', 'Some rendered text may be too small.', [], meta('layout', 'smallText')));
  }
  const forbidden = getForbiddenElements({ platformId, imageType });

  const riskLevel = issues.reduce((level, item) => maxRiskLevel(level, item.level), 'low');
  const pass = issues.length === 0;
  return normalizeReviewResult({
    pass,
    riskLevel,
    issues,
    fixSuggestions: issues.map((item) => `Fix: ${item.message}`),
    platformChecks: {
      mainImageTextAllowed: !(imageType === 'main_image' && asArray(plan.textBlocks).length),
      backgroundValid: true,
      watermarkDetected: false,
      platformRuleSnapshot: platformRule,
      categoryRuleSnapshot: categoryRule,
      forbiddenElements: forbidden
    },
    visualChecks: {
      productVisible: null,
      productDistortedRisk: image.preserveQuality?.subjectPreserveRisk || 'unknown',
      backgroundRisk: image.backgroundType === 'complex' ? 'medium' : 'low'
    },
    textChecks: {
      hasChinese: chinesePattern.test(text),
      hasPrice: pricePattern.test(text),
      hasPromotion: promotionPattern.test(text),
      hasUnconfirmedSpecs: issues.some((item) => ['unconfirmed_capacity', 'inferred_candidate_used'].includes(item.type))
    },
    sourceChecks: {
      isMockPreview: Boolean(image.isMockPreview || image.provider === 'mock'),
      isRealGenerated: Boolean(image.isRealGenerated),
      fallbackToMock: Boolean(image.fallbackToMock),
      realGenerationMode: image.realGenerationMode || (image.isRealGenerated ? 'real' : 'mock')
    },
    evidenceChecks: {
      unconfirmedCapacityUsed: issues.some((item) => (
        item.type === 'unconfirmed_capacity' ||
        item.type === 'inferred_candidate_used' ||
        (item.type === 'text_layout_blocking_issue' && /capacity|5tb|unconfirmed/i.test(`${item.message} ${item.evidence?.join(' ')}`))
      )),
      unconfirmedCertificationUsed: issues.some((item) => item.type === 'unconfirmed_certification_or_claim')
    },
    notes: [
      image.isRealGenerated ? 'Real generated image still requires human review before marketplace upload.' : '',
      image.isMockPreview ? 'Mock preview cannot be used as final marketplace upload.' : ''
    ].filter(Boolean)
  });
}

export function mergeReviewData(ruleData, visionData = null) {
  if (!visionData) return ruleData;
  const normalizedVision = normalizeReviewResult(visionData);
  const issues = [...asArray(ruleData.issues), ...asArray(normalizedVision.issues)];
  const riskLevel = issues.reduce((level, item) => maxRiskLevel(level, item.level), maxRiskLevel(ruleData.riskLevel, normalizedVision.riskLevel));
  return normalizeReviewResult({
    pass: Boolean(ruleData.pass && normalizedVision.pass && !issues.some((item) => item.level === 'high')),
    riskLevel,
    issues,
    fixSuggestions: [...asArray(ruleData.fixSuggestions), ...asArray(normalizedVision.fixSuggestions)],
    platformChecks: { ...ruleData.platformChecks, ...normalizedVision.platformChecks },
    visualChecks: { ...ruleData.visualChecks, ...normalizedVision.visualChecks },
    textChecks: {
      ...ruleData.textChecks,
      ...normalizedVision.textChecks,
      hasChinese: Boolean(ruleData.textChecks?.hasChinese || normalizedVision.textChecks?.hasChinese),
      hasPrice: Boolean(ruleData.textChecks?.hasPrice || normalizedVision.textChecks?.hasPrice),
      hasPromotion: Boolean(ruleData.textChecks?.hasPromotion || normalizedVision.textChecks?.hasPromotion),
      hasUnconfirmedSpecs: Boolean(ruleData.textChecks?.hasUnconfirmedSpecs || normalizedVision.textChecks?.hasUnconfirmedSpecs)
    },
    sourceChecks: {
      ...ruleData.sourceChecks,
      ...normalizedVision.sourceChecks,
      isMockPreview: Boolean(ruleData.sourceChecks?.isMockPreview || normalizedVision.sourceChecks?.isMockPreview),
      isRealGenerated: Boolean(ruleData.sourceChecks?.isRealGenerated || normalizedVision.sourceChecks?.isRealGenerated),
      fallbackToMock: Boolean(ruleData.sourceChecks?.fallbackToMock || normalizedVision.sourceChecks?.fallbackToMock)
    },
    evidenceChecks: {
      ...ruleData.evidenceChecks,
      ...normalizedVision.evidenceChecks,
      unconfirmedCapacityUsed: Boolean(ruleData.evidenceChecks?.unconfirmedCapacityUsed || normalizedVision.evidenceChecks?.unconfirmedCapacityUsed),
      unconfirmedCertificationUsed: Boolean(ruleData.evidenceChecks?.unconfirmedCertificationUsed || normalizedVision.evidenceChecks?.unconfirmedCertificationUsed)
    },
    notes: [...asArray(ruleData.notes), ...asArray(normalizedVision.notes)]
  });
}
