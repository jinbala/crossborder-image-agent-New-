const IMAGE_TYPE_ORDER = [
  ['main_image', '01_main.jpg'],
  ['feature_image', '02_feature.jpg'],
  ['size_image', '03_size.jpg'],
  ['compatibility_image', '04_compatibility.jpg'],
  ['package_image', '05_package.jpg'],
  ['lifestyle_image', '06_lifestyle.jpg'],
  ['detail_image', '07_detail.jpg'],
  ['variant_image', '08_variant.jpg']
];

const PLATFORM_FOLDERS = {
  amazon: 'Amazon',
  temu: 'Temu',
  noon: 'Noon',
  ozon: 'Ozon',
  rakuten: 'Rakuten'
};

const SECRET_PATTERNS = [
  [/\b[A-Z0-9_]*API[_-]?KEY\b\s*[:=]\s*[^\s"',，。；;]+/gi, '[api-key-removed]'],
  [/\b(provider[_-]?secret|api[_-]?key|secret|token|password)\b\s*[:=]\s*[^\s"',，。；;]+/gi, '[secret-removed]'],
  [/\b(?:sk|rk|ak)-[A-Za-z0-9_-]{6,}\b/g, '[secret-removed]'],
  [/[A-Z]:\\[^\s"',，。；;]+/gi, '[local-path-removed]'],
  [/\.env(?:\.[\w.-]+)?/gi, '[env-file-removed]'],
  [/\b[\w.-]*\.sqlite\b/gi, '[sqlite-path-removed]'],
  [/\bnode_modules\b/gi, '[node-modules-removed]']
];

export { IMAGE_TYPE_ORDER };

export function asArray(value) {
  return Array.isArray(value) ? value : value ? [value] : [];
}

export function sanitizeText(value) {
  let text = String(value ?? '');
  for (const [pattern, replacement] of SECRET_PATTERNS) {
    text = text.replace(pattern, replacement);
  }
  return text;
}

export function sanitizeValue(value) {
  if (Array.isArray(value)) return value.map(sanitizeValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value)
      .filter(([key]) => !/apiKey|api_key|secret|token|password|absolutePath|sourceFolderPath|sqlitePath|dbPath/i.test(key))
      .map(([key, item]) => [key, sanitizeValue(item)]));
  }
  if (typeof value === 'string') return sanitizeText(value);
  return value;
}

export function safeSegment(value, fallback = 'item') {
  const sanitized = sanitizeText(value || fallback)
    .replace(/[/\\:*?"<>|]+/g, '-')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return sanitized || fallback;
}

export function normalizePlatforms(platforms = []) {
  const values = asArray(platforms)
    .flatMap((item) => String(item || '').split(','))
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
  const unique = [...new Set(values)];
  return unique.length ? unique : ['amazon'];
}

export function platformFolder(platformId) {
  return PLATFORM_FOLDERS[String(platformId || '').toLowerCase()] || safeSegment(platformId || 'marketplace', 'Marketplace');
}

export function skuValue(task = {}, skuTask = {}) {
  return task.productInfoConfirmed?.sku || task.productInfo?.sku || task.sku || skuTask.skuId || task.id || 'SKU';
}

export function imageTypeFileName(imageType) {
  return IMAGE_TYPE_ORDER.find(([type]) => type === imageType)?.[1] || `${safeSegment(imageType, 'image')}.jpg`;
}

export function sourceTypeForImage(image = {}) {
  if (!image || !Object.keys(image).length) return 'missing';
  if (image.sourceType) return image.sourceType;
  if (image.fallbackToMock) return 'fallbackMock';
  if (image.isMockPreview || image.provider === 'mock' || image.mockPreview) return 'mock';
  if (image.isRealGenerated || image.realMode || image.provider === 'openai') return 'real';
  return 'generated';
}

export function csvEscape(value) {
  const text = sanitizeText(value ?? '');
  if (/[",\n\r]/.test(text)) return `"${text.replaceAll('"', '""')}"`;
  return text;
}

export function toCsv(rows = [], columns = []) {
  return [
    columns.join(','),
    ...rows.map((row) => columns.map((column) => csvEscape(row[column])).join(','))
  ].join('\n');
}
