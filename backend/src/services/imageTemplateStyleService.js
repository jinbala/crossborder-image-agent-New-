export const IMAGE_TEMPLATE_TYPES = [
  'main_image',
  'feature_image',
  'size_image',
  'compatibility_image',
  'package_image',
  'lifestyle_image',
  'detail_image',
  'variant_image'
];

const CHINESE_PATTERN = /[\u3400-\u9fff]/;
const PROMOTION_PATTERN = /\b(price|sale|discount|off|coupon|deal|best|no\.?\s*1|guaranteed|free shipping|limited time)\b|[$€£¥]|\d+\s?%/i;
const RISKY_BROAD_CLAIM_PATTERN = /\b(all devices|universal compatibility|works with everything)\b/i;

const TEMPLATE_STYLES = {
  main_image: {
    templateType: 'main_image',
    templateName: 'Amazon Clean Main Image',
    title: 'Product Hero',
    subtitle: 'White background product view',
    layoutStyle: 'centered-white-product-hero',
    allowedTextBlocks: [],
    iconHints: [],
    backgroundStyle: 'pure_white',
    productPlacement: 'centered with safe margin',
    safetyNotes: ['White background', 'No image text', 'No icons', 'No promotional badges']
  },
  feature_image: {
    templateType: 'feature_image',
    templateName: 'Clean Feature Callouts',
    title: 'Key Features',
    subtitle: 'Short confirmed benefits',
    layoutStyle: 'split-product-callouts',
    allowedTextBlocks: ['sellingPoints', 'visibleSpecs'],
    iconHints: ['check', 'spark', 'shield'],
    backgroundStyle: 'soft-blue-panel',
    productPlacement: 'center-right hero',
    safetyNotes: ['Use confirmed benefits only', 'Avoid long paragraphs']
  },
  size_image: {
    templateType: 'size_image',
    templateName: 'Dimensions And Specs Diagram',
    title: 'Dimensions & Specs',
    subtitle: 'Confirmed measurements only',
    layoutStyle: 'measurement-diagram',
    allowedTextBlocks: ['dimensions', 'visibleSpecs'],
    iconHints: ['ruler', 'port'],
    backgroundStyle: 'white-technical-grid',
    productPlacement: 'center diagram',
    safetyNotes: ['Do not invent dimensions', 'Use confirmation placeholder when missing']
  },
  compatibility_image: {
    templateType: 'compatibility_image',
    templateName: 'Device Compatibility Grid',
    title: 'Compatibility',
    subtitle: 'Confirmed device support',
    layoutStyle: 'device-icon-grid',
    allowedTextBlocks: ['compatibleDevices', 'interfaceType'],
    iconHints: ['laptop', 'phone', 'tablet', 'game-console'],
    backgroundStyle: 'clean-cyan-band',
    productPlacement: 'center with device row',
    safetyNotes: ['Avoid broad compatibility claims', 'Use selected devices only']
  },
  package_image: {
    templateType: 'package_image',
    templateName: 'Package Contents Flat Lay',
    title: 'Package Includes',
    subtitle: 'Confirmed items in the box',
    layoutStyle: 'flat-lay-checklist',
    allowedTextBlocks: ['packageIncluded'],
    iconHints: ['box', 'cable', 'manual'],
    backgroundStyle: 'soft-neutral-flatlay',
    productPlacement: 'top product with item cards',
    safetyNotes: ['Do not invent accessories', 'Use confirmed package list only']
  },
  lifestyle_image: {
    templateType: 'lifestyle_image',
    templateName: 'Desk Lifestyle Mock Scene',
    title: 'Everyday Use',
    subtitle: 'Programmatic scene preview',
    layoutStyle: 'desk-scene-product-focus',
    allowedTextBlocks: ['productName'],
    iconHints: ['desk', 'travel', 'work'],
    backgroundStyle: 'warm-desk-scene',
    productPlacement: 'foreground product focus',
    safetyNotes: ['Mock scene only', 'No unconfirmed specs']
  },
  detail_image: {
    templateType: 'detail_image',
    templateName: 'Detail Callout Panels',
    title: 'Detail View',
    subtitle: 'Visible product details',
    layoutStyle: 'closeup-detail-panels',
    allowedTextBlocks: ['interfaceType', 'material', 'visibleSpecs'],
    iconHints: ['zoom', 'port', 'texture'],
    backgroundStyle: 'white-detail-panels',
    productPlacement: 'large crop with side panels',
    safetyNotes: ['Do not overstate material', 'Highlight visible details only']
  },
  variant_image: {
    templateType: 'variant_image',
    templateName: 'Confirmed Variants Grid',
    title: 'Confirmed Variants',
    subtitle: 'Verified options only',
    layoutStyle: 'variant-badge-grid',
    allowedTextBlocks: ['colors', 'sizes', 'capacity', 'model'],
    iconHints: ['badge', 'swatch'],
    backgroundStyle: 'clean-variant-grid',
    productPlacement: 'product with variant cards',
    safetyNotes: ['Capacity needs evidence', 'Do not invent variants']
  }
};

const TEMPLATE_VARIANT_PRESETS = {
  main_image: [
    {
      templateName: 'Amazon Clean Main Image',
      layoutStyle: 'centered-white-product-hero',
      backgroundStyle: 'pure_white',
      productPlacement: 'centered with safe margin',
      iconHints: [],
      backgroundColor: '#ffffff',
      accentColor: '#0f172a'
    },
    {
      templateName: 'Amazon Clean Main Image Wide Hero',
      layoutStyle: 'centered-white-wide-product-hero',
      backgroundStyle: 'pure_white',
      productPlacement: 'centered large product with wide safe margin',
      iconHints: [],
      backgroundColor: '#ffffff',
      accentColor: '#111827'
    },
    {
      templateName: 'Amazon Clean Main Image Tall Hero',
      layoutStyle: 'centered-white-tall-product-hero',
      backgroundStyle: 'pure_white',
      productPlacement: 'centered tall product with clean margin',
      iconHints: [],
      backgroundColor: '#ffffff',
      accentColor: '#1f2937'
    }
  ],
  feature_image: [
    {
      templateName: 'Clean Feature Callouts',
      layoutStyle: 'split-product-callouts',
      backgroundStyle: 'soft-blue-panel',
      productPlacement: 'center-right hero',
      iconHints: ['check', 'spark', 'shield'],
      backgroundColor: '#eff6ff',
      accentColor: '#2563eb'
    },
    {
      templateName: 'Clean Feature Ribbon Callouts',
      layoutStyle: 'stacked-ribbon-callouts',
      backgroundStyle: 'cool-gray-blue-panel',
      productPlacement: 'left hero with right callout stack',
      iconHints: ['check', 'bolt', 'shield'],
      backgroundColor: '#eef2ff',
      accentColor: '#4f46e5'
    },
    {
      templateName: 'Clean Feature Tile Callouts',
      layoutStyle: 'modular-feature-tiles',
      backgroundStyle: 'white-blue-tile-grid',
      productPlacement: 'top hero with lower feature tiles',
      iconHints: ['spark', 'check', 'detail'],
      backgroundColor: '#f8fafc',
      accentColor: '#0284c7'
    }
  ],
  size_image: [
    {
      templateName: 'Dimensions And Specs Diagram',
      layoutStyle: 'measurement-diagram',
      backgroundStyle: 'white-technical-grid',
      productPlacement: 'center diagram',
      iconHints: ['ruler', 'port'],
      backgroundColor: '#f0fdf4',
      accentColor: '#16a34a'
    },
    {
      templateName: 'Dimensions Side Gauge Diagram',
      layoutStyle: 'side-gauge-measurement-diagram',
      backgroundStyle: 'white-green-spec-grid',
      productPlacement: 'left product with right measurement rail',
      iconHints: ['ruler', 'scale'],
      backgroundColor: '#ecfdf5',
      accentColor: '#059669'
    },
    {
      templateName: 'Dimensions Blueprint Diagram',
      layoutStyle: 'blueprint-spec-callout-diagram',
      backgroundStyle: 'light-blue-technical-grid',
      productPlacement: 'center product with corner spec labels',
      iconHints: ['ruler', 'port', 'spec'],
      backgroundColor: '#eff6ff',
      accentColor: '#0ea5e9'
    }
  ],
  compatibility_image: [
    {
      templateName: 'Device Compatibility Grid',
      layoutStyle: 'device-icon-grid',
      backgroundStyle: 'clean-cyan-band',
      productPlacement: 'center with device row',
      iconHints: ['laptop', 'phone', 'tablet', 'game-console'],
      backgroundColor: '#ecfeff',
      accentColor: '#0891b2'
    },
    {
      templateName: 'Device Compatibility Orbit',
      layoutStyle: 'device-orbit-callouts',
      backgroundStyle: 'cool-cyan-panel',
      productPlacement: 'center product with device orbit',
      iconHints: ['laptop', 'phone', 'tablet'],
      backgroundColor: '#f0f9ff',
      accentColor: '#0284c7'
    },
    {
      templateName: 'Device Compatibility Shelf',
      layoutStyle: 'device-shelf-row',
      backgroundStyle: 'white-cyan-shelf',
      productPlacement: 'top product with lower device shelf',
      iconHints: ['laptop', 'phone', 'desktop'],
      backgroundColor: '#f8fafc',
      accentColor: '#0e7490'
    }
  ],
  package_image: [
    {
      templateName: 'Package Contents Flat Lay',
      layoutStyle: 'flat-lay-checklist',
      backgroundStyle: 'soft-neutral-flatlay',
      productPlacement: 'top product with item cards',
      iconHints: ['box', 'cable', 'manual'],
      backgroundColor: '#fdf2f8',
      accentColor: '#db2777'
    },
    {
      templateName: 'Package Contents Inventory Cards',
      layoutStyle: 'inventory-card-grid',
      backgroundStyle: 'white-rose-inventory-grid',
      productPlacement: 'center product with surrounding item cards',
      iconHints: ['box', 'check', 'manual'],
      backgroundColor: '#fff1f2',
      accentColor: '#e11d48'
    },
    {
      templateName: 'Package Contents Shelf View',
      layoutStyle: 'package-shelf-display',
      backgroundStyle: 'warm-white-package-shelf',
      productPlacement: 'left product with right accessory shelf',
      iconHints: ['box', 'cable', 'bundle'],
      backgroundColor: '#fffbeb',
      accentColor: '#d97706'
    }
  ],
  lifestyle_image: [
    {
      templateName: 'Desk Lifestyle Mock Scene',
      layoutStyle: 'desk-scene-product-focus',
      backgroundStyle: 'warm-desk-scene',
      productPlacement: 'foreground product focus',
      iconHints: ['desk', 'travel', 'work'],
      backgroundColor: '#fffbeb',
      accentColor: '#d97706'
    },
    {
      templateName: 'Office Lifestyle Mock Scene',
      layoutStyle: 'office-scene-centered-product',
      backgroundStyle: 'soft-office-scene',
      productPlacement: 'center product on work surface',
      iconHints: ['office', 'work', 'desk'],
      backgroundColor: '#f8fafc',
      accentColor: '#64748b'
    },
    {
      templateName: 'Travel Lifestyle Mock Scene',
      layoutStyle: 'travel-scene-product-corner',
      backgroundStyle: 'clean-travel-scene',
      productPlacement: 'lower-right product focus',
      iconHints: ['travel', 'bag', 'desk'],
      backgroundColor: '#f0fdfa',
      accentColor: '#0f766e'
    }
  ],
  detail_image: [
    {
      templateName: 'Detail Callout Panels',
      layoutStyle: 'closeup-detail-panels',
      backgroundStyle: 'white-detail-panels',
      productPlacement: 'large crop with side panels',
      iconHints: ['zoom', 'port', 'texture'],
      backgroundColor: '#f5f3ff',
      accentColor: '#7c3aed'
    },
    {
      templateName: 'Detail Magnifier Callouts',
      layoutStyle: 'magnifier-detail-callouts',
      backgroundStyle: 'white-violet-closeup',
      productPlacement: 'center close-up with magnifier labels',
      iconHints: ['zoom', 'port', 'finish'],
      backgroundColor: '#faf5ff',
      accentColor: '#9333ea'
    },
    {
      templateName: 'Detail Strip Panels',
      layoutStyle: 'horizontal-detail-strip-panels',
      backgroundStyle: 'cool-white-detail-strip',
      productPlacement: 'top crop with lower detail strip',
      iconHints: ['texture', 'port', 'detail'],
      backgroundColor: '#f8fafc',
      accentColor: '#6366f1'
    }
  ],
  variant_image: [
    {
      templateName: 'Confirmed Variants Grid',
      layoutStyle: 'variant-badge-grid',
      backgroundStyle: 'clean-variant-grid',
      productPlacement: 'product with variant cards',
      iconHints: ['badge', 'swatch'],
      backgroundColor: '#fff7ed',
      accentColor: '#ea580c'
    },
    {
      templateName: 'Confirmed Variants Comparison Row',
      layoutStyle: 'variant-comparison-row',
      backgroundStyle: 'white-orange-comparison-row',
      productPlacement: 'top product with lower option row',
      iconHints: ['swatch', 'badge', 'compare'],
      backgroundColor: '#fefce8',
      accentColor: '#ca8a04'
    },
    {
      templateName: 'Confirmed Variants Selector Cards',
      layoutStyle: 'variant-selector-cards',
      backgroundStyle: 'soft-orange-selector-grid',
      productPlacement: 'left product with right option cards',
      iconHints: ['badge', 'swatch', 'option'],
      backgroundColor: '#fff7ed',
      accentColor: '#f97316'
    }
  ]
};

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

export function getImageTemplateStyle(type) {
  return TEMPLATE_STYLES[type] || TEMPLATE_STYLES.feature_image;
}

function hashText(value) {
  let hash = 2166136261;
  for (const char of String(value || '')) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return Math.abs(hash >>> 0);
}

function normalizeIndex(value, count) {
  if (!Number.isFinite(value) || count <= 0) return 0;
  return ((Math.trunc(value) % count) + count) % count;
}

export function buildTemplateSeedVariants({ sku = '', templateType = 'feature_image' } = {}) {
  const base = getImageTemplateStyle(templateType);
  const presets = TEMPLATE_VARIANT_PRESETS[base.templateType] || TEMPLATE_VARIANT_PRESETS.feature_image;
  return presets.slice(0, 3).map((preset, index) => ({
    ...base,
    ...preset,
    templateType: base.templateType,
    allowedTextBlocks: [...base.allowedTextBlocks],
    iconHints: [...(preset.iconHints || base.iconHints)],
    safetyNotes: [...base.safetyNotes],
    variantId: `${base.templateType}-seed-${index + 1}`,
    layoutSeed: `${base.templateType}-${hashText(`${sku}|${base.templateType}|${index + 1}`).toString(36).slice(0, 6)}`,
    seedIndex: index + 1
  }));
}

export function selectTemplateSeed({ sku = '', templateType = 'feature_image', outputIndex = null, version = null, variantIndex = null } = {}) {
  const variants = buildTemplateSeedVariants({ sku, templateType });
  let selectedIndex;
  if (variantIndex !== null && variantIndex !== undefined) {
    selectedIndex = normalizeIndex(Number(variantIndex), variants.length);
  } else if (version !== null && version !== undefined) {
    selectedIndex = normalizeIndex(Number(version) - 1, variants.length);
  } else if (outputIndex !== null && outputIndex !== undefined) {
    selectedIndex = normalizeIndex(Number(outputIndex) - 1, variants.length);
  } else {
    selectedIndex = normalizeIndex(hashText(`${sku}|${templateType}`), variants.length);
  }
  return variants[selectedIndex];
}

export function isMarketplaceSafeEnglishCopy(value) {
  const text = String(value || '').trim();
  if (!text) return false;
  if (CHINESE_PATTERN.test(text)) return false;
  if (PROMOTION_PATTERN.test(text)) return false;
  if (RISKY_BROAD_CLAIM_PATTERN.test(text)) return false;
  return true;
}

export function recognitionQualityBlockedFields(recognitionQuality = {}) {
  return new Set([
    ...asArray(recognitionQuality.missingEvidenceFields).map((item) => item.field),
    ...asArray(recognitionQuality.conflictFields).map((item) => item.field),
    ...asArray(recognitionQuality.inferredOnlyFields).map((item) => item.field)
  ].filter(Boolean));
}

export function sanitizeMarketplaceTextBlocks(blocks = [], { blockedFields = new Set(), allowedFields = null } = {}) {
  const allowed = allowedFields ? new Set(allowedFields) : null;
  return asArray(blocks).filter((block) => {
    const fields = blockFields(block);
    if (fields.some((field) => blockedFields.has(field))) return false;
    if (allowed && fields.length && !fields.some((field) => allowed.has(field))) return false;
    return isMarketplaceSafeEnglishCopy(block.text);
  });
}

export function applyImageTemplateStyle(plan = {}, options = {}) {
  const sku = options.sku || plan.sku || plan.productSku || plan.id || '';
  const templateVariants = buildTemplateSeedVariants({ sku, templateType: plan.type });
  const style = selectTemplateSeed({
    sku,
    templateType: plan.type,
    outputIndex: options.outputIndex,
    version: options.version,
    variantIndex: options.variantIndex
  });
  return {
    ...plan,
    templateType: style.templateType,
    templateName: style.templateName,
    layoutStyle: style.layoutStyle,
    allowedTextBlocks: style.allowedTextBlocks,
    iconHints: style.iconHints,
    backgroundStyle: style.backgroundStyle,
    backgroundColor: style.backgroundColor,
    accentColor: style.accentColor,
    productPlacement: style.productPlacement,
    safetyNotes: style.safetyNotes,
    templateSeed: style,
    templateVariants
  };
}
