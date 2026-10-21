import {exportReportText, exportReportLabel, exportReportCards, exportReportBoolean} from './exportReportLabels.js';

const SECRET_PATTERNS = [
  [/[A-Z]:\\[^\s"',，。；;]+/gi, '[local-path-removed]'],
  [/\b[\w.-]*\.sqlite\b/gi, '[sqlite-path-removed]'],
  [/\bnode_modules\b/gi, '[node-modules-removed]'],
  [/\.env(?:\.[\w.-]+)?/gi, '[env-file-removed]'],
  [/\b[A-Z0-9_]*API[_-]?KEY\b\s*[:=]\s*[^\s"',，。；;]+/gi, '[credential-removed]'],
  [/\b(?:sk|rk|ak)-[A-Za-z0-9_-]{6,}\b/gi, '[credential-removed]'],
  [/\b(provider secret|provider credential|Temu token|Miaoshou token|Amazon token)\b/gi, '[credential-removed]'],
  [/\breal token value\b/gi, '[credential-removed]']
];

export const uploadSafetyNotice = '当前不会真实上传，也不会调用平台 API。页面只显示变量名、configured 状态和安全风险提示；localStorage 仅用于 dry-run UI 体验，不能保存真实平台凭据。';

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
      .filter(([key]) => !/apiKey|api_key|password|credentialValue|rawValue|absolutePath|sourceFolderPath|sqlitePath|dbPath/i.test(key))
      .map(([key, item]) => [key, sanitizeForDisplay(item)]));
  }
  if (typeof value === 'string') return safeText(value);
  return value;
}

function issueText(items = [], t) {
  return asArray(items)
    .map((item) => {
      if (typeof item === 'string') return safeText(item);
      return [exportReportLabel('severity',item.severity,t), item.code, item.message].filter(Boolean).map(safeText).join(' - ');
    })
    .filter(Boolean)
    .join(' / ');
}

export function getUploadSafetyDisplayModel(report, t) {
  if (!report) {
    return {
      emptyText: exportReportText(t, '暂无上传安全检查报告。请点击“刷新凭据状态”查看当前只读状态。'),
      notice: exportReportText(t, uploadSafetyNotice),
      summaryCards: [],
      platformRows: [],
      findingText: '',
      recommendationText: '',
      nextSuggestedAction: ''
    };
  }

  const summary = report.summary || {};
  const credentialStatus = report.credentialStatus || {};
  return {
    emptyText: '',
    notice: exportReportText(t, uploadSafetyNotice),
    summaryCards: exportReportCards([
      { label: 'realUploadEnabled', value: exportReportBoolean(report.meta?.realUploadEnabled === true || credentialStatus.realUploadEnabled === true, t) },
      { label: 'readyForSandboxApi', value: exportReportBoolean(summary.readyForSandboxApi === true, t) },
      { label: 'readyForRealUpload', value: exportReportBoolean(summary.readyForRealUpload === true, t) },
      { label: 'platformsChecked', value: String(summary.platformsChecked || 0) },
      { label: 'criticalIssues', value: String(summary.criticalIssues || 0) },
      { label: 'warnings', value: String(summary.warnings || 0) }
    ], t),
    platformRows: asArray(credentialStatus.platforms).map((platform) => {
      const safe = sanitizeForDisplay(platform);
      return {
        ...safe,
        configuredText: exportReportText(t, safe.configured === true ? '已配置' : '未配置'),
        sandboxText: exportReportText(t, safe.sandboxSupported === true ? '支持 dry-run' : '占位'),
        realUploadText: exportReportText(t, safe.realUploadSupported === true ? '支持真实上传' : '不支持真实上传'),
        requiredVariablesText: asArray(safe.requiredVariables).join(', ') || '-',
        configuredVariablesText: asArray(safe.configuredVariables).join(', ') || '-',
        missingVariablesText: asArray(safe.missingVariables).join(', ') || '-',
        warningText: issueText(safe.warnings,t)
      };
    }),
    findingText: issueText(report.securityFindings,t),
    recommendationText: asArray(report.recommendations).map(safeText).join(' / '),
    nextSuggestedAction: safeText(report.nextSuggestedAction || '')
  };
}

export function uploadSafetyJson(report) {
  return JSON.stringify(sanitizeForDisplay(report || {}), null, 2);
}

export function buildUploadSafetyDownload({ report, timestamp } = {}) {
  const safeTimestamp = safeText(timestamp || new Date().toISOString().replace(/[:.]/g, '-'));
  return {
    fileName: `upload-safety-report-${safeTimestamp}.json`,
    mimeType: 'application/json',
    json: uploadSafetyJson(report)
  };
}

export function downloadUploadSafetyJson({ report, timestamp } = {}) {
  if (typeof document === 'undefined') return null;
  const download = buildUploadSafetyDownload({ report, timestamp });
  const blob = new Blob([download.json], { type: download.mimeType });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = download.fileName;
  anchor.click();
  URL.revokeObjectURL(url);
  return download;
}
