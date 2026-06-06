const BANNED_WORDS = [
  'price',
  'discount',
  'sale',
  'coupon',
  'free shipping',
  'best',
  'no.1',
  'guaranteed',
  'cure',
  'medical',
  'official certification'
];

const CAUTION_WORDS = [
  'waterproof',
  'shockproof',
  'certified',
  'warranty',
  'lifetime',
  'high speed',
  'ultra fast',
  'military grade',
  'professional grade'
];

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function platformRule({
  platformId,
  platformName,
  defaultLocale,
  allowedLanguages,
  amazonStrict = false,
  riskNotes = []
}) {
  return {
    platformId,
    platformName,
    defaultLocale,
    allowedLanguages,
    mainImageRules: {
      background: amazonStrict ? 'pure_white' : 'white_or_clean_simple',
      backgroundStrict: amazonStrict,
      textAllowed: false,
      sellingPointsAllowed: false,
      iconsAllowed: false,
      priceAllowed: false,
      promotionAllowed: false,
      watermarkAllowed: false,
      productCentered: true,
      productClear: true
    },
    secondaryImageRules: {
      textAllowed: true,
      allowedTextLanguages: ['English'],
      chineseAllowed: false,
      priceAllowed: false,
      promotionAllowed: false,
      unconfirmedCertificationAllowed: false,
      unconfirmedWarrantyAllowed: false,
      unconfirmedCapacityAllowed: false,
      unconfirmedSpeedAllowed: false,
      absoluteClaimsAllowed: false,
      keepCopyConcise: true
    },
    textRules: {
      allowChinese: false,
      priceAllowed: false,
      promotionAllowed: false,
      absoluteClaimsAllowed: false,
      requireEvidenceForRiskClaims: true
    },
    bannedWords: [...BANNED_WORDS],
    cautionWords: [...CAUTION_WORDS],
    imageSizeHints: {
      minSize: '1000x1000',
      recommendedSize: '2000x2000',
      squarePreferred: true
    },
    exportHints: [
      `${platformName} export should keep marketplace-safe English copy.`,
      'Keep local validation report for manual review before upload.'
    ],
    riskNotes: [
      'Internal conservative rule helper, not final official marketplace approval.',
      ...riskNotes
    ]
  };
}

const PLATFORM_RULES = {
  amazon: platformRule({
    platformId: 'amazon',
    platformName: 'Amazon',
    defaultLocale: 'en-US',
    allowedLanguages: ['English'],
    amazonStrict: true,
    riskNotes: ['Amazon main image must stay pure white and text-free.']
  }),
  temu: platformRule({
    platformId: 'temu',
    platformName: 'Temu',
    defaultLocale: 'en-US',
    allowedLanguages: ['English'],
    riskNotes: ['Temu first-stage rules are conservative: simple background and no risky promo copy.']
  }),
  noon: platformRule({
    platformId: 'noon',
    platformName: 'Noon',
    defaultLocale: 'en-AE',
    allowedLanguages: ['English', 'Arabic'],
    riskNotes: ['Noon main image should avoid seller logo, price, promotion, and unsupported warranty text.']
  }),
  ozon: platformRule({
    platformId: 'ozon',
    platformName: 'Ozon',
    defaultLocale: 'en-US',
    allowedLanguages: ['English'],
    riskNotes: ['Ozon first-stage cross-border copy defaults to English and conservative claims.']
  }),
  rakuten: platformRule({
    platformId: 'rakuten',
    platformName: 'Rakuten',
    defaultLocale: 'en-US',
    allowedLanguages: ['English'],
    riskNotes: ['Rakuten localization is reserved for later; do not generate Japanese by default.']
  })
};

const STORAGE_HIGH_RISK_FIELDS = [
  'capacity',
  'dimensions',
  'interfaceType',
  'certifications',
  'warranty',
  'material',
  'model',
  'brand',
  'packageIncluded',
  'compatibleDevices',
  'speed',
  'waterproof',
  'shockproof'
];

function placeholderCategory(categoryId, categoryName) {
  return {
    categoryId,
    categoryName,
    placeholder: true,
    highRiskFields: ['certifications', 'warranty'],
    requiredEvidenceFields: ['certifications', 'warranty'],
    bannedClaims: ['official certification'],
    cautionClaims: ['certified', 'warranty'],
    allowedSellingPointTypes: ['confirmed_visible_benefit'],
    attributeRules: {},
    reviewNotes: ['Placeholder category rule. Use generic ecommerce validation only in this phase.']
  };
}

const CATEGORY_RULES = {
  generic_ecommerce: {
    categoryId: 'generic_ecommerce',
    categoryName: 'Generic Ecommerce',
    placeholder: false,
    highRiskFields: ['certifications', 'warranty', 'medicalClaims'],
    requiredEvidenceFields: ['certifications', 'warranty', 'medicalClaims'],
    bannedClaims: ['official certification', 'medical', 'cure'],
    cautionClaims: ['certified', 'warranty', 'lifetime'],
    allowedSellingPointTypes: ['confirmed_benefit', 'visible_feature', 'confirmed_package_content'],
    attributeRules: {
      certifications: { evidenceRequired: true, evidenceType: 'visible_text_or_user_confirmed' },
      warranty: { evidenceRequired: true, evidenceType: 'visible_text_or_user_confirmed' }
    },
    reviewNotes: ['Use confirmed product facts only. Avoid unsupported certifications, warranty, and medical claims.']
  },
  electronics_storage: {
    categoryId: 'electronics_storage',
    categoryName: 'Electronics / Storage Devices',
    placeholder: false,
    highRiskFields: STORAGE_HIGH_RISK_FIELDS,
    requiredEvidenceFields: STORAGE_HIGH_RISK_FIELDS,
    bannedClaims: [
      'official certification',
      'universal compatibility',
      'all devices',
      'guaranteed speed',
      'medical',
      'cure'
    ],
    cautionClaims: [
      'waterproof',
      'shockproof',
      'certified',
      'warranty',
      'lifetime',
      'high speed',
      'ultra fast',
      'military grade',
      'professional grade'
    ],
    allowedSellingPointTypes: [
      'confirmed_portability',
      'confirmed_visible_feature',
      'confirmed_package_content',
      'confirmed_interface',
      'confirmed_compatibility'
    ],
    attributeRules: Object.fromEntries(STORAGE_HIGH_RISK_FIELDS.map((field) => [field, {
      evidenceRequired: true,
      evidenceType: field === 'material' ? 'visible_text_or_user_confirmed_visual_review' : 'visible_text_or_user_confirmed',
      note: `${field} requires evidence before image copy can use it.`
    }])),
    reviewNotes: [
      'Storage capacity must have evidence; do not infer capacity.',
      'Interface type must have evidence; do not invent Type-C, USB 3.1, or USB 3.2.',
      'Dimensions must have evidence; do not estimate by visual judgment.',
      'Certification and warranty claims must have evidence.',
      'Speed, waterproof, and shockproof claims must have evidence.',
      'Compatibility must be supported; avoid all devices or universal compatibility claims.'
    ]
  },
  apparel: placeholderCategory('apparel', 'Apparel'),
  beauty: placeholderCategory('beauty', 'Beauty'),
  home: placeholderCategory('home', 'Home'),
  tools: placeholderCategory('tools', 'Tools'),
  pet: placeholderCategory('pet', 'Pet Supplies'),
  medical_device: placeholderCategory('medical_device', 'Medical Device')
};

function normalizeId(value, fallback) {
  return String(value || fallback).trim().toLowerCase().replace(/[\s-]+/g, '_');
}

export function getPlatformRules(platformId = 'amazon') {
  return clone(PLATFORM_RULES[normalizeId(platformId, 'amazon')] || PLATFORM_RULES.amazon);
}

export function getCategoryRules(categoryId = 'generic_ecommerce') {
  return clone(CATEGORY_RULES[normalizeId(categoryId, 'generic_ecommerce')] || CATEGORY_RULES.generic_ecommerce);
}

export function listCategoryRules() {
  return Object.values(CATEGORY_RULES).map((rule) => clone(rule));
}

export function listPlatformCategoryRules() {
  return {
    platforms: Object.values(PLATFORM_RULES).map((rule) => ({
      platformId: rule.platformId,
      platformName: rule.platformName,
      defaultLocale: rule.defaultLocale,
      allowedLanguages: [...rule.allowedLanguages]
    })),
    categories: listCategoryRules().map((rule) => ({
      categoryId: rule.categoryId,
      categoryName: rule.categoryName,
      placeholder: Boolean(rule.placeholder)
    }))
  };
}

export function getEffectiveRules(platformId = 'amazon', categoryId = 'generic_ecommerce') {
  const platform = getPlatformRules(platformId);
  const category = getCategoryRules(categoryId);
  const effectiveBannedWords = unique([
    ...platform.bannedWords,
    ...category.bannedClaims
  ]);
  const effectiveCautionWords = unique([
    ...platform.cautionWords,
    ...category.cautionClaims
  ]);
  const effectiveHighRiskFields = unique([
    ...category.highRiskFields
  ]);
  const effectiveEvidenceRequirements = Object.fromEntries(unique([
    ...category.requiredEvidenceFields
  ]).map((field) => [field, category.attributeRules?.[field] || {
    evidenceRequired: true,
    evidenceType: 'visible_text_or_user_confirmed'
  }]));
  const recommendations = [
    `${platform.platformName} 主图规则：保持产品清晰，${platform.mainImageRules.backgroundStrict ? '必须 pure_white 白底且无文字。' : '建议白底或简洁背景，避免过多文字。'}`,
    `${category.categoryName} 规则：高风险字段必须有证据，不能使用 AI 推测自动放行。`
  ];
  if (category.categoryId === 'electronics_storage') {
    recommendations.push('存储设备容量、接口、认证、保修、速度、防水、防摔和兼容设备必须人工核验证据。');
  }
  return {
    platformId: platform.platformId,
    platformName: platform.platformName,
    categoryId: category.categoryId,
    categoryName: category.categoryName,
    effectiveMainImageRules: clone(platform.mainImageRules),
    effectiveSecondaryImageRules: clone(platform.secondaryImageRules),
    effectiveTextRules: clone(platform.textRules),
    effectiveHighRiskFields,
    effectiveBannedWords,
    effectiveCautionWords,
    effectiveEvidenceRequirements,
    recommendations
  };
}
