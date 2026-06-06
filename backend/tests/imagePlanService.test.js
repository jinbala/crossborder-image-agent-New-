import assert from 'node:assert/strict';
import { test } from 'node:test';
import { generateImagePlans } from '../src/services/imagePlanService.js';
import { getPlatformRuleSnapshot } from '../src/rules/platformRules.js';

function buildTask(overrides = {}) {
  return {
    id: 'task-plan-test',
    status: 'rules_selected',
    productInfoRaw: {
      name: 'Raw Unconfirmed Drive',
      capacity: ['500GB', '1TB', '2TB', '4TB', '5TB']
    },
    productInfoConfirmed: {
      sku: 'HD-001',
      name: 'Portable External Drive',
      category: 'External Storage',
      brand: 'Acme',
      model: 'X1',
      color: 'Black',
      capacity: '',
      material: 'Aluminum',
      interfaceType: 'USB-C',
      compatibleDevices: ['PC', 'Mac'],
      packageList: ['Portable drive', 'USB-C cable'],
      sellingPoints: ['Fast file backup', 'Portable metal body'],
      visibleSpecs: ['USB-C port']
    },
    fieldEvidence: {
      productName: [{ source: 'visual', imageIndex: 0, confidence: 0.8 }],
      category: [{ source: 'visual', imageIndex: 0, confidence: 0.7 }],
      interfaceType: [{ source: 'visible_text', imageIndex: 1, text: 'USB-C', value: 'USB-C', confidence: 0.92 }],
      packageIncluded: [{ source: 'visible_text', imageIndex: 3, text: 'USB-C cable included', value: 'USB-C cable', confidence: 0.9 }],
      sellingPoints: [{ source: 'visible_text', imageIndex: 2, text: 'Fast file backup', value: 'Fast file backup', confidence: 0.86 }],
      material: [{ source: 'visual', imageIndex: 0, reason: 'Metal-like shell', value: 'Aluminum', confidence: 0.58 }]
    },
    inferredCandidates: [
      { field: 'capacity', value: '5TB', reason: 'Common hard drive capacity, not visible' },
      { field: 'certifications', value: 'CE', reason: 'Common mark, not visible' }
    ],
    targets: [
      {
        id: 'target-amazon',
        platformId: 'amazon',
        site: 'US',
        language: 'English',
        category: 'general',
        rulesSnapshot: getPlatformRuleSnapshot({
          platformId: 'amazon',
          site: 'US',
          language: 'English',
          category: 'general'
        })
      }
    ],
    ...overrides
  };
}

function allText(plan) {
  return [
    plan.title,
    plan.goal,
    plan.prompt,
    ...(plan.textBlocks || []).map((block) => `${block.label || ''} ${block.text || ''}`)
  ].join(' ');
}

test('generates the expanded marketplace image plan set', () => {
  const plans = generateImagePlans(buildTask());

  assert.deepEqual(
    plans.map((plan) => plan.type),
    [
      'main_image',
      'feature_image',
      'size_image',
      'compatibility_image',
      'package_image',
      'lifestyle_image',
      'detail_image',
      'variant_image'
    ]
  );
  for (const plan of plans) {
    assert.equal(plan.promptVersion, 'v1.5');
    assert.ok(Array.isArray(plan.textBlocks));
    assert.ok(Array.isArray(plan.riskWarnings));
    assert.ok(Array.isArray(plan.complianceNotes));
    assert.ok(Array.isArray(plan.excludedUnconfirmedFields));
  }
});

test('uses confirmed product info and excludes inferred candidates from image copy', () => {
  const plans = generateImagePlans(buildTask());
  const joinedText = plans.map(allText).join('\n');

  assert.match(joinedText, /Portable External Drive/);
  assert.doesNotMatch(joinedText, /Raw Unconfirmed Drive/);
  assert.doesNotMatch(joinedText, /5TB/);
  assert.doesNotMatch(joinedText, /500GB/);

  for (const plan of plans) {
    const textBlocks = (plan.textBlocks || []).map((block) => block.text).join(' ');
    assert.doesNotMatch(textBlocks, /CE|5TB|500GB/);
  }
});

test('keeps Amazon main image free of marketplace text blocks', () => {
  const mainPlan = generateImagePlans(buildTask()).find((plan) => plan.type === 'main_image');

  assert.equal(mainPlan.background, 'pure_white');
  assert.equal(mainPlan.textBlocks.length, 0);
  assert.equal(mainPlan.templateName, 'Amazon Clean Main Image');
  assert.equal(mainPlan.layoutStyle, 'centered-white-product-hero');
  assert.equal(mainPlan.productPlacement, 'centered with safe margin');
  assert.equal(mainPlan.canGenerate, true);
  assert.match(mainPlan.prompt, /No Chinese text/);
  assert.match(mainPlan.prompt, /Do not invent product specs/);
});

test('all image plans carry distinct ecommerce template metadata', () => {
  const plans = generateImagePlans(buildTask());

  assert.equal(new Set(plans.map((plan) => plan.templateName)).size, 8);
  assert.equal(new Set(plans.map((plan) => plan.layoutStyle)).size, 8);
  for (const plan of plans) {
    assert.ok(plan.templateName);
    assert.ok(plan.templateSeed?.variantId);
    assert.ok(plan.templateSeed?.layoutSeed);
    assert.ok(Array.isArray(plan.templateVariants));
    assert.ok(plan.templateVariants.length >= 2);
    assert.ok(plan.templateVariants.length <= 3);
    assert.ok(plan.backgroundStyle);
    assert.ok(plan.productPlacement);
    assert.ok(Array.isArray(plan.iconHints));
    assert.ok(Array.isArray(plan.safetyNotes));
    assert.doesNotMatch(JSON.stringify([plan.templateName, plan.safetyNotes, plan.iconHints]), /[\u3400-\u9fff]/);
  }
});

test('same SKU image plans use varied layout seeds while preserving Amazon main image rules', () => {
  const plans = generateImagePlans(buildTask());
  const signatures = plans.map((plan) => [
    plan.templateSeed.variantId,
    plan.templateName,
    plan.layoutStyle,
    plan.productPlacement,
    plan.backgroundStyle
  ].join('|'));
  const mainPlan = plans.find((plan) => plan.type === 'main_image');

  assert.ok(new Set(signatures).size > 4);
  assert.equal(mainPlan.background, 'pure_white');
  assert.equal(mainPlan.backgroundStyle, 'pure_white');
  assert.equal(mainPlan.textBlocks.length, 0);
  assert.equal(mainPlan.templateSeed.allowedTextBlocks.length, 0);
  assert.equal(mainPlan.templateVariants.every((item) => item.backgroundStyle === 'pure_white'), true);
  assert.equal(mainPlan.templateVariants.every((item) => item.allowedTextBlocks.length === 0), true);
});

test('template copy excludes Chinese promotion inferred blocked and conflicted fields', () => {
  const plans = generateImagePlans(buildTask({
    productInfoConfirmed: {
      sku: 'HD-003',
      name: 'Portable External Drive',
      category: 'External Storage',
      capacity: ['5TB'],
      dimensions: ['4 x 2 in'],
      compatibleDevices: ['All devices'],
      packageList: ['Drive', '中文说明书'],
      sellingPoints: ['中文卖点', '50% OFF', 'Compact Design']
    },
    fieldEvidence: {
      capacity: [{ source: 'visible_text', text: '5TB', value: '5TB' }],
      dimensions: [{ source: 'visible_text', text: '4 x 2 in', value: '4 x 2 in' }]
    },
    recognitionQuality: {
      missingEvidenceFields: [{ field: 'capacity' }],
      conflictFields: [{ field: 'compatibleDevices' }],
      inferredOnlyFields: [{ field: 'dimensions' }]
    },
    inferredCandidates: [
      { field: 'capacity', value: '5TB', reason: 'AI guess' }
    ]
  }));
  const imageCopy = plans.flatMap((plan) => plan.textBlocks || []).map((block) => block.text).join('\n');

  assert.match(imageCopy, /Compact Design/);
  assert.doesNotMatch(imageCopy, /中文|50% OFF|5TB|All devices|4 x 2 in/);
  assert.equal(plans.find((plan) => plan.type === 'variant_image').textBlocks.some((block) => /5TB/.test(block.text)), false);
});

test('allows evidence-backed feature and package copy while warning on weak evidence', () => {
  const plans = generateImagePlans(buildTask());
  const featurePlan = plans.find((plan) => plan.type === 'feature_image');
  const packagePlan = plans.find((plan) => plan.type === 'package_image');
  const detailPlan = plans.find((plan) => plan.type === 'detail_image');

  assert.ok(featurePlan.textBlocks.some((block) => /Fast file backup/.test(block.text)));
  assert.ok(packagePlan.textBlocks.some((block) => /USB-C cable/.test(block.text)));
  assert.ok(detailPlan.textBlocks.some((block) => /Aluminum/.test(block.text)));
  assert.ok(detailPlan.riskWarnings.some((warning) => /material|材质/i.test(warning.message || warning)));
});

test('marks package image as needing information when package list is missing', () => {
  const task = buildTask({
    productInfoConfirmed: {
      sku: 'HD-002',
      name: 'Portable External Drive',
      category: 'External Storage',
      packageList: [],
      sellingPoints: ['Portable']
    },
    fieldEvidence: {}
  });

  const packagePlan = generateImagePlans(task).find((plan) => plan.type === 'package_image');

  assert.equal(packagePlan.canGenerate, false);
  assert.ok(packagePlan.riskWarnings.some((warning) => /缺少信息，建议补充/.test(warning.message || warning)));
});
