import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildTextLayout, isProgrammaticTextLayoutType, normalizeTextLayoutOverride } from '../src/services/textLayoutService.js';

function task(overrides = {}) {
  return {
    id: 'layout-task',
    productInfoConfirmed: {
      productName: 'Portable External SSD',
      category: 'External Storage',
      sellingPoints: ['Fast backup', 'Compact metal body', 'USB-C ready'],
      visibleSpecs: ['USB-C port', 'Slim portable design'],
      dimensions: ['4.5 x 2.8 x 0.4 in'],
      sizes: ['Pocket size'],
      compatibleDevices: ['Laptop', 'Phone', 'Tablet'],
      packageIncluded: ['External SSD', 'USB-C cable', 'User manual'],
      capacity: ['1TB'],
      colors: ['Black']
    },
    fieldEvidence: {
      capacity: [{ source: 'visible_text', text: '1TB', value: '1TB', confidence: 0.92 }],
      compatibleDevices: [{ source: 'visible_text', text: 'Laptop Phone Tablet', confidence: 0.8 }]
    },
    inferredCandidates: [{ field: 'capacity', value: '5TB', reason: 'Common capacity but not visible' }],
    ...overrides
  };
}

function plan(type, overrides = {}) {
  return {
    id: `${type}-plan`,
    type,
    title: `${type} plan`,
    language: 'English',
    textBlocks: [
      { id: 'tb-1', text: 'Fast backup', role: 'bullet', sourceField: 'sellingPoints', evidenceStatus: 'confirmed' },
      { id: 'tb-2', text: 'Limited time 50% OFF', role: 'bullet', sourceField: 'promotion', evidenceStatus: 'confirmed' },
      { id: 'tb-3', text: '中文卖点', role: 'bullet', sourceField: 'sellingPoints', evidenceStatus: 'confirmed' }
    ],
    riskWarnings: [],
    excludedUnconfirmedFields: [{ field: 'capacity', value: '5TB', reason: 'No image evidence' }],
    ...overrides
  };
}

test('programmatic text layout type guard covers text-heavy image types only', () => {
  assert.equal(isProgrammaticTextLayoutType('feature_image'), true);
  assert.equal(isProgrammaticTextLayoutType('size_image'), true);
  assert.equal(isProgrammaticTextLayoutType('compatibility_image'), true);
  assert.equal(isProgrammaticTextLayoutType('package_image'), true);
  assert.equal(isProgrammaticTextLayoutType('variant_image'), true);
  assert.equal(isProgrammaticTextLayoutType('lifestyle_image'), false);
  assert.equal(isProgrammaticTextLayoutType('main_image'), false);
});

test('feature_image creates headline bullets and filters unsafe text', () => {
  const layout = buildTextLayout({ task: task(), plan: plan('feature_image') });

  assert.equal(layout.layoutVersion, 'v2.9');
  assert.equal(layout.imageType, 'feature_image');
  assert.equal(layout.layoutSource, 'auto');
  assert.equal(layout.layoutEditedByUser, false);
  assert.ok(layout.textElements.some((item) => item.role === 'headline'));
  assert.equal(layout.textElements[0].visible, true);
  assert.equal(layout.textElements[0].editable, true);
  assert.equal(layout.textElements[0].locked, false);
  assert.equal(layout.textElements[0].zIndex, 1);
  assert.ok(layout.textElements.some((item) => item.text === 'Fast backup'));
  assert.ok(layout.iconElements.length >= 1);
  assert.ok(layout.warnings.some((item) => item.code === 'TEXT_FILTERED_CHINESE'));
  assert.ok(layout.warnings.some((item) => item.code === 'TEXT_FILTERED_PROMOTION'));
  assert.doesNotMatch(JSON.stringify(layout.textElements), /中文|50% OFF/i);
});

test('size and package images report blocking issues when confirmed data is missing', () => {
  const missingTask = task({
    productInfoConfirmed: {
      productName: 'Portable External SSD',
      category: 'External Storage',
      sellingPoints: []
    }
  });
  const sizeLayout = buildTextLayout({ task: missingTask, plan: plan('size_image', { textBlocks: [] }) });
  const packageLayout = buildTextLayout({ task: missingTask, plan: plan('package_image', { textBlocks: [] }) });

  assert.ok(sizeLayout.blockingIssues.some((item) => item.code === 'MISSING_DIMENSIONS'));
  assert.ok(packageLayout.blockingIssues.some((item) => item.code === 'MISSING_PACKAGE_INCLUDED'));
});

test('compatibility image uses confirmed devices and warns when evidence is weak', () => {
  const layout = buildTextLayout({
    task: task({ fieldEvidence: { compatibleDevices: [] } }),
    plan: plan('compatibility_image', { textBlocks: [] })
  });

  assert.ok(layout.iconElements.some((item) => item.label === 'Laptop'));
  assert.ok(layout.warnings.some((item) => item.code === 'WEAK_COMPATIBILITY_EVIDENCE'));
});

test('variant image excludes inferred capacity and only renders confirmed variants', () => {
  const layout = buildTextLayout({ task: task(), plan: plan('variant_image', { textBlocks: [] }) });
  const rendered = JSON.stringify(layout);

  assert.match(rendered, /1TB/);
  assert.doesNotMatch(rendered, /5TB/);
  assert.ok(layout.warnings.some((item) => item.code === 'INFERRED_CANDIDATES_EXCLUDED'));
});

test('textLayoutOverride keeps user edited positions and marks unsafe text as blocking', () => {
  const override = normalizeTextLayoutOverride({
    task: task(),
    plan: plan('feature_image'),
    textLayoutOverride: {
      layoutVersion: 'v2.9',
      textElements: [
        { id: 'headline', text: 'Portable SSD', x: 200, y: 150, width: 900, height: 80, fontSize: 54 },
        { id: 'bad-cn', text: '中文卖点', x: 200, y: 260, width: 500, height: 80, fontSize: 36 },
        { id: 'bad-capacity', text: '5TB', sourceField: 'capacity', evidenceStatus: 'needs_confirmation', x: 200, y: 360, width: 500, height: 80, fontSize: 36 }
      ],
      iconElements: [{ id: 'icon-1', type: 'feature_dot', label: 'Fast', x: 120, y: 260, size: 42 }],
      lineElements: []
    }
  });

  assert.equal(override.layoutSource, 'user_override');
  assert.equal(override.layoutEditedByUser, true);
  assert.equal(override.textElements.find((item) => item.id === 'headline').editedByUser, true);
  assert.equal(override.textElements.find((item) => item.id === 'bad-cn').visible, false);
  assert.ok(override.blockingIssues.some((item) => item.code === 'TEXT_BLOCKED_CHINESE'));
  assert.ok(override.blockingIssues.some((item) => item.code === 'TEXT_BLOCKED_UNCONFIRMED_CAPACITY'));
});
