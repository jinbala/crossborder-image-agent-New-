const DEFAULT_CHECKLIST = {
  productShapePreserved: false,
  edgeCleanliness: false,
  interfaceIntegrity: false,
  holeAndPortIntegrity: false,
  texturePreserved: false,
  textReadable: false,
  noChineseText: false,
  noWrongClaims: false,
  platformRulePass: false,
  suitableForMainImage: false,
  suitableForFeatureImage: false,
  suitableForDetailImage: false,
  suitableForNextStage: false,
  notes: ''
};

const DEFAULT_THREE_SAMPLE_CHECKLIST = {
  productShapeConsistency: false,
  textSafetyAcrossSamples: false,
  platformRuleConsistency: false,
  subjectPreservationAcrossSamples: false,
  suitableForNextStage: false,
  notes: ''
};

function sanitizeText(value) {
  return String(value)
    .replace(/\b[A-Z0-9_]*API[_-]?KEY\b\s*[:=]\s*[^\s"',，。；;]+/gi, '[api-key-removed]')
    .replace(/\b[A-Z0-9_]*API[_-]?KEY\b/gi, '[api-key-removed]')
    .replace(/\b(provider[_-]?secret|api[_-]?key|secret)\b\s*[:=]\s*[^\s"',，。；;]+/gi, '[secret-removed]')
    .replace(/\b(?:sk|rk|ak)-[A-Za-z0-9_-]{6,}\b/g, '[secret-removed]')
    .replace(/[A-Z]:\\[^\s"',，。；;]+/gi, '[local-path-removed]')
    .replace(/\.env(?:\.[\w.-]+)?/gi, '[env-file-removed]')
    .replace(/\b[\w.-]*\.sqlite\b/gi, '[sqlite-path-removed]')
    .replace(/\bnode_modules\b/gi, '[node-modules-removed]');
}

function sanitizeValue(value) {
  if (Array.isArray(value)) return value.map(sanitizeValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value)
      .filter(([key]) => !/apiKey|api_key|secret|token|password|absolutePath|subjectPngPath|maskPath/i.test(key))
      .map(([key, item]) => [key, sanitizeValue(item)]));
  }
  if (typeof value === 'string') return sanitizeText(value);
  return value;
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function compactUnique(values = []) {
  return [...new Set(values.filter(Boolean).map((value) => String(value)))];
}

function safeTimestamp(value) {
  return String(value || new Date().toISOString()).replace(/[:.]/g, '-');
}

function sourceImageName(task = {}, generationRequest = {}) {
  const sourceId = generationRequest.productReference?.sourceImageId;
  const sourceImages = asArray(task.sourceImages);
  const source = sourceImages.find((image) => image.id === sourceId) || sourceImages[0] || task.originalImage || {};
  return source.displayName || source.fileName || source.name || '';
}

function confirmedFields(plan = {}, task = {}) {
  if (Array.isArray(plan.usedConfirmedFields)) return plan.usedConfirmedFields;
  const confirmed = task.productInfoConfirmed || task.productInfo || {};
  return Object.entries(confirmed)
    .filter(([, value]) => value !== undefined && value !== null && value !== '')
    .map(([field, value]) => ({ field, value }));
}

function excludedFields(task = {}, plan = {}, key) {
  const summary = plan.generationRequestSummary || {};
  if (Array.isArray(summary[key])) return summary[key];
  if (key === 'blockedFields') {
    return compactUnique([
      ...asArray(summary.blockingIssues).map((item) => item.field || item.code),
      ...asArray(task.recognitionQuality?.blockedHighRisk).map((item) => item.field)
    ]);
  }
  if (key === 'inferredFieldsExcluded') {
    return compactUnique([
      ...asArray(task.inferredCandidates).map((item) => item.field || item.key),
      ...asArray(task.recognitionQuality?.inferredOnly).map((item) => item.field)
    ]);
  }
  if (key === 'conflictedFieldsExcluded') {
    return compactUnique(asArray(task.recognitionQuality?.conflicted).map((item) => item.field));
  }
  return [];
}

function outputType({ image = {}, providerResult = {}, mattingResult = {} }) {
  return image.outputType
    || providerResult.output?.outputType
    || mattingResult.outputType
    || (image.isMockPreview ? 'simulated' : 'real-generated');
}

export function buildSingleImageGenerationFileName({ taskId = 'task', imageType = 'image', timestamp = new Date().toISOString() } = {}) {
  return `single-image-generation-report-${taskId}-${imageType}-${safeTimestamp(timestamp)}.json`;
}

export function buildSingleImageGenerationAcceptanceReport(input = {}) {
  const {
    task = {},
    plan = {},
    image = {},
    providerResult = {},
    mattingResult = {},
    generationRequest = {},
    qualityScore = {},
    templateAudit = {},
    fallbackUsed = false,
    fallbackReason = '',
    warnings = [],
    generatedAt = new Date().toISOString()
  } = input;
  const imageType = plan.type || plan.imageType || image.imageType || image.type || '';
  const ruleAuditSummary = templateAudit.ruleAuditSummary || input.ruleAuditSummary || {};
  const report = {
    meta: {
      reportId: buildSingleImageGenerationFileName({ taskId: task.id, imageType, timestamp: generatedAt }).replace(/\.json$/, ''),
      taskId: task.id,
      sku: task.productInfoConfirmed?.sku || task.productInfo?.sku || task.sku || '',
      productName: task.productInfoConfirmed?.name || task.productInfo?.name || task.productName || '',
      imageType,
      platformId: plan.platformId || task.platformId || '',
      categoryId: plan.categoryId || task.categoryId || '',
      generatedAt,
      testMode: 'single-image-sample',
      providerMode: generationRequest.providerMode || generationRequest.realMode || providerResult.metadata?.generationStrategy?.selectedMode || '',
      mattingProvider: mattingResult.requestedProvider || mattingResult.providerUsed || 'sharp',
      generationProvider: providerResult.provider || image.provider || '',
      modelName: providerResult.model || image.model || '',
      costNotice: '单 SKU 小样本真实生图验收记录，仅用于人工测试；不要批量运行，不上传平台。'
    },
    inputSummary: {
      sourceImageName: sourceImageName(task, generationRequest),
      imagePlanId: plan.id || image.planId || '',
      imageType,
      confirmedFieldsUsed: confirmedFields(plan, task),
      blockedFields: excludedFields(task, plan, 'blockedFields'),
      inferredFieldsExcluded: excludedFields(task, plan, 'inferredFieldsExcluded'),
      conflictedFieldsExcluded: excludedFields(task, plan, 'conflictedFieldsExcluded')
    },
    generationResult: {
      status: image.isMockPreview || image.fallbackToMock ? 'fallback_mock' : (image.status || providerResult.status || ''),
      outputImage: image.url || image.previewUrl || '',
      previewImage: image.previewUrl || image.url || '',
      durationMs: providerResult.durationMs || image.durationMs || 0,
      fallbackUsed: Boolean(fallbackUsed || mattingResult.fallbackUsed || image.fallbackToMock),
      fallbackReason: fallbackReason || mattingResult.fallbackReason || image.fallbackReason || '',
      outputType: outputType({ image, providerResult, mattingResult }),
      warnings: compactUnique([...asArray(warnings), ...asArray(qualityScore.warnings), ...asArray(mattingResult.warnings)]),
      errorMessage: providerResult.error?.message || image.realGenerationError?.message || ''
    },
    qualityScore,
    templateAudit: {
      imageTypeCoverage: templateAudit.imageTypeCoverage || null,
      templateDiversity: templateAudit.templateDiversity || null,
      textSafety: templateAudit.textSafety || null,
      fieldSafety: templateAudit.fieldSafety || null,
      amazonMainImageCheck: templateAudit.amazonMainImageCheck || null,
      summary: templateAudit.summary || templateAudit.meta || null
    },
    ruleAuditSummary: {
      passed: ruleAuditSummary.passed ?? false,
      issueCounts: ruleAuditSummary.issueCounts || { error: 0, warning: 0, info: 0 },
      issues: ruleAuditSummary.issues || [],
      blockedFields: ruleAuditSummary.blockedFields || [],
      cautionFields: ruleAuditSummary.cautionFields || [],
      recommendations: ruleAuditSummary.recommendations || []
    },
    manualChecklist: { ...DEFAULT_CHECKLIST },
    conclusion: {
      keepExperimentalOnly: true,
      allowBatchGeneration: false,
      allowFormalGenerationUse: false,
      recommendedNextAction: '请人工打开生成图，检查产品形状、接口、孔位、纹理和英文文案。未完成人工验收前，不建议扩大真实生图范围。'
    }
  };
  return sanitizeValue(report);
}

function qualityNumber(report = {}) {
  const value = Number(report.qualityScore?.score);
  return Number.isFinite(value) ? value : 0;
}

function durationNumber(report = {}) {
  const value = Number(report.generationResult?.durationMs);
  return Number.isFinite(value) ? value : 0;
}

function isFailed(report = {}) {
  return report.generationResult?.status === 'failed' || report.status === 'failed';
}

function isFallback(report = {}) {
  return Boolean(report.fallbackUsed || report.generationResult?.fallbackUsed || report.singleImageGeneration?.fallbackUsed);
}

function sampleSummary(report = {}, index = 0) {
  return sanitizeValue({
    sampleId: report.sampleId || report.meta?.sampleId || `sample-${index + 1}`,
    imageType: report.meta?.imageType || report.inputSummary?.imageType || report.singleImageGeneration?.imageType || '',
    status: report.generationResult?.status || report.singleImageGeneration?.status || report.status || '',
    provider: report.meta?.generationProvider || report.singleImageGeneration?.providerUsed || '',
    modelName: report.meta?.modelName || report.singleImageGeneration?.model || '',
    mattingProvider: report.meta?.mattingProvider || report.singleImageGeneration?.matting?.providerUsed || '',
    fallbackUsed: isFallback(report),
    fallbackReason: report.generationResult?.fallbackReason || report.singleImageGeneration?.fallbackReason || '',
    outputImage: report.generationResult?.outputImage || report.singleImageGeneration?.previewUrl || '',
    previewImage: report.generationResult?.previewImage || report.singleImageGeneration?.previewUrl || '',
    qualityScore: report.qualityScore || { score: 0, level: 'unknown', warnings: [] },
    warnings: compactUnique([
      ...asArray(report.warnings),
      ...asArray(report.generationResult?.warnings),
      ...asArray(report.qualityScore?.warnings)
    ]),
    templateAudit: report.templateAudit || {},
    ruleAuditSummary: report.ruleAuditSummary || {},
    manualChecklist: report.manualChecklist || { ...DEFAULT_CHECKLIST },
    conclusion: report.conclusion || {
      keepExperimentalOnly: true,
      allowBatchGeneration: false,
      allowFormalGenerationUse: false,
      recommendedNextAction: '请人工检查该样本。'
    }
  });
}

export function buildThreeSampleGenerationFileName({ taskId = 'task', timestamp = new Date().toISOString() } = {}) {
  return `three-sample-generation-report-${taskId}-${safeTimestamp(timestamp)}.json`;
}

export function buildThreeSampleAggregateReport(input = {}) {
  const {
    taskId = '',
    sampleReports = [],
    mattingProvider = 'sharp',
    generationProvider = '',
    confirmPaidApi = false,
    generatedAt = new Date().toISOString()
  } = input;
  const samples = asArray(sampleReports).map(sampleSummary);
  const scores = samples.map(qualityNumber);
  const durations = samples.map(durationNumber);
  const totalDurationMs = durations.reduce((sum, value) => sum + value, 0);
  const successSamples = samples.filter((sample) => !isFailed(sample) && !isFallback(sample));
  const failedSamples = samples.filter(isFailed);
  const fallbackSamples = samples.filter(isFallback);
  const best = samples.reduce((current, sample) => (qualityNumber(sample) > qualityNumber(current) ? sample : current), samples[0] || {});
  const worst = samples.reduce((current, sample) => (qualityNumber(sample) < qualityNumber(current) ? sample : current), samples[0] || {});
  const issueCounts = samples.reduce((counts, sample) => {
    const itemCounts = sample.ruleAuditSummary?.issueCounts || {};
    counts.error += itemCounts.error || 0;
    counts.warning += itemCounts.warning || 0;
    counts.info += itemCounts.info || 0;
    return counts;
  }, { error: 0, warning: 0, info: 0 });
  const report = {
    meta: {
      reportId: buildThreeSampleGenerationFileName({ taskId, timestamp: generatedAt }).replace(/\.json$/, ''),
      taskId,
      generatedAt,
      testMode: 'three-sample-real-generation',
      sampleCount: samples.length,
      imageTypes: samples.map((sample) => sample.imageType).filter(Boolean),
      mattingProvider,
      generationProvider,
      confirmPaidApi: Boolean(confirmPaidApi),
      costNotice: '本次最多生成 3 张真实小样本，可能产生 API 成本。仅用于人工验收，不批量、不上传平台。'
    },
    summary: {
      totalSamples: samples.length,
      successCount: successSamples.length,
      failedCount: failedSamples.length,
      fallbackCount: fallbackSamples.length,
      averageQualityScore: scores.length ? Math.round(scores.reduce((sum, value) => sum + value, 0) / scores.length) : 0,
      lowestQualityScore: scores.length ? Math.min(...scores) : 0,
      highestQualityScore: scores.length ? Math.max(...scores) : 0,
      totalDurationMs,
      averageDurationMs: durations.length ? Math.round(totalDurationMs / durations.length) : 0
    },
    sampleReports: samples,
    comparison: {
      bestSampleId: best.sampleId || '',
      worstSampleId: worst.sampleId || '',
      commonWarnings: compactUnique(samples.flatMap((sample) => asArray(sample.warnings))),
      ruleIssueSummary: issueCounts,
      templateIssueSummary: {
        missingAuditCount: samples.filter((sample) => !sample.templateAudit || Object.keys(sample.templateAudit).length === 0).length
      },
      recommendation: '请人工逐张检查 3 张生成图的主体形状、接口、孔位、纹理、英文文案和平台规则。未完成人工验收前，不建议扩大真实生图范围。'
    },
    manualChecklist: { ...DEFAULT_THREE_SAMPLE_CHECKLIST },
    conclusion: {
      keepExperimentalOnly: true,
      allowBatchGeneration: false,
      allowFormalGenerationUse: false,
      recommendedNextAction: '请人工逐张检查 3 张生成图的主体形状、接口、孔位、纹理、英文文案和平台规则。未完成人工验收前，不建议扩大真实生图范围。'
    }
  };
  return sanitizeValue(report);
}
