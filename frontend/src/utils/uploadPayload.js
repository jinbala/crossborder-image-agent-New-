const SECRET_PATTERNS = [
  [/[A-Z]:\\[^\s"',，。；;]+/gi, '[local-path-removed]'],
  [/\b[\w.-]*\.sqlite\b/gi, '[sqlite-path-removed]'],
  [/\bnode_modules\b/gi, '[node-modules-removed]'],
  [/\.env(?:\.[\w.-]+)?/gi, '[env-file-removed]'],
  [/\b[A-Z0-9_]*API[_-]?KEY\b\s*[:=]\s*[^\s"',，。；;]+/gi, '[credential-removed]'],
  [/\b(?:sk|rk|ak)-[A-Za-z0-9_-]{6,}\b/gi, '[credential-removed]'],
  [/\b(provider[_-]?credential|provider[_-]?secret|api[_-]?key|secret|token|password|account)\b\s*[:=]\s*[^\s"',，。；;]+/gi, '[credential-removed]'],
  [/\b(token|secret|account|seller)\b/gi, '[credential-removed]']
];

export const uploadPayloadNotice = '本阶段只生成上传请求预览和沙盒模拟结果，不会上传平台，不会调用平台 API。';

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
      .filter(([key]) => !/apiKey|api_key|secret|token|password|credential|localStorageAccount|absolutePath|sourceFolderPath|sqlitePath|dbPath|platformAccount|account/i.test(key))
      .map(([key, item]) => [key, sanitizeForDisplay(item)]));
  }
  if (typeof value === 'string') return safeText(value);
  return value;
}

function issueText(items = []) {
  return asArray(items)
    .map((item) => {
      if (typeof item === 'string') return safeText(item);
      return [
        item.code,
        item.sku,
        item.platformId,
        item.message,
        asArray(item.fields).join(','),
        asArray(item.images).join(',')
      ].filter(Boolean).map(safeText).join(' - ');
    })
    .filter(Boolean)
    .join(' / ');
}

function payloadFields(payload = {}) {
  return Object.keys(payload)
    .filter((key) => payload[key] !== undefined && payload[key] !== null && payload[key] !== '' && key !== 'images' && key !== 'imageList')
    .join(', ');
}

function imageCount(payload = {}) {
  if (Array.isArray(payload.imageList)) return payload.imageList.length;
  return Number(Boolean(payload.images?.main)) + asArray(payload.images?.gallery).length;
}

export function getUploadPayloadDisplayModel(preview) {
  if (!preview) {
    return {
      emptyText: '暂无 Payload 预览。请先点击“生成 Payload 预览”。',
      summaryCards: [],
      platformRows: [],
      skuRows: [],
      blockedText: '',
      warningText: '',
      recommendationText: '',
      notice: uploadPayloadNotice
    };
  }
  const summary = preview.summary || {};
  return {
    emptyText: '',
    notice: uploadPayloadNotice,
    summaryCards: [
      { label: 'total SKU', value: String(summary.totalSku || 0) },
      { label: 'ready payload', value: String(summary.readyPayloadCount || 0) },
      { label: 'warning payload', value: String(summary.warningPayloadCount || 0) },
      { label: 'blocked payload', value: String(summary.blockedPayloadCount || 0) },
      { label: 'missing fields', value: String(summary.missingFieldCount || 0) },
      { label: 'mock images', value: String(summary.mockImagePayloadCount || 0) }
    ],
    platformRows: asArray(preview.platformPayloads).map(sanitizeForDisplay),
    skuRows: asArray(preview.skuPayloads).map((row) => ({
      ...sanitizeForDisplay(row),
      fieldSummary: payloadFields(row.payload || {}),
      imageCount: imageCount(row.payload || {}),
      missingFieldsText: asArray(row.missingFields).join(', ') || '-',
      blockedFieldsText: asArray(row.blockedFields).join(', ') || '-',
      warningText: issueText(row.warnings),
      riskNotesText: asArray(row.riskNotes).map(safeText).join(', ') || '-'
    })),
    blockedText: issueText(preview.blockedPayloads?.flatMap((row) => row.blockingIssues || [])),
    warningText: issueText(preview.warnings),
    recommendationText: asArray(preview.recommendations).map(safeText).join(' / ')
  };
}

export function getUploadSandboxDisplayModel(report) {
  if (!report) {
    return {
      emptyText: '暂无沙盒模拟结果。请先点击“执行沙盒提交模拟”。',
      summaryCards: [],
      resultRows: [],
      blockedText: '',
      warningText: '',
      recommendationText: '',
      notice: uploadPayloadNotice
    };
  }
  const summary = report.summary || {};
  return {
    emptyText: '',
    notice: uploadPayloadNotice,
    summaryCards: [
      { label: 'accepted', value: String(summary.accepted || 0) },
      { label: 'accepted_with_warnings', value: String(summary.acceptedWithWarnings || 0) },
      { label: 'blocked', value: String(summary.blocked || 0) },
      { label: 'uploaded', value: String(summary.uploaded === true) },
      { label: 'realNetworkCalled', value: String(summary.realNetworkCalled === true) },
      { label: 'externalApiCalled', value: String(summary.externalApiCalled === true) }
    ],
    resultRows: asArray(report.simulatedResults).map((row) => ({
      ...sanitizeForDisplay(row),
      uploadedText: String(row.uploaded === true),
      realNetworkCalledText: String(row.realNetworkCalled === true),
      externalApiCalledText: String(row.externalApiCalled === true),
      blockingText: issueText(row.blockingIssues),
      warningText: issueText(row.warnings)
    })),
    blockedText: issueText(report.blockedResults?.flatMap((row) => row.blockingIssues || [])),
    warningText: issueText(report.warnings),
    recommendationText: asArray(report.recommendations).map(safeText).join(' / ')
  };
}

export function uploadPayloadJson(value) {
  return JSON.stringify(sanitizeForDisplay(value || {}), null, 2);
}

function safeFileBatchId(value) {
  return safeText(value || 'batch').replace(/[^A-Za-z0-9._-]+/g, '-');
}

function safeTimestamp(value) {
  return safeText(value || new Date().toISOString().replace(/[:.]/g, '-'));
}

export function buildUploadPayloadDownload({ batchId, preview, timestamp } = {}) {
  return {
    fileName: `upload-payload-preview-${safeFileBatchId(batchId || preview?.meta?.batchId)}-${safeTimestamp(timestamp)}.json`,
    mimeType: 'application/json',
    json: uploadPayloadJson(preview)
  };
}

export function buildUploadSandboxDownload({ batchId, report, timestamp } = {}) {
  return {
    fileName: `upload-sandbox-report-${safeFileBatchId(batchId || report?.meta?.batchId)}-${safeTimestamp(timestamp)}.json`,
    mimeType: 'application/json',
    json: uploadPayloadJson(report)
  };
}

function browserDownload(download) {
  if (typeof document === 'undefined') return null;
  const blob = new Blob([download.json], { type: download.mimeType });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = download.fileName;
  anchor.click();
  URL.revokeObjectURL(url);
  return download;
}

export function downloadUploadPayloadJson({ batchId, preview, timestamp } = {}) {
  return browserDownload(buildUploadPayloadDownload({ batchId, preview, timestamp }));
}

export function downloadUploadSandboxJson({ batchId, report, timestamp } = {}) {
  return browserDownload(buildUploadSandboxDownload({ batchId, report, timestamp }));
}
