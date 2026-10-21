import {exportReportText, exportReportLabel, exportReportCards, exportReportBoolean} from './exportReportLabels.js';

const platformOptions = ['temu', 'miaoshou', 'amazon', 'noon', 'ozon', 'rakuten'];
const sandboxConfigKey = 'uploadSandboxConfig';

const SECRET_PATTERNS = [
  [/[A-Z]:\\[^\s"',，。；;]+/gi, '[local-path-removed]'],
  [/\b[\w.-]*\.sqlite\b/gi, '[sqlite-path-removed]'],
  [/\bnode_modules\b/gi, '[node-modules-removed]'],
  [/\.env(?:\.[\w.-]+)?/gi, '[env-file-removed]'],
  [/\b[A-Z0-9_]*API[_-]?KEY\b\s*[:=]\s*[^\s"',，。；;]+/gi, '[credential-removed]'],
  [/\b(?:sk|rk|ak)-[A-Za-z0-9_-]{6,}\b/gi, '[credential-removed]'],
  [/\b(provider[_-]?credential|provider[_-]?secret|api[_-]?key|secret|token|password|account)\b\s*[:=]\s*[^\s"',，。；;]+/gi, '[credential-removed]'],
  [/\b(token|secret|account)\b/gi, '[credential-removed]']
];

export const uploadReadinessNotice = '本阶段只做 dry-run 上传前检查，不会上传商品，不会调用平台 API。';
export const uploadSandboxNotice = '本阶段仅做沙盒 dry-run，不会上传平台。请确认 CSV、图片和审核状态满足要求。';

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
    return Object.fromEntries(Object.entries(value)
      .filter(([key]) => !/apiKey|api_key|secret|token|password|credential|absolutePath|sourceFolderPath|sqlitePath|dbPath|platformAccount/i.test(key))
      .map(([key, item]) => [key, sanitizeForDisplay(item)]));
  }
  if (typeof value === 'string') return safeText(value);
  return value;
}

export function normalizeUploadReadinessOptions(input = {}) {
  const platforms = asArray(input.platforms)
    .flatMap((item) => String(item || '').split(','))
    .map((item) => item.trim().toLowerCase())
    .filter((item) => platformOptions.includes(item));
  return {
    platforms: platforms.length ? [...new Set(platforms)] : ['temu', 'miaoshou']
  };
}

export function normalizeUploadSandboxConfig(input = {}) {
  const entries = Object.entries(input || {})
    .filter(([platformId]) => platformOptions.includes(String(platformId || '').toLowerCase()))
    .map(([platformId, config]) => {
      const normalizedPlatformId = String(platformId).toLowerCase();
      const accountName = String(config?.accountName || '').trim();
      const credential = String(config?.credential || '').trim();
      const enabled = config?.enabled !== false;
      return [normalizedPlatformId, {
        enabled,
        accountName,
        credential,
        configured: enabled && Boolean(accountName || credential)
      }];
    });
  return Object.fromEntries(entries);
}

function storageOrDefault(storage) {
  if (storage) return storage;
  if (typeof window !== 'undefined' && window.localStorage) return window.localStorage;
  return null;
}

export function loadUploadSandboxConfig(storage) {
  const target = storageOrDefault(storage);
  if (!target) return {};
  try {
    return normalizeUploadSandboxConfig(JSON.parse(target.getItem(sandboxConfigKey) || '{}'));
  } catch {
    return {};
  }
}

export function saveUploadSandboxConfig(config = {}, storage) {
  const normalized = normalizeUploadSandboxConfig(config);
  const target = storageOrDefault(storage);
  if (target) target.setItem(sandboxConfigKey, JSON.stringify(normalized));
  return normalized;
}

function issueText(items = []) {
  return asArray(items)
    .map((item) => {
      if (typeof item === 'string') return safeText(item);
      const parts = [
        item.code,
        item.sku,
        item.platformId,
        item.message,
        asArray(item.fields).join(','),
        asArray(item.images).join(',')
      ].filter(Boolean);
      return parts.map(safeText).join(' - ');
    })
    .filter(Boolean)
    .join(' / ');
}

export function getUploadReadinessDisplayModel(report, t) {
  if (!report) {
    return {
      emptyText: exportReportText(t, '暂无上传前检查报告。请先选择平台，然后点击“执行上传前检查”。'),
      summaryCards: [],
      platformRows: [],
      skuRows: [],
      blockingText: '',
      warningText: '',
      recommendationText: '',
      nextSuggestedAction: '',
      notice: exportReportText(t, uploadReadinessNotice)
    };
  }
  const summary = report.summary || {};
  return {
    emptyText: '',
    notice: exportReportText(t, uploadReadinessNotice),
    summaryCards: exportReportCards([
      { label: 'total SKU', value: String(summary.totalSku || 0) },
      { label: 'ready SKU', value: String(summary.readySku || 0) },
      { label: 'blocked SKU', value: String(summary.blockedSku || 0) },
      { label: 'warning SKU', value: String(summary.warningSku || 0) },
      { label: 'missing images', value: String(summary.missingImageCount || 0) },
      { label: 'missing fields', value: String(summary.missingFieldCount || 0) },
      { label: 'noReview SKU', value: String(summary.noReviewSku || 0) },
      { label: 'highRisk SKU', value: String(summary.highRiskSku || 0) },
      { label: 'mockImage SKU', value: String(summary.mockImageSku || 0) },
      { label: 'canUploadNow', value: exportReportBoolean(summary.canUploadNow === true, t) }
    ], t),
    platformRows: asArray(report.platformReports).map((row) => ({...sanitizeForDisplay(row),statusDisplay:exportReportLabel('status',row.status,t),realUploadEnabledText:exportReportBoolean(row.realUploadEnabled,t)})),
    skuRows: asArray(report.skuReports).map((row) => ({
      ...sanitizeForDisplay(row),
      statusDisplay: exportReportLabel('status',row.status,t),
      reviewStatusDisplay: exportReportLabel('status',row.reviewStatus,t),
      usesMockImagesText: exportReportBoolean(row.usesMockImages,t),
      hasHighRiskIssuesText: exportReportBoolean(row.hasHighRiskIssues,t),
      readyText: exportReportBoolean(row.ready,t),
      missingFieldsText: asArray(row.missingFields).join(', ') || '-',
      missingImagesText: asArray(row.missingImages).join(', ') || '-',
      blockingText: issueText(row.blockingIssues),
      warningText: issueText(row.warnings)
    })),
    blockingText: issueText(report.blockingIssues),
    warningText: issueText(report.warnings),
    recommendationText: asArray(report.recommendations).map(safeText).join(' / '),
    nextSuggestedAction: safeText(report.nextSuggestedAction || '')
  };
}

export function uploadReadinessJson(report) {
  return JSON.stringify(sanitizeForDisplay(report || {}), null, 2);
}

export function buildUploadReadinessDownload({ batchId, report, timestamp } = {}) {
  const safeBatchId = safeText(batchId || report?.meta?.batchId || 'batch').replace(/[^A-Za-z0-9._-]+/g, '-');
  const safeTimestamp = safeText(timestamp || new Date().toISOString().replace(/[:.]/g, '-'));
  return {
    fileName: `upload-readiness-report-${safeBatchId}-${safeTimestamp}.json`,
    mimeType: 'application/json',
    json: uploadReadinessJson(report)
  };
}

export function downloadUploadReadinessJson({ batchId, report, timestamp } = {}) {
  if (typeof document === 'undefined') return null;
  const download = buildUploadReadinessDownload({ batchId, report, timestamp });
  const blob = new Blob([download.json], { type: download.mimeType });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = download.fileName;
  anchor.click();
  URL.revokeObjectURL(url);
  return download;
}
