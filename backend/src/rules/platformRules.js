import { categoryRuleRegistry } from './categoryRules.js';

export const RULE_VERSION = 'v3.2';

const supportedCategoryIds = Object.keys(categoryRuleRegistry);

const imageTypeKeys = [
  'main_image',
  'feature_image',
  'size_image',
  'compatibility_image',
  'package_image',
  'lifestyle_image',
  'detail_image',
  'variant_image'
];

const globalForbidden = [
  'price',
  'discount',
  'promotion',
  'watermark',
  'seller_logo',
  'fake_certification',
  'best_seller_badge',
  'review_stars',
  'unsupported_logo',
  'chinese_text'
];

function imageRule({
  required = false,
  backgroundAllowed = ['clean_neutral'],
  backgroundRecommended = 'clean_neutral',
  backgroundStrict = false,
  textAllowed = true,
  productArea = 65,
  allowProps = true,
  allowLifestyleScene = false,
  forbiddenElements = globalForbidden,
  severity = {},
  notes = ''
} = {}) {
  return {
    required,
    background: {
      allowed: backgroundAllowed,
      recommended: backgroundRecommended,
      strict: backgroundStrict
    },
    text: {
      allowed: textAllowed,
      allowedExceptions: [],
      forbiddenLanguages: ['Chinese'],
      forbiddenPatterns: ['price', 'discount', 'promotion', 'best seller', 'no.1', 'review stars']
    },
    product: {
      mustShowProductClearly: true,
      mustNotCropProduct: true,
      recommendedProductAreaPercent: productArea,
      allowProps,
      allowLifestyleScene
    },
    forbiddenElements,
    file: {
      minWidth: 1000,
      minHeight: 1000,
      recommendedWidth: 2000,
      recommendedHeight: 2000,
      formats: ['jpg', 'jpeg', 'png']
    },
    severity: {
      text: textAllowed ? 'medium' : 'high',
      chineseText: 'high',
      nonWhiteBackground: backgroundStrict ? 'high' : 'medium',
      watermark: 'high',
      price: 'high',
      promotion: 'high',
      sellerLogo: 'high',
      unconfirmedCertification: 'high',
      unconfirmedCapacity: 'high',
      sourceMock: 'medium',
      ...severity
    },
    // Legacy compatibility for existing services.
    title: required ? 'Main Image' : 'Auxiliary Image',
    textAllowed,
    background: {
      allowed: backgroundAllowed,
      recommended: backgroundRecommended,
      strict: backgroundStrict
    },
    watermarkAllowed: false,
    logoAllowed: true,
    minSize: '1000x1000',
    recommendedSize: '2000x2000',
    productArea: `${productArea}%`,
    fileFormats: ['jpg', 'jpeg', 'png'],
    bannedElements: forbiddenElements,
    languageRules: textAllowed ? 'Use target language only. No Chinese text.' : 'No text allowed.',
    notes
  };
}

const strictMain = (notes) => imageRule({
  required: true,
  backgroundAllowed: ['pure_white'],
  backgroundRecommended: 'pure_white',
  backgroundStrict: true,
  textAllowed: false,
  productArea: 85,
  allowProps: false,
  allowLifestyleScene: false,
  notes
});

const simpleMain = (notes) => imageRule({
  required: true,
  backgroundAllowed: ['pure_white', 'clean_neutral', 'light_gray'],
  backgroundRecommended: 'clean_neutral',
  backgroundStrict: false,
  textAllowed: false,
  productArea: 80,
  allowProps: false,
  allowLifestyleScene: false,
  notes
});

const auxiliary = (notes, overrides = {}) => imageRule({
  textAllowed: true,
  allowProps: true,
  allowLifestyleScene: Boolean(overrides.allowLifestyleScene),
  backgroundAllowed: overrides.backgroundAllowed || ['clean_neutral', 'light_commercial', 'simple_scene'],
  backgroundRecommended: overrides.backgroundRecommended || 'clean_neutral',
  productArea: overrides.productArea || 65,
  notes
});

function imageTypesForPlatform(platformId) {
  const mainNotes = {
    amazon: 'Amazon main image: pure white background, no text, no icons, no selling points, no scene background.',
    temu: 'Temu main image: product clear and centered, simple background, no Chinese, price, watermark, or exaggerated promotion.',
    noon: 'Noon main image: white background preferred; no watermark, price, promotion, seller logo, or unsupported warranty text.',
    ozon: 'Ozon main image: product clear and complete; text and scene background are not recommended.',
    rakuten: 'Rakuten main image: product clear, simple background, avoid excessive text and promotional badges.',
    marketplace: 'Marketplace main image: product-first, no text, price, watermark, or promotional badges.'
  }[platformId];
  const main = platformId === 'amazon' || platformId === 'noon'
    ? strictMain(mainNotes)
    : simpleMain(mainNotes);
  return {
    main_image: main,
    feature_image: auxiliary('Auxiliary feature images may use target-language selling points if confirmed. No price, fake certification, watermark, or Chinese.'),
    size_image: auxiliary('Size/spec images may show confirmed dimensions, capacity, ports, and visible specs only.'),
    compatibility_image: auxiliary('Compatibility images may show confirmed devices/interfaces only; avoid broad unsupported compatibility claims.'),
    package_image: auxiliary('Package images may show confirmed package contents only.'),
    lifestyle_image: auxiliary('Lifestyle images may use a scene background while preserving product appearance. No price, watermark, or unconfirmed specs.', { allowLifestyleScene: true, backgroundRecommended: 'realistic_scene', productArea: 50 }),
    detail_image: auxiliary('Detail images may label confirmed material, ports, texture, and visible details.'),
    variant_image: auxiliary('Variant images may show confirmed color, capacity, size, or model variants only.')
  };
}

function platform({ platformId, platformName, sites, defaultLanguage, supportedLanguages, notes }) {
  return {
    platformId,
    platformName,
    name: platformName,
    sites,
    defaultLanguage,
    supportedLanguages,
    languages: supportedLanguages,
    categories: supportedCategoryIds,
    imageTypes: imageTypesForPlatform(platformId),
    globalForbidden,
    languageRules: {
      forbiddenLanguages: ['Chinese'],
      targetLanguageOnly: true,
      supportedLanguages
    },
    certificationRules: {
      requireEvidence: true,
      forbiddenWithoutEvidence: ['FDA', 'CE', 'FCC', 'RoHS', 'warranty', 'waterproof', 'medical claims']
    },
    notes: [
      'Internal auxiliary rule set only. It does not represent official final marketplace approval.',
      ...notes
    ],
    ruleVersion: RULE_VERSION
  };
}

export const platformRuleRegistry = {
  marketplace: platform({
    platformId: 'marketplace',
    platformName: 'Marketplace',
    sites: ['US'],
    defaultLanguage: 'English',
    supportedLanguages: ['English'],
    notes: ['Generic fallback rules for unsupported platforms.']
  }),
  amazon: platform({
    platformId: 'amazon',
    platformName: 'Amazon',
    sites: ['US', 'JP', 'EU'],
    defaultLanguage: 'English',
    supportedLanguages: ['English', 'Japanese'],
    notes: ['Amazon rules are conservative: main image should be pure white and text-free.']
  }),
  temu: platform({
    platformId: 'temu',
    platformName: 'Temu',
    sites: ['US'],
    defaultLanguage: 'English',
    supportedLanguages: ['English'],
    notes: ['Temu rules here prioritize clear product display and avoiding risky claims.']
  }),
  noon: platform({
    platformId: 'noon',
    platformName: 'Noon',
    sites: ['UAE', 'SA'],
    defaultLanguage: 'English',
    supportedLanguages: ['English', 'Arabic'],
    notes: ['Noon main image favors white background and no seller logo, price, or promotion.']
  }),
  ozon: platform({
    platformId: 'ozon',
    platformName: 'Ozon',
    sites: ['RU'],
    defaultLanguage: 'Russian',
    supportedLanguages: ['Russian', 'English'],
    notes: ['Ozon auxiliary images may include target-language parameters and scene images.']
  }),
  rakuten: platform({
    platformId: 'rakuten',
    platformName: 'Rakuten',
    sites: ['JP'],
    defaultLanguage: 'Japanese',
    supportedLanguages: ['Japanese', 'English'],
    notes: ['Rakuten auxiliary images may include selling points, but avoid language mixing and fake certifications.']
  })
};

const legacyPlatformMap = {
  Amazon: 'amazon',
  Temu: 'temu',
  Noon: 'noon',
  Rakuten: 'rakuten',
  Ozon: 'ozon'
};

export const imageTypes = imageTypeKeys;

export function normalizePlatformId(platformIdOrName = 'amazon') {
  return legacyPlatformMap[platformIdOrName] || String(platformIdOrName).toLowerCase();
}

export function listPlatformRules() {
  return {
    platforms: Object.values(platformRuleRegistry)
      .filter((platformItem) => platformItem.platformId !== 'marketplace')
      .map((platformItem) => ({
        platformId: platformItem.platformId,
        name: platformItem.name,
        platformName: platformItem.platformName,
        sites: platformItem.sites,
        languages: platformItem.languages,
        supportedLanguages: platformItem.supportedLanguages,
        categories: platformItem.categories,
        ruleVersion: platformItem.ruleVersion
      })),
    imageTypes,
    rules: platformRuleRegistry
  };
}

export function getPlatformRuleSnapshot({ platformId, platform, site, language, category } = {}) {
  const normalizedPlatformId = normalizePlatformId(platformId || platform || 'amazon');
  const rule = platformRuleRegistry[normalizedPlatformId] || platformRuleRegistry.marketplace;

  return {
    platformId: rule.platformId,
    name: rule.name,
    platformName: rule.platformName,
    site: site || rule.sites[0],
    language: language || rule.defaultLanguage,
    category: category || rule.categories[0],
    imageTypes: rule.imageTypes,
    globalForbidden: rule.globalForbidden,
    languageRules: rule.languageRules,
    certificationRules: rule.certificationRules,
    notes: rule.notes,
    ruleVersion: rule.ruleVersion
  };
}
