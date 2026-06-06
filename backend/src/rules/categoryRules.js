export const CATEGORY_RULE_VERSION = 'v3.3';

const sharedImageTypeGuidance = {
  main_image: { note: 'Keep product clear and avoid unsupported category claims.' },
  feature_image: { note: 'Use only confirmed feature claims.' },
  size_image: { note: 'Use confirmed dimensions, sizes, or visible specs.' },
  compatibility_image: { note: 'Use confirmed compatibility only; avoid broad universal claims.' },
  package_image: { note: 'Use confirmed package contents only.' },
  lifestyle_image: { note: 'Show realistic use without adding unsupported product claims.' },
  detail_image: { note: 'Highlight confirmed visual details.' },
  variant_image: { note: 'Show confirmed variants only.' }
};

const conservativeTemplate = (categoryId, categoryName, aliases = []) => ({
  categoryId,
  categoryName,
  aliases,
  criticalFields: ['productName', 'category', 'packageIncluded', 'sellingPoints'],
  highRiskFields: ['certifications', 'warranty', 'medicalClaims'],
  evidenceRequiredFields: {
    certifications: 'visible_text',
    warranty: 'visible_text',
    medicalClaims: 'visible_text'
  },
  allowedClaims: [],
  riskyClaims: ['best performance', 'best seller', 'guaranteed result'],
  forbiddenClaimsWithoutEvidence: ['certified', 'warranty', 'guaranteed'],
  imageTypeGuidance: sharedImageTypeGuidance,
  notes: ['Conservative category fallback rule. Internal risk helper only.']
});

export const categoryRuleRegistry = {
  general: conservativeTemplate('general', 'General Marketplace Product', ['general']),
  electronics_general: {
    ...conservativeTemplate('electronics_general', 'Electronics', ['electronics', 'electronic device', 'gadget']),
    criticalFields: ['model', 'brand', 'interfaceType', 'compatibleDevices', 'packageIncluded'],
    highRiskFields: ['certifications', 'warranty', 'speed', 'waterproof', 'compatibility'],
    evidenceRequiredFields: {
      certifications: 'visible_text',
      warranty: 'visible_text',
      speed: 'visible_text',
      waterproof: 'visible_text',
      compatibility: 'visible_text_or_user_confirmed'
    },
    riskyClaims: ['ultra fast', 'waterproof', 'shockproof', 'universal compatibility', 'guaranteed speed'],
    forbiddenClaimsWithoutEvidence: ['waterproof', 'shockproof', 'CE certified', 'FCC certified', 'up to 1000MB/s']
  },
  electronics_storage: {
    categoryId: 'electronics_storage',
    categoryName: 'Electronics / Storage Devices',
    aliases: [
      'external hard drive',
      'portable hard drive',
      'external SSD',
      'portable SSD',
      'storage device',
      'hard disk',
      'external storage',
      'portable external drive',
      'solid state drive'
    ],
    criticalFields: [
      'capacity',
      'interfaceType',
      'compatibleDevices',
      'dimensions',
      'packageIncluded',
      'material',
      'model',
      'brand'
    ],
    highRiskFields: [
      'capacity',
      'certifications',
      'warranty',
      'speed',
      'waterproof',
      'shockproof',
      'compatibility'
    ],
    evidenceRequiredFields: {
      capacity: 'visible_text',
      certifications: 'visible_text',
      warranty: 'visible_text',
      speed: 'visible_text',
      waterproof: 'visible_text',
      shockproof: 'visible_text',
      compatibility: 'visible_text_or_user_confirmed'
    },
    allowedClaims: [
      'portable',
      'external storage',
      'compact design'
    ],
    riskyClaims: [
      'ultra fast',
      'military grade',
      'waterproof',
      'shockproof',
      'drop proof',
      'universal compatibility',
      'all devices',
      'best performance',
      'guaranteed speed'
    ],
    forbiddenClaimsWithoutEvidence: [
      'waterproof',
      'shockproof',
      'military grade',
      'up to 1000MB/s',
      '5-year warranty',
      'CE certified',
      'FCC certified',
      'RoHS certified',
      'guaranteed speed'
    ],
    imageTypeGuidance: {
      ...sharedImageTypeGuidance,
      size_image: { note: 'Show confirmed dimensions, capacity, interface, or visible specs only.' },
      compatibility_image: { note: 'Avoid universal compatibility; list only confirmed compatible devices.' },
      detail_image: { note: 'Interface and port details need image or user-confirmed evidence.' },
      variant_image: { note: 'Capacity variants require visible text evidence or explicit confirmation.' }
    },
    notes: [
      'Storage products require strict evidence for capacity, speed, warranty, certification, waterproof, shockproof, and broad compatibility claims.',
      'Internal auxiliary category rule only; not official platform approval.'
    ]
  },
  beauty: conservativeTemplate('beauty', 'Beauty', ['beauty', 'cosmetic', 'skincare']),
  apparel: conservativeTemplate('apparel', 'Apparel', ['apparel', 'clothing', 'shirt', 'dress']),
  home: conservativeTemplate('home', 'Home', ['home', 'kitchen', 'household']),
  tools: conservativeTemplate('tools', 'Tools', ['tool', 'hardware']),
  pet: conservativeTemplate('pet', 'Pet Supplies', ['pet', 'dog', 'cat']),
  medical_device: {
    ...conservativeTemplate('medical_device', 'Medical Device', ['medical device', 'health device']),
    highRiskFields: ['medicalClaims', 'certifications', 'warranty', 'effectiveness'],
    forbiddenClaimsWithoutEvidence: ['FDA approved', 'medical grade', 'clinically proven', 'cure', 'treats']
  }
};

