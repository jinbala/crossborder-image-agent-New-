import { normalizeVisionResult } from './normalizeVisionResult.js';

const arrayFields = [
  'colors',
  'sizes',
  'capacity',
  'compatibleDevices',
  'dimensions',
  'certifications',
  'packageIncluded',
  'sellingPoints',
  'useScenarios',
  'targetUsers',
  'visibleSpecs'
];

const scalarFields = ['productName', 'category', 'brand', 'model', 'material', 'interfaceType', 'warranty', 'weight'];

function unique(items) {
  const seen = new Set();
  return items.filter((item) => {
    const key = String(item).trim().toLowerCase();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function mergeVisibleText(results) {
  const seen = new Set();
  const merged = [];
  for (const result of results) {
    for (const item of result.visibleText || []) {
      const key = `${item.imageIndex ?? ''}|${item.imageName || ''}|${item.text || ''}`.toLowerCase();
      if (!item.text || seen.has(key)) continue;
      seen.add(key);
      merged.push(item);
    }
  }
  return merged;
}

function mergeRisks(results) {
  const seen = new Set();
  const merged = [];
  for (const result of results) {
    for (const item of result.risks || []) {
      const key = `${item.type}|${(item.evidence || []).join('|')}|${item.imageIndex ?? ''}`.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(item);
    }
  }
  return merged;
}

function mergeFieldEvidence(results) {
  const merged = {};
  const seen = new Set();
  for (const result of results) {
    for (const [field, items] of Object.entries(result.fieldEvidence || {})) {
      if (!merged[field]) merged[field] = [];
      for (const item of items || []) {
        const key = `${field}|${item.source}|${item.imageIndex ?? ''}|${item.value || ''}|${item.text || ''}`.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        merged[field].push(item);
      }
    }
  }
  return merged;
}

function mergeInferredCandidates(results) {
  const seen = new Set();
  const merged = [];
  for (const result of results) {
    for (const item of result.inferredCandidates || []) {
      const key = `${item.field}|${item.value}|${item.reason}`.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(item);
    }
  }
  return merged;
}

export function mergeVisionResults(results = []) {
  const normalized = results.map((result) => normalizeVisionResult(result));
  const productInfoRaw = {};
  const notes = [];

  for (const field of scalarFields) {
    const values = unique(normalized.map((result) => result.productInfoRaw[field]).filter(Boolean));
    productInfoRaw[field] = values[0] || null;
    if (values.length > 1) {
      notes.push(`字段 ${field} 存在多批识别冲突：${values.join(' / ')}`);
    }
  }

  for (const field of arrayFields) {
    productInfoRaw[field] = unique(normalized.flatMap((result) => result.productInfoRaw[field] || []));
  }

  const confidence = {};
  for (const result of normalized) {
    for (const [field, value] of Object.entries(result.confidence || {})) {
      confidence[field] = Math.max(confidence[field] || 0, Number(value) || 0);
    }
  }

  notes.push(...unique(normalized.flatMap((result) => result.notes || [])));

  return normalizeVisionResult({
    productInfoRaw,
    visibleText: mergeVisibleText(normalized),
    risks: mergeRisks(normalized),
    confidence,
    notes: notes.slice(0, 15),
    fieldEvidence: mergeFieldEvidence(normalized),
    inferredCandidates: mergeInferredCandidates(normalized)
  });
}
