const QUALITY_LEVELS = ['good', 'medium', 'poor', 'unknown'];

function clampScore(value) {
  return Math.max(0, Math.min(100, Math.round(Number(value) || 0)));
}

function inferStrategy(image = {}) {
  if (image.realGenerationMode) return image.realGenerationMode;
  if (image.subjectCompositeUsed) return 'subject_composite';
  if (image.editSucceeded || image.editAttempted) return 'image_edit';
  if (image.isRealGenerated) return 'text_to_image';
  return 'mock';
}

function levelFromScore(score) {
  if (score >= 75) return 'good';
  if (score >= 50) return 'medium';
  return 'poor';
}

function cleanWarnings(image = {}) {
  return Array.isArray(image.mattingWarnings) ? image.mattingWarnings.filter(Boolean) : [];
}

export function assessCompositeQuality(image = {}) {
  const strategy = inferStrategy(image);
  if (strategy !== 'subject_composite') {
    return {
      level: 'unknown',
      subjectPlacementRisk: 'medium',
      edgeBlendRisk: 'medium',
      shadowRisk: 'medium',
      reasons: ['Composite quality applies only to subject_composite results.'],
      suggestions: []
    };
  }
  const settings = image.compositeSettings || {};
  const reasons = [];
  const suggestions = [];
  let score = 70;
  const scale = Number(settings.scale ?? image.subjectScale ?? 0.72);
  const offsetX = Math.abs(Number(settings.offsetX || 0));
  const offsetY = Math.abs(Number(settings.offsetY || 0));
  if (scale < 0.45 || scale > 0.95) {
    score -= scale < 0.35 || scale > 1 ? 25 : 12;
    reasons.push('Subject scale may be too small or too large.');
    suggestions.push('Adjust subject size to roughly 55%-80%.');
  }
  if (offsetX > 240 || offsetY > 240) {
    score -= 18;
    reasons.push('Subject offset is close to the edge.');
    suggestions.push('Move the product closer to the composition center.');
  }
  if (image.edgeQuality === 'poor') {
    score -= 26;
    reasons.push('Matting edge quality is poor.');
    suggestions.push('Use a cleaner product reference or external matting.');
  } else if (image.edgeQuality === 'good') {
    score += 10;
    reasons.push('Matting edge quality is good.');
  }
  if (settings.shadowEnabled === false) {
    score -= 10;
    reasons.push('Shadow is disabled.');
    suggestions.push('Enable soft contact shadow for desk scenes.');
  } else {
    score += 8;
    reasons.push('Shadow is enabled.');
  }
  if (Number(settings.edgeFeather || 0) > 0) score += 4;
  const level = levelFromScore(clampScore(score));
  return {
    level,
    subjectPlacementRisk: (scale < 0.35 || scale > 1 || offsetX > 260 || offsetY > 260) ? 'high' : (scale < 0.45 || scale > 0.95 || offsetX > 180 || offsetY > 180) ? 'medium' : 'low',
    edgeBlendRisk: image.edgeQuality === 'poor' ? 'high' : image.edgeQuality === 'medium' ? 'medium' : 'low',
    shadowRisk: settings.shadowEnabled === false ? 'medium' : 'low',
    reasons,
    suggestions
  };
}

export function assessProductPreserveQuality(image = {}) {
  const strategy = inferStrategy(image);
  const reasons = [];
  const suggestions = [];

  if (strategy === 'mock' || image.isMockPreview) {
    return {
      qualityScore: 0,
      qualityLevel: 'unknown',
      strategy: 'mock',
      subjectPreserveRisk: 'high',
      backgroundRisk: 'medium',
      textRisk: 'medium',
      reasons: ['Mock preview cannot be used to evaluate real product preservation.'],
      suggestions: ['Use a real lifestyle generation mode and manually review the result before marketplace use.'],
      compositeQuality: assessCompositeQuality({ ...image, realGenerationMode: 'mock' })
    };
  }

  if (strategy === 'text_to_image') {
    return {
      qualityScore: 35,
      qualityLevel: 'poor',
      strategy,
      subjectPreserveRisk: 'high',
      backgroundRisk: 'medium',
      textRisk: 'low',
      reasons: ['Text-to-image does not strictly preserve the uploaded product appearance.'],
      suggestions: ['Use subject_composite with a clean white-background product image when product fidelity matters.'],
      compositeQuality: assessCompositeQuality(image)
    };
  }

  if (strategy === 'image_edit') {
    const score = clampScore((image.productReferenceUsed ? 58 : 45) + (image.editSucceeded ? 18 : 0));
    return {
      qualityScore: score,
      qualityLevel: levelFromScore(score),
      strategy,
      subjectPreserveRisk: 'medium',
      backgroundRisk: 'low',
      textRisk: 'low',
      reasons: [
        image.productReferenceUsed
          ? 'Image edit used a product reference, but the model may still redraw product details.'
          : 'Image edit did not use a product reference.'
      ],
      suggestions: ['Manually check shape, color, ports, logo, texture, and product proportions.'],
      compositeQuality: assessCompositeQuality(image)
    };
  }

  const warnings = cleanWarnings(image);
  let score = 55 + Math.round((Number(image.mattingConfidence) || 0) * 25);
  if (image.edgeQuality === 'good') score += 12;
  if (image.edgeQuality === 'medium') score += 4;
  if (image.edgeQuality === 'poor') score -= 22;
  if (['plain', 'light'].includes(image.backgroundType)) score += 8;
  if (image.backgroundType === 'complex') score -= 14;
  for (const warning of warnings) {
    if (warning === 'complex_background_detected') score -= 8;
    if (warning === 'low_edge_confidence') score -= 12;
    if (warning === 'manual_review_recommended') score -= 6;
  }
  score = clampScore(score);

  if ((Number(image.mattingConfidence) || 0) >= 0.75) reasons.push('Matting confidence is high.');
  if (image.edgeQuality === 'good') reasons.push('Subject edge quality is good.');
  if (image.edgeQuality === 'poor') reasons.push('Subject edge quality is poor.');
  if (image.backgroundType === 'complex') reasons.push('Reference image background is complex.');
  if (warnings.length) reasons.push(`Matting warnings: ${warnings.join(', ')}`);

  const qualityLevel = levelFromScore(score);
  if (qualityLevel !== 'good') {
    suggestions.push('Use a white-background or clean-background main image and regenerate.');
  }
  if (image.edgeQuality === 'poor') {
    suggestions.push('Try image_edit if the cutout edge remains rough.');
  }
  suggestions.push('Manual review is still required before marketplace upload.');

  return {
    qualityScore: score,
    qualityLevel,
    strategy: 'subject_composite',
    subjectPreserveRisk: qualityLevel === 'good' ? 'low' : qualityLevel === 'medium' ? 'medium' : 'high',
    backgroundRisk: image.backgroundType === 'complex' ? 'medium' : 'low',
    textRisk: 'low',
    reasons,
    suggestions,
    compositeQuality: assessCompositeQuality(image)
  };
}

export function recommendGenerationStrategy({ plan, generationRequest, mattingResult } = {}) {
  const blockingIssues = generationRequest?.providerHints?.blockingIssues || [];
  if (plan?.type && plan.type !== 'lifestyle_image') {
    return {
      recommendedMode: 'mock',
      reason: 'Only lifestyle_image supports real background generation.',
      alternatives: [],
      blockingIssues: ['Only lifestyle_image supports real background generation.'],
      userMessage: '当前图片类型不支持真实背景生成，建议继续使用 mock 预览。'
    };
  }
  if (generationRequest?.providerHints?.safeForRealGeneration === false) {
    return {
      recommendedMode: 'mock',
      reason: 'The generation request is not safe for real generation.',
      alternatives: ['Fix blocking issues', 'Generate mock preview'],
      blockingIssues,
      userMessage: '当前方案存在安全阻断项，建议先修正后再尝试真实生图。'
    };
  }
  if (!generationRequest?.productReference?.enabled) {
    return {
      recommendedMode: 'text_to_image',
      reason: 'No product reference image is available.',
      alternatives: ['mock'],
      blockingIssues: ['NO_PRODUCT_REFERENCE'],
      userMessage: '缺少商品参考图，纯场景生成不保证商品主体保真。'
    };
  }

  const edgeQuality = mattingResult?.metadata?.edgeQuality;
  const backgroundType = mattingResult?.metadata?.backgroundType;
  const warnings = mattingResult?.metadata?.warnings || [];
  if (edgeQuality === 'poor' || backgroundType === 'complex' || warnings.includes('low_edge_confidence')) {
    return {
      recommendedMode: 'image_edit',
      reason: 'The reference image has complex background or weak cutout edges.',
      alternatives: ['subject_composite', 'text_to_image', 'mock'],
      blockingIssues: [],
      userMessage: '参考图背景较复杂或边缘质量较弱，建议尝试 image edit，或换白底主图后再主体合成。'
    };
  }

  return {
    recommendedMode: 'subject_composite',
    reason: 'A product reference is available and no blocking quality issue is known.',
    alternatives: ['image_edit', 'text_to_image', 'mock'],
    blockingIssues: [],
    userMessage: '建议使用主体合成：商品主体来自原图，背景由 AI 生成。'
  };
}

export function buildGenerationStrategy({ selectedMode, generationRequest, plan, mattingResult } = {}) {
  const recommendation = recommendGenerationStrategy({ generationRequest, plan, mattingResult });
  return {
    selectedMode: selectedMode || recommendation.recommendedMode,
    recommendedMode: recommendation.recommendedMode,
    reason: recommendation.reason,
    alternatives: recommendation.alternatives,
    blockingIssues: recommendation.blockingIssues,
    userMessage: recommendation.userMessage
  };
}

export function buildGenerationQualitySummary(images = []) {
  const summary = {
    goodCount: 0,
    mediumCount: 0,
    poorCount: 0,
    unknownCount: 0,
    subjectCompositeCount: 0,
    imageEditCount: 0,
    textToImageCount: 0,
    mockCount: 0
  };
  for (const image of images) {
    const level = QUALITY_LEVELS.includes(image.preserveQuality?.qualityLevel)
      ? image.preserveQuality.qualityLevel
      : assessProductPreserveQuality(image).qualityLevel;
    summary[`${level}Count`] += 1;

    const selectedMode = image.generationStrategy?.selectedMode || inferStrategy(image);
    if (selectedMode === 'subject_composite') summary.subjectCompositeCount += 1;
    else if (selectedMode === 'image_edit') summary.imageEditCount += 1;
    else if (selectedMode === 'text_to_image') summary.textToImageCount += 1;
    else summary.mockCount += 1;
  }
  return summary;
}
