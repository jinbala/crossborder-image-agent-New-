import { reportDisplayLabel, reportUi } from './reportDisplayLabels.js';
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

export function singleImageGenerationEmptyText(report, t) {
  const safeReport = reportObject(report);
  if (!safeReport.singleImageGeneration && !safeReport.generationResult) {
    return reportUi(t)('暂无真实生图小样本结果。暂无单图生成报告，请先在生成页运行小样本生成。');
  }
  return '';
}

export function singleImageGenerationSections(report, t) {
  const ui = reportUi(t), label = (kind, value) => reportDisplayLabel(kind, value, t);
  const safeReport = reportObject(report);
  const generation = generationFrom(safeReport);
  const generationResult = safeReport.generationResult || {};
  const meta = safeReport.meta || {};
  const quality = safeReport.qualityScore || generation?.matting?.qualityScore || {};
  const issueCounts = issueCountsFrom(safeReport);
  const effectiveRules = safeReport.effectiveRulesSummary || safeReport.ruleAuditSummary?.effectiveRulesSummary || {};
  const emptyText = singleImageGenerationEmptyText(safeReport, t);
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
    resultText: `${label('imageType', imageTypeFrom(safeReport))} / ${generation.providerUsed || meta.generationProvider || '-'} / ${label('status', generationResult.status || generation.status || '-')} / ${generationResult.previewImage || generation.previewUrl || '-'}`,
    auditText: ui('ruleAuditSummary：error {error} / warning {warning} / info {info}', { error: issueCounts.error || 0, warning: issueCounts.warning || 0, info: issueCounts.info || 0 }),
    qualityText: ui('qualityScore：{score} / {level}', { score: quality.score ?? 0, level: label('quality', quality.level || 'unknown') }),
    ruleText: `${effectiveRules.mainImageText || ''} ${effectiveRules.secondaryImageText || ''}`.trim(),
    cards: [
      { label: 'imageType', value: label('imageType', imageTypeFrom(safeReport)) },
      { label: 'provider', value: generation.providerUsed || meta.generationProvider || '-' },
      { label: 'model', value: generation.model || meta.modelName || '-' },
      { label: 'matting', value: meta.mattingProvider || generation.matting?.providerUsed || generation.matting?.requestedProvider || '-' },
      { label: 'qualityScore', value: String(quality.score ?? 0) },
      { label: 'fallback', value: ui(fallbackUsed ? '是' : '否') }
    ].map(card => ({ ...card, label: t ? ui(({ imageType: '图片类型', provider: 'Provider', model: '模型', matting: '抠图', qualityScore: '质量分', fallback: '回退' })[card.label]) : card.label })),
    warnings: [
      ...asArray(safeReport.warnings),
      ...asArray(generationResult.warnings),
      ...asArray(quality.warnings)
    ].map(safeText)
  };
}

export function singleImageAcceptanceReportSections(report, t) {
  const ui = reportUi(t), label = (kind, value) => reportDisplayLabel(kind, value, t);
  const base = singleImageGenerationSections(report, t);
  if (base.emptyText) {
    return {
      ...base,
      title: ui('真实生图验收报告'),
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
    title: ui('真实生图验收报告'),
    statusText: ui('生成状态：{status} / 图片类型：{type} / 输出类型：{output}', { status: label('status', generationResult.status || generation.status || '-'), type: label('imageType', imageTypeFrom(safeReport)), output: generationResult.outputType || '-' }),
    providerText: ui('Provider：{provider} / Model：{model} / Matting：{matting}', { provider: meta.generationProvider || generation.providerUsed || '-', model: meta.modelName || generation.model || '-', matting: meta.mattingProvider || generation.matting?.providerUsed || '-' }),
    fallbackText: fallbackUsed ? ui('已触发 fallback：{reason}', { reason: generationResult.fallbackReason || generation.fallbackReason || '-' }) : ui('fallback：未触发'),
    qualityText: ui('qualityScore：{score} / {level} / warnings：{count}', { score: quality.score ?? 0, level: label('quality', quality.level || 'unknown'), count: asArray(quality.warnings).length }),
    ruleAuditText: ui('ruleAuditSummary：error {error} / warning {warning} / info {info}', { error: issueCounts.error || 0, warning: issueCounts.warning || 0, info: issueCounts.info || 0 }),
    templateAuditText: ui('templateAudit：{sections}', { sections: templateKeys.join(' / ') || ui('暂无模板审计摘要') }),
    manualChecklistText: ui('manualChecklist：默认未检查，待人工确认 {count} 项。', { count: uncheckedCount }),
    conclusionText: ui('conclusion：仅保留小样本实验={experimental} / 不允许批量={noBatch} / 不进入正式生成={noFormal}。{next}', { experimental: conclusion.keepExperimentalOnly !== false, noBatch: conclusion.allowBatchGeneration === false, noFormal: conclusion.allowFormalGenerationUse === false, next: conclusion.recommendedNextAction || '' }),
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

export function threeSampleCanRun({ confirmPaidApi = false, samples = [] } = {}, t) {
  const ui = reportUi(t);
  const sampleCount = Array.isArray(samples) ? samples.length : 0;
  if (confirmPaidApi !== true) {
    return { canRun: false, reason: ui('请先确认这是小样本测试，并接受可能产生的 API 成本。') };
  }
  if (sampleCount < 1) {
    return { canRun: false, reason: ui('请至少选择 1 张样本图片。') };
  }
  if (sampleCount > 3) {
    return { canRun: false, reason: ui('三张小样本对比最多 3 张样本。') };
  }
  return { canRun: true, reason: '' };
}

export function threeSampleGenerationSections(result, t) {
  const ui = reportUi(t), label = (kind, value) => reportDisplayLabel(kind, value, t);
  const aggregate = result?.aggregateReport || null;
  if (!aggregate) {
    return {
      emptyText: ui('暂无三张小样本对比报告。请先选择样本并确认 API 成本提示后运行。'),
      title: ui('三张小样本对比'),
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
    title: ui('三张小样本对比'),
    summaryText: ui('总数 {total} / 成功 {success} / 失败 {failed} / fallback {fallback} / 平均质量分 {score}', { total: summary.totalSamples || 0, success: summary.successCount || 0, failed: summary.failedCount || 0, fallback: summary.fallbackCount || 0, score: summary.averageQualityScore ?? 0 }),
    comparisonText: ui('最佳 {best} / 最弱 {worst} / commonWarnings：{warnings}', { best: comparison.bestSampleId || '-', worst: comparison.worstSampleId || '-', warnings: (comparison.commonWarnings || []).join('；') || ui('无') }),
    recommendationText: comparison.recommendation || aggregate.conclusion?.recommendedNextAction || '',
    sampleCards: sampleReports.map((sample, index) => {
      const meta = sample.meta || {};
      const generation = sample.generationResult || {};
      const quality = sample.qualityScore || {};
      const issueCounts = sample.ruleAuditSummary?.issueCounts || {};
      return {
        sampleId: sample.sampleId || meta.sampleId || `sample-${index + 1}`,
        imageType: meta.imageType || sample.imageType || '-',
        imageTypeLabel: label('imageType', meta.imageType || sample.imageType || '-'),
        statusText: `${label('status', generation.status || sample.status || '-')} / ${meta.generationProvider || sample.provider || '-'} / ${meta.modelName || sample.modelName || '-'}`,
        fallbackText: generation.fallbackUsed || sample.fallbackUsed ? ui('fallback：{reason}', { reason: generation.fallbackReason || sample.fallbackReason || '-' }) : ui('fallback：否'),
        qualityText: ui('qualityScore：{score} / {level}', { score: quality.score ?? 0, level: label('quality', quality.level || 'unknown') }),
        warningText: [...asArray(generation.warnings), ...asArray(quality.warnings), ...asArray(sample.warnings)].map(safeText).join('；') || ui('无 warnings'),
        ruleAuditText: ui('ruleAuditSummary：error {error} / warning {warning} / info {info}', { error: issueCounts.error || 0, warning: issueCounts.warning || 0, info: issueCounts.info || 0 }),
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
