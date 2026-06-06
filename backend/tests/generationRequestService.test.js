import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildGenerationRequest } from '../src/services/generationRequestService.js';
import { getPlatformRuleSnapshot } from '../src/rules/platformRules.js';

function task(overrides = {}) {
  const rulesSnapshot = getPlatformRuleSnapshot({
    platformId: 'amazon',
    site: 'US',
    language: 'English',
    category: 'general'
  });
  return {
    id: 'generation-request-task',
    platform: 'Amazon',
    platformId: 'amazon',
    site: 'US',
    language: 'English',
    category: 'general',
    productInfoConfirmed: {
      sku: 'REQ-001',
      name: 'Portable External Drive',
      category: 'External Storage',
      brand: 'Acme',
      model: 'X1',
      capacity: '',
      material: 'Aluminum',
      packageList: ['Drive', 'USB-C cable'],
      sellingPoints: ['Fast backup'],
      visibleSpecs: ['USB-C']
    },
    sourceImages: [
      {
        id: 'source-1',
        imageIndex: 0,
        displayName: '01-main.jpg',
        filePath: 'uploads/01-main.jpg',
        url: '/uploads/01-main.jpg'
      }
    ],
    fieldEvidence: {
      sellingPoints: [{ source: 'visible_text', confidence: 0.9 }],
      packageIncluded: [{ source: 'visible_text', confidence: 0.9 }],
      material: [{ source: 'visual', confidence: 0.6 }]
    },
    inferredCandidates: [{ field: 'capacity', value: '5TB', reason: 'No visible evidence' }],
    targets: [
      {
        id: 'target-1',
        platformId: 'amazon',
        site: 'US',
        language: 'English',
        category: 'general',
        rulesSnapshot
      }
    ],
    ...overrides
  };
}

function plan(type, overrides = {}) {
  return {
    id: `${type}-1`,
    targetId: 'target-1',
    type,
    title: `${type} title`,
    goal: `${type} goal`,
    layout: 'Centered layout',
    background: 'pure_white',
    size: '2000x2000',
    platform: 'Amazon',
    site: 'US',
    language: 'English',
    textBlocks: [{ id: 'text-1', text: 'Fast backup', sourceFields: ['sellingPoints'] }],
    riskWarnings: [],
    complianceNotes: ['No Chinese text'],
    excludedUnconfirmedFields: [{ field: 'capacity', reason: 'No evidence' }],
    rulesSnapshot: getPlatformRuleSnapshot({ platformId: 'amazon' }).imageTypes[type],
    promptVersion: 'v1.5',
    ...overrides
  };
}

test('buildGenerationRequest creates the standard v1.8 structure', () => {
  const request = buildGenerationRequest({ task: task(), plan: plan('feature_image') });

  assert.equal(request.requestVersion, 'v1.8');
  assert.equal(request.taskId, 'generation-request-task');
  assert.equal(request.planId, 'feature_image-1');
  assert.equal(request.imageType, 'feature_image');
  assert.equal(request.product.name, 'Portable External Drive');
  assert.equal(request.sourceImages[0].role, 'main');
  assert.equal(request.productReference.enabled, true);
  assert.equal(request.productReference.sourceImageId, 'source-1');
  assert.equal(request.productReference.reason, 'filename indicates main product image');
  assert.equal(request.layout.outputSize, '2000x2000');
  assert.equal(request.textBlocks[0].text, 'Fast backup');
  assert.equal(request.visualInstructions.keepProductAppearance, true);
  assert.ok(request.prompt.positivePrompt.includes('Portable External Drive'));
  assert.ok(request.prompt.negativePrompt.includes('No Chinese text'));
});

test('productReference prefers explicit main role over filename hints', () => {
  const request = buildGenerationRequest({
    task: task({
      sourceImages: [
        { id: 'source-size', imageIndex: 0, displayName: '01-size.jpg', role: 'source', filePath: 'uploads/01-size.jpg', url: '/uploads/01-size.jpg' },
        { id: 'source-main', imageIndex: 1, displayName: '02-detail.jpg', role: 'main', filePath: 'uploads/02-detail.jpg', url: '/uploads/02-detail.jpg' }
      ]
    }),
    plan: plan('lifestyle_image')
  });

  assert.equal(request.productReference.sourceImageId, 'source-main');
  assert.equal(request.productReference.imageIndex, 1);
  assert.equal(request.productReference.reason, 'source image role is main');
});

test('productReference uses main filename hints before falling back to lowest imageIndex', () => {
  const hinted = buildGenerationRequest({
    task: task({
      sourceImages: [
        { id: 'source-detail', imageIndex: 0, displayName: '01-detail.jpg', filePath: 'uploads/01-detail.jpg', url: '/uploads/01-detail.jpg' },
        { id: 'source-front', imageIndex: 1, displayName: '02-front.jpg', filePath: 'uploads/02-front.jpg', url: '/uploads/02-front.jpg' }
      ]
    }),
    plan: plan('lifestyle_image')
  });
  assert.equal(hinted.productReference.sourceImageId, 'source-front');
  assert.equal(hinted.productReference.reason, 'filename indicates main product image');

  const fallback = buildGenerationRequest({
    task: task({
      sourceImages: [
        { id: 'source-two', imageIndex: 2, displayName: 'detail.jpg', filePath: 'uploads/detail.jpg', url: '/uploads/detail.jpg' },
        { id: 'source-zero', imageIndex: 0, displayName: 'angle.jpg', filePath: 'uploads/angle.jpg', url: '/uploads/angle.jpg' }
      ]
    }),
    plan: plan('lifestyle_image')
  });
  assert.equal(fallback.productReference.sourceImageId, 'source-zero');
  assert.equal(fallback.productReference.reason, 'lowest imageIndex fallback');
});

test('productReferenceOverride takes priority over automatic selection', () => {
  const request = buildGenerationRequest({
    task: task({
      sourceImages: [
        { id: 'source-main', imageIndex: 0, displayName: '01-main.jpg', filePath: 'uploads/01-main.jpg', url: '/uploads/01-main.jpg' },
        { id: 'source-detail', imageIndex: 1, displayName: '02-detail.jpg', filePath: 'uploads/02-detail.jpg', url: '/uploads/02-detail.jpg' }
      ]
    }),
    plan: plan('lifestyle_image', {
      productReferenceOverride: {
        sourceImageId: 'source-detail',
        imageIndex: 1,
        displayName: '02-detail.jpg',
        setByUser: true,
        setAt: '2026-05-29T00:00:00.000Z'
      }
    })
  });

  assert.equal(request.productReference.sourceImageId, 'source-detail');
  assert.equal(request.productReference.displayName, '02-detail.jpg');
  assert.equal(request.productReference.selectedBy, 'user');
  assert.equal(request.productReference.reason, 'user selected product reference');
  assert.equal(request.productReferenceOverride.sourceImageId, 'source-detail');
});

test('main image with text is not safe for real generation', () => {
  const request = buildGenerationRequest({
    task: task(),
    plan: plan('main_image', { textBlocks: [{ id: 'bad', text: 'Fast backup', sourceFields: ['sellingPoints'] }] })
  });

  assert.equal(request.providerHints.safeForRealGeneration, false);
  assert.ok(request.providerHints.blockingIssues.some((issue) => /main_image.*text/i.test(issue)));
});

test('Chinese text blocks are not safe for real generation', () => {
  const request = buildGenerationRequest({
    task: task(),
    plan: plan('feature_image', { textBlocks: [{ id: 'cn', text: '快速备份', sourceFields: ['sellingPoints'] }] })
  });

  assert.equal(request.providerHints.safeForRealGeneration, false);
  assert.ok(request.providerHints.blockingIssues.some((issue) => /Chinese/i.test(issue)));
});

test('unconfirmed capacity in text blocks is not safe for real generation', () => {
  const request = buildGenerationRequest({
    task: task(),
    plan: plan('feature_image', {
      textBlocks: [{ id: 'capacity', text: '5TB Capacity', sourceFields: ['capacity'] }]
    })
  });

  assert.equal(request.providerHints.safeForRealGeneration, false);
  assert.ok(request.providerHints.blockingIssues.some((issue) => /capacity/i.test(issue)));
});

test('preferred mode follows image type', () => {
  assert.equal(buildGenerationRequest({ task: task(), plan: plan('lifestyle_image') }).providerHints.preferredMode, 'background_replace');
  assert.equal(buildGenerationRequest({ task: task(), plan: plan('size_image') }).providerHints.preferredMode, 'text_layout');
  assert.equal(buildGenerationRequest({ task: task(), plan: plan('main_image') }).providerHints.preferredMode, 'product_preserve');
});
