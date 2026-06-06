const SECRET_PATTERNS = [
  [/[A-Z]:\\[^\s"',，。；;]+/gi, '[local-path-removed]'],
  [/\b[\w.-]*\.sqlite\b/gi, '[sqlite-path-removed]'],
  [/\bnode_modules\b/gi, '[node-modules-removed]'],
  [/\.env(?:\.[\w.-]+)?/gi, '[env-file-removed]'],
  [/\b[A-Z0-9_]*API[_-]?KEY\b\s*[:=]\s*[^\s"',，。；;]+/gi, '[api-key-removed]'],
  [/\b(provider[_-]?secret|api[_-]?key|secret)\b\s*[:=]\s*[^\s"',，。；;]+/gi, '[secret-removed]'],
  [/\b(?:sk|rk|ak)-[A-Za-z0-9_-]{6,}\b/g, '[secret-removed]']
];

export const singleImageGenerationOptions = [
  { value: 'main_image', label: 'main_image 主图' },
  { value: 'feature_image', label: 'feature_image 卖点图' },
  { value: 'detail_image', label: 'detail_image 细节图' }
];

export const singleImageGenerationNotice = '单 SKU 小样本生成真实生图，初期仅用于测试，不批量，不上传平台。Image2 仅作为实验抠图选项，不默认启用。';
export const singleImageGenerationWarningText = '生成结果已脱敏，不包含 .env、API Key、本机绝对路径。导出内容已脱敏，仅用于人工验收。';

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function safeText(value) {
  let text = String(value ?? '');
  for (const [pattern, replacement] of SECRET_PATTERNS) {
    text = text.replace(pattern, replacement);
  }
  return text;
}

function sanitize(value) {
  if (Array.isArray(value)) return value.map(sanitize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value)
      .filter(([key]) => !/apiKey|api_key|secret|token|password|absolutePath|subjectPngPath|maskPath/i.test(key))
      .map(([key, item]) => [key, sanitize(item)]));
  }
  if (typeof value === 'string') return safeText(value);
  return value;
}

function reportObject(report) {
  return report && typeof report === 'object' ? report : {};
}

function issueCountsFrom(report = {}) {
  const safeReport = reportObject(report);
  return safeReport.issueCounts || safeReport.ruleAuditSummary?.issueCounts || { error: 0, warning: 0, info: 0 };
}

function generationFrom(report = {}) {
  return reportObject(report).singleImageGeneration || {};
}

function imageTypeFrom(report = {}) {
  const safeReport = reportObject(report);
  return safeReport.meta?.imageType || safeReport.generationResult?.imageType || generationFrom(safeReport).imageType || 'main_image';
}

export function singleImageGenerationEmptyText(report) {
  const safeReport = reportObject(report);
  if (!safeReport.singleImageGeneration && !safeReport.generationResult) {
    return '暂无真实生图小样本结果。暂无单图生成报告，请先在生成页运行小样本生成。';
  }
  return '';
}

export function singleImageGenerationSections(report) {
  const safeReport = reportObject(report);
  const generation = generationFrom(safeReport);
  const generationResult = safeReport.generationResult || {};
  const meta = safeReport.meta || {};
  const quality = safeReport.qualityScore || generation?.matting?.qualityScore || {};
  const issueCounts = issueCountsFrom(safeReport);
  const effectiveRules = safeReport.effectiveRulesSummary || safeReport.ruleAuditSummary?.effectiveRulesSummary || {};
  const emptyText = singleImageGenerationEmptyText(safeReport);
  if (emptyText) {
    return {
      emptyText,
      resultText: '',
      auditText: '',
      qualityText: '',
      ruleText: '',
      cards: [],
      warnings: []
    };
  }

  const fallbackUsed = generationResult.fallbackUsed ?? generation.fallbackUsed;
  return {
    emptyText: '',
    resultText: `${imageTypeFrom(safeReport)} / ${generation.providerUsed || meta.generationProvider || '-'} / ${generationResult.status || generation.status || '-'} / ${generationResult.previewImage || generation.previewUrl || '-'}`,
    auditText: `ruleAuditSummary：error ${issueCounts.error || 0} / warning ${issueCounts.warning || 0} / info ${issueCounts.info || 0}`,
    qualityText: `qualityScore：${quality.score ?? 0} / ${quality.level || 'unknown'}`,
    ruleText: `${effectiveRules.mainImageText || ''} ${effectiveRules.secondaryImageText || ''}`.trim(),
    cards: [
      { label: 'imageType', value: imageTypeFrom(safeReport) },
      { label: 'provider', value: generation.providerUsed || meta.generationProvider || '-' },
      { label: 'model', value: generation.model || meta.modelName || '-' },
      { label: 'matting', value: meta.mattingProvider || generation.matting?.providerUsed || generation.matting?.requestedProvider || '-' },
      { label: 'qualityScore', value: String(quality.score ?? 0) },
      { label: 'fallback', value: fallbackUsed ? '是' : '否' }
    ],
    warnings: [
      ...asArray(safeReport.warnings),
      ...asArray(generationResult.warnings),
      ...asArray(quality.warnings)
    ].map(safeText)
  };
}

export function singleImageAcceptanceReportSections(report) {
  const base = singleImageGenerationSections(report);
  if (base.emptyText) {
    return {
      ...base,
      title: '真实生图验收报告',
      statusText: '',
      providerText: '',
      fallbackText: '',
      templateAuditText: '',
      manualChecklistText: '',
      conclusionText: ''
    };
  }
  const safeReport = reportObject(report);
  const meta = safeReport.meta || {};
  const generationResult = safeReport.generationResult || {};
  const generation = generationFrom(safeReport);
  const quality = safeReport.qualityScore || {};
  const issueCounts = issueCountsFrom(safeReport);
  const templateAudit = safeReport.templateAudit || {};
  const checklist = safeReport.manualChecklist || {};
  const conclusion = safeReport.conclusion || {};
  const fallbackUsed = generationResult.fallbackUsed ?? generation.fallbackUsed;
  const uncheckedCount = Object.entries(checklist).filter(([key, value]) => key !== 'notes' && value === false).length;
  const templateKeys = ['imageTypeCoverage', 'templateDiversity', 'textSafety', 'fieldSafety', 'amazonMainImageCheck']
    .filter((key) => templateAudit[key] !== undefined && templateAudit[key] !== null);

  return {
    ...base,
    title: '真实生图验收报告',
    statusText: `生成状态：${generationResult.status || generation.status || '-'} / 图片类型：${imageTypeFrom(safeReport)} / 输出类型：${generationResult.outputType || '-'}`,
    providerText: `Provider：${meta.generationProvider || generation.providerUsed || '-'} / Model：${meta.modelName || generation.model || '-'} / Matting：${meta.mattingProvider || generation.matting?.providerUsed || '-'}`,
    fallbackText: fallbackUsed ? `已触发 fallback：${generationResult.fallbackReason || generation.fallbackReason || '-'}` : 'fallback：未触发',
    qualityText: `qualityScore：${quality.score ?? 0} / ${quality.level || 'unknown'} / warnings：${asArray(quality.warnings).length}`,
    ruleAuditText: `ruleAuditSummary：error ${issueCounts.error || 0} / warning ${issueCounts.warning || 0} / info ${issueCounts.info || 0}`,
    templateAuditText: `templateAudit：${templateKeys.join(' / ') || '暂无模板审计摘要'}`,
    manualChecklistText: `manualChecklist：默认未检查，待人工确认 ${uncheckedCount} 项。`,
    conclusionText: `conclusion：仅保留小样本实验=${conclusion.keepExperimentalOnly !== false} / 不允许批量=${conclusion.allowBatchGeneration === false} / 不进入正式生成=${conclusion.allowFormalGenerationUse === false}。${conclusion.recommendedNextAction || ''}`,
    warnings: base.warnings
  };
}

function fileName(taskId = 'task', imageType = 'image', timestamp = new Date().toISOString()) {
  return `single-image-generation-report-${taskId || 'task'}-${imageType || 'image'}-${timestamp.replace(/[:.]/g, '-')}.json`;
}

export function buildSingleImageGenerationDownload(report, timestamp = new Date().toISOString()) {
  const safeReport = sanitize(report || {});
  const taskId = safeReport.taskId || safeReport.meta?.taskId || safeReport.singleImageGeneration?.taskId || 'task';
  const imageType = safeReport.meta?.imageType || safeReport.generationResult?.imageType || safeReport.singleImageGeneration?.imageType || 'image';
  return {
    fileName: fileName(taskId, imageType, timestamp),
    json: JSON.stringify(safeReport, null, 2)
  };
}

export function downloadSingleImageGenerationJson(report, options = {}) {
  const { fileName: name, json } = buildSingleImageGenerationDownload(report, options.timestamp || new Date().toISOString());
  const BlobCtor = options.BlobCtor || globalThis.Blob;
  const createObjectURL = options.createObjectURL || globalThis.URL?.createObjectURL?.bind(globalThis.URL);
  const revokeObjectURL = options.revokeObjectURL || globalThis.URL?.revokeObjectURL?.bind(globalThis.URL);
  const createElement = options.createElement || globalThis.document?.createElement?.bind(globalThis.document);
  const appendChild = options.appendChild || globalThis.document?.body?.appendChild?.bind(globalThis.document?.body);
  if (!BlobCtor || !createObjectURL || !createElement || !appendChild) {
    return { downloaded: false, reason: 'browser_api_unavailable', fileName: name, json };
  }
  const blob = new BlobCtor([json], { type: 'application/json;charset=utf-8' });
  const url = createObjectURL(blob);
  const link = createElement('a');
  link.href = url;
  link.download = name;
  appendChild(link);
  link.click();
  link.remove?.();
  revokeObjectURL?.(url);
  return { downloaded: true, fileName: name, json, blob };
}

export function threeSampleCanRun({ confirmPaidApi = false, samples = [] } = {}) {
  const sampleCount = Array.isArray(samples) ? samples.length : 0;
  if (!confirmPaidApi) {
    return { canRun: false, reason: '请先确认这是小样本测试，并接受可能产生的 API 成本。' };
  }
  if (sampleCount < 1) {
    return { canRun: false, reason: '请至少选择 1 张样本图片。' };
  }
  if (sampleCount > 3) {
    return { canRun: false, reason: '三张小样本对比最多 3 张样本。' };
  }
  return { canRun: true, reason: '' };
}

export function threeSampleGenerationSections(result) {
  const aggregate = result?.aggregateReport || null;
  if (!aggregate) {
    return {
      emptyText: '暂无三张小样本对比报告。请先选择样本并确认 API 成本提示后运行。',
      title: '三张小样本对比',
      summaryText: '',
      comparisonText: '',
      recommendationText: '',
      sampleCards: []
    };
  }
  const summary = aggregate.summary || result.summary || {};
  const comparison = aggregate.comparison || {};
  const sampleReports = Array.isArray(result.sampleReports) ? result.sampleReports : (aggregate.sampleReports || []);
  return {
    emptyText: '',
    title: '三张小样本对比',
    summaryText: `总数 ${summary.totalSamples || 0} / 成功 ${summary.successCount || 0} / 失败 ${summary.failedCount || 0} / fallback ${summary.fallbackCount || 0} / 平均质量分 ${summary.averageQualityScore ?? 0}`,
    comparisonText: `最佳 ${comparison.bestSampleId || '-'} / 最弱 ${comparison.worstSampleId || '-'} / commonWarnings：${(comparison.commonWarnings || []).join('；') || '无'}`,
    recommendationText: comparison.recommendation || aggregate.conclusion?.recommendedNextAction || '',
    sampleCards: sampleReports.map((sample, index) => {
      const meta = sample.meta || {};
      const generation = sample.generationResult || {};
      const quality = sample.qualityScore || {};
      const issueCounts = sample.ruleAuditSummary?.issueCounts || {};
      return {
        sampleId: sample.sampleId || meta.sampleId || `sample-${index + 1}`,
        imageType: meta.imageType || sample.imageType || '-',
        statusText: `${generation.status || sample.status || '-'} / ${meta.generationProvider || sample.provider || '-'} / ${meta.modelName || sample.modelName || '-'}`,
        fallbackText: generation.fallbackUsed || sample.fallbackUsed ? `fallback：${generation.fallbackReason || sample.fallbackReason || '-'}` : 'fallback：否',
        qualityText: `qualityScore：${quality.score ?? 0} / ${quality.level || 'unknown'}`,
        warningText: [...asArray(generation.warnings), ...asArray(quality.warnings), ...asArray(sample.warnings)].map(safeText).join('；') || '无 warnings',
        ruleAuditText: `ruleAuditSummary：error ${issueCounts.error || 0} / warning ${issueCounts.warning || 0} / info ${issueCounts.info || 0}`,
        conclusionText: sample.conclusion?.recommendedNextAction || aggregate.conclusion?.recommendedNextAction || ''
      };
    })
  };
}

function threeSampleFileName(taskId = 'task', timestamp = new Date().toISOString()) {
  return `three-sample-generation-report-${taskId || 'task'}-${timestamp.replace(/[:.]/g, '-')}.json`;
}

export function buildThreeSampleGenerationDownload(result, timestamp = new Date().toISOString()) {
  const safeResult = sanitize(result || {});
  const taskId = safeResult.aggregateReport?.meta?.taskId || safeResult.taskId || 'task';
  return {
    fileName: threeSampleFileName(taskId, timestamp),
    json: JSON.stringify(safeResult, null, 2)
  };
}

export function downloadThreeSampleGenerationJson(result, options = {}) {
  const { fileName: name, json } = buildThreeSampleGenerationDownload(result, options.timestamp || new Date().toISOString());
  const BlobCtor = options.BlobCtor || globalThis.Blob;
  const createObjectURL = options.createObjectURL || globalThis.URL?.createObjectURL?.bind(globalThis.URL);
  const revokeObjectURL = options.revokeObjectURL || globalThis.URL?.revokeObjectURL?.bind(globalThis.URL);
  const createElement = options.createElement || globalThis.document?.createElement?.bind(globalThis.document);
  const appendChild = options.appendChild || globalThis.document?.body?.appendChild?.bind(globalThis.document?.body);
  if (!BlobCtor || !createObjectURL || !createElement || !appendChild) {
    return { downloaded: false, reason: 'browser_api_unavailable', fileName: name, json };
  }
  const blob = new BlobCtor([json], { type: 'application/json;charset=utf-8' });
  const url = createObjectURL(blob);
  const link = createElement('a');
  link.href = url;
  link.download = name;
  appendChild(link);
  link.click();
  link.remove?.();
  revokeObjectURL?.(url);
  return { downloaded: true, fileName: name, json, blob };
}
