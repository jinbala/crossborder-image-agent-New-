import { createThrownProviderError } from './providerErrors.js';
import { getVisionRecognitionConfig } from './visionRecognitionConfig.js';

const productDefaults = {
  productName: null,
  category: null,
  brand: null,
  model: null,
  colors: [],
  sizes: [],
  capacity: [],
  material: null,
  interfaceType: null,
  compatibleDevices: [],
  dimensions: [],
  certifications: [],
  warranty: null,
  weight: null,
  packageIncluded: [],
  sellingPoints: [],
  useScenarios: [],
  targetUsers: [],
  visibleSpecs: []
};

const confidenceDefaults = {
  productName: 0,
  category: 0,
  brand: 0,
  model: 0,
  colors: 0,
  sizes: 0,
  capacity: 0,
  material: 0,
  interfaceType: 0,
  compatibleDevices: 0,
  dimensions: 0,
  packageIncluded: 0,
  sellingPoints: 0,
  visibleText: 0
};

const evidenceFields = [
  'productName',
  'category',
  'brand',
  'model',
  'colors',
  'capacity',
  'interfaceType',
  'compatibleDevices',
  'dimensions',
  'material',
  'packageIncluded',
  'certifications',
  'warranty',
  'sellingPoints',
  'visibleSpecs'
];

const strictVisibleTextEvidenceFields = ['capacity', 'certifications', 'warranty'];

const visibleTextPriorityPatterns = [
  /\b\d+(?:\.\d+)?\s?(?:tb|gb|mb|mah|ml|oz|kg|g|cm|mm|inch|in)\b/i,
  /\b(?:usb|usb-c|type-c|type c|lightning|thunderbolt|sata|nvme|pcie|interface)\b/i,
  /\b(?:size|dimension|length|width|height|weight|capacity|storage)\b/i,
  /\b(?:package|included|contains|box|cable|manual|adapter|accessory)\b/i,
  /\b(?:compatible|compatibility|pc|mac|laptop|desktop|phone|android|ios|windows)\b/i,
  /\b(?:watermark|price|discount|sale|promotion|coupon|certified|certification|ce|fcc|rohs)\b/i,
  /[\u4e00-\u9fff]/
];

function visibleTextLimitConfig(env = process.env) {
  const config = getVisionRecognitionConfig(env);
  return {
    perImage: config.visibleTextLimitPerImage,
    total: config.visibleTextTotalLimit
  };
}

function nullableString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function stringifyArrayItem(item) {
  if (typeof item === 'string') return item.trim();
  if (typeof item === 'number') return String(item);
  if (item && typeof item === 'object') {
    if (typeof item.text === 'string') return item.text.trim();
    if (typeof item.value === 'string') return item.value.trim();
    if (typeof item.name === 'string') return item.name.trim();
    if (typeof item.spec === 'string') return item.spec.trim();
  }
  return '';
}

function stringArray(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map(stringifyArrayItem)
    .filter(Boolean);
}

function fieldEvidenceDefaults() {
  return Object.fromEntries(evidenceFields.map((field) => [field, []]));
}

function clampConfidence(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.max(0, Math.min(1, number));
}

function normalizeVisibleTextItem(item) {
  if (typeof item === 'string') {
    return {
      text: item,
      language: '',
      locationHint: '',
      confidence: 0
    };
  }

  if (!item || typeof item !== 'object') {
    return null;
  }

  return {
    text: typeof item.text === 'string' ? item.text : '',
    language: typeof item.language === 'string' ? item.language : '',
    locationHint: typeof item.locationHint === 'string' ? item.locationHint : '',
    imageIndex: Number.isInteger(item.imageIndex) ? item.imageIndex : null,
    imageName: typeof item.imageName === 'string' ? item.imageName : '',
    confidence: clampConfidence(item.confidence)
  };
}

function visibleTextPriorityScore(item) {
  const text = item.text || '';
  let score = 0;
  visibleTextPriorityPatterns.forEach((pattern, index) => {
    if (pattern.test(text)) score += 100 - index;
  });
  score += Math.round((Number(item.confidence) || 0) * 10);
  return score;
}

function dedupeVisibleText(items) {
  const seen = new Set();
  return items.filter((item) => {
    const text = (item.text || '').trim();
    if (!text) return false;
    const key = `${item.imageIndex ?? ''}|${item.imageName || ''}|${text}`.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    item.text = text;
    return true;
  });
}

function limitVisibleText(items) {
  const config = visibleTextLimitConfig();
  const deduped = dedupeVisibleText(items);
  const originalCount = items.length;
  const groups = new Map();

  deduped.forEach((item, index) => {
    const key = Number.isInteger(item.imageIndex) ? item.imageIndex : `unknown-${item.imageName || 'none'}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ item, index, score: visibleTextPriorityScore(item) });
  });

  const perImageLimited = [];
  for (const group of groups.values()) {
    const kept = group
      .sort((a, b) => b.score - a.score || a.index - b.index)
      .slice(0, config.perImage)
      .sort((a, b) => a.index - b.index)
      .map((entry) => entry.item);
    perImageLimited.push(...kept);
  }

  const totalLimited = perImageLimited
    .map((item, index) => ({ item, index, score: visibleTextPriorityScore(item) }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, config.total)
    .sort((a, b) => a.index - b.index)
    .map((entry) => entry.item);

  return {
    items: totalLimited,
    summary: {
      visibleTextOriginalCount: originalCount,
      visibleTextDedupedCount: deduped.length,
      visibleTextKeptCount: totalLimited.length,
      visibleTextTruncated: totalLimited.length < originalCount,
      perImageLimit: config.perImage,
      totalLimit: config.total
    }
  };
}

function normalizeRiskItem(item) {
  if (typeof item === 'string') {
    return {
      type: item,
      level: 'medium',
      message: item,
      evidence: []
    };
  }

  if (!item || typeof item !== 'object') {
    return null;
  }

  const level = ['low', 'medium', 'high'].includes(item.level) ? item.level : 'medium';
  const evidence = Array.isArray(item.evidence) ? item.evidence.map(stringifyArrayItem).filter(Boolean) : [];
  return {
    type: typeof item.type === 'string' && item.type ? item.type : 'unknown',
    level,
    message: typeof item.message === 'string' ? item.message : '',
    evidence,
    imageIndex: Number.isInteger(item.imageIndex) ? item.imageIndex : null
  };
}

function normalizeEvidenceItem(item) {
  if (!item || typeof item !== 'object') return null;
  const source = ['visible_text', 'visual', 'inferred', 'user_input'].includes(item.source)
    ? item.source
    : 'inferred';
  return {
    source,
    imageIndex: Number.isInteger(item.imageIndex) ? item.imageIndex : null,
    imageName: typeof item.imageName === 'string' ? item.imageName : '',
    text: typeof item.text === 'string' ? item.text : '',
    reason: typeof item.reason === 'string' ? item.reason : '',
    value: stringifyArrayItem(item.value),
    confidence: clampConfidence(item.confidence)
  };
}

function normalizeFieldEvidence(value) {
  const defaults = fieldEvidenceDefaults();
  if (!value || typeof value !== 'object') return defaults;
  for (const field of evidenceFields) {
    if (Array.isArray(value[field])) {
      defaults[field] = value[field].map(normalizeEvidenceItem).filter(Boolean);
    }
  }
  return defaults;
}

function normalizeInferredCandidates(value) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => {
    if (typeof item === 'string') {
      return { field: 'unknown', value: item, reason: 'Model returned inferred candidate', evidence: [] };
    }
    if (!item || typeof item !== 'object') return null;
    return {
      field: typeof item.field === 'string' ? item.field : 'unknown',
      value: stringifyArrayItem(item.value),
      reason: typeof item.reason === 'string' ? item.reason : '',
      evidence: Array.isArray(item.evidence) ? item.evidence.map(stringifyArrayItem).filter(Boolean) : []
    };
  }).filter((item) => item?.value);
}

function evidenceMatchesValue(evidence, value) {
  const target = String(value || '').trim().toLowerCase();
  if (!target) return false;
  return evidence.some((item) => {
    const evidenceValue = String(item.value || '').toLowerCase();
    const evidenceText = String(item.text || '').toLowerCase();
    return evidenceValue === target || evidenceText.includes(target);
  });
}

function hasVisibleTextEvidenceForValue(fieldEvidence, field, value) {
  return evidenceMatchesValue((fieldEvidence[field] || []).filter((item) => item.source === 'visible_text'), value);
}

function normalizeColorValue(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z/\s-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function isLikelyMainBodyColor(value) {
  return /\b(?:black|gray|grey|dark|graphite|charcoal|silver|white)\b/i.test(normalizeColorValue(value));
}

function isLikelyAccentColor(value) {
  return /\b(?:orange|red|coral|yellow|gold|blue|green|purple|pink)\b/i.test(normalizeColorValue(value));
}

function evidenceForValue(fieldEvidence, field, value) {
  return (fieldEvidence[field] || []).filter((item) => evidenceMatchesValue([item], value));
}

function evidenceText(evidence) {
  return evidence.map((item) => `${item.reason || ''} ${item.text || ''} ${item.value || ''}`).join(' ').toLowerCase();
}

function hasBodyOrVariantEvidence(evidence) {
  return /\b(?:body|main product|product shell|whole product|full product|variant|option|available color|colour option|color option)\b/i.test(evidenceText(evidence));
}

function hasAccentEvidence(evidence) {
  return /\b(?:accent|trim|ring|port|connector|button|logo|text|title|label|icon|decorative|highlight|small detail|edge)\b/i.test(evidenceText(evidence));
}

function demoteAccentColors(productInfoRaw, fieldEvidence, inferredCandidates, notes) {
  const colors = Array.isArray(productInfoRaw.colors) ? productInfoRaw.colors : [];
  if (colors.length <= 1 || !colors.some(isLikelyMainBodyColor)) return;

  const kept = [];
  const demoted = [];

  for (const color of colors) {
    const evidence = evidenceForValue(fieldEvidence, 'colors', color);
    const isAccentOnly =
      isLikelyAccentColor(color) &&
      (hasAccentEvidence(evidence) ||
        (!hasVisibleTextEvidenceForValue(fieldEvidence, 'colors', color) && !hasBodyOrVariantEvidence(evidence)));

    if (isAccentOnly) demoted.push(color);
    else kept.push(color);
  }

  if (!kept.length || !demoted.length) return;

  productInfoRaw.colors = kept;
  fieldEvidence.colors = (fieldEvidence.colors || []).filter((item) => kept.some((color) => evidenceMatchesValue([item], color)));

  for (const color of demoted) {
    pushInferredCandidate(
      inferredCandidates,
      'colors',
      color,
      'Color appears to be an accent color, trim, text color, icon color, or connector detail rather than a confirmed product body color variant.'
    );
  }
  notes.push('Accent colors were demoted from confirmed colors and need manual confirmation if they are actual product variants.');
}

function addAutoVisibleTextEvidence(fieldEvidence, field, values, visibleText) {
  const list = Array.isArray(values) ? values : [values].filter(Boolean);
  for (const value of list) {
    if (hasVisibleTextEvidenceForValue(fieldEvidence, field, value)) continue;
    const match = visibleText.find((item) => String(item.text || '').toLowerCase().includes(String(value).toLowerCase()));
    if (match) {
      fieldEvidence[field].push({
        source: 'visible_text',
        imageIndex: match.imageIndex ?? null,
        imageName: match.imageName || '',
        text: match.text,
        reason: '',
        value: String(value),
        confidence: match.confidence || 0
      });
    }
  }
}

function pushInferredCandidate(inferredCandidates, field, value, reason) {
  if (!value) return;
  inferredCandidates.push({ field, value: String(value), reason, evidence: [] });
}

function enforceEvidenceConstraints(productInfoRaw, fieldEvidence, visibleText, inferredCandidates, notes) {
  for (const field of evidenceFields) {
    const value = productInfoRaw[field];
    if (Array.isArray(value)) addAutoVisibleTextEvidence(fieldEvidence, field, value, visibleText);
    else if (value) addAutoVisibleTextEvidence(fieldEvidence, field, [value], visibleText);
  }

  for (const field of strictVisibleTextEvidenceFields) {
    const value = productInfoRaw[field];
    const reason = `${field} requires visible text evidence before it can be used as a confirmed product field.`;

    if (Array.isArray(value)) {
      const kept = [];
      for (const item of value) {
        if (hasVisibleTextEvidenceForValue(fieldEvidence, field, item)) kept.push(item);
        else pushInferredCandidate(inferredCandidates, field, item, reason);
      }
      if (kept.length !== value.length) notes.push(reason);
      productInfoRaw[field] = kept;
    } else if (value && !hasVisibleTextEvidenceForValue(fieldEvidence, field, value)) {
      pushInferredCandidate(inferredCandidates, field, value, reason);
      productInfoRaw[field] = null;
      notes.push(reason);
    }
  }

  demoteAccentColors(productInfoRaw, fieldEvidence, inferredCandidates, notes);

  for (const field of evidenceFields) {
    const value = productInfoRaw[field];
    const hasValue = Array.isArray(value) ? value.length > 0 : Boolean(value);
    if (hasValue && !(fieldEvidence[field] || []).length) {
      notes.push(`${field} has no fieldEvidence and needs manual confirmation.`);
    }
  }
}

export function toLegacyProductInfo(productInfoRaw, visibleText = [], risks = []) {
  return {
    sku: '',
    name: productInfoRaw.productName || '',
    category: productInfoRaw.category || '',
    color: productInfoRaw.colors.join(', '),
    dimensions: (productInfoRaw.dimensions?.length ? productInfoRaw.dimensions : productInfoRaw.sizes).join(', '),
    capacity: productInfoRaw.capacity.join(', '),
    material: productInfoRaw.material || '',
    interfaceType: productInfoRaw.interfaceType || '',
    compatibleDevices: productInfoRaw.compatibleDevices,
    certifications: productInfoRaw.certifications,
    warranty: productInfoRaw.warranty || '',
    weight: productInfoRaw.weight || '',
    packageList: productInfoRaw.packageIncluded,
    imageText: visibleText.map((item) => item.text).filter(Boolean),
    sellingPoints: productInfoRaw.sellingPoints,
    riskItems: risks.map((item) => item.message || item.type).filter(Boolean),
    language: 'English',
    brand: productInfoRaw.brand,
    model: productInfoRaw.model,
    visibleSpecs: productInfoRaw.visibleSpecs
  };
}

export function normalizeVisionResult(parsed) {
  if (!parsed || typeof parsed !== 'object') {
    throw createThrownProviderError('NORMALIZE_ERROR', 'Vision result is not an object');
  }

  const rawProduct = parsed.productInfoRaw;
  if (!rawProduct || typeof rawProduct !== 'object') {
    throw createThrownProviderError('NORMALIZE_ERROR', 'Vision result is missing productInfoRaw');
  }

  const productInfoRaw = {
    productName: nullableString(rawProduct.productName ?? rawProduct.name),
    category: nullableString(rawProduct.category),
    brand: nullableString(rawProduct.brand),
    model: nullableString(rawProduct.model),
    colors: stringArray(rawProduct.colors ?? (rawProduct.color ? [rawProduct.color] : [])),
    sizes: stringArray(rawProduct.sizes ?? (rawProduct.dimensions ? [rawProduct.dimensions] : [])),
    capacity: stringArray(rawProduct.capacity == null ? [] : Array.isArray(rawProduct.capacity) ? rawProduct.capacity : [rawProduct.capacity]),
    material: nullableString(rawProduct.material),
    interfaceType: nullableString(rawProduct.interfaceType ?? rawProduct.interface),
    compatibleDevices: stringArray(rawProduct.compatibleDevices),
    dimensions: stringArray(rawProduct.dimensions ?? rawProduct.dimension),
    certifications: stringArray(rawProduct.certifications ?? rawProduct.certification),
    warranty: nullableString(rawProduct.warranty),
    weight: nullableString(rawProduct.weight),
    packageIncluded: stringArray(rawProduct.packageIncluded ?? rawProduct.packageList),
    sellingPoints: stringArray(rawProduct.sellingPoints),
    useScenarios: stringArray(rawProduct.useScenarios),
    targetUsers: stringArray(rawProduct.targetUsers),
    visibleSpecs: stringArray(rawProduct.visibleSpecs)
  };

  const rawVisibleText = Array.isArray(parsed.visibleText)
    ? parsed.visibleText.map(normalizeVisibleTextItem).filter(Boolean)
    : [];
  const visibleTextResult = limitVisibleText(rawVisibleText);
  const visibleText = visibleTextResult.items;
  const risks = Array.isArray(parsed.risks)
    ? parsed.risks.map(normalizeRiskItem).filter(Boolean)
    : [];
  const fieldEvidence = normalizeFieldEvidence(parsed.fieldEvidence);
  const inferredCandidates = normalizeInferredCandidates(parsed.inferredCandidates);

  const confidence = Object.fromEntries(
    Object.entries(confidenceDefaults).map(([key, defaultValue]) => [
      key,
      clampConfidence(parsed.confidence?.[key] ?? defaultValue)
    ])
  );

  const notes = stringArray(parsed.notes);
  if (visibleTextResult.summary.visibleTextTruncated) {
    notes.push(`visibleText truncated: original ${visibleTextResult.summary.visibleTextOriginalCount}, kept ${visibleTextResult.summary.visibleTextKeptCount}`);
    notes.push('OCR text summarized due to long content');
  }
  enforceEvidenceConstraints(productInfoRaw, fieldEvidence, visibleText, inferredCandidates, notes);

  return {
    productInfoRaw: { ...productDefaults, ...productInfoRaw },
    visibleText,
    risks,
    confidence,
    notes: notes.slice(0, 10),
    ocrSummary: visibleTextResult.summary,
    fieldEvidence,
    inferredCandidates
  };
}
