import {
  applyImageTemplateStyle,
  getImageTemplateStyle,
  recognitionQualityBlockedFields,
  sanitizeMarketplaceTextBlocks
} from '../services/imageTemplateStyleService.js';

export const PROMPT_VERSION = 'v1.5';

const PLAN_DEFINITIONS = [
  {
    type: 'main_image',
    title: 'Platform Main Image',
    goal: 'Create a compliant primary marketplace image focused only on the confirmed product.'
  },
  {
    type: 'feature_image',
    title: 'Core Selling Points Image',
    goal: 'Present confirmed buyer benefits with concise marketplace-safe text.'
  },
  {
    type: 'size_image',
    title: 'Size and Specification Image',
    goal: 'Show confirmed dimensions, capacity, ports, and visible specifications without inventing parameters.'
  },
  {
    type: 'compatibility_image',
    title: 'Compatibility Image',
    goal: 'Explain confirmed device or interface compatibility without broad unsupported claims.'
  },
  {
    type: 'package_image',
    title: 'Package Included Image',
    goal: 'Show only confirmed package contents and accessories.'
  },
  {
    type: 'lifestyle_image',
    title: 'Lifestyle Image',
    goal: 'Show a realistic use scenario while preserving the exact product appearance.'
  },
  {
    type: 'detail_image',
    title: 'Product Detail Image',
    goal: 'Highlight confirmed visible details such as texture, ports, materials, and finish.'
  },
  {
    type: 'variant_image',
    title: 'Variant Image',
    goal: 'Show confirmed color, capacity, or specification variants only when they are user-confirmed and safe.'
  }
];

const HIGH_RISK_TEXT_FIELDS = new Set(['capacity', 'certifications', 'warranty']);
const STRICT_EVIDENCE_FIELDS = new Set([
  'capacity',
  'dimensions',
  'material',
  'interfaceType',
  'compatibleDevices',
  'packageIncluded',
  'certifications',
  'warranty',
  'model',
  'brand'
]);

function asArray(value) {
  if (Array.isArray(value)) return value.filter((item) => item !== null && item !== undefined && String(item).trim() !== '');
  if (value === null || value === undefined || value === '') return [];
  return [value];
}

function unique(values) {
  return [...new Set(asArray(values).map((item) => String(item).trim()).filter(Boolean))];
}

function valueForField(productInfo, field) {
  const aliases = {
    productName: ['productName', 'name'],
    colors: ['colors', 'color'],
    dimensions: ['dimensions', 'sizes', 'size'],
    packageIncluded: ['packageIncluded', 'packageList'],
    compatibleDevices: ['compatibleDevices'],
    sellingPoints: ['sellingPoints'],
    visibleSpecs: ['visibleSpecs'],
    certifications: ['certifications'],
    capacity: ['capacity'],
    material: ['material'],
    interfaceType: ['interfaceType'],
    warranty: ['warranty'],
    brand: ['brand'],
    model: ['model'],
    category: ['category'],
    weight: ['weight']
  };
  const keys = aliases[field] || [field];
  for (const key of keys) {
    if (productInfo[key] !== undefined && productInfo[key] !== null && productInfo[key] !== '') {
      return productInfo[key];
    }
  }
  return Array.isArray(productInfo[field]) ? [] : '';
}

function evidenceFor(fieldEvidence = {}, field) {
  const evidence = fieldEvidence[field];
  return Array.isArray(evidence) ? evidence : [];
}

function evidenceSources(evidence = []) {
  return [...new Set(evidence.map((item) => item.source).filter(Boolean))];
}

function evidenceStatus(field, productInfo, fieldEvidence = {}) {
  const values = unique(valueForField(productInfo, field));
  const evidence = evidenceFor(fieldEvidence, field);
  const sources = evidenceSources(evidence);
  const hasVisibleText = sources.includes('visible_text');
  const onlyVisual = evidence.length > 0 && sources.every((source) => source === 'visual');
  const onlyInferred = evidence.length > 0 && sources.every((source) => source === 'inferred');
  let status = evidence.length ? 'has_evidence' : 'needs_confirmation';
  let riskLevel = evidence.length ? 'low' : 'medium';
  let message = evidence.length ? '有图片证据' : '需人工确认';

  if (!values.length) {
    return { field, values, evidence, sources, status: 'missing', riskLevel: 'medium', message: '缺少信息，建议补充' };
  }

  if (HIGH_RISK_TEXT_FIELDS.has(field) && !hasVisibleText) {
    status = 'blocked_without_visible_text';
    riskLevel = 'high';
    message = `${field} 缺少图片文字证据，不应进入图片文案`;
  } else if (field === 'material' && onlyVisual) {
    status = 'visual_only';
    riskLevel = 'medium';
    message = '材质仅来自视觉判断，需人工确认';
  } else if (field === 'compatibleDevices' && (!evidence.length || onlyInferred)) {
    status = 'weak_compatibility';
    riskLevel = 'medium';
    message = '兼容设备缺少明确证据，避免宽泛兼容表述';
  } else if (onlyInferred) {
    status = 'inferred';
    riskLevel = 'high';
    message = 'AI 推测，不建议直接使用';
  } else if (!evidence.length && STRICT_EVIDENCE_FIELDS.has(field)) {
    status = 'needs_confirmation';
    riskLevel = 'medium';
    message = `${field} 需要人工确认`;
  }

  return { field, values, evidence, sources, status, riskLevel, message };
}

function canUseInText(field, productInfo, fieldEvidence = {}) {
  const status = evidenceStatus(field, productInfo, fieldEvidence);
  if (!status.values.length) return { allowed: false, status };
  if (HIGH_RISK_TEXT_FIELDS.has(field) && status.status === 'blocked_without_visible_text') {
    return { allowed: false, status };
  }
  if (status.status === 'inferred') return { allowed: false, status };
  return { allowed: true, status };
}

function warning(field, message, level = 'medium') {
  return { field, level, message };
}

function textBlock(id, label, text, fields) {
  return { id, label, text, sourceFields: fields };
}

function summarizeEvidence(productInfo, fieldEvidence = {}) {
  const fields = [
    'productName',
    'category',
    'brand',
    'model',
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
  return Object.fromEntries(fields.map((field) => {
    const status = evidenceStatus(field, productInfo, fieldEvidence);
    return [field, {
      status: status.status,
      riskLevel: status.riskLevel,
      message: status.message,
      sources: status.sources,
      evidenceCount: status.evidence.length
    }];
  }));
}

function excludedFields(task = {}) {
  const inferred = Array.isArray(task.inferredCandidates) ? task.inferredCandidates : [];
  return inferred.map((item) => ({
    field: item.field || 'unknown',
    reason: item.reason || 'AI inferred candidate excluded from marketplace copy'
  }));
}

function platformMainImageNotes(target, rule) {
  const platformId = target.platformId || target.rulesSnapshot?.platformId;
  if (platformId === 'amazon') {
    return [
      'Amazon main image: pure white background, no text, no icons, no selling points, no scene background.',
      'Show only the confirmed product and necessary confirmed accessories.'
    ];
  }
  if (platformId === 'temu') {
    return ['Temu main image: clear simple product presentation, no Chinese text, no exaggerated claims.'];
  }
  if (platformId === 'noon') {
    return ['Noon main image: white or neutral background, no price, promotion, watermark, or seller logo.'];
  }
  return [rule?.notes || 'Main image should be simple, compliant, and product-first.'];
}

function baseComplianceNotes(target, rule, definition) {
  const notes = [
    `Use ${target.language || 'English'} for any allowed image text.`,
    'No Chinese text in generated marketplace images.',
    'No price, discount badge, watermark, fake certification, or unsupported marketplace logo.',
    'Do not exaggerate functions or add unconfirmed specifications.',
    'Keep product shape, color, texture, ports, logo, and visible details unchanged.'
  ];
  if (definition.type === 'main_image') return [...platformMainImageNotes(target, rule), ...notes];
  if (rule?.notes) notes.push(rule.notes);
  return notes;
}

function addMissingRisk(riskWarnings, field) {
  riskWarnings.push(warning(field, `缺少信息，建议补充：${field}`, 'medium'));
}

function addEvidenceWarning(riskWarnings, status) {
  if (status.values.length && status.riskLevel !== 'low') {
    riskWarnings.push(warning(status.field, status.message, status.riskLevel));
  }
}

function buildTextBlocks(definition, productInfo, fieldEvidence = {}, riskWarnings) {
  const blocks = [];
  const usedFields = [];

  const addFieldBlock = (field, label, formatter = (values) => values.join(', '), options = {}) => {
    const result = canUseInText(field, productInfo, fieldEvidence);
    addEvidenceWarning(riskWarnings, result.status);
    if (!result.allowed) return false;
    const values = result.status.values;
    if (!values.length) {
      if (options.required) addMissingRisk(riskWarnings, field);
      return false;
    }
    const text = formatter(values);
    if (!text) return false;
    blocks.push(textBlock(`${definition.type}-${field}-${blocks.length + 1}`, label, text, [field]));
    usedFields.push({ field, value: values, evidenceStatus: result.status.status });
    return true;
  };

  if (definition.type === 'main_image') {
    return { blocks, usedFields };
  }

  if (definition.type === 'feature_image') {
    const sellingPoints = unique(valueForField(productInfo, 'sellingPoints')).slice(0, 3);
    if (sellingPoints.length) {
      sellingPoints.forEach((point, index) => {
        blocks.push(textBlock(`feature-point-${index + 1}`, 'Selling point', point, ['sellingPoints']));
      });
      const status = evidenceStatus('sellingPoints', productInfo, fieldEvidence);
      addEvidenceWarning(riskWarnings, status);
      usedFields.push({ field: 'sellingPoints', value: sellingPoints, evidenceStatus: status.status });
    } else {
      addMissingRisk(riskWarnings, 'sellingPoints');
    }
  }

  if (definition.type === 'size_image') {
    const hasDimensions = addFieldBlock('dimensions', 'Size', (values) => values.join(' / '));
    const hasCapacity = addFieldBlock('capacity', 'Capacity', (values) => values.join(' / '));
    const hasSpecs = addFieldBlock('visibleSpecs', 'Visible specs', (values) => values.slice(0, 4).join(' / '));
    if (!hasDimensions && !hasCapacity && !hasSpecs) addMissingRisk(riskWarnings, 'dimensions or visibleSpecs');
  }

  if (definition.type === 'compatibility_image') {
    const compatibility = canUseInText('compatibleDevices', productInfo, fieldEvidence);
    addEvidenceWarning(riskWarnings, compatibility.status);
    if (compatibility.allowed && compatibility.status.values.length && compatibility.status.status !== 'weak_compatibility') {
      blocks.push(textBlock('compatibility-devices', 'Compatibility', `Compatible with ${compatibility.status.values.join(', ')}`, ['compatibleDevices']));
      usedFields.push({ field: 'compatibleDevices', value: compatibility.status.values, evidenceStatus: compatibility.status.status });
    } else if (compatibility.status.values.length) {
      blocks.push(textBlock('compatibility-selected', 'Compatibility', 'Compatible with selected devices', ['compatibleDevices']));
      usedFields.push({ field: 'compatibleDevices', value: ['selected devices'], evidenceStatus: compatibility.status.status });
    } else {
      addMissingRisk(riskWarnings, 'compatibleDevices');
    }
    addFieldBlock('interfaceType', 'Interface', (values) => values.join(' / '));
  }

  if (definition.type === 'package_image') {
    const hasPackage = addFieldBlock('packageIncluded', 'Package included', (values) => values.join(' + '), { required: true });
    if (!hasPackage) addMissingRisk(riskWarnings, 'packageIncluded');
  }

  if (definition.type === 'lifestyle_image') {
    const productName = unique(valueForField(productInfo, 'productName'))[0] || 'Confirmed product';
    blocks.push(textBlock('lifestyle-context', 'Use scene', `${productName} in a realistic everyday use scene`, ['productName']));
    usedFields.push({ field: 'productName', value: [productName], evidenceStatus: evidenceStatus('productName', productInfo, fieldEvidence).status });
  }

  if (definition.type === 'detail_image') {
    addFieldBlock('interfaceType', 'Interface detail', (values) => values.join(' / '));
    addFieldBlock('material', 'Material detail', (values) => values.join(' / '));
    addFieldBlock('visibleSpecs', 'Visible detail', (values) => values.slice(0, 4).join(' / '));
  }

  if (definition.type === 'variant_image') {
    const hasColor = addFieldBlock('colors', 'Color', (values) => values.join(' / '));
    const hasCapacity = addFieldBlock('capacity', 'Capacity variant', (values) => values.join(' / '));
    const hasModel = addFieldBlock('model', 'Model', (values) => values.join(' / '));
    if (!hasColor && !hasCapacity && !hasModel) addMissingRisk(riskWarnings, 'variant details');
  }

  return { blocks, usedFields };
}

function buildImageElements(definition, productInfo) {
  const productName = unique(valueForField(productInfo, 'productName'))[0] || 'confirmed product';
  const base = [`Show the actual ${productName} from uploaded source images.`];
  if (definition.type === 'package_image') base.push('Arrange confirmed package items separately and clearly.');
  if (definition.type === 'size_image') base.push('Use clean measurement lines only for confirmed dimensions or visible specs.');
  if (definition.type === 'lifestyle_image') base.push('Use a realistic scene without changing the product or adding nonexistent accessories.');
  if (definition.type === 'detail_image') base.push('Use close-up crops for confirmed ports, finish, and visible details.');
  return base;
}

function planLayout(definition) {
  const layouts = {
    main_image: 'Centered product, high product area, no overlay text.',
    feature_image: 'Product on one side with concise benefit callouts and simple icons only if allowed.',
    size_image: 'Product diagram with confirmed specification labels and clean measurement guides.',
    compatibility_image: 'Product plus simple device silhouettes only for confirmed or selected compatibility.',
    package_image: 'Flat-lay package arrangement with labels for confirmed items.',
    lifestyle_image: 'Realistic environment, product remains the visual hero.',
    detail_image: 'Close-up detail panels around the product.',
    variant_image: 'Clean grid or comparison layout for confirmed variants.'
  };
  return layouts[definition.type] || definition.goal;
}

function ruleBackground(rule = {}, fallback = 'clean') {
  if (typeof rule.background === 'string') return rule.background;
  if (typeof rule.backgroundRule === 'string') return rule.backgroundRule;
  return rule.background?.recommended ||
    rule.backgroundRule?.recommended ||
    rule.background?.allowed?.[0] ||
    rule.backgroundRule?.allowed?.[0] ||
    fallback;
}

function stringifyRules(rule = {}) {
  return [
    `background=${ruleBackground(rule, 'unspecified')}`,
    `textAllowed=${Boolean(rule.textAllowed)}`,
    `watermarkAllowed=${Boolean(rule.watermarkAllowed)}`,
    `logoAllowed=${Boolean(rule.logoAllowed)}`,
    `minSize=${rule.minSize || '-'}`,
    `recommendedSize=${rule.recommendedSize || '-'}`,
    `productArea=${rule.productArea || '-'}`,
    `fileFormats=${(rule.fileFormats || []).join('/')}`,
    `bannedElements=${(rule.bannedElements || []).join(', ')}`,
    `languageRules=${rule.languageRules || '-'}`,
    `notes=${rule.notes || '-'}`
  ].join('; ');
}

function buildPrompt({ definition, target, productInfo, rule, plan }) {
  const safeProduct = {
    sku: productInfo.sku || '',
    name: valueForField(productInfo, 'productName') || '',
    category: productInfo.category || '',
    brand: productInfo.brand || '',
    model: productInfo.model || '',
    color: valueForField(productInfo, 'colors') || '',
    confirmedTextBlocks: plan.textBlocks.map((block) => ({ label: block.label, text: block.text }))
  };
  const evidenceRisks = plan.riskWarnings.map((item) => `${item.level}:${item.field}:${item.message}`).join(' | ') || 'none';
  const excluded = plan.excludedUnconfirmedFields.map((item) => item.field).join(', ') || 'none';
  return [
    `Prompt version: ${PROMPT_VERSION}.`,
    `Platform: ${target.rulesSnapshot.name} (${target.platformId}).`,
    `Site: ${target.site}.`,
    `Language: ${target.language}.`,
    `Image type: ${definition.type}.`,
    `Product confirmed information only: ${JSON.stringify(safeProduct)}.`,
    `Platform rules: ${stringifyRules(rule)}.`,
    `Layout: ${plan.layout}.`,
    `Background: ${plan.background}.`,
    `Goal: ${plan.goal}.`,
    `Product requirements: ${plan.productRequirements.join(' ')}`,
    `Text blocks allowed for this image: ${JSON.stringify(plan.textBlocks)}.`,
    `Field evidence risks: ${evidenceRisks}.`,
    `Forbidden unconfirmed fields: ${excluded}.`,
    'Do not invent product specs.',
    'Do not add unconfirmed capacity.',
    'Do not add certifications unless confirmed.',
    'Do not change product shape, color, texture, ports, logo, or visible details.',
    'No Chinese text in generated marketplace images.',
    'Do not add prices, discounts, watermarks, fake certifications, medical claims, warranty claims, or exaggerated performance claims.'
  ].join(' ');
}

export function refreshImagePlanPrompt({ plan, productInfo, target }) {
  const promptTarget = target || {
    platformId: plan.platformId,
    site: plan.site,
    language: plan.language,
    category: plan.category || 'general',
    rulesSnapshot: {
      name: plan.platform,
      platformId: plan.platformId,
      imageTypes: {
        [plan.type]: plan.rulesSnapshot || {}
      }
    }
  };
  return buildPrompt({
    definition: { type: plan.type, goal: plan.goal },
    target: promptTarget,
    productInfo,
    rule: plan.rulesSnapshot || {},
    plan
  });
}

export function createImagePlans({ productInfo, target, task = {}, fieldEvidence = {}, inferredCandidates = [] }) {
  const rules = target.rulesSnapshot.imageTypes || {};
  const excluded = excludedFields({ ...task, inferredCandidates });
  const evidenceSummary = summarizeEvidence(productInfo, fieldEvidence);

  return PLAN_DEFINITIONS.map((definition, index) => {
    const rule = rules[definition.type] || rules.feature_image || {};
    const riskWarnings = [];
    const { blocks, usedFields } = buildTextBlocks(definition, productInfo, fieldEvidence, riskWarnings);
    const templateStyle = getImageTemplateStyle(definition.type);
    const blockedFields = recognitionQualityBlockedFields(task.recognitionQuality || {});
    const safeBlocks = sanitizeMarketplaceTextBlocks(blocks, {
      blockedFields,
      allowedFields: templateStyle.allowedTextBlocks
    });
    const safeUsedFields = usedFields.filter((item) => {
      if (blockedFields.has(item.field)) return false;
      return !templateStyle.allowedTextBlocks.length || templateStyle.allowedTextBlocks.includes(item.field);
    });
    const complianceNotes = baseComplianceNotes(target, rule, definition);
    const missingCritical = riskWarnings.some((item) => /缺少信息，建议补充/.test(item.message));
    const canGenerate = definition.type === 'main_image' ? true : !missingCritical;
    const plan = {
      id: `${target.platformId}-${definition.type}-${index + 1}`,
      targetId: target.id,
      type: definition.type,
      title: definition.title,
      description: definition.goal,
      goal: definition.goal,
      layout: planLayout(definition),
      background: ruleBackground(rule, 'clean'),
      productRequirements: buildImageElements(definition, productInfo),
      textBlocks: rule.textAllowed === false ? [] : safeBlocks,
      imageElements: buildImageElements(definition, productInfo),
      complianceNotes,
      riskWarnings,
      usedConfirmedFields: safeUsedFields,
      excludedUnconfirmedFields: excluded,
      fieldEvidenceSummary: evidenceSummary,
      rulesSnapshot: rule,
      platformRuleSnapshot: target.platformRuleSnapshot || null,
      categoryRuleSnapshot: target.categoryRuleSnapshot || null,
      canGenerate,
      platform: target.rulesSnapshot.name,
      platformId: target.platformId,
      platformName: target.platformName || target.rulesSnapshot.name,
      site: target.site,
      language: target.language,
      categoryId: target.categoryId || target.category,
      size: rule.recommendedSize || '2000x2000',
      status: 'planned',
      promptVersion: PROMPT_VERSION,
      version: 1,
      editedByUser: false,
      editedAt: null
    };
    const styledPlan = applyImageTemplateStyle(plan, {
      sku: productInfo.sku || productInfo.productName || productInfo.name || target.id,
      outputIndex: index + 1
    });
    styledPlan.prompt = buildPrompt({ definition, target, productInfo, rule, plan: styledPlan });
    return styledPlan;
  });
}
