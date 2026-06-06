import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  buildTemplateAuditDownload,
  buildTemplateAuditFileName,
  downloadTemplateAuditJson,
  templateAuditCoverageRows,
  templateAuditDisplaySections,
  templateAuditEmptyText,
  templateAuditExportNotice,
  templateAuditJson
} from '../src/utils/templateAudit.js';

function report(overrides = {}) {
  return {
    meta: {
      taskId: 'task-audit-1',
      sku: 'AUDIT-001',
      productName: 'Portable External Drive',
      imageCount: 8,
      expectedImageTypes: [
        'main_image',
        'feature_image',
        'size_image',
        'compatibility_image',
        'package_image',
        'lifestyle_image',
        'detail_image',
        'variant_image'
      ]
    },
    imageTypeCoverage: [
      { imageType: 'main_image', exists: true, templateName: 'Main Template', layoutStyle: 'main-layout', variantId: 'main-seed', layoutSeed: 'main-layout-seed', status: 'present' },
      { imageType: 'feature_image', exists: true, templateName: 'Feature Template', layoutStyle: 'feature-layout', variantId: 'feature-seed', layoutSeed: 'feature-layout-seed', status: 'present' },
      { imageType: 'size_image', exists: true, templateName: 'Size Template', layoutStyle: 'size-layout', variantId: 'size-seed', layoutSeed: 'size-layout-seed', status: 'present' },
      { imageType: 'compatibility_image', exists: true, templateName: 'Compatibility Template', layoutStyle: 'compatibility-layout', variantId: 'compatibility-seed', layoutSeed: 'compatibility-layout-seed', status: 'present' },
      { imageType: 'package_image', exists: true, templateName: 'Package Template', layoutStyle: 'package-layout', variantId: 'package-seed', layoutSeed: 'package-layout-seed', status: 'present' },
      { imageType: 'lifestyle_image', exists: true, templateName: 'Lifestyle Template', layoutStyle: 'lifestyle-layout', variantId: 'lifestyle-seed', layoutSeed: 'lifestyle-layout-seed', status: 'present' },
      { imageType: 'detail_image', exists: true, templateName: 'Detail Template', layoutStyle: 'detail-layout', variantId: 'detail-seed', layoutSeed: 'detail-layout-seed', status: 'present' },
      { imageType: 'variant_image', exists: true, templateName: 'Variant Template', layoutStyle: 'variant-layout', variantId: 'variant-seed', layoutSeed: 'variant-layout-seed', status: 'present' }
    ],
    templateDiversity: {
      uniqueTemplateNames: 8,
      uniqueLayoutStyles: 8,
      uniqueVariantIds: 8,
      repeatedTemplates: [],
      diversityScore: 100,
      diversityLevel: 'high',
      warnings: []
    },
    textSafety: {
      containsChinese: false,
      containsPrice: false,
      containsPromotionWords: false,
      containsBannedWords: false,
      nonEnglishTextBlocks: [],
      riskyTextBlocks: []
    },
    fieldSafety: {
      usesInferredCandidates: false,
      usesBlockedHighRiskFields: false,
      usesConflictedFields: false,
      usesMissingEvidenceFields: false,
      unsafeFields: [],
      warnings: []
    },
    amazonMainImageCheck: {
      isPureWhite: true,
      hasTextBlocks: false,
      hasIcons: false,
      productPlacement: 'centered with safe margin',
      pass: true,
      warnings: []
    },
    ruleAuditSummary: {
      passed: false,
      platformId: 'amazon',
      categoryId: 'electronics_storage',
      issueCount: 3,
      errorCount: 2,
      warningCount: 1,
      infoCount: 0,
      issueCounts: { error: 2, warning: 1, info: 0 },
      effectiveRulesSummary: {
        mainImageText: 'Amazon 主图必须白底、无文字、无 icon。',
        secondaryImageText: '辅图允许英文卖点，不允许中文、价格、促销词。',
        highRiskFields: [
          { fieldKey: 'capacity', fieldLabel: '容量' },
          { fieldKey: 'interfaceType', fieldLabel: '接口类型' }
        ]
      },
      imagePlanRuleAudit: [
        {
          imageType: 'main_image',
          imageTypeLabel: '平台主图',
          issueCount: 2,
          errorCount: 2,
          warningCount: 0,
          infoCount: 0,
          issues: [
            {
              code: 'MAIN_IMAGE_TEXT_NOT_ALLOWED',
              severity: 'error',
              message: 'Amazon 主图不允许出现文字。',
              suggestion: '请移除主图文字。',
              imageType: 'main_image',
              ruleSource: 'platform'
            }
          ]
        },
        {
          imageType: 'variant_image',
          imageTypeLabel: '变体图',
          issueCount: 1,
          errorCount: 0,
          warningCount: 1,
          infoCount: 0,
          issues: [
            {
              code: 'TEXT_CONTAINS_CAUTION_WORD',
              severity: 'warning',
              message: '图片文案包含谨慎词：waterproof',
              suggestion: '请人工确认是否有证据。',
              imageType: 'variant_image',
              ruleSource: 'combined',
              fieldKey: 'waterproof',
              fieldLabel: '防水'
            }
          ]
        }
      ],
      issues: [
        { code: 'MAIN_IMAGE_TEXT_NOT_ALLOWED', severity: 'error', message: 'Amazon 主图不允许出现文字。', imageType: 'main_image', ruleSource: 'platform' },
        { code: 'TEXT_CONTAINS_PRICE', severity: 'error', message: '图片文案包含价格。', imageType: 'feature_image', ruleSource: 'platform' },
        { code: 'TEXT_CONTAINS_CAUTION_WORD', severity: 'warning', message: '图片文案包含谨慎词：waterproof', imageType: 'variant_image', ruleSource: 'combined', fieldKey: 'waterproof', fieldLabel: '防水' }
      ],
      warnings: [],
      blockedFields: [{ fieldKey: 'capacity', fieldLabel: '容量', imageType: 'variant_image', reason: 'missingEvidence' }],
      cautionFields: [{ fieldKey: 'waterproof', fieldLabel: '防水', imageType: 'variant_image', reason: 'cautionWord' }],
      recommendations: ['请先处理主图文字和高风险字段证据。'],
      contextWarnings: []
    },
    recommendations: ['模板差异化良好，可进入人工视觉验收。'],
    ...overrides
  };
}

test('template audit display sections summarize coverage diversity and safety', () => {
  const sections = templateAuditDisplaySections(report());

  assert.match(sections.summaryText, /图片数量 8/);
  assert.match(sections.summaryText, /8 类图片已齐全/);
  assert.match(sections.diversityText, /100/);
  assert.match(sections.amazonText, /Amazon 主图通过/);
  assert.match(sections.textSafetyText, /文案安全通过/);
  assert.match(sections.fieldSafetyText, /字段安全通过/);
  assert.equal(sections.summaryCards.some((card) => card.label === '模板差异分' && card.value === '100'), true);
  assert.match(sections.ruleAuditText, /规则审计未通过/);
  assert.equal(sections.ruleAuditCards.some((card) => card.label === 'error' && card.value === '2'), true);
  assert.equal(sections.ruleAuditGroups.length, 2);
  assert.equal(sections.ruleAuditFields[0].labelText, '容量 capacity');
  assert.match(sections.ruleAuditCopyRiskText, /价格/);
  assert.match(sections.ruleAuditAmazonText, /主图/);
});

test('template audit coverage rows expose all eight image rows', () => {
  const rows = templateAuditCoverageRows(report());

  assert.equal(rows.length, 8);
  assert.equal(rows[0].imageType, 'main_image');
  assert.equal(rows[0].existsText, '已生成');
  assert.equal(rows[0].templateName, 'Main Template');
  assert.equal(rows[0].layoutStyle, 'main-layout');
  assert.equal(rows[0].variantId, 'main-seed');
  assert.equal(rows[0].layoutSeed, 'main-layout-seed');
});

test('template audit display sections handle missing report and empty generated images', () => {
  assert.match(templateAuditEmptyText(null), /暂无模板验收报告/);
  assert.match(templateAuditDisplaySections(null).emptyText, /暂无模板验收报告/);
  assert.match(templateAuditDisplaySections(report({ meta: { imageCount: 0 }, imageTypeCoverage: [] })).emptyText, /暂无可验收的 mock 图片/);
  assert.match(templateAuditDisplaySections(report({ ruleAuditSummary: null })).ruleAuditEmptyText, /暂无规则审计结果/);
  assert.match(templateAuditDisplaySections(report({ ruleAuditSummary: { contextWarnings: ['暂无平台规则上下文，请先选择平台规则。'] } })).ruleAuditContextText, /暂无平台规则上下文/);
});

test('template audit display sections show warnings and recommendations', () => {
  const sections = templateAuditDisplaySections(report({
    templateDiversity: {
      uniqueTemplateNames: 2,
      uniqueLayoutStyles: 2,
      uniqueVariantIds: 2,
      repeatedTemplates: [{ signature: 'same', count: 2 }],
      diversityScore: 35,
      diversityLevel: 'low',
      warnings: ['发现模板重复']
    },
    textSafety: {
      containsChinese: true,
      containsPrice: true,
      containsPromotionWords: true,
      containsBannedWords: true,
      nonEnglishTextBlocks: [{ text: '中文卖点' }],
      riskyTextBlocks: [{ text: '$19.99' }]
    },
    fieldSafety: {
      usesInferredCandidates: true,
      usesBlockedHighRiskFields: true,
      usesConflictedFields: true,
      usesMissingEvidenceFields: true,
      unsafeFields: [{ field: 'capacity' }],
      warnings: ['字段风险']
    },
    amazonMainImageCheck: {
      isPureWhite: false,
      hasTextBlocks: true,
      hasIcons: true,
      productPlacement: 'left',
      pass: false,
      warnings: ['主图包含文字']
    },
    recommendations: ['请先处理模板风险。']
  }));

  assert.match(sections.diversityText, /低/);
  assert.match(sections.amazonText, /未通过/);
  assert.match(sections.textSafetyText, /发现中文/);
  assert.match(sections.fieldSafetyText, /使用了 AI 推测字段/);
  assert.equal(sections.recommendations[0], '请先处理模板风险。');
});

test('template audit JSON export file name includes taskId and timestamp', () => {
  assert.equal(
    buildTemplateAuditFileName('task-audit-1', '2026-06-01T02:03:04.000Z'),
    'template-audit-task-audit-1-2026-06-01T02-03-04-000Z.json'
  );
});

test('template audit JSON export strips env api keys and local absolute paths', () => {
  const unsafeReport = report({
    textSafety: {
      containsChinese: true,
      containsPrice: true,
      containsPromotionWords: true,
      containsBannedWords: true,
      nonEnglishTextBlocks: [{ text: '中文 OPENAI_API_KEY=sk-secret D:\\Code\\app.sqlite .env node_modules' }],
      riskyTextBlocks: [{ text: '$19.99 C:\\secret\\file.png sk-should-not-export' }]
    }
  });
  const json = templateAuditJson(unsafeReport);

  assert.doesNotMatch(json, /\.env/i);
  assert.doesNotMatch(json, /OPENAI_API_KEY/i);
  assert.doesNotMatch(json, /sk-secret|sk-should-not-export/);
  assert.doesNotMatch(json, /[A-Z]:\\/);
  assert.doesNotMatch(json, /node_modules/i);
  assert.doesNotMatch(json, /app\.sqlite/i);
  assert.match(json, /中文/);
});

test('template audit download payload returns safe file name and json', () => {
  const download = buildTemplateAuditDownload(report(), '2026-06-01T02:03:04.000Z');

  assert.equal(download.fileName, 'template-audit-task-audit-1-2026-06-01T02-03-04-000Z.json');
  assert.match(download.json, /imageTypeCoverage/);
  assert.match(download.json, /ruleAuditSummary/);
  assert.match(download.json, /effectiveRulesSummary/);
  assert.match(download.json, /issueCounts/);
});

test('template audit browser export prompts and downloads sanitized JSON', async () => {
  const unsafeReport = report({
    meta: { taskId: 'task-audit-1', imageCount: 8, expectedImageTypes: [] },
    ruleAuditSummary: {
      ...report().ruleAuditSummary,
      recommendations: ['OPENAI_API_KEY=sk-secret D:\\Code\\app.sqlite .env node_modules']
    }
  });
  const calls = { prompt: '', clicked: 0, removed: 0, revoked: '' };
  const link = {
    href: '',
    download: '',
    click: () => { calls.clicked += 1; },
    remove: () => { calls.removed += 1; }
  };
  class TestBlob {
    constructor(parts, options) {
      this.parts = parts;
      this.type = options.type;
    }
    async text() {
      return this.parts.join('');
    }
  }

  const result = downloadTemplateAuditJson(unsafeReport, {
    confirm: (message) => {
      calls.prompt = message;
      return true;
    },
    createElement: () => link,
    appendChild: () => {},
    createObjectURL: () => 'blob:template-audit',
    revokeObjectURL: (url) => { calls.revoked = url; },
    BlobCtor: TestBlob,
    timestamp: '2026-06-01T02:03:04.000Z'
  });

  assert.equal(calls.prompt, templateAuditExportNotice);
  assert.equal(result.downloaded, true);
  assert.equal(link.download, 'template-audit-task-audit-1-2026-06-01T02-03-04-000Z.json');
  assert.equal(calls.clicked, 1);
  assert.equal(calls.removed, 1);
  assert.equal(calls.revoked, 'blob:template-audit');
  const json = await result.blob.text();
  assert.match(json, /ruleAuditSummary/);
  assert.match(json, /effectiveRulesSummary/);
  assert.match(json, /issueCounts/);
  assert.match(json, /recommendations/);
  assert.doesNotMatch(json, /\.env/i);
  assert.doesNotMatch(json, /OPENAI_API_KEY/i);
  assert.doesNotMatch(json, /sk-secret/);
  assert.doesNotMatch(json, /[A-Z]:\\/);
  assert.doesNotMatch(json, /app\.sqlite/i);
  assert.doesNotMatch(json, /node_modules/i);
});

test('template audit browser export can be cancelled before download', () => {
  let clicked = false;
  const result = downloadTemplateAuditJson(report(), {
    confirm: () => false,
    createElement: () => ({ click: () => { clicked = true; }, remove: () => {} }),
    appendChild: () => {},
    createObjectURL: () => 'blob:template-audit',
    revokeObjectURL: () => {}
  });

  assert.equal(result.downloaded, false);
  assert.equal(result.reason, 'cancelled');
  assert.equal(clicked, false);
});

test('template audit API helper and GeneratePage entry are wired', async () => {
  const { api } = await import('../src/services/api.js');
  const captured = [];
  global.fetch = async (url) => {
    captured.push(url);
    return {
      ok: true,
      json: async () => ({ templateAudit: report() })
    };
  };

  const result = await api.getTemplateAudit('task-audit-1');
  const page = readFileSync(new URL('../src/pages/GeneratePage.jsx', import.meta.url), 'utf8');
  const imagePlanPage = readFileSync(new URL('../src/pages/ImagePlanPage.jsx', import.meta.url), 'utf8');

  assert.equal(captured[0], '/api/tasks/task-audit-1/template-audit');
  assert.equal(result.templateAudit.meta.taskId, 'task-audit-1');
  assert.match(page, /模板验收摘要/);
  assert.match(page, /规则审计摘要/);
  assert.match(page, /ruleAuditGroups/);
  assert.match(page, /导出 JSON/);
  assert.match(page, /downloadTemplateAuditJson/);
  assert.match(page, /templateAuditDisplaySections/);
  assert.match(imagePlanPage, /导出规则审计 JSON/);
  assert.match(imagePlanPage, /downloadTemplateAuditJson/);
  assert.match(imagePlanPage, /getTemplateAudit/);
});
