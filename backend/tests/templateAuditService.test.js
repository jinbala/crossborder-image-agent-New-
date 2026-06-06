import assert from 'node:assert/strict';
import { test } from 'node:test';
import { analyzeTemplateSet } from '../src/services/templateAuditService.js';

const imageTypes = [
  'main_image',
  'feature_image',
  'size_image',
  'compatibility_image',
  'package_image',
  'lifestyle_image',
  'detail_image',
  'variant_image'
];

function makeImage(type, index, overrides = {}) {
  return {
    id: `${type}-image`,
    planId: `${type}-plan`,
    type,
    imageType: type,
    platform: 'Amazon',
    status: 'succeeded',
    prompt: `English prompt for ${type}`,
    textBlocks: type === 'main_image' ? [] : [
      { id: `${type}-copy`, text: `Safe English copy ${index}`, sourceFields: ['sellingPoints'] }
    ],
    mockPreview: {
      type,
      usedTextBlocks: type === 'main_image' ? [] : [
        { id: `${type}-preview-copy`, text: `Safe preview copy ${index}`, sourceFields: ['sellingPoints'] }
      ],
      template: {
        templateType: type,
        templateName: `${type} Template ${index}`,
        layoutStyle: `${type}-layout-${index}`,
        variantId: `${type}-seed-${index}`,
        layoutSeed: `${type}-layout-seed-${index}`,
        backgroundStyle: type === 'main_image' ? 'pure_white' : `safe-bg-${index}`,
        productPlacement: type === 'main_image' ? 'centered with safe margin' : `placement-${index}`,
        iconHints: type === 'main_image' ? [] : ['check'],
        safetyNotes: ['Safe English copy only']
      }
    },
    ...overrides
  };
}

function makeTask(overrides = {}) {
  const generatedImages = imageTypes.map((type, index) => makeImage(type, index + 1));
  return {
    id: 'template-audit-task',
    platform: 'Amazon',
    productInfoConfirmed: {
      sku: 'AUDIT-001',
      name: 'Portable External Drive'
    },
    inferredCandidates: [{ field: 'capacity', value: '5TB', reason: 'No visible evidence' }],
    recognitionQuality: {
      missingEvidenceFields: [{ field: 'dimensions', value: '10 x 5 cm' }],
      conflictFields: [{ field: 'compatibleDevices', values: ['Laptop', 'Phone'] }],
      inferredOnlyFields: [{ field: 'material', value: 'Aluminum' }],
      blockedHighRiskFields: [{ field: 'warranty', value: '3 years' }]
    },
    imagePlans: generatedImages.map((image) => ({
      id: image.planId,
      type: image.type,
      textBlocks: image.textBlocks,
      templateSeed: image.mockPreview.template
    })),
    generatedImages,
    ...overrides
  };
}

test('template audit checks coverage for all eight image types', () => {
  const report = analyzeTemplateSet(makeTask());

  assert.deepEqual(report.meta.expectedImageTypes, imageTypes);
  assert.equal(report.meta.imageCount, 8);
  assert.equal(report.imageTypeCoverage.length, 8);
  assert.equal(report.imageTypeCoverage.every((item) => item.exists), true);
  assert.equal(report.imageTypeCoverage.find((item) => item.imageType === 'main_image').templateName, 'main_image Template 1');
});

test('template audit warns when an expected image type is missing', () => {
  const task = makeTask({
    generatedImages: makeTask().generatedImages.filter((image) => image.type !== 'package_image')
  });

  const report = analyzeTemplateSet(task);
  const missing = report.imageTypeCoverage.find((item) => item.imageType === 'package_image');

  assert.equal(missing.exists, false);
  assert.equal(missing.status, 'missing');
  assert.ok(report.recommendations.some((item) => /缺少/.test(item) && /package_image/.test(item)));
});

test('template audit calculates diversity and warns on repeated template signatures', () => {
  const repeatedTemplate = {
    templateName: 'Repeated Template',
    layoutStyle: 'same-layout',
    variantId: 'same-seed',
    layoutSeed: 'same-layout-seed',
    backgroundStyle: 'same-bg',
    productPlacement: 'same-placement',
    iconHints: ['same'],
    safetyNotes: ['Safe English copy only']
  };
  const task = makeTask({
    generatedImages: imageTypes.map((type, index) => makeImage(type, index + 1, {
      mockPreview: {
        type,
        usedTextBlocks: [],
        template: {
          ...repeatedTemplate,
          templateType: type,
          backgroundStyle: type === 'main_image' ? 'pure_white' : repeatedTemplate.backgroundStyle,
          iconHints: type === 'main_image' ? [] : repeatedTemplate.iconHints
        }
      }
    }))
  });

  const report = analyzeTemplateSet(task);

  assert.equal(report.templateDiversity.uniqueTemplateNames, 1);
  assert.equal(report.templateDiversity.uniqueLayoutStyles, 1);
  assert.equal(report.templateDiversity.uniqueVariantIds, 1);
  assert.equal(report.templateDiversity.repeatedTemplates.length, 1);
  assert.equal(report.templateDiversity.diversityLevel, 'low');
  assert.ok(report.templateDiversity.warnings.some((item) => /重复/.test(item)));
});

test('template audit passes Amazon main image when it is pure white with no text or icons', () => {
  const report = analyzeTemplateSet(makeTask());

  assert.equal(report.amazonMainImageCheck.isPureWhite, true);
  assert.equal(report.amazonMainImageCheck.hasTextBlocks, false);
  assert.equal(report.amazonMainImageCheck.hasIcons, false);
  assert.equal(report.amazonMainImageCheck.pass, true);
});

test('template audit fails Amazon main image when text blocks are present', () => {
  const task = makeTask({
    generatedImages: [
      makeImage('main_image', 1, {
        textBlocks: [{ id: 'bad-main-copy', text: 'Main image text', sourceFields: ['sellingPoints'] }],
        mockPreview: {
          ...makeImage('main_image', 1).mockPreview,
          usedTextBlocks: [{ id: 'bad-main-preview-copy', text: 'Main image text', sourceFields: ['sellingPoints'] }]
        }
      }),
      ...imageTypes.slice(1).map((type, index) => makeImage(type, index + 2))
    ]
  });

  const report = analyzeTemplateSet(task);

  assert.equal(report.amazonMainImageCheck.hasTextBlocks, true);
  assert.equal(report.amazonMainImageCheck.pass, false);
  assert.ok(report.amazonMainImageCheck.warnings.some((item) => /主图/.test(item) && /文字/.test(item)));
});

test('template audit text safety detects Chinese price discount and promotion copy', () => {
  const task = makeTask({
    generatedImages: [
      makeImage('main_image', 1),
      makeImage('feature_image', 2, {
        textBlocks: [
          { id: 'cn', text: '中文卖点', sourceFields: ['sellingPoints'] },
          { id: 'price', text: '$19.99', sourceFields: ['sellingPoints'] },
          { id: 'promo', text: '50% OFF limited time deal', sourceFields: ['sellingPoints'] }
        ]
      }),
      ...imageTypes.slice(2).map((type, index) => makeImage(type, index + 3))
    ]
  });

  const report = analyzeTemplateSet(task);

  assert.equal(report.textSafety.containsChinese, true);
  assert.equal(report.textSafety.containsPrice, true);
  assert.equal(report.textSafety.containsPromotionWords, true);
  assert.equal(report.textSafety.nonEnglishTextBlocks.length >= 1, true);
  assert.equal(report.textSafety.riskyTextBlocks.length >= 2, true);
});

test('template audit field safety detects inferred blocked conflicted and missing evidence fields', () => {
  const task = makeTask({
    generatedImages: [
      makeImage('main_image', 1),
      makeImage('variant_image', 2, {
        textBlocks: [
          { id: 'capacity', text: '5TB', sourceFields: ['capacity'] },
          { id: 'dimensions', text: '10 x 5 cm', sourceFields: ['dimensions'] },
          { id: 'compatibility', text: 'Laptop and Phone', sourceFields: ['compatibleDevices'] },
          { id: 'warranty', text: '3 years', sourceFields: ['warranty'] }
        ]
      }),
      ...imageTypes.filter((type) => !['main_image', 'variant_image'].includes(type)).map((type, index) => makeImage(type, index + 3))
    ]
  });

  const report = analyzeTemplateSet(task);

  assert.equal(report.fieldSafety.usesInferredCandidates, true);
  assert.equal(report.fieldSafety.usesMissingEvidenceFields, true);
  assert.equal(report.fieldSafety.usesConflictedFields, true);
  assert.equal(report.fieldSafety.usesBlockedHighRiskFields, true);
  assert.deepEqual(
    [...new Set(report.fieldSafety.unsafeFields.map((item) => item.field))].sort(),
    ['capacity', 'compatibleDevices', 'dimensions', 'warranty']
  );
});

test('template audit produces Chinese recommendations and does not mutate source data', () => {
  const task = makeTask();
  const before = JSON.parse(JSON.stringify(task));

  const report = analyzeTemplateSet(task);

  assert.equal(report.recommendations.length > 0, true);
  assert.equal(report.recommendations.some((item) => /模板/.test(item) || /主图/.test(item)), true);
  assert.deepEqual(task, before);
});

test('template audit includes rule audit summary with counts image groups and field labels', () => {
  const task = makeTask({
    platformId: 'amazon',
    categoryId: 'electronics_storage',
    generatedImages: [
      makeImage('main_image', 1, {
        textBlocks: [{ id: 'main-copy', text: 'Best $19.99 主图文案', sourceFields: ['sellingPoints'] }],
        mockPreview: {
          ...makeImage('main_image', 1).mockPreview,
          usedTextBlocks: [{ id: 'main-preview-copy', text: 'Best $19.99 主图文案', sourceFields: ['sellingPoints'] }],
          template: {
            ...makeImage('main_image', 1).mockPreview.template,
            backgroundStyle: 'soft_gray',
            iconHints: ['badge']
          }
        }
      }),
      makeImage('variant_image', 2, {
        textBlocks: [
          { id: 'capacity', text: '5TB capacity', sourceFields: ['capacity'] },
          { id: 'speed', text: 'High speed transfer', sourceFields: ['speed'] }
        ]
      }),
      ...imageTypes.filter((type) => !['main_image', 'variant_image'].includes(type)).map((type, index) => makeImage(type, index + 3))
    ],
    recognitionQuality: {
      missingEvidenceFields: [{ field: 'capacity' }, { field: 'speed' }],
      conflictFields: [],
      inferredOnlyFields: [],
      blockedHighRiskFields: []
    },
    inferredCandidates: [{ field: 'capacity', value: '5TB' }]
  });

  const report = analyzeTemplateSet(task);
  const summary = report.ruleAuditSummary;

  assert.equal(summary.platformId, 'amazon');
  assert.equal(summary.categoryId, 'electronics_storage');
  assert.equal(summary.passed, false);
  assert.equal(summary.issueCounts.error > 0, true);
  assert.equal(summary.issueCount, summary.issues.length);
  assert.ok(summary.issues.some((item) => item.code === 'MAIN_IMAGE_TEXT_NOT_ALLOWED' && item.imageType === 'main_image'));
  assert.ok(summary.issues.some((item) => item.code === 'MAIN_IMAGE_BACKGROUND_NOT_WHITE' && item.imageType === 'main_image'));
  assert.ok(summary.issues.some((item) => item.code === 'TEXT_CONTAINS_CHINESE' && item.ruleSource === 'platform'));
  assert.ok(summary.issues.some((item) => item.code === 'TEXT_CONTAINS_PRICE'));
  assert.ok(summary.blockedFields.some((item) => item.fieldKey === 'capacity' && item.fieldLabel === '容量'));
  assert.ok(summary.blockedFields.some((item) => item.fieldKey === 'speed' && item.fieldLabel === '速度'));
  assert.ok(summary.imagePlanRuleAudit.some((item) => item.imageType === 'main_image' && item.errorCount > 0));
  assert.ok(summary.imagePlanRuleAudit.some((item) => item.imageType === 'variant_image' && item.errorCount > 0));
  assert.ok(summary.effectiveRulesSummary.highRiskFields.some((item) => item.fieldKey === 'capacity' && item.fieldLabel === '容量'));
  assert.ok(summary.recommendations.length > 0);
});

test('template audit rule audit summary falls back when platform or category is missing', () => {
  const task = makeTask({
    platform: '',
    platformId: '',
    categoryId: '',
    targets: [],
    generatedImages: [],
    imagePlans: []
  });

  const report = analyzeTemplateSet(task);

  assert.equal(report.ruleAuditSummary.platformId, 'amazon');
  assert.equal(report.ruleAuditSummary.categoryId, 'generic_ecommerce');
  assert.equal(report.ruleAuditSummary.issueCount, 0);
  assert.match(report.ruleAuditSummary.emptyStateText, /暂无可审计的图片方案/);
  assert.match(report.ruleAuditSummary.contextWarnings.join('\n'), /暂无平台规则上下文/);
  assert.match(report.ruleAuditSummary.contextWarnings.join('\n'), /未选择类目/);
});

test('template audit report strips secrets env markers and local absolute paths', () => {
  const task = makeTask({
    generatedImages: [
      makeImage('main_image', 1),
      makeImage('feature_image', 2, {
        textBlocks: [
          {
            id: 'unsafe-secret-copy',
            text: '中文促销 $19.99 OPENAI_API_KEY=sk-secret D:\\Code\\app.sqlite node_modules .env',
            sourceFields: ['sellingPoints']
          }
        ],
        prompt: 'Prompt contains sk-should-not-export and C:\\Users\\secret\\.env'
      }),
      ...imageTypes.slice(2).map((type, index) => makeImage(type, index + 3))
    ]
  });

  const json = JSON.stringify(analyzeTemplateSet(task));

  assert.doesNotMatch(json, /\.env/i);
  assert.doesNotMatch(json, /OPENAI_API_KEY/i);
  assert.doesNotMatch(json, /sk-secret|sk-should-not-export/);
  assert.doesNotMatch(json, /[A-Z]:\\/);
  assert.doesNotMatch(json, /node_modules/i);
  assert.doesNotMatch(json, /app\.sqlite/i);
  assert.match(json, /中文促销/);
});
