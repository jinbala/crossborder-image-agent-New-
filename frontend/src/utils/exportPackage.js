import {exportReportText, exportReportLabel, exportReportCards} from './exportReportLabels.js';

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

const sourceTypeDisplay = {
  mock: 'mock preview',
  mockPreview: 'mock preview',
  real: 'real generated',
  realGenerated: 'real generated',
  generated: '生成图片（来源未验证）',
  fallbackMock: 'fallback mock',
  fallback_mock: 'fallback mock',
  realSample: 'real sample',
  missing: 'missing'
};

export const exportPackageConfirmText = '本次将生成本地 ZIP 文件，不会上传平台，不会调用真实 Provider。';

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

export function normalizeExportPackageOptions(input = {}) {
  const platforms = asArray(input.platforms)
    .map((item) => String(item || '').trim().toLowerCase())
    .filter((item) => platformOptions.includes(item));
  return {
    platforms: platforms.length ? [...new Set(platforms)] : ['amazon'],
    includeReports: input.includeReports !== false,
    includeMockImages: input.includeMockImages !== false,
    includeRealSamples: input.includeRealSamples === true,
    format: 'zip',
    confirmExport: input.confirmExport === true
  };
}

export function getExportPackageDisplayModel({ preview, result } = {}, t) {
  const source = result || preview || null;
  if (!source) {
    return {
      emptyText: exportReportText(t, '暂无导出包预览。请先点击“预览导出包”，确认目录结构和缺失图片后再生成 ZIP。'),
      summaryCards: [],
      treeRows: [],
      failedSkuRows: [],
      warningText: '',
      resultText: '',
      previewNotice: exportReportText(t, '上架前资料包只生成本地 ZIP，不会上传平台，不会调用真实 Provider。')
    };
  }
  const summary = source.summary || {};
  const warnings = asArray(source.warnings);
  const treeRows = asArray(result?.directoryTree ?? preview?.directoryTree).slice(0, 80).map((row) => ({
    ...sanitizeForDisplay(row),
    statusDisplay: exportReportLabel('status', row.status, t),
    sourceTypeDisplay: typeof t === 'function' ? exportReportLabel('source', row.sourceType, t) : Object.hasOwn(sourceTypeDisplay, row.sourceType) ? sourceTypeDisplay[row.sourceType] : row.sourceType || 'unknown'
  }));
  const failedSkuRows = asArray(source.failedSku || result?.failedSku).map((row) => sanitizeForDisplay(row));
  return {
    emptyText: '',
    previewNotice: exportReportText(t, '上架前资料包只生成本地 ZIP，不会上传平台，不会调用真实 Provider；mock 图片会标记 sourceType=mock。'),
    summaryCards: exportReportCards([
      { key: 'totalSku', label: 'SKU 总数', value: String(summary.totalSku || 0) },
      { key: 'successSku', label: '成功 SKU', value: String(summary.successSku || 0) },
      { key: 'failedSku', label: '失败 SKU', value: String(summary.failedSku || 0) },
      { key: 'readyImageCount', label: '可导出图片', value: String(summary.readyImageCount || 0) },
      { key: 'missingImageCount', label: '缺失图片', value: String(summary.missingImageCount || 0) },
      { key: 'mockImageCount', label: 'mock 图片', value: String(summary.mockImageCount || 0) },
      { key: 'reportCount', label: '报告文件', value: String(summary.reportCount || 0) }
    ], t),
    treeRows,
    failedSkuRows,
    reportsText: asArray(preview?.reports).join(' / ') || '-',
    warningText: warnings.map(safeText).join(' / '),
    resultText: result?.zipFile ? exportReportText(t, '已生成 {name}', {name:safeText(result.zipFile)}) : '',
    downloadUrl: buildExportPackageDownloadUrl(result?.relativePath)
  };
}

export function exportPackageJson(value) {
  return JSON.stringify(sanitizeForDisplay(value || {}), null, 2);
}

export function buildExportPackageDownloadUrl(relativePath = '') {
  const safePath = safeText(relativePath).replaceAll('\\', '/');
  if (!safePath || /[A-Z]:\//i.test(safePath) || safePath.includes('..')) return '';
  if (!safePath.startsWith('outputs/export-packages/')) return '';
  return `/${safePath}`;
}
