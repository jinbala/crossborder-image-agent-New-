export const HIGH_RISK_FIELDS = [
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
];

const CONFLICT_SENSITIVE_FIELDS = new Set([
  'capacity',
  'dimensions',
  'interfaceType',
  'warranty',
  'material',
  'model',
  'brand'
]);

const FIELD_LABELS = {
  productName: '商品名称',
  category: '类目',
  brand: '品牌',
  model: '型号',
  capacity: '容量',
  dimensions: '尺寸',
  interfaceType: '接口',
  certifications: '认证',
  warranty: '保修',
  material: '材质',
  packageIncluded: '包装清单',
  compatibleDevices: '兼容设备',
  sellingPoints: '卖点',
  visibleSpecs: '可见规格'
};

const LEGACY_FIELD_MAP = {
  productName: 'name',
  packageIncluded: 'packageList'
};

function asArray(value) {
  if (Array.isArray(value)) return value.map((item) => String(item || '').trim()).filter(Boolean);
  if (value === null || value === undefined || value === '') return [];
  return [String(value).trim()].filter(Boolean);
}

function normalizeToken(value) {
  return String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function uniqueValues(values = []) {
  return [...new Set(values.map(normalizeToken).filter(Boolean))];
}

function taskFieldValue(task = {}, field) {
  const raw = task.productInfoRaw || {};
  const legacy = task.productInfo || {};
  const rawValue = raw[field];
  if (rawValue !== undefined && rawValue !== null && !(Array.isArray(rawValue) && rawValue.length === 0) && rawValue !== '') {
    return rawValue;
  }
  return legacy[LEGACY_FIELD_MAP[field] || field];
}

function evidenceFor(task = {}, field) {
  return Array.isArray(task.fieldEvidence?.[field]) ? task.fieldEvidence[field] : [];
}

function inferredFor(task = {}, field) {
  return (task.inferredCandidates || []).filter((item) => item?.field === field);
}

function evidenceSourceSummary(evidence = []) {
  return [...new Set(evidence.map((item) => item.source || 'unknown'))];
}

function reliableEvidence(evidence = []) {
  return evidence.filter((item) => ['visible_text', 'visual', 'user_input'].includes(item.source));
}

function strongEvidence(evidence = []) {
  return evidence.filter((item) => ['visible_text', 'user_input'].includes(item.source) && Number(item.confidence ?? 1) >= 0.7);
}

function evidenceCandidateValues(evidence = []) {
  return evidence
    .map((item) => item.value || item.text)
    .flatMap(asArray);
}

function fieldList(task = {}) {
  return [...new Set([
    'productName',
    'category',
    ...HIGH_RISK_FIELDS,
    'sellingPoints',
    'visibleSpecs',
    ...Object.keys(task.productInfoRaw || {}),
    ...Object.keys(task.fieldEvidence || {}),
    ...(task.inferredCandidates || []).map((item) => item.field).filter(Boolean)
  ])];
}

function analyzeField(task, field) {
  const values = asArray(taskFieldValue(task, field));
  const evidence = evidenceFor(task, field);
  const inferred = inferredFor(task, field);
  const reliable = reliableEvidence(evidence);
  const strong = strongEvidence(evidence);
  const isHighRisk = HIGH_RISK_FIELDS.includes(field);
  const evidenceValues = uniqueValues(evidenceCandidateValues(evidence));
  const inferredValues = uniqueValues(inferred.map((item) => item.value));
  const conflictValues = CONFLICT_SENSITIVE_FIELDS.has(field) && evidenceValues.length > 1 ? evidenceValues : [];

  let status = 'needsManualConfirm';
  const issues = [];
  if (!values.length && inferred.length) {
    status = 'inferredOnly';
    issues.push('仅来自 AI 推测，未进入确认字段。');
  } else if (conflictValues.length) {
    status = 'conflicted';
    issues.push('不同图片或证据中出现多个候选值，请人工确认。');
  } else if (isHighRisk && values.length && !reliable.length) {
    status = 'blockedHighRisk';
    issues.push('高风险字段缺少可用图片证据。');
  } else if (values.length && strong.length) {
    status = 'confirmedWithEvidence';
  } else if (values.length && reliable.length) {
    status = 'needsManualConfirm';
    issues.push('字段有证据，但证据较弱或置信度不足。');
  } else if (values.length) {
    status = isHighRisk ? 'blockedHighRisk' : 'needsManualConfirm';
    issues.push(isHighRisk ? '高风险字段缺少可用图片证据。' : '字段缺少图片证据。');
  } else {
    status = 'empty';
  }

  return {
    field,
    label: FIELD_LABELS[field] || field,
    value: values,
    status,
    isHighRisk,
    evidenceCount: evidence.length,
    evidenceSources: evidenceSourceSummary(evidence),
    evidence,
    inferredValues,
    inferredCandidates: inferred,
    conflictValues,
    confidence: task.confidence?.[field] ?? null,
    issues
  };
}

function summarizeEvidence(fields) {
  const allEvidence = fields.flatMap((field) => field.evidence || []);
  const bySource = {};
  const byImageMap = new Map();
  allEvidence.forEach((item) => {
    const source = item.source || 'unknown';
    bySource[source] = (bySource[source] || 0) + 1;
    const imageIndex = Number.isInteger(item.imageIndex) ? item.imageIndex : -1;
    byImageMap.set(imageIndex, (byImageMap.get(imageIndex) || 0) + 1);
  });
  return {
    totalEvidence: allEvidence.length,
    bySource,
    byImage: [...byImageMap.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([imageIndex, count]) => ({ imageIndex, count }))
  };
}

function countByStatus(fields, status) {
  return fields.filter((field) => field.status === status).length;
}

export function analyzeRecognitionQuality(task = {}) {
  const fields = fieldList(task).map((field) => analyzeField(task, field));
  const highRiskFields = fields.filter((field) => field.isHighRisk && field.status !== 'empty');
  const missingEvidenceFields = fields.filter((field) => field.status === 'blockedHighRisk');
  const conflictFields = fields.filter((field) => field.status === 'conflicted');
  const inferredOnlyFields = fields.filter((field) => (
    field.status === 'inferredOnly' || (field.inferredCandidates.length > 0 && field.evidenceSources.length === 0)
  ));
  const recognitionMeta = task.recognitionMeta || task.recognitionProvider || {};

  return {
    summary: {
      totalFields: fields.filter((field) => field.status !== 'empty').length,
      confirmedWithEvidence: countByStatus(fields, 'confirmedWithEvidence'),
      needsManualConfirm: countByStatus(fields, 'needsManualConfirm'),
      inferredOnly: inferredOnlyFields.length,
      conflicted: conflictFields.length,
      blockedHighRisk: missingEvidenceFields.length,
      highRiskFieldCount: HIGH_RISK_FIELDS.length,
      missingEvidenceCount: missingEvidenceFields.length,
      conflictCount: conflictFields.length,
      inferredCandidateCount: (task.inferredCandidates || []).length
    },
    recognition: {
      provider: recognitionMeta.provider || '',
      model: recognitionMeta.model || '',
      durationMs: Number(recognitionMeta.durationMs || 0),
      status: recognitionMeta.status || ''
    },
    fields,
    highRiskFields,
    missingEvidenceFields,
    conflictFields,
    inferredOnlyFields,
    evidenceSummary: summarizeEvidence(fields)
  };
}

export function analyzeRecognitionStability(results = []) {
  const fieldValues = new Map();
  const qualityReports = results.map((result) => analyzeRecognitionQuality(result));

  results.forEach((result) => {
    fieldList(result).forEach((field) => {
      const values = uniqueValues(asArray(taskFieldValue(result, field)));
      if (!fieldValues.has(field)) fieldValues.set(field, []);
      fieldValues.get(field).push(values.join('|') || '');
    });
  });

  const fieldConsistency = {};
  for (const [field, values] of fieldValues.entries()) {
    const distinctValues = uniqueValues(values);
    const counts = new Map();
    values.forEach((value) => counts.set(value, (counts.get(value) || 0) + 1));
    const maxCount = Math.max(...counts.values(), 0);
    fieldConsistency[field] = {
      field,
      label: FIELD_LABELS[field] || field,
      distinctValues,
      consistencyRate: values.length ? maxCount / values.length : 1
    };
  }

  const consistencyValues = Object.values(fieldConsistency).map((item) => item.consistencyRate);
  const missingEvidenceFields = [...new Set(qualityReports.flatMap((report) => report.missingEvidenceFields.map((field) => field.field)))];
  const conflictFields = Object.values(fieldConsistency)
    .filter((item) => item.distinctValues.length > 1)
    .map((item) => item.field);

  return {
    runCount: results.length,
    averageConsistency: consistencyValues.length
      ? consistencyValues.reduce((sum, value) => sum + value, 0) / consistencyValues.length
      : 1,
    fieldConsistency,
    conflictFields,
    missingEvidenceFields
  };
}
