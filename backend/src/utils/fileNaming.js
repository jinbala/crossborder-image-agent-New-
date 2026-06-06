const typeLabels = {
  main: 'main',
  selling_points: 'selling-points',
  capacity_size: 'capacity-size',
  lifestyle: 'lifestyle',
  package_list: 'package-list',
  main_image: 'main-image',
  feature_image: 'feature-image',
  size_image: 'size-image',
  compatibility_image: 'compatibility-image',
  lifestyle_image: 'lifestyle-image',
  package_image: 'package-image',
  detail_image: 'detail-image',
  variant_image: 'variant-image'
};

export function sanitizeFilePart(value) {
  return String(value || 'item')
    .trim()
    .replace(/[^a-z0-9]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'item';
}

export function buildImageFileName({ platform, sku, type, index, extension = 'jpg' }) {
  const safePlatform = sanitizeFilePart(platform);
  const safeSku = sanitizeFilePart(sku);
  const safeType = typeLabels[type] || sanitizeFilePart(type);
  return `${safePlatform}_${safeSku}_${String(index).padStart(2, '0')}_${safeType}.${extension}`;
}
