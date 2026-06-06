const chinesePattern = /[\u3400-\u9fff]/;
const pricePattern = /([$]|USD|EUR|AED|SAR|JPY|RUB|\d+\.\d{2})/i;
const watermarkPattern = /(watermark|sample|preview)/i;
const logoPattern = /(nike|adidas|apple|disney|starbucks|coca-cola)/i;
const certificationPattern = /\b(fda|ce|ul certified|organic certified)\b/i;

function statusFor(condition) {
  return condition ? 'failed' : 'passed';
}

export function reviewGeneratedImage(image, meta = {}) {
  const text = `${image.fileName} ${image.title || ''}`;
  const checks = {
    noChinese: { label: 'No Chinese text', status: statusFor(chinesePattern.test(text)) },
    noWatermark: { label: 'No watermark', status: statusFor(watermarkPattern.test(text)) },
    noPrice: { label: 'No price text', status: statusFor(pricePattern.test(text)) },
    noViolatingLogo: { label: 'No violating logo', status: statusFor(logoPattern.test(text)) },
    noFakeCertification: { label: 'No false certification', status: statusFor(certificationPattern.test(text)) },
    mainImageRule: {
      label: 'Platform main image rule',
      status: image.type === 'main_image' && /text callout|props|price/i.test(text) ? 'failed' : 'passed'
    }
  };
  const status = Object.values(checks).every((check) => check.status === 'passed') ? 'passed' : 'failed';
  const issues = Object.values(checks)
    .filter((check) => check.status === 'failed')
    .map((check) => check.label);

  return {
    id: `${image.id}-review`,
    imageId: image.id,
    planId: image.planId,
    fileName: image.fileName,
    type: image.type,
    isMockPreview: Boolean(image.isMockPreview || image.provider === 'mock'),
    isRealGenerated: Boolean(image.isRealGenerated),
    fallbackToMock: Boolean(image.fallbackToMock),
    realGenerationError: image.realGenerationError || null,
    productReferenceUsed: Boolean(image.productReferenceUsed),
    productReferenceSelectedBy: image.productReferenceSelectedBy || null,
    productReferenceOverride: image.productReferenceOverride || null,
    realBackgroundOnly: Boolean(image.realBackgroundOnly),
    realGenerationMode: image.realGenerationMode || (image.isRealGenerated ? 'text_to_image' : 'mock'),
    subjectCompositeUsed: Boolean(image.subjectCompositeUsed),
    subjectPreserved: Boolean(image.subjectPreserved),
    backgroundGenerated: Boolean(image.backgroundGenerated),
    productGeneratedByAI: image.productGeneratedByAI ?? null,
    fallbackChain: image.fallbackChain || [],
    mattingProvider: image.mattingProvider || null,
    mattingModel: image.mattingModel || null,
    mattingMethod: image.mattingMethod || null,
    mattingConfidence: image.mattingConfidence ?? null,
    edgeQuality: image.edgeQuality || null,
    backgroundType: image.backgroundType || null,
    mattingWarnings: image.mattingWarnings || [],
    mattingFallbackToSharp: Boolean(image.mattingFallbackToSharp),
    externalMattingError: image.externalMattingError || null,
    subjectPngPath: image.subjectPngPath || null,
    maskPath: image.maskPath || null,
    mattingPreviewUsed: Boolean(image.mattingPreviewUsed),
    compositeSettings: image.compositeSettings || null,
    compositeQuality: image.compositeQuality || image.preserveQuality?.compositeQuality || null,
    compositeMode: image.compositeMode || null,
    subjectScale: image.subjectScale ?? null,
    subjectPlacement: image.subjectPlacement || null,
    shadowApplied: Boolean(image.shadowApplied),
    edgeFeatherApplied: Boolean(image.edgeFeatherApplied),
    colorMatchApplied: Boolean(image.colorMatchApplied),
    preserveQuality: image.preserveQuality || null,
    generationStrategy: image.generationStrategy || null,
    editAttempted: Boolean(image.editAttempted),
    editSucceeded: Boolean(image.editSucceeded),
    editFailed: Boolean(image.editFailed),
    fallbackMode: image.fallbackMode || null,
    productReference: image.productReference || null,
    referencePreprocess: image.referencePreprocess || null,
    mockPreviewNotice: image.isMockPreview || image.provider === 'mock'
      ? 'Current image is a mock preview and does not represent final marketplace compliance.'
      : '',
    status,
    riskLevel: status === 'passed' ? 'low' : 'medium',
    issues,
    fixSuggestions: issues.map((issue) => `Fix: ${issue}`),
    checks,
    provider: meta.provider || 'mock',
    model: meta.model || 'mock-review-v0.2',
    durationMs: meta.durationMs ?? 0
  };
}

export function reviewGeneratedImages(task) {
  if (!task.generatedImages?.length) {
    const error = new Error('Generated images are required before review');
    error.statusCode = 400;
    throw error;
  }

  const items = task.generatedImages.map((image) => reviewGeneratedImage(image));

  return {
    reviewedAt: new Date().toISOString(),
    overallStatus: items.every((item) => item.status === 'passed') ? 'passed' : 'failed',
    items
  };
}
