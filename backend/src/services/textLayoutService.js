import { categoryRuleSnapshotForImage } from '../rules/categoryRuleUtils.js';

export const TEXT_LAYOUT_VERSION = 'v2.9';

const PROGRAMMATIC_TYPES = new Set([
  'feature_image',
  'size_image',
  'compatibility_image',
  'package_image',
  'variant_image'
]);

const PROMOTION_PATTERN = /\b(price|sale|discount|off|coupon|deal|best seller|no\.?\s*1|limited time|free shipping)\b|[$€£¥]\s?\d+|\d+\s?%/i;
const CHINESE_PATTERN = /[\u3400-\u9fff]/;
const CERTIFICATION_PATTERN = /\b(fda|ce|fcc|rohs|certified|certification|warranty|guarantee)\b/i;

function asArray(value) {
  if (Array.isArray(value)) return value.filter((item) => item !== null && item !== undefined && String(item).trim() !== '');
  if (value === null || value === undefined || value === '') return [];
  return [value];
}

function unique(values) {
  return [...new Set(asArray(values).flatMap((item) => asArray(item)).map((item) => String(item).trim()).filter(Boolean))];
}

function productInfo(task = {}) {
  return task.productInfoConfirmed || task.productInfo || {};
}

function fieldEvidence(task = {}, field) {
  const value = task.fieldEvidence?.[field];
  return Array.isArray(value) ? value : [];
}

function hasVisibleTextEvidence(task, field, expectedValue) {
  const evidence = fieldEvidence(task, field);
  if (!evidence.length) return false;
  if (!expectedValue) return evidence.some((item) => item.source === 'visible_text');
  const expected = String(expectedValue).toLowerCase();
  return evidence.some((item) => {
    const source = String(item.source || '').toLowerCase();
    const text = String(item.text || item.value || '').toLowerCase();
    return source === 'visible_text' && (!expected || text.includes(expected));
  });
}

function addWarning(layout, code, message, details = {}) {
  layout.warnings.push({ code, message, ...details });
}

function addBlocking(layout, code, message, details = {}) {
  layout.blockingIssues.push({ code, message, ...details });
}

function textBlockText(block) {
  return String(block?.text || '').trim();
}

function blockSourceField(block) {
  return block?.sourceField || block?.sourceFields?.[0] || block?.sourceFields?.[0]?.field || '';
}

function categoryClaimNeedsEvidence(value, sourceField, evidenceStatus, categoryRule = {}) {
  const text = String(value || '');
  const status = String(evidenceStatus || '').toLowerCase();
  if (/confirmed|visible_text|has_visible_text/.test(status)) return false;
  const required = categoryRule.evidenceRequiredFields || {};
  if (sourceField && required[sourceField]) return true;
  if (/\b(up to\s*)?\d{2,5}\s?(mb\/s|gb\/s)|transfer speed|ultra fast|guaranteed speed\b/i.test(text)) return true;
  if (/\b(warranty|guarantee)\b/i.test(text)) return true;
  if (/\b(ce|fcc|rohs|fda)\b/i.test(text)) return true;
  if (/\b(universal compatibility|all devices|wide compatibility)\b/i.test(text)) return true;
  if (/\b(waterproof|shockproof|drop proof|military grade)\b/i.test(text)) return true;
  return (categoryRule.forbiddenClaimsWithoutEvidence || []).some((claim) => text.toLowerCase().includes(String(claim).toLowerCase()));
}

function validateText(text, { layout, sourceField, evidenceStatus, categoryRule }) {
  const value = String(text || '').trim();
  if (!value) return { ok: false, reason: 'empty' };
  if (CHINESE_PATTERN.test(value)) {
    addWarning(layout, 'TEXT_FILTERED_CHINESE', 'Chinese text was excluded from marketplace image copy.', { text: value });
    return { ok: false, reason: 'chinese_text' };
  }
  if (PROMOTION_PATTERN.test(value)) {
    addWarning(layout, 'TEXT_FILTERED_PROMOTION', 'Price, discount, promotion, or marketplace-sensitive wording was excluded.', { text: value });
    return { ok: false, reason: 'promotion_or_price' };
  }
  if (CERTIFICATION_PATTERN.test(value) && evidenceStatus !== 'confirmed') {
    addWarning(layout, 'TEXT_FILTERED_UNCONFIRMED_CERTIFICATION', 'Unconfirmed certification or warranty text was excluded.', { text: value });
    return { ok: false, reason: 'unconfirmed_certification' };
  }
  if (sourceField === 'capacity' && evidenceStatus !== 'confirmed') {
    addWarning(layout, 'TEXT_FILTERED_UNCONFIRMED_CAPACITY', 'Unconfirmed capacity text was excluded.', { text: value });
    return { ok: false, reason: 'unconfirmed_capacity' };
  }
  if (categoryClaimNeedsEvidence(value, sourceField, evidenceStatus, categoryRule)) {
    addWarning(layout, 'TEXT_FILTERED_CATEGORY_EVIDENCE_REQUIRED', 'Category rule excluded a high-risk claim without evidence.', { text: value, sourceField, categoryId: categoryRule?.categoryId });
    return { ok: false, reason: 'category_evidence_required' };
  }
  return { ok: true };
}

function blockingCodeForReason(reason) {
  if (reason === 'chinese_text') return 'TEXT_BLOCKED_CHINESE';
  if (reason === 'promotion_or_price') return 'TEXT_BLOCKED_PROMOTION';
  if (reason === 'unconfirmed_capacity') return 'TEXT_BLOCKED_UNCONFIRMED_CAPACITY';
  if (reason === 'unconfirmed_certification') return 'TEXT_BLOCKED_UNCONFIRMED_CERTIFICATION';
  return 'TEXT_BLOCKED_UNSAFE';
}

function applyElementDefaults(element = {}, index = 0, zIndexBase = 1) {
  return {
    ...element,
    id: element.id || `layout-element-${index + 1}`,
    locked: Boolean(element.locked),
    visible: element.visible !== false,
    zIndex: Number.isFinite(Number(element.zIndex)) ? Number(element.zIndex) : zIndexBase + index,
    editable: element.editable !== false,
    editedByUser: Boolean(element.editedByUser),
    editedAt: element.editedAt || null
  };
}

function decorateLayoutElements(layout, { editedByUser = false, editedAt = null } = {}) {
  layout.textElements = asArray(layout.textElements).map((item, index) => ({
    ...applyElementDefaults(item, index, 1),
    editedByUser: Boolean(item.editedByUser || editedByUser),
    editedAt: item.editedAt || editedAt
  }));
  layout.iconElements = asArray(layout.iconElements).map((item, index) => ({
    ...applyElementDefaults(item, index, 100),
    editedByUser: Boolean(item.editedByUser || editedByUser),
    editedAt: item.editedAt || editedAt
  }));
  layout.lineElements = asArray(layout.lineElements).map((item, index) => ({
    ...applyElementDefaults(item, index, 50),
    editedByUser: Boolean(item.editedByUser || editedByUser),
    editedAt: item.editedAt || editedAt
  }));
  return layout;
}

function makeTextElement({ id, text, role, x, y, width, height = 72, fontSize = 42, fontWeight = 700, align = 'left', language = 'English', sourceField, evidenceStatus = 'confirmed', riskLevel = 'low' }) {
  return applyElementDefaults({
    id,
    text,
    role,
    x,
    y,
    width,
    height,
    fontSize,
    fontWeight,
    align,
    language,
    sourceField,
    evidenceStatus,
    riskLevel
  });
}

function pushSafeText(layout, block, position, fallbackRole = 'bullet', context = {}) {
  const text = textBlockText(block);
  const sourceField = blockSourceField(block);
  const evidenceStatus = block.evidenceStatus || block.evidence || 'confirmed';
  const validation = validateText(text, { layout, sourceField, evidenceStatus, categoryRule: context.categoryRule });
  if (!validation.ok) {
    layout.excludedTextBlocks.push({
      id: block.id || `excluded-${layout.excludedTextBlocks.length + 1}`,
      text,
      reason: validation.reason,
      sourceField
    });
    return false;
  }
  layout.textElements.push(makeTextElement({
    id: block.id || `text-${layout.textElements.length + 1}`,
    text,
    role: block.role || fallbackRole,
    sourceField,
    evidenceStatus,
    ...position
  }));
  return true;
}

function baseLayout(imageType) {
  return {
    layoutVersion: TEXT_LAYOUT_VERSION,
    imageType,
    canvas: {
      width: 1600,
      height: 1600,
      background: imageType === 'feature_image' ? '#f8fbff' : '#ffffff'
    },
    productArea: {
      x: 500,
      y: 420,
      width: 600,
      height: 560,
      placement: 'center'
    },
    textElements: [],
    iconElements: [],
    lineElements: [],
    warnings: [],
    blockingIssues: [],
    excludedTextBlocks: [],
    layoutSource: 'auto',
    layoutEditedByUser: false,
    layoutEditedAt: null
  };
}

function headline(layout, text, sourceField = 'productName') {
  if (!text) return;
  layout.textElements.push(makeTextElement({
    id: 'headline',
    text: String(text),
    role: 'headline',
    x: 150,
    y: 120,
    width: 1300,
    height: 92,
    fontSize: 58,
    fontWeight: 800,
    align: 'center',
    sourceField
  }));
}

function featureLayout(layout, task, plan, context = {}) {
  const info = productInfo(task);
  headline(layout, plan.title || info.productName || info.name || 'Key Features', 'title');
  const blocks = [...asArray(plan.textBlocks)];
  for (const point of unique(info.sellingPoints || []).slice(0, 5)) {
    blocks.push({ text: point, role: 'bullet', sourceField: 'sellingPoints', evidenceStatus: 'confirmed' });
  }
  if (!blocks.length && info.visibleSpecs) {
    for (const spec of unique(info.visibleSpecs).slice(0, 4)) blocks.push({ text: spec, role: 'bullet', sourceField: 'visibleSpecs', evidenceStatus: 'confirmed' });
  }
  const positions = [
    { x: 130, y: 430, width: 420 },
    { x: 1050, y: 430, width: 420 },
    { x: 130, y: 720, width: 420 },
    { x: 1050, y: 720, width: 420 },
    { x: 590, y: 1110, width: 420, align: 'center' }
  ];
  let rendered = 0;
  for (const block of blocks) {
    if (rendered >= 5) break;
    if (pushSafeText(layout, block, { ...positions[rendered], fontSize: 34, height: 90 }, 'bullet', context)) {
      layout.iconElements.push({
        id: `feature-icon-${rendered + 1}`,
        type: 'feature_dot',
        label: textBlockText(block).slice(0, 18),
        x: positions[rendered].x - 56,
        y: positions[rendered].y - 18,
        size: 42,
        sourceField: blockSourceField(block) || 'sellingPoints'
      });
      rendered += 1;
    }
  }
  if (!rendered) addBlocking(layout, 'MISSING_SELLING_POINTS', 'Missing confirmed selling points or specs for feature image.');
}

function sizeLayout(layout, task, plan) {
  const info = productInfo(task);
  headline(layout, 'Dimensions & Specs', 'dimensions');
  const values = unique([
    ...asArray(info.dimensions),
    ...asArray(info.sizes),
    ...asArray(info.size),
    ...asArray(info.visibleSpecs)
  ]).slice(0, 5);
  if (!values.length) addBlocking(layout, 'MISSING_DIMENSIONS', 'Missing dimensions or size information.');
  values.forEach((value, index) => {
    layout.textElements.push(makeTextElement({
      id: `spec-${index + 1}`,
      text: value,
      role: 'spec',
      x: 980,
      y: 460 + index * 110,
      width: 440,
      height: 80,
      fontSize: 34,
      sourceField: /x|\d/.test(value) ? 'dimensions' : 'visibleSpecs',
      evidenceStatus: 'confirmed'
    }));
    layout.lineElements.push({
      id: `callout-${index + 1}`,
      type: index === 0 ? 'dimension' : 'callout',
      x1: 820,
      y1: 520 + index * 95,
      x2: 960,
      y2: 500 + index * 110,
      label: value,
      sourceField: 'dimensions'
    });
  });
}

function compatibilityLayout(layout, task) {
  const info = productInfo(task);
  headline(layout, 'Compatibility', 'compatibleDevices');
  const devices = unique(info.compatibleDevices).slice(0, 6);
  if (!devices.length) addBlocking(layout, 'MISSING_COMPATIBLE_DEVICES', 'Missing confirmed compatible devices.');
  if (devices.length && !hasVisibleTextEvidence(task, 'compatibleDevices')) {
    addWarning(layout, 'WEAK_COMPATIBILITY_EVIDENCE', 'Compatible device copy has weak image evidence; manual confirmation recommended.');
  }
  devices.forEach((device, index) => {
    const x = 220 + (index % 3) * 390;
    const y = 1000 + Math.floor(index / 3) * 170;
    layout.iconElements.push({ id: `device-${index + 1}`, type: deviceIconType(device), label: device, x, y, size: 96, sourceField: 'compatibleDevices' });
    layout.textElements.push(makeTextElement({
      id: `device-label-${index + 1}`,
      text: device,
      role: 'label',
      x: x - 60,
      y: y + 115,
      width: 220,
      height: 60,
      fontSize: 28,
      align: 'center',
      sourceField: 'compatibleDevices',
      evidenceStatus: hasVisibleTextEvidence(task, 'compatibleDevices') ? 'confirmed' : 'needs_confirmation',
      riskLevel: hasVisibleTextEvidence(task, 'compatibleDevices') ? 'low' : 'medium'
    }));
  });
}

function deviceIconType(device) {
  const value = String(device).toLowerCase();
  if (value.includes('phone')) return 'phone';
  if (value.includes('tablet')) return 'tablet';
  if (value.includes('tv')) return 'tv';
  if (value.includes('game')) return 'game_console';
  if (value.includes('desktop') || value.includes('pc')) return 'desktop';
  return 'laptop';
}

function packageLayout(layout, task) {
  const info = productInfo(task);
  headline(layout, 'Package Includes', 'packageIncluded');
  const items = unique([...(asArray(info.packageIncluded)), ...(asArray(info.packageList))]).slice(0, 8);
  if (!items.length) addBlocking(layout, 'MISSING_PACKAGE_INCLUDED', 'Missing confirmed package included list.');
  items.forEach((item, index) => {
    const x = 210 + (index % 2) * 610;
    const y = 450 + Math.floor(index / 2) * 180;
    layout.iconElements.push({ id: `package-icon-${index + 1}`, type: 'package_item', label: item, x, y, size: 72, sourceField: 'packageIncluded' });
    layout.textElements.push(makeTextElement({
      id: `package-${index + 1}`,
      text: item,
      role: 'bullet',
      x: x + 100,
      y: y + 20,
      width: 420,
      height: 72,
      fontSize: 32,
      sourceField: 'packageIncluded'
    }));
  });
}

function variantLayout(layout, task) {
  const info = productInfo(task);
  headline(layout, 'Confirmed Variants', 'variants');
  const inferred = asArray(task.inferredCandidates).map((item) => ({ field: item.field, value: String(item.value || '') }));
  const capacity = unique(info.capacity).filter((value) => hasVisibleTextEvidence(task, 'capacity', value));
  const colors = unique([...(asArray(info.colors)), ...(asArray(info.color))]);
  const sizes = unique([...(asArray(info.sizes)), ...(asArray(info.size))]);
  const variants = [
    ...capacity.map((value) => ({ value, field: 'capacity' })),
    ...colors.map((value) => ({ value, field: 'colors' })),
    ...sizes.map((value) => ({ value, field: 'sizes' }))
  ].filter((item) => !inferred.some((candidate) => candidate.field === item.field && candidate.value.toLowerCase() === String(item.value).toLowerCase()));
  if (inferred.length) addWarning(layout, 'INFERRED_CANDIDATES_EXCLUDED', 'AI inferred candidates were excluded from variant text layout.');
  if (info.capacity && capacity.length < unique(info.capacity).length) {
    addWarning(layout, 'CAPACITY_WITHOUT_VISIBLE_EVIDENCE_EXCLUDED', 'Capacity values without visible text evidence were excluded.');
  }
  if (!variants.length) addBlocking(layout, 'MISSING_CONFIRMED_VARIANTS', 'Missing confirmed capacity, color, or size variants.');
  variants.slice(0, 8).forEach((item, index) => {
    const x = 190 + (index % 4) * 310;
    const y = 500 + Math.floor(index / 4) * 230;
    layout.textElements.push(makeTextElement({
      id: `variant-${index + 1}`,
      text: item.value,
      role: 'label',
      x,
      y,
      width: 250,
      height: 100,
      fontSize: 38,
      fontWeight: 800,
      align: 'center',
      sourceField: item.field,
      evidenceStatus: item.field === 'capacity' ? 'visible_text' : 'confirmed'
    }));
    layout.iconElements.push({ id: `variant-icon-${index + 1}`, type: 'variant_badge', label: item.field, x: x + 75, y: y - 85, size: 78, sourceField: item.field });
  });
}

export function isProgrammaticTextLayoutType(type) {
  return PROGRAMMATIC_TYPES.has(type);
}

export function buildTextLayout({ task, plan, generationRequest } = {}) {
  const type = plan?.type || generationRequest?.imageType;
  if (!isProgrammaticTextLayoutType(type)) return null;
  if (plan?.textLayoutOverride) {
    return normalizeTextLayoutOverride({ task, plan, textLayoutOverride: plan.textLayoutOverride });
  }
  const layout = baseLayout(type);
  const categoryRule = generationRequest?.categoryRuleSnapshot || generationRequest?.compliance?.categoryRuleSnapshot || categoryRuleSnapshotForImage({
    categoryId: task?.categoryId || task?.targets?.[0]?.categoryId || task?.targets?.[0]?.category,
    imageType: type,
    productInfoConfirmed: productInfo(task)
  });
  if (type === 'feature_image') featureLayout(layout, task, plan, { categoryRule });
  if (type === 'size_image') sizeLayout(layout, task, plan);
  if (type === 'compatibility_image') compatibilityLayout(layout, task, plan);
  if (type === 'package_image') packageLayout(layout, task, plan);
  if (type === 'variant_image') variantLayout(layout, task, plan);
  return decorateLayoutElements(layout);
}

export function normalizeTextLayoutOverride({ task, plan, textLayoutOverride } = {}) {
  const type = plan?.type || textLayoutOverride?.imageType;
  const layout = {
    ...baseLayout(type),
    ...(textLayoutOverride || {}),
    layoutVersion: TEXT_LAYOUT_VERSION,
    imageType: type,
    canvas: {
      ...baseLayout(type).canvas,
      ...(textLayoutOverride?.canvas || {})
    },
    productArea: {
      ...baseLayout(type).productArea,
      ...(textLayoutOverride?.productArea || {})
    },
    warnings: asArray(textLayoutOverride?.warnings),
    blockingIssues: asArray(textLayoutOverride?.blockingIssues),
    excludedTextBlocks: asArray(textLayoutOverride?.excludedTextBlocks),
    layoutSource: 'user_override',
    layoutEditedByUser: true,
    layoutEditedAt: textLayoutOverride?.layoutEditedAt || textLayoutOverride?.editedAt || new Date().toISOString()
  };
  decorateLayoutElements(layout, { editedByUser: true, editedAt: layout.layoutEditedAt });

  layout.textElements = layout.textElements.map((element) => {
    const validation = validateText(element.text, {
      layout,
      sourceField: element.sourceField,
      evidenceStatus: element.evidenceStatus,
      categoryRule: categoryRuleSnapshotForImage({
        categoryId: task?.categoryId || task?.targets?.[0]?.categoryId || task?.targets?.[0]?.category,
        imageType: type,
        productInfoConfirmed: productInfo(task)
      })
    });
    if (validation.ok) return element;
    const code = blockingCodeForReason(validation.reason);
    addBlocking(layout, code, 'Edited text was blocked by marketplace text safety rules.', {
      elementId: element.id,
      text: element.text,
      reason: validation.reason
    });
    return {
      ...element,
      visible: false,
      riskLevel: 'high'
    };
  });

  return layout;
}
