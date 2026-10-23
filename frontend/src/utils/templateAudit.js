import { reportDisplayLabel, reportUi } from './reportDisplayLabels.js';
const SECRET_PATTERNS = [
  [/[A-Z]:\\[^\s"',，。；;]+/gi, '[local-path-removed]'],
  [/\b[\w.-]*\.sqlite\b/gi, '[sqlite-path-removed]'],
  [/\bnode_modules\b/gi, '[node-modules-removed]'],
  [/\.env(?:\.[\w.-]+)?/gi, '[env-file-removed]'],
  [/\b[A-Z0-9_]*API[_-]?KEY\b\s*[:=]\s*[^\s"',，。；;]+/gi, '[api-key-removed]'],
  [/\b(?:sk|rk|ak)-[A-Za-z0-9_-]{6,}\b/g, '[secret-removed]'],
  [/\b(provider[_-]?secret|api[_-]?key|secret)\b\s*[:=]\s*[^\s"',，。；;]+/gi, '[secret-removed]']
];

const imageTypeLabels = {
  main_image: '平台主图',
  feature_image: '核心卖点图',
  size_image: '尺寸/规格图',
  compatibility_image: '兼容设备图',
  package_image: '包装清单图',
  lifestyle_image: '使用场景图',
  detail_image: '细节图',
  variant_image: '变体图'
};

const copyRiskCodes = new Set([
  'TEXT_CONTAINS_CHINESE',
  'TEXT_CONTAINS_PRICE',
  'TEXT_CONTAINS_BANNED_WORD',
  'TEXT_CONTAINS_CAUTION_WORD'
]);

const amazonMainImageCodes = new Set([
  'MAIN_IMAGE_TEXT_NOT_ALLOWED',
  'MAIN_IMAGE_BACKGROUND_NOT_WHITE',
  'MAIN_IMAGE_ICON_NOT_ALLOWED'
]);

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

function sanitizeForExport(value) {
  if (Array.isArray(value)) return value.map(sanitizeForExport);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, sanitizeForExport(item)]));
  }
  if (typeof value === 'string') return safeText(value);
  return value;
}

function boolText(value, t) {
  return reportUi(t)(value === true ? '是' : value === false ? '否' : '未知');
}

function passText(value, t) {
  return reportUi(t)(value === true ? '通过' : value === false ? '未通过' : '未检查');
}

function diversityLevelLabel(level, t) {
  if (level === 'high') return reportUi(t)('高 (high)');
  if (level === 'medium') return reportUi(t)('中 (medium)');
  if (level === 'low') return reportUi(t)('低 (low)');
  return level || '-';
}

export function templateAuditEmptyText(report, t) {
  if (!report) return reportUi(t)('暂无模板验收报告。请先完成图片方案生成或 mock 图片生成。');
  if (!Number(report.meta?.imageCount || 0)) return reportUi(t)('暂无可验收的 mock 图片，请先生成图片。');
  return '';
}

function imageLabel(type, fallback, t) {
  return Object.hasOwn(imageTypeLabels, type) ? reportUi(t)(t ? imageTypeLabels[type] : fallback || imageTypeLabels[type]) : fallback || type || '-';
}

export function templateAuditCoverageRows(report, t) {
  return asArray(report?.imageTypeCoverage).map((row) => ({
    imageType: row.imageType || '',
    imageTypeLabel: imageLabel(row.imageType, '', t),
    exists: row.exists === true,
    existsText: reportUi(t)(row.exists === true ? '已生成' : '缺少'),
    templateName: row.templateName || '-',
    layoutStyle: row.layoutStyle || '-',
    variantId: row.variantId || '-',
    layoutSeed: row.layoutSeed || '-',
    status: row.status || '-',
    statusLabel: reportDisplayLabel('status', row.status || '-', t)
  }));
}

export function templateAuditDisplaySections(report, t) {
  const ui = reportUi(t);
  const emptyText = templateAuditEmptyText(report, t);
  const coverageRows = templateAuditCoverageRows(report, t);
  const imageCount = Number(report?.meta?.imageCount || 0);
  const expectedCount = asArray(report?.meta?.expectedImageTypes).length || 8;
  const presentCount = coverageRows.filter((row) => row.exists).length;
  const coverageComplete = expectedCount > 0 && presentCount >= expectedCount;
  const diversity = report?.templateDiversity || {};
  const textSafety = report?.textSafety || {};
  const fieldSafety = report?.fieldSafety || {};
  const amazon = report?.amazonMainImageCheck || {};
  const ruleAudit = report?.ruleAuditSummary || null;
  const textFlags = [textSafety.containsChinese, textSafety.containsPrice, textSafety.containsPromotionWords, textSafety.containsBannedWords];
  const fieldFlags = [fieldSafety.usesInferredCandidates, fieldSafety.usesBlockedHighRiskFields, fieldSafety.usesConflictedFields, fieldSafety.usesMissingEvidenceFields];
  const textSafe = textFlags.every(value => value === false), textUnsafe = textFlags.some(value => value === true);
  const fieldSafe = fieldFlags.every(value => value === false), fieldUnsafe = fieldFlags.some(value => value === true);
  const ruleAuditIssues = asArray(ruleAudit?.issues);
  const ruleAuditGroups = asArray(ruleAudit?.imagePlanRuleAudit).map((group) => ({
    ...group,
    imageTypeLabel: imageLabel(group.imageType, group.imageTypeLabel, t),
    issues: asArray(group.issues),
    summaryText: ui('{type}：{count} 个规则问题，error {error} / warning {warning} / info {info}', { type: imageLabel(group.imageType, group.imageTypeLabel, t), count: group.issueCount || 0, error: group.errorCount || 0, warning: group.warningCount || 0, info: group.infoCount || 0 })
  }));
  const ruleAuditFields = [
    ...asArray(ruleAudit?.blockedFields),
    ...asArray(ruleAudit?.cautionFields)
  ].map((item) => ({
    ...item,
    fieldLabel: item.fieldLabel || item.fieldKey || '-',
    labelText: item.labelText || `${item.fieldLabel || item.fieldKey || '-'} ${item.fieldKey || ''}`.trim(),
    imageTypeLabel: imageLabel(item.imageType, '', t)
  }));
  const ruleAuditCopyRisks = ruleAuditIssues.filter((item) => copyRiskCodes.has(item.code));
  const ruleAuditAmazonRisks = ruleAuditIssues.filter((item) => amazonMainImageCodes.has(item.code));
  const ruleAuditContextWarnings = asArray(ruleAudit?.contextWarnings);

  return {
    emptyText,
    coverageRows,
    summaryText: ui('图片数量 {count}，{coverage}，模板差异分 {score}。', { count: imageCount, coverage: coverageComplete ? ui('{count} 类图片已齐全', { count: expectedCount }) : ui('已生成 {present}/{expected} 类图片', { present: presentCount, expected: expectedCount }), score: diversity.diversityScore ?? 0 }),
    diversityText: ui('差异分 {score}，等级 {level}。templateName {templates} 个，layoutStyle {layouts} 个，variantId {variants} 个。', { score: diversity.diversityScore ?? 0, level: diversityLevelLabel(diversity.diversityLevel, t), templates: diversity.uniqueTemplateNames || 0, layouts: diversity.uniqueLayoutStyles || 0, variants: diversity.uniqueVariantIds || 0 }) + asArray(diversity.warnings).join(' '),
    amazonText: ui('Amazon 主图{status}。白底：{white}，文字块：{text}，图标：{icons}，位置：{position}。', { status: passText(amazon.pass, t), white: boolText(amazon.isPureWhite, t), text: boolText(amazon.hasTextBlocks, t), icons: boolText(amazon.hasIcons, t), position: amazon.productPlacement || '-' }) + asArray(amazon.warnings).join(' '),
    textSafetyText: textSafe
      ? ui('文案安全通过：未发现中文、价格、折扣或促销词。')
      : textUnsafe ? ui('文案安全未通过：发现中文 {chinese}，价格 {price}，折扣/促销词 {promotion}。', { chinese: boolText(textSafety.containsChinese, t), price: boolText(textSafety.containsPrice, t), promotion: boolText(textSafety.containsPromotionWords, t) }) : ui('文案安全未检查：报告缺少明确的检查结果，请重新验收。'),
    fieldSafetyText: fieldSafe
      ? ui('字段安全通过：未发现 AI 推测、缺证据、冲突或高风险字段进入图片文案。')
      : fieldUnsafe ? ui('字段安全未通过：使用了 AI 推测字段 {inferred}，缺证据字段 {missing}，冲突字段 {conflicted}，高风险字段 {risk}。', { inferred: boolText(fieldSafety.usesInferredCandidates, t), missing: boolText(fieldSafety.usesMissingEvidenceFields, t), conflicted: boolText(fieldSafety.usesConflictedFields, t), risk: boolText(fieldSafety.usesBlockedHighRiskFields, t) }) : ui('字段安全未检查：报告缺少明确的检查结果，请重新验收。'),
    repeatedTemplates: asArray(diversity.repeatedTemplates),
    recommendations: asArray(report?.recommendations),
    ruleAuditEmptyText: ruleAudit ? '' : ui('暂无规则审计结果。'),
    ruleAuditContextText: ruleAuditContextWarnings.join(' '),
    ruleAuditText: ruleAudit
      ? ui('规则审计{status}：error {error} / warning {warning} / info {info}，平台 {platform}，类目 {category}。', { status: passText(ruleAudit.passed, t), error: ruleAudit.errorCount || ruleAudit.issueCounts?.error || 0, warning: ruleAudit.warningCount || ruleAudit.issueCounts?.warning || 0, info: ruleAudit.infoCount || ruleAudit.issueCounts?.info || 0, platform: ruleAudit.platformId || '-', category: ruleAudit.categoryId || 'generic_ecommerce' })
      : ui('暂无规则审计结果。'),
    ruleAuditCards: [
      { label: '规则审计', value: ruleAudit ? passText(ruleAudit.passed, t) : '-', tone: ruleAudit?.passed === true ? 'ok' : 'danger' },
      { label: 'error', value: String(ruleAudit?.errorCount ?? ruleAudit?.issueCounts?.error ?? 0), tone: (ruleAudit?.errorCount ?? ruleAudit?.issueCounts?.error ?? 0) ? 'danger' : 'ok' },
      { label: 'warning', value: String(ruleAudit?.warningCount ?? ruleAudit?.issueCounts?.warning ?? 0), tone: (ruleAudit?.warningCount ?? ruleAudit?.issueCounts?.warning ?? 0) ? 'warn' : 'ok' },
      { label: 'info', value: String(ruleAudit?.infoCount ?? ruleAudit?.issueCounts?.info ?? 0), tone: 'warn' },
      { label: '平台', value: ruleAudit?.platformId || '-', tone: 'warn' },
      { label: '类目', value: ruleAudit?.categoryId || 'generic_ecommerce', tone: 'warn' }
    ].map(card => ({ ...card, label: ui(card.label) })),
    ruleAuditGroups,
    ruleAuditFields,
    ruleAuditCopyRisks,
    ruleAuditAmazonRisks,
    ruleAuditCopyRiskText: ruleAuditCopyRisks.length
      ? ui('文案风险：{details}', { details: ruleAuditCopyRisks.map((item) => item.message || item.code).join('；') })
      : ui('文案风险：未发现中文、价格、折扣、促销词、绝对化词或谨慎词。'),
    ruleAuditAmazonText: ruleAuditAmazonRisks.length
      ? ui('Amazon 主图风险：{details}', { details: ruleAuditAmazonRisks.map((item) => item.message || item.code).join('；') })
      : ui('Amazon 主图风险：未发现白底、文字、icon、价格/促销规则问题。'),
    ruleAuditRecommendations: asArray(ruleAudit?.recommendations),
    ruleAuditEffectiveRulesText: ruleAudit?.effectiveRulesSummary
      ? `${ruleAudit.effectiveRulesSummary.mainImageText || ''} ${ruleAudit.effectiveRulesSummary.secondaryImageText || ''}`.trim()
      : '',
    summaryCards: [
      { label: '图片数量', value: String(imageCount), tone: imageCount ? 'ok' : 'warn' },
      { label: ui('{count} 类图片', { count: expectedCount }), value: coverageComplete ? ui('齐全') : `${presentCount}/${expectedCount}`, tone: coverageComplete ? 'ok' : 'warn' },
      { label: '模板差异分', value: String(diversity.diversityScore ?? 0), tone: diversity.diversityLevel === 'high' ? 'ok' : 'warn' },
      { label: '差异等级', value: reportDisplayLabel('quality', diversity.diversityLevel || '-', t), tone: diversity.diversityLevel === 'high' ? 'ok' : 'warn' },
      { label: 'Amazon 主图', value: passText(amazon.pass, t), tone: amazon.pass === true ? 'ok' : amazon.pass === false ? 'danger' : 'warn' },
      { label: '文案安全', value: passText(textSafe ? true : textUnsafe ? false : undefined, t), tone: textSafe ? 'ok' : textUnsafe ? 'danger' : 'warn' },
      { label: '字段安全', value: passText(fieldSafe ? true : fieldUnsafe ? false : undefined, t), tone: fieldSafe ? 'ok' : fieldUnsafe ? 'danger' : 'warn' }
    ].map(card => ({ ...card, label: ui(card.label) }))
  };
}

export function buildTemplateAuditFileName(taskId = 'task', timestamp = new Date().toISOString()) {
  return `template-audit-${taskId || 'task'}-${timestamp.replace(/[:.]/g, '-')}.json`;
}

export function templateAuditJson(report) {
  return JSON.stringify(sanitizeForExport(report || {}), null, 2);
}

export function buildTemplateAuditDownload(report, timestamp = new Date().toISOString()) {
  return {
    fileName: buildTemplateAuditFileName(report?.meta?.taskId || 'task', timestamp),
    json: templateAuditJson(report)
  };
}

export const templateAuditExportNotice = '导出 JSON 仅用于人工验收，导出内容已脱敏。';

export function downloadTemplateAuditJson(report, options = {}) {
  const confirmExport = options.confirm ?? globalThis.window?.confirm?.bind(globalThis.window);
  if (confirmExport && !confirmExport(reportUi(options.t)(templateAuditExportNotice))) {
    return { downloaded: false, reason: 'cancelled' };
  }

  const { fileName, json } = buildTemplateAuditDownload(report, options.timestamp || new Date().toISOString());
  const BlobCtor = options.BlobCtor || globalThis.Blob;
  const createObjectURL = options.createObjectURL || globalThis.URL?.createObjectURL?.bind(globalThis.URL);
  const revokeObjectURL = options.revokeObjectURL || globalThis.URL?.revokeObjectURL?.bind(globalThis.URL);
  const createElement = options.createElement || globalThis.document?.createElement?.bind(globalThis.document);
  const appendChild = options.appendChild || globalThis.document?.body?.appendChild?.bind(globalThis.document?.body);

  if (!BlobCtor || !createObjectURL || !createElement || !appendChild) {
    return { downloaded: false, reason: 'browser_api_unavailable', fileName, json };
  }

  const blob = new BlobCtor([json], { type: 'application/json;charset=utf-8' });
  const url = createObjectURL(blob);
  const link = createElement('a');
  link.href = url;
  link.download = fileName;
  appendChild(link);
  link.click();
  link.remove?.();
  revokeObjectURL?.(url);

  return { downloaded: true, fileName, json, blob, url };
}
