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

function boolText(value) {
  return value ? '是' : '否';
}

function passText(value) {
  return value ? '通过' : '未通过';
}

function diversityLevelLabel(level) {
  if (level === 'high') return '高 (high)';
  if (level === 'medium') return '中 (medium)';
  if (level === 'low') return '低 (low)';
  return level || '-';
}

export function templateAuditEmptyText(report) {
  if (!report) return '暂无模板验收报告。请先完成图片方案生成或 mock 图片生成。';
  if (!Number(report.meta?.imageCount || 0)) return '暂无可验收的 mock 图片，请先生成图片。';
  return '';
}

export function templateAuditCoverageRows(report) {
  return asArray(report?.imageTypeCoverage).map((row) => ({
    imageType: row.imageType || '',
    imageTypeLabel: imageTypeLabels[row.imageType] || row.imageType || '-',
    exists: Boolean(row.exists),
    existsText: row.exists ? '已生成' : '缺少',
    templateName: row.templateName || '-',
    layoutStyle: row.layoutStyle || '-',
    variantId: row.variantId || '-',
    layoutSeed: row.layoutSeed || '-',
    status: row.status || '-'
  }));
}

export function templateAuditDisplaySections(report) {
  const emptyText = templateAuditEmptyText(report);
  const coverageRows = templateAuditCoverageRows(report);
  const imageCount = Number(report?.meta?.imageCount || 0);
  const expectedCount = asArray(report?.meta?.expectedImageTypes).length || 8;
  const presentCount = coverageRows.filter((row) => row.exists).length;
  const coverageComplete = expectedCount > 0 && presentCount >= expectedCount;
  const diversity = report?.templateDiversity || {};
  const textSafety = report?.textSafety || {};
  const fieldSafety = report?.fieldSafety || {};
  const amazon = report?.amazonMainImageCheck || {};
  const ruleAudit = report?.ruleAuditSummary || null;
  const textSafe = !textSafety.containsChinese && !textSafety.containsPrice && !textSafety.containsPromotionWords && !textSafety.containsBannedWords;
  const fieldSafe = !fieldSafety.usesInferredCandidates &&
    !fieldSafety.usesBlockedHighRiskFields &&
    !fieldSafety.usesConflictedFields &&
    !fieldSafety.usesMissingEvidenceFields;
  const ruleAuditIssues = asArray(ruleAudit?.issues);
  const ruleAuditGroups = asArray(ruleAudit?.imagePlanRuleAudit).map((group) => ({
    ...group,
    imageTypeLabel: group.imageTypeLabel || imageTypeLabels[group.imageType] || group.imageType || '-',
    issues: asArray(group.issues),
    summaryText: `${group.imageTypeLabel || imageTypeLabels[group.imageType] || group.imageType || '-'}：${group.issueCount || 0} 个规则问题，error ${group.errorCount || 0} / warning ${group.warningCount || 0} / info ${group.infoCount || 0}`
  }));
  const ruleAuditFields = [
    ...asArray(ruleAudit?.blockedFields),
    ...asArray(ruleAudit?.cautionFields)
  ].map((item) => ({
    ...item,
    fieldLabel: item.fieldLabel || item.fieldKey || '-',
    labelText: item.labelText || `${item.fieldLabel || item.fieldKey || '-'} ${item.fieldKey || ''}`.trim(),
    imageTypeLabel: imageTypeLabels[item.imageType] || item.imageType || '-'
  }));
  const ruleAuditCopyRisks = ruleAuditIssues.filter((item) => copyRiskCodes.has(item.code));
  const ruleAuditAmazonRisks = ruleAuditIssues.filter((item) => amazonMainImageCodes.has(item.code));
  const ruleAuditContextWarnings = asArray(ruleAudit?.contextWarnings);

  return {
    emptyText,
    coverageRows,
    summaryText: `图片数量 ${imageCount}，${coverageComplete ? '8 类图片已齐全' : `已生成 ${presentCount}/${expectedCount} 类图片`}，模板差异分 ${diversity.diversityScore ?? 0}。`,
    diversityText: `差异分 ${diversity.diversityScore ?? 0}，等级 ${diversityLevelLabel(diversity.diversityLevel)}。templateName ${diversity.uniqueTemplateNames || 0} 个，layoutStyle ${diversity.uniqueLayoutStyles || 0} 个，variantId ${diversity.uniqueVariantIds || 0} 个。${asArray(diversity.warnings).join(' ')}`,
    amazonText: `Amazon 主图${amazon.pass ? '通过' : '未通过'}。白底：${boolText(amazon.isPureWhite)}，文字块：${boolText(amazon.hasTextBlocks)}，图标：${boolText(amazon.hasIcons)}，位置：${amazon.productPlacement || '-'}。${asArray(amazon.warnings).join(' ')}`,
    textSafetyText: textSafe
      ? '文案安全通过：未发现中文、价格、折扣或促销词。'
      : `文案安全未通过：发现中文 ${boolText(textSafety.containsChinese)}，价格 ${boolText(textSafety.containsPrice)}，折扣/促销词 ${boolText(textSafety.containsPromotionWords)}。`,
    fieldSafetyText: fieldSafe
      ? '字段安全通过：未发现 AI 推测、缺证据、冲突或高风险字段进入图片文案。'
      : `字段安全未通过：使用了 AI 推测字段 ${boolText(fieldSafety.usesInferredCandidates)}，缺证据字段 ${boolText(fieldSafety.usesMissingEvidenceFields)}，冲突字段 ${boolText(fieldSafety.usesConflictedFields)}，高风险字段 ${boolText(fieldSafety.usesBlockedHighRiskFields)}。`,
    repeatedTemplates: asArray(diversity.repeatedTemplates),
    recommendations: asArray(report?.recommendations),
    ruleAuditEmptyText: ruleAudit ? '' : '暂无规则审计结果。',
    ruleAuditContextText: ruleAuditContextWarnings.join(' '),
    ruleAuditText: ruleAudit
      ? `规则审计${passText(ruleAudit.passed)}：error ${ruleAudit.errorCount || ruleAudit.issueCounts?.error || 0} / warning ${ruleAudit.warningCount || ruleAudit.issueCounts?.warning || 0} / info ${ruleAudit.infoCount || ruleAudit.issueCounts?.info || 0}，平台 ${ruleAudit.platformId || '-'}，类目 ${ruleAudit.categoryId || 'generic_ecommerce'}。`
      : '暂无规则审计结果。',
    ruleAuditCards: [
      { label: '规则审计', value: ruleAudit ? passText(ruleAudit.passed) : '-', tone: ruleAudit?.passed ? 'ok' : 'danger' },
      { label: 'error', value: String(ruleAudit?.errorCount ?? ruleAudit?.issueCounts?.error ?? 0), tone: (ruleAudit?.errorCount ?? ruleAudit?.issueCounts?.error ?? 0) ? 'danger' : 'ok' },
      { label: 'warning', value: String(ruleAudit?.warningCount ?? ruleAudit?.issueCounts?.warning ?? 0), tone: (ruleAudit?.warningCount ?? ruleAudit?.issueCounts?.warning ?? 0) ? 'warn' : 'ok' },
      { label: 'info', value: String(ruleAudit?.infoCount ?? ruleAudit?.issueCounts?.info ?? 0), tone: 'warn' },
      { label: '平台', value: ruleAudit?.platformId || '-', tone: 'warn' },
      { label: '类目', value: ruleAudit?.categoryId || 'generic_ecommerce', tone: 'warn' }
    ],
    ruleAuditGroups,
    ruleAuditFields,
    ruleAuditCopyRisks,
    ruleAuditAmazonRisks,
    ruleAuditCopyRiskText: ruleAuditCopyRisks.length
      ? `文案风险：${ruleAuditCopyRisks.map((item) => item.message || item.code).join('；')}`
      : '文案风险：未发现中文、价格、折扣、促销词、绝对化词或谨慎词。',
    ruleAuditAmazonText: ruleAuditAmazonRisks.length
      ? `Amazon 主图风险：${ruleAuditAmazonRisks.map((item) => item.message || item.code).join('；')}`
      : 'Amazon 主图风险：未发现白底、文字、icon、价格/促销规则问题。',
    ruleAuditRecommendations: asArray(ruleAudit?.recommendations),
    ruleAuditEffectiveRulesText: ruleAudit?.effectiveRulesSummary
      ? `${ruleAudit.effectiveRulesSummary.mainImageText || ''} ${ruleAudit.effectiveRulesSummary.secondaryImageText || ''}`.trim()
      : '',
    summaryCards: [
      { label: '图片数量', value: String(imageCount), tone: imageCount ? 'ok' : 'warn' },
      { label: '8 类图片', value: coverageComplete ? '齐全' : `${presentCount}/${expectedCount}`, tone: coverageComplete ? 'ok' : 'warn' },
      { label: '模板差异分', value: String(diversity.diversityScore ?? 0), tone: diversity.diversityLevel === 'high' ? 'ok' : 'warn' },
      { label: '差异等级', value: diversity.diversityLevel || '-', tone: diversity.diversityLevel === 'high' ? 'ok' : 'warn' },
      { label: 'Amazon 主图', value: passText(amazon.pass), tone: amazon.pass ? 'ok' : 'danger' },
      { label: '文案安全', value: passText(textSafe), tone: textSafe ? 'ok' : 'danger' },
      { label: '字段安全', value: passText(fieldSafe), tone: fieldSafe ? 'ok' : 'danger' }
    ]
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
  if (confirmExport && !confirmExport(templateAuditExportNotice)) {
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
