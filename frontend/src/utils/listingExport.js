import {exportReportText, exportReportLabel} from './exportReportLabels.js';

const SECRET_PATTERNS = [
  [/[A-Z]:\\[^\s"',，。；;]+/gi, '[local-path-removed]'],
  [/\b[\w.-]*\.sqlite\b/gi, '[sqlite-path-removed]'],
  [/\bnode_modules\b/gi, '[node-modules-removed]'],
  [/\.env(?:\.[\w.-]+)?/gi, '[env-file-removed]'],
  [/\b[A-Z0-9_]*API[_-]?KEY\b\s*[:=]\s*[^\s"',，。；;]+/gi, '[api-key-removed]'],
  [/\b(?:sk|rk|ak)-[A-Za-z0-9_-]{6,}\b/g, '[secret-removed]'],
  [/\b(provider[_-]?secret|api[_-]?key|secret|token|password)\b\s*[:=]\s*[^\s"',，。；;]+/gi, '[secret-removed]']
];

const platformOptions = ['amazon', 'temu', 'noon', 'ozon', 'rakuten'];

export const listingExportConfirmText = '本次只会生成本地 CSV/JSON 文件，不会自动提交到任何平台。';
export const listingExportNotice = 'CSV 仅用于人工检查和后续平台对接，不会自动提交到任何平台。';

function asArray(value) {
  return Array.isArray(value) ? value : value ? [value] : [];
}

function safeText(value) {
  let text = String(value ?? '');
  for (const [pattern, replacement] of SECRET_PATTERNS) text = text.replace(pattern, replacement);
  return text;
}

function sanitizeForDisplay(value) {
  if (Array.isArray(value)) return value.map(sanitizeForDisplay);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, sanitizeForDisplay(item)]));
  }
  if (typeof value === 'string') return safeText(value);
  return value;
}

export function normalizeListingExportOptions(input = {}) {
  const platforms = asArray(input.platforms)
    .map((item) => String(item || '').trim().toLowerCase())
    .filter((item) => platformOptions.includes(item));
  return {
    platforms: platforms.length ? [...new Set(platforms)] : ['amazon'],
    includeMockImages: input.includeMockImages !== false,
    includeRealSamples: input.includeRealSamples === true,
    confirmExport: input.confirmExport === true
  };
}

export function getListingExportDisplayModel({ preview, result } = {}, t) {
  const source = result || preview || null;
  if (!source) {
    return {
      emptyText: exportReportText(t, '暂无 CSV 预览。请先点击“预览 CSV”，确认缺失字段、blocked 字段和 noReview SKU。'),
      platformRows: [],
      fileRows: [],
      missingText: '',
      blockedText: '',
      noReviewText: '',
      warningText: '',
      recommendationText: '',
      notice: exportReportText(t, listingExportNotice)
    };
  }
  const summary = source.summary || {};
  const rowsByPlatform = summary.rowsByPlatform || {};
  return {
    emptyText: '',
    notice: exportReportText(t, listingExportNotice),
    platformRows: Object.entries(rowsByPlatform).map(([platform, rows]) => ({ platform, rows })),
    fileRows: asArray(source.files).map(sanitizeForDisplay),
    missingText: asArray(summary.missingRequiredFields).map((item) => `${item.sku || '-'} ${item.platform || '-'} ${item.field || '-'}`).join(' / ') || exportReportText(t, '无'),
    blockedText: asArray(summary.blockedFields).map((item) => `${item.sku || '-'} ${item.field || '-'} ${exportReportLabel('status',item.status,t) || '-'}`).join(' / ') || exportReportText(t, '无'),
    noReviewText: asArray(summary.noReviewSku).join(' / ') || exportReportText(t, '无'),
    failedText: asArray(summary.failedSku).map((item) => item.sku || item.taskId).join(' / ') || exportReportText(t, '无'),
    warningText: [...asArray(summary.warnings), ...asArray(source.warnings)].map(safeText).join(' / '),
    recommendationText: asArray(summary.recommendations).map(safeText).join(' / '),
    resultText: result?.exportId ? exportReportText(t, '已生成 {name}', {name:safeText(result.exportId)}) : ''
  };
}

export function listingExportJson(value) {
  return JSON.stringify(sanitizeForDisplay(value || {}), null, 2);
}

export function buildListingCsvDownloadUrl(relativePath = '') {
  const safePath = safeText(relativePath).replaceAll('\\', '/');
  if (!safePath || /[A-Z]:\//i.test(safePath) || safePath.includes('..')) return '';
  if (!safePath.startsWith('outputs/listing-csv/') && !safePath.startsWith('outputs/export-packages/')) return '';
  return `/${safePath}`;
}
