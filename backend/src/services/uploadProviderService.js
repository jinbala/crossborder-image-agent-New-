const PROVIDERS = {
  temu: {
    platformId: 'temu',
    platformName: 'Temu',
    provider: 'dryRun',
    providerName: 'Temu dry-run upload readiness provider',
    mode: 'dryRun',
    supportsDryRun: true,
    supportsRealUpload: false,
    realUploadEnabled: false,
    placeholder: false,
    requiredFields: ['sku', 'product_name', 'category', 'main_image'],
    requiredImages: ['main_image'],
    suggestedFields: ['product_description', 'selling_point_1', 'gallery_image_1'],
    notes: ['Dry-run only. No seller-center API is called.']
  },
  miaoshou: {
    platformId: 'miaoshou',
    platformName: '妙手',
    provider: 'dryRun',
    providerName: 'Miaoshou dry-run upload readiness provider',
    mode: 'dryRun',
    supportsDryRun: true,
    supportsRealUpload: false,
    realUploadEnabled: false,
    placeholder: false,
    requiredFields: ['sku', 'product_name_or_title', 'category', 'main_image', 'gallery_image_1', 'listing_csv_row'],
    requiredImages: ['main_image', 'gallery_image_1'],
    suggestedFields: ['product_description', 'selling_point_1'],
    notes: ['Dry-run only. It only checks handoff readiness.']
  },
  amazon: {
    platformId: 'amazon',
    platformName: 'Amazon',
    provider: 'placeholder',
    providerName: 'Amazon reserved dry-run placeholder',
    mode: 'dryRun',
    supportsDryRun: true,
    supportsRealUpload: false,
    realUploadEnabled: false,
    placeholder: true,
    requiredFields: ['sku', 'product_title', 'category', 'main_image'],
    requiredImages: ['main_image'],
    suggestedFields: ['brand', 'product_description'],
    notes: ['Reserved for later provider mapping.']
  },
  noon: {
    platformId: 'noon',
    platformName: 'Noon',
    provider: 'placeholder',
    providerName: 'Noon reserved dry-run placeholder',
    mode: 'dryRun',
    supportsDryRun: true,
    supportsRealUpload: false,
    realUploadEnabled: false,
    placeholder: true,
    requiredFields: ['sku', 'product_name', 'category', 'main_image'],
    requiredImages: ['main_image'],
    suggestedFields: [],
    notes: ['Reserved for later provider mapping.']
  },
  ozon: {
    platformId: 'ozon',
    platformName: 'Ozon',
    provider: 'placeholder',
    providerName: 'Ozon reserved dry-run placeholder',
    mode: 'dryRun',
    supportsDryRun: true,
    supportsRealUpload: false,
    realUploadEnabled: false,
    placeholder: true,
    requiredFields: ['sku', 'product_name', 'category', 'main_image'],
    requiredImages: ['main_image'],
    suggestedFields: [],
    notes: ['Reserved for later provider mapping.']
  },
  rakuten: {
    platformId: 'rakuten',
    platformName: 'Rakuten',
    provider: 'placeholder',
    providerName: 'Rakuten reserved dry-run placeholder',
    mode: 'dryRun',
    supportsDryRun: true,
    supportsRealUpload: false,
    realUploadEnabled: false,
    placeholder: true,
    requiredFields: ['sku', 'product_name', 'category', 'main_image'],
    requiredImages: ['main_image'],
    suggestedFields: [],
    notes: ['Reserved for later provider mapping.']
  }
};

function cloneProvider(provider) {
  return {
    ...provider,
    requiredFields: [...(provider.requiredFields || [])],
    requiredImages: [...(provider.requiredImages || [])],
    suggestedFields: [...(provider.suggestedFields || [])],
    notes: [...(provider.notes || [])]
  };
}

export function normalizeUploadPlatformId(platformId) {
  const value = String(platformId || '').trim().toLowerCase();
  return value || 'temu';
}

export function getUploadProvider(platformId) {
  const normalized = normalizeUploadPlatformId(platformId);
  return cloneProvider(PROVIDERS[normalized] || {
    platformId: normalized,
    platformName: normalized || 'Unknown',
    provider: 'placeholder',
    providerName: 'Reserved dry-run placeholder',
    mode: 'dryRun',
    supportsDryRun: true,
    supportsRealUpload: false,
    realUploadEnabled: false,
    placeholder: true,
    requiredFields: ['sku', 'product_name', 'category', 'main_image'],
    requiredImages: ['main_image'],
    suggestedFields: [],
    notes: ['Reserved for later provider mapping.']
  });
}

export function listUploadProviders() {
  return Object.keys(PROVIDERS).map((platformId) => getUploadProvider(platformId));
}

export function normalizeUploadPlatforms(platforms = []) {
  const raw = Array.isArray(platforms) ? platforms : String(platforms || '').split(',');
  const values = raw
    .flatMap((item) => String(item || '').split(','))
    .map(normalizeUploadPlatformId)
    .filter(Boolean);
  const allowed = new Set(Object.keys(PROVIDERS));
  const unique = [...new Set(values)].filter((platformId) => allowed.has(platformId));
  return unique.length ? unique : ['temu', 'miaoshou'];
}
