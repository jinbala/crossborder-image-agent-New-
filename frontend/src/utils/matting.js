export const MATING_PROVIDER_OPTIONS = [
  { id: 'sharp', label: 'sharp 本地抠图', enabled: true },
  { id: 'external', label: '第三方抠图', enabled: false },
  { id: 'image2', label: 'Image2 实验性抠图', enabled: false },
  { id: 'auto', label: '自动选择', enabled: true }
];

export function externalMattingEnabled(config = {}) {
  return Boolean(config.externalConfigured);
}

export function image2MattingEnabled(config = {}) {
  return Boolean(config.image2Available);
}

export function mattingImage2Notice(config = {}) {
  if (config.image2Available) {
    return 'Image2 抠图测试可能产生 API 成本，仅在你点击对应按钮时才会调用。Image2 结果为实验性抠图输出，仅用于小样本验证。';
  }
  return 'Image2 未配置，当前仅可使用 sharp 本地抠图，不会产生第三方 API 成本。';
}

export function mattingOutputTypeWarning(outputType) {
  if (!outputType || outputType === 'transparent') return '';
  if (outputType === 'edited-background-removed') {
    return '当前结果为背景移除式编辑输出，不保证为标准透明背景 PNG。';
  }
  return '当前结果为 Image2 实验性抠图输出，请人工复查后再使用。';
}

export function mattingConfigNotice(config = {}) {
  if (config.externalConfigured) {
    return '已检测到第三方抠图配置。只有点击第三方抠图按钮时才会调用，不会自动调用。第三方抠图 API 可能产生费用，请确认后再调用。';
  }
  return '第三方抠图 API 未配置。当前将使用 sharp 本地抠图，不会产生第三方 API 成本。';
}

export function normalizeMattingPayload(input = {}) {
  const safe = input && typeof input === 'object' && !('currentTarget' in input) ? input : {};
  const provider = ['sharp', 'external', 'image2', 'auto'].includes(safe.provider) ? safe.provider : 'sharp';
  return {
    taskId: String(safe.taskId || ''),
    imageId: String(safe.imageId || ''),
    provider
  };
}

export function mattingQualityLabel(quality = {}) {
  if (!quality || quality.score == null) return '质量评分：未知';
  const levelText = {
    good: '较好',
    medium: '一般',
    poor: '较差',
    unknown: '未知'
  }[quality.level] || quality.level || '未知';
  return `质量评分：${quality.score} / 100（${levelText}）`;
}

export function mattingFallbackText(result = {}) {
  if (!result?.fallbackUsed) return '未发生 fallback。';
  return result.fallbackReason || '第三方抠图不可用，已 fallback 到 sharp。';
}

function cardFor(title, result, image) {
  if (!result) {
    return { title, imageUrl: '', statusText: '暂无结果', qualityText: '质量评分：未知', warnings: [] };
  }
  return {
    title,
    imageUrl: result.mattedImage?.previewUrl || result.previewImage?.previewUrl || image?.previewUrl || '',
    statusText: result.message || [result.providerUsed || result.requestedProvider, result.status || 'unknown'].filter(Boolean).join(' '),
    outputType: result.outputType || '',
    metaText: [
      result.requestedProvider ? `requestedProvider=${result.requestedProvider}` : '',
      result.providerUsed ? `providerUsed=${result.providerUsed}` : '',
      result.outputType ? `outputType=${result.outputType}` : '',
      result.fallbackUsed != null ? `fallbackUsed=${Boolean(result.fallbackUsed)}` : '',
      result.fallbackReason ? `fallbackReason=${result.fallbackReason}` : ''
    ].filter(Boolean).join(' / '),
    qualityText: mattingQualityLabel(result.qualityScore),
    warnings: result.qualityScore?.warnings || result.warnings || []
  };
}

export function mattingCompareCards(compare = {}) {
  return [
    {
      title: '原图',
      imageUrl: compare.originalImage?.previewUrl || '',
      statusText: compare.originalImage?.displayName || '原图',
      qualityText: '',
      warnings: []
    },
    cardFor('sharp 抠图结果', compare.sharp),
    cardFor('第三方抠图结果', compare.external),
    cardFor('Image2 实验结果', compare.image2 || compare.image2Result)
  ];
}

function sanitizeString(value) {
  if (typeof value !== 'string') return value;
  return value
    .replace(/[A-Z]:\\[^"',\n\r\t]+/g, (match) => match.split('\\').filter(Boolean).pop() || '[已隐藏本地路径]')
    .replace(/\bsk-[A-Za-z0-9_-]+/g, '[已隐藏敏感密钥]');
}

export function sanitizeMattingDisplay(value) {
  if (Array.isArray(value)) return value.map(sanitizeMattingDisplay);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value)
      .filter(([key]) => !/apiKey|api_key|secret|token|password|localPath|path/i.test(key))
      .map(([key, item]) => [key, sanitizeMattingDisplay(item)]));
  }
  return sanitizeString(value);
}
