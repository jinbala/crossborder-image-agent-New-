export function getImageSourceStatus(image = {}) {
  if (image.fallbackToMock) {
    return {
      key: 'fallback',
      label: 'FALLBACK MOCK',
      title: '真实生成失败，已回退 mock',
      description: '该图不是真实生成结果，请检查错误摘要。',
      className: 'border-red-200 bg-red-50 text-red-700'
    };
  }

  if (image.isRealGenerated) {
    return {
      key: 'real',
      label: 'REAL GENERATED',
      title: '真实生成图',
      description: '由真实图片 Provider 生成，仍建议人工审核。',
      className: 'border-emerald-200 bg-emerald-50 text-emerald-700'
    };
  }

  return {
    key: 'mock',
    label: 'MOCK PREVIEW',
    title: 'mock 预览图',
    description: '仅用于流程测试，不代表真实平台可上传结果。',
    className: 'border-amber-200 bg-amber-50 text-amber-700'
  };
}

export function summarizeImageSources(images = []) {
  const providers = [...new Set(images.map((image) => image.provider).filter(Boolean))].sort();
  return {
    totalImages: images.length,
    mockPreviewCount: images.filter((image) => (image.isMockPreview || image.provider === 'mock') && !image.fallbackToMock).length,
    realGeneratedCount: images.filter((image) => image.isRealGenerated).length,
    fallbackMockCount: images.filter((image) => image.fallbackToMock).length,
    providers
  };
}

export function imageSourceNotice(summary) {
  if (!summary.totalImages) return '';
  if (summary.fallbackMockCount > 0) {
    return '部分真实生成失败，已回退 mock，请检查 fallback 错误信息。';
  }
  if (summary.realGeneratedCount > 0 && summary.mockPreviewCount > 0) {
    return '当前图片包包含 mock 预览图和真实生成图。mock 图片仅用于流程预览，真实生成图已标记 isRealGenerated=true。';
  }
  if (summary.realGeneratedCount === summary.totalImages) {
    return '当前导出的图片均为真实生成图，请仍进行人工审核。';
  }
  return '当前导出的图片均为 mock 预览图，不代表真实平台可上传结果。';
}
