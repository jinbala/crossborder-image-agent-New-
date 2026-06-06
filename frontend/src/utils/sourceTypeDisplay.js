const displayMap = {
  mockPreview: {
    label: 'mock preview',
    description: 'mock 预览图，仅用于流程预览'
  },
  realGenerated: {
    label: 'real generated',
    description: '真实生成图，需人工复核后使用'
  },
  fallbackMock: {
    label: 'fallback mock',
    description: '真实生成失败后的 mock 回退图'
  },
  realSample: {
    label: 'real sample',
    description: '真实小样本测试图'
  },
  missing: {
    label: 'missing',
    description: '缺失图片'
  },
  unknown: {
    label: 'unknown',
    description: '未知来源'
  }
};

export function normalizeSourceTypeForDisplay(sourceType = '') {
  const value = String(sourceType || '').trim();
  if (['mock', 'mockPreview', 'mock_preview'].includes(value)) return 'mockPreview';
  if (['real', 'realGenerated', 'generated', 'real_generated'].includes(value)) return 'realGenerated';
  if (['fallbackMock', 'fallback_mock'].includes(value)) return 'fallbackMock';
  if (value === 'realSample') return 'realSample';
  if (value === 'missing') return 'missing';
  return 'unknown';
}

export function getSourceTypeDisplay(sourceType = '') {
  const key = normalizeSourceTypeForDisplay(sourceType);
  return {
    raw: sourceType,
    key,
    ...displayMap[key]
  };
}
