const STATUS_LABELS = {
  confirmedWithEvidence: '有可靠证据',
  needsManualConfirm: '需人工确认',
  inferredOnly: 'AI 推测字段',
  conflicted: '字段冲突',
  blockedHighRisk: '高风险缺证据',
  empty: '暂无内容'
};

const FIELD_LABELS = {
  capacity: '容量',
  dimensions: '尺寸',
  interfaceType: '接口类型',
  certifications: '认证',
  warranty: '保修',
  material: '材质',
  model: '型号',
  brand: '品牌',
  packageIncluded: '包装清单',
  compatibleDevices: '兼容设备',
  color: '颜色',
  colors: '颜色',
  productName: '商品名称',
  category: '类目',
  sellingPoints: '卖点',
  visibleSpecs: '可见规格',
  packageList: '包装清单',
  name: '商品名称',
  weight: '重量'
};

const HIGH_RISK_FIELDS = new Set([
  'capacity',
  'dimensions',
  'interfaceType',
  'certifications',
  'warranty',
  'material',
  'model',
  'brand',
  'packageIncluded',
  'compatibleDevices'
]);

const ACTION_ADVICE = {
  confirmedWithEvidence: '该字段有图片或文字证据，通常可以作为确认信息使用。',
  needsManualConfirm: '该字段有值，但证据不足，建议人工核对后再确认。',
  inferredOnly: '该字段来自 AI 推测，不会自动进入确认信息或图片文案。需要使用时请人工确认。',
  conflicted: '该字段在不同证据中出现多个候选值，请人工选择正确值。',
  blockedHighRisk: '该字段属于高风险字段且缺少必要证据，不建议用于商品信息或图片文案。'
};

function listLabels(items = []) {
  return items.map((item) => item.label || recognitionQualityFieldLabel(item.field)).filter(Boolean).join('、') || '无';
}

function asArray(value) {
  return Array.isArray(value) ? value.filter((item) => item !== null && item !== undefined && item !== '') : value ? [value] : [];
}

function evidenceSourceLabel(source) {
  return {
    visible_text: '文字证据',
    visual: '视觉证据',
    inferred: 'AI 推测证据',
    user_input: '人工输入证据'
  }[source] || source || '未知证据';
}

function safeSummary(report) {
  return report?.summary && typeof report.summary === 'object' ? report.summary : {};
}

function safeFields(report) {
  return Array.isArray(report?.fields) ? report.fields : [];
}

function fieldDisplayName(field) {
  return field?.label || recognitionQualityFieldLabel(field?.field);
}

function valueText(value) {
  const values = asArray(value);
  return values.length ? values.join(' / ') : '-';
}

function riskLine(field, reason) {
  return `${fieldDisplayName(field)}：${reason}`;
}

function dedupeLines(lines = []) {
  const seen = new Set();
  return lines.filter((line) => {
    const key = String(line || '').trim();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function exportRiskLevel(field = {}) {
  if (field.status === 'conflicted' || field.status === 'blockedHighRisk') return 'high';
  if (field.isHighRisk && field.status !== 'confirmedWithEvidence') return 'high';
  if (field.status === 'needsManualConfirm' || field.status === 'inferredOnly') return 'medium';
  return 'low';
}

function sanitizeExportString(value) {
  if (typeof value !== 'string') return value;
  return value
    .replace(/[A-Z]:\\[^"',\n\r\t]+/g, (match) => match.split('\\').filter(Boolean).pop() || '[已隐藏本地路径]')
    .replace(/\b[\w.-]*node_modules[\w./\\-]*/gi, '[已隐藏本地路径]')
    .replace(/\bapp\.sqlite\b/gi, '[已隐藏本地数据库路径]')
    .replace(/\bOPENAI_API_KEY\s*=\s*[^\s"',]+/gi, '[已隐藏敏感配置]')
    .replace(/\b[A-Z0-9_]*API[_-]?KEY\s*=\s*[^\s"',]+/gi, '[已隐藏敏感配置]')
    .replace(/\bsk-[A-Za-z0-9_-]+/g, '[已隐藏敏感密钥]')
    .replace(/(^|\s)\.env(?:\.[\w-]+)?/gi, '$1[已隐藏敏感配置]');
}

function sanitizeExportValue(value) {
  if (Array.isArray(value)) return value.map(sanitizeExportValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value)
      .filter(([key]) => !/secret|token|password|apiKey|api_key|localPath|path|absolutePath/i.test(key))
      .map(([key, item]) => [key, sanitizeExportValue(item)]));
  }
  return sanitizeExportString(value);
}

function fieldValueForExport(field = {}) {
  const value = field.value ?? field.values ?? field.inferredValues ?? field.conflictValues ?? '';
  return sanitizeExportValue(value);
}

function fieldEvidenceSummary(field = {}) {
  const sources = asArray(field.evidenceSources).map(evidenceSourceLabel);
  const parts = [
    `证据 ${Number(field.evidenceCount || 0)} 条`,
    sources.length ? `来源：${sources.join('、')}` : '',
    field.confidence != null ? `置信度 ${Number(field.confidence).toFixed(2)}` : ''
  ].filter(Boolean);
  return parts.join('；') || '暂无证据摘要';
}

function normalizeExportField(field = {}) {
  const status = field.status || 'needsManualConfirm';
  return {
    fieldKey: field.field || '',
    fieldLabel: fieldDisplayName(field),
    value: fieldValueForExport(field),
    category: status,
    riskLevel: exportRiskLevel(field),
    suggestion: recognitionQualityActionAdvice(status),
    evidenceCount: Number(field.evidenceCount || 0),
    evidenceSummary: fieldEvidenceSummary(field)
  };
}

function addExportField(target, source, status) {
  const fieldKey = source?.field || '';
  if (!fieldKey) return;
  const exists = target.some((item) => item.field === fieldKey && item.status === status);
  if (!exists) target.push({ ...source, status });
}

function exportFieldGroups(report) {
  const fields = safeFields(report).map((field) => ({ ...field }));
  asArray(report?.conflictFields).forEach((field) => addExportField(fields, field, 'conflicted'));
  asArray(report?.missingEvidenceFields).forEach((field) => addExportField(fields, field, 'blockedHighRisk'));
  asArray(report?.inferredOnlyFields).forEach((field) => addExportField(fields, field, 'inferredOnly'));

  return {
    confirmedWithEvidence: fields.filter((field) => field.status === 'confirmedWithEvidence').map(normalizeExportField),
    needsManualConfirm: fields.filter((field) => field.status === 'needsManualConfirm').map(normalizeExportField),
    inferredOnly: fields.filter((field) => field.status === 'inferredOnly').map(normalizeExportField),
    conflicted: fields.filter((field) => field.status === 'conflicted').map(normalizeExportField),
    blockedHighRisk: fields.filter((field) => field.status === 'blockedHighRisk').map(normalizeExportField)
  };
}

function exportSummary(report) {
  const summary = safeSummary(report);
  const highRiskFieldCount = asArray(report?.highRiskFields).length;
  const missingEvidenceCount = summary.missingEvidenceCount ?? asArray(report?.missingEvidenceFields).length;
  return {
    totalFields: Number(summary.totalFields || 0),
    confirmedWithEvidenceCount: Number(summary.confirmedWithEvidence || summary.confirmedWithEvidenceCount || 0),
    needsManualConfirmCount: Number(summary.needsManualConfirm || summary.needsManualConfirmCount || 0),
    inferredOnlyCount: Number(summary.inferredOnly || summary.inferredOnlyCount || 0),
    conflictedCount: Number(summary.conflicted || summary.conflictedCount || 0),
    blockedHighRiskCount: Number(summary.blockedHighRisk || summary.blockedHighRiskCount || 0),
    highRiskFieldCount,
    missingEvidenceCount: Number(missingEvidenceCount || 0)
  };
}

function highRiskAuditRows(report) {
  const fields = [
    ...asArray(report?.highRiskFields),
    ...asArray(report?.missingEvidenceFields),
    ...safeFields(report).filter((field) => field.isHighRisk || HIGH_RISK_FIELDS.has(field.field))
  ];
  const seen = new Set();
  return fields.filter((field) => {
    const key = field?.field || '';
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  }).map((field) => {
    const status = field.status || (Number(field.evidenceCount || 0) > 0 ? 'needsManualConfirm' : 'blockedHighRisk');
    const hasEvidence = Number(field.evidenceCount || 0) > 0 || asArray(field.evidenceSources).length > 0;
    return {
      fieldKey: field.field,
      fieldLabel: fieldDisplayName(field),
      value: fieldValueForExport(field),
      hasEvidence,
      status,
      reason: hasEvidence ? '高风险字段仍建议人工核对证据' : '高风险字段缺少必要证据',
      suggestion: recognitionQualityActionAdvice(status)
    };
  });
}

function exportEvidenceSummary(task = {}, report = {}) {
  const safeReport = report || {};
  const recognition = safeReport.recognition || task.recognitionMeta || task.recognitionProvider || {};
  const visibleText = asArray(task.visibleText).slice(0, 20).map((item) => {
    const normalized = typeof item === 'string' ? { text: item } : item || {};
    return sanitizeExportValue({
      text: normalized.text,
      imageName: normalized.imageName || normalized.displayName || normalized.originalName,
      confidence: normalized.confidence
    });
  });
  const fieldEvidence = Object.fromEntries(Object.entries(task.fieldEvidence || {}).map(([field, evidenceItems]) => [
    field,
    asArray(evidenceItems).slice(0, 10).map((item) => sanitizeExportValue({
      source: item.source,
      imageName: item.imageName || item.displayName || item.originalName,
      text: item.text,
      value: item.value,
      confidence: item.confidence
    }))
  ]));
  const risks = asArray(safeReport.risks || task.risks).slice(0, 20).map((risk) => sanitizeExportValue({
    type: risk.type,
    level: risk.level,
    message: risk.message
  }));

  return {
    visibleText,
    fieldEvidence,
    recognitionMeta: sanitizeExportValue({
      provider: recognition.provider,
      model: recognition.model,
      durationMs: recognition.durationMs
    }),
    risks
  };
}

export function buildRecognitionQualityExport(task = {}, exportedAt = new Date().toISOString()) {
  const report = task?.recognitionQuality || null;
  const recognition = report?.recognition || task?.recognitionMeta || task?.recognitionProvider || {};
  const warning = buildRecognitionQualitySoftWarning(report);
  const product = task?.productInfo || {};
  return sanitizeExportValue({
    meta: {
      taskId: task?.id || task?.taskId || '',
      sku: product.sku || task?.sku || '',
      productName: product.name || product.productName || task?.name || '',
      exportedAt,
      recognitionProvider: recognition.provider || '',
      recognitionModel: recognition.model || '',
      recognitionDurationMs: recognition.durationMs ?? null,
      confidence: task?.confidence || report?.confidence || {},
      overallRiskLevel: recognitionQualityRiskLevel(report).level
    },
    summary: exportSummary(report),
    fieldGroups: exportFieldGroups(report),
    highRiskAudit: highRiskAuditRows(report),
    evidenceSummary: exportEvidenceSummary(task, report),
    softWarningSummary: {
      shouldWarn: warning.shouldWarn,
      topRisks: warning.risks,
      remainingRiskCount: warning.remainingCount,
      warningTitle: warning.title,
      warningMessage: warning.body
    },
    notes: [
      '本报告为识别质量复查报告，仅用于人工核对和调试。AI 推测字段不会自动进入确认信息或图片文案。最终商品信息以用户人工确认结果为准。'
    ]
  });
}

export function buildRecognitionQualityJson(task = {}) {
  return JSON.stringify(buildRecognitionQualityExport(task), null, 2);
}

export function buildRecognitionQualityFileName(taskId = 'task', timestamp = new Date().toISOString()) {
  const safeTaskId = String(taskId || 'task').replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'task';
  const safeTimestamp = String(timestamp || new Date().toISOString()).replace(/[:.]/g, '-');
  return `recognition-quality-${safeTaskId}-${safeTimestamp}.json`;
}

export function downloadRecognitionQualityJson(task = {}) {
  if (!task?.recognitionQuality) {
    return {
      downloaded: false,
      reason: '暂无可导出的识别质量报告，请先完成商品识别。'
    };
  }
  const exportedAt = new Date().toISOString();
  const json = JSON.stringify(buildRecognitionQualityExport(task, exportedAt), null, 2);
  const fileName = buildRecognitionQualityFileName(task?.id || task?.taskId, exportedAt);
  if (typeof document === 'undefined' || typeof Blob === 'undefined' || typeof URL === 'undefined') {
    return { downloaded: false, fileName, json };
  }
  const blob = new Blob([json], { type: 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
  return { downloaded: true, fileName };
}

export function recognitionQualityStatusLabel(status) {
  return STATUS_LABELS[status] || status || '未知';
}

export function recognitionQualityFieldLabel(field) {
  return FIELD_LABELS[field] || field || '未知字段';
}

export function recognitionQualityActionAdvice(status) {
  return ACTION_ADVICE[status] || '请人工核对该字段。';
}

export function recognitionQualityRiskLevel(report) {
  const summary = safeSummary(report);
  const conflicted = Number(summary.conflicted || summary.conflictCount || 0);
  const blockedHighRisk = Number(summary.blockedHighRisk || summary.missingEvidenceCount || 0);
  const needsManualConfirm = Number(summary.needsManualConfirm || 0);
  const inferredOnly = Number(summary.inferredOnly || 0);
  if (conflicted > 0 || blockedHighRisk > 0) {
    return {
      level: 'high',
      label: '高风险',
      message: '存在冲突或高风险缺证据字段，建议先修正商品信息再继续。'
    };
  }
  if (needsManualConfirm > 0 || inferredOnly > 0) {
    return {
      level: 'medium',
      label: '中风险',
      message: '部分字段需要人工核对，确认后再生成图片方案。'
    };
  }
  return {
    level: 'low',
    label: '低风险',
    message: '识别结果整体较可靠，仍建议人工确认关键字段。'
  };
}

export function recognitionQualityWarningText(report) {
  if (!report) return '';
  return '识别质量复查只用于提醒，不会阻止人工确认保存。请根据图片证据人工核对后再继续。';
}

export function recognitionQualityDisplaySections(report) {
  if (!report) {
    return {
      emptyText: '暂无识别质量报告。请先完成商品识别，或刷新页面后重试。',
      overviewText: '暂无识别质量报告。',
      statsText: '暂无识别质量报告。',
      focusText: '暂无需要人工重点检查的字段。',
      highRiskText: '暂无高风险字段。',
      missingEvidenceText: '暂无缺证据字段。',
      conflictText: '暂无冲突字段。',
      inferredText: '暂无 AI 推测字段。',
      evidenceText: '暂无证据来源。',
      evidenceFieldsText: '暂无有可靠证据的字段。',
      evidenceSummaryText: '暂无证据来源。',
      risk: recognitionQualityRiskLevel(null),
      blocksSave: false
    };
  }

  const summary = safeSummary(report);
  const fields = safeFields(report);
  const bySource = report.evidenceSummary?.bySource || {};
  const risk = recognitionQualityRiskLevel(report);
  const sourceParts = [
    bySource.visible_text ? `文字证据 ${bySource.visible_text} 条` : '',
    bySource.visual ? `视觉证据 ${bySource.visual} 条` : '',
    bySource.inferred ? `AI 推测证据 ${bySource.inferred} 条` : '',
    bySource.user_input ? `人工输入证据 ${bySource.user_input} 条` : ''
  ].filter(Boolean);
  const conflictFields = Array.isArray(report.conflictFields) ? report.conflictFields : [];
  const inferredOnlyFields = Array.isArray(report.inferredOnlyFields) ? report.inferredOnlyFields : [];
  const confirmedFields = fields.filter((field) => field.status === 'confirmedWithEvidence');
  const focusFields = fields.filter((field) => (
    field.status === 'conflicted' ||
    field.status === 'blockedHighRisk' ||
    (field.status === 'needsManualConfirm' && field.isHighRisk)
  ));
  const conflictText = conflictFields.length
    ? conflictFields.map((item) => `${fieldDisplayName(item)}：${(item.conflictValues || []).join(' / ')}。${recognitionQualityActionAdvice('conflicted')}`).join('；')
    : '暂无冲突字段。';
  const inferredText = inferredOnlyFields.length
    ? `${inferredOnlyFields.map((item) => {
        const values = item.inferredValues?.length
          ? `（${item.inferredValues.join(' / ')}）`
          : '';
        return `${fieldDisplayName(item)}${values}`;
      }).join('、')}。${recognitionQualityActionAdvice('inferredOnly')}`
    : '暂无 AI 推测字段。';
  const focusText = focusFields.length
    ? focusFields.map((field) => `${fieldDisplayName(field)}：${recognitionQualityStatusLabel(field.status)}。${recognitionQualityActionAdvice(field.status)}`).join('；')
    : '暂无需要人工重点检查的字段。';
  const evidenceFieldsText = confirmedFields.length
    ? confirmedFields.map((field) => {
        const sources = asArray(field.evidenceSources).map(evidenceSourceLabel).join('、') || '证据';
        const confidence = field.confidence != null ? `，置信度 ${Number(field.confidence).toFixed(2)}` : '';
        return `${fieldDisplayName(field)}：${valueText(field.value)}，${sources}${confidence}`;
      }).join('；')
    : '暂无有可靠证据的字段。';
  const sourceImageCount = Array.isArray(report.evidenceSummary?.byImage)
    ? report.evidenceSummary.byImage.filter((item) => Number(item.imageIndex) >= 0).length
    : 0;
  const recognition = report.recognition || {};
  const recognitionText = recognition.provider
    ? `Provider：${recognition.provider}${recognition.model ? ` / 模型：${recognition.model}` : ''}${recognition.durationMs != null ? ` / 耗时：${recognition.durationMs} ms` : ''}`
    : 'Provider：暂无';
  const riskText = Array.isArray(report.risks) && report.risks.length
    ? `风险提示 ${report.risks.length} 条`
    : '';
  const evidenceSummaryText = [
    `来源图片 ${sourceImageCount} 张`,
    sourceParts.length ? sourceParts.join('，') : '暂无证据来源',
    recognitionText,
    riskText
  ].filter(Boolean).join('；');

  return {
    emptyText: '',
    overviewText: `总体风险：${risk.label}。${risk.message} 共分析 ${summary.totalFields || 0} 个字段，有证据字段 ${summary.confirmedWithEvidence || 0} 个，需人工确认 ${summary.needsManualConfirm || 0} 个，AI 推测 ${summary.inferredOnly || 0} 个，冲突 ${summary.conflicted || 0} 个，高风险缺证据 ${summary.blockedHighRisk || 0} 个。`,
    statsText: `共分析 ${summary.totalFields || 0} 个字段，有可靠证据 ${summary.confirmedWithEvidence || 0} 个，需人工确认 ${summary.needsManualConfirm || 0} 个，冲突 ${summary.conflicted || 0} 个，高风险缺证据 ${summary.blockedHighRisk || 0} 个。`,
    focusText,
    highRiskText: listLabels(report.highRiskFields),
    missingEvidenceText: listLabels(report.missingEvidenceFields),
    conflictText,
    inferredText,
    evidenceText: sourceParts.length ? sourceParts.join('，') : '暂无证据来源。',
    evidenceFieldsText,
    evidenceSummaryText,
    risk,
    blocksSave: false
  };
}

export function buildRecognitionQualitySoftWarning(report) {
  const risk = recognitionQualityRiskLevel(report);
  const summary = safeSummary(report);
  const fields = safeFields(report);
  const conflictFields = Array.isArray(report?.conflictFields) ? report.conflictFields : [];
  const missingEvidenceFields = Array.isArray(report?.missingEvidenceFields) ? report.missingEvidenceFields : [];
  const inferredOnlyFields = Array.isArray(report?.inferredOnlyFields) ? report.inferredOnlyFields : [];
  const focusFields = fields.filter((field) => (
    field.status === 'conflicted' ||
    field.status === 'blockedHighRisk' ||
    (field.status === 'needsManualConfirm' && field.isHighRisk)
  ));
  const highRiskInferredFields = inferredOnlyFields.filter((field) => field.isHighRisk || HIGH_RISK_FIELDS.has(field.field));

  const shouldWarn = risk.level === 'high' ||
    conflictFields.length > 0 ||
    missingEvidenceFields.length > 0 ||
    highRiskInferredFields.length > 0 ||
    focusFields.length > 0 ||
    Number(summary.blockedHighRisk || 0) > 0 ||
    Number(summary.conflicted || 0) > 0;

  if (!shouldWarn) {
    return {
      shouldWarn: false,
      title: '',
      body: '',
      risks: [],
      allRisks: [],
      remainingCount: 0,
      moreText: ''
    };
  }

  const allRisks = dedupeLines([
    ...conflictFields.map((field) => riskLine(field, '不同证据中出现多个候选值，请人工选择正确值')),
    ...missingEvidenceFields.map((field) => riskLine(field, '属于高风险字段，但缺少可靠证据')),
    ...highRiskInferredFields.map((field) => riskLine(field, '来自 AI 推测，不会自动用于图片文案，需要人工确认')),
    ...focusFields.map((field) => {
      if (field.status === 'conflicted') return riskLine(field, '不同证据中出现多个候选值，请人工选择正确值');
      if (field.status === 'blockedHighRisk') return riskLine(field, '属于高风险字段，但缺少可靠证据');
      return riskLine(field, '证据不足，建议人工核对');
    })
  ]);
  const risks = allRisks.slice(0, 5);
  const remainingCount = Math.max(0, allRisks.length - risks.length);

  return {
    shouldWarn: true,
    title: '识别质量存在需要人工确认的字段',
    body: '系统发现部分商品字段存在证据不足、AI 推测或冲突情况。继续保存前，建议你核对这些字段，避免后续图片方案使用错误信息。',
    risks,
    allRisks,
    remainingCount,
    moreText: remainingCount > 0 ? `还有 ${remainingCount} 条风险字段，可在识别质量复查区域查看详情。` : ''
  };
}

export function canSaveWithRecognitionQualitySoftWarning({ warning, riskConfirmed, saveOriginal }) {
  if (warning?.shouldWarn && !riskConfirmed) return false;
  return saveOriginal();
}
