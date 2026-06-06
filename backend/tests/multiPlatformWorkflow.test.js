import assert from 'node:assert/strict';
import { test } from 'node:test';
import { nanoid } from 'nanoid';
import { generateImagePlans } from '../src/services/imagePlanService.js';
import { getPlatformRuleSnapshot } from '../src/rules/platformRules.js';
import { buildExportMetadata, buildTargetExportMetadata, buildMasterMetadata } from '../src/services/exportService.js';
import { generateMockImageForPlan } from '../src/services/mockImageService.js';
import { runRuleBasedReviewChecks } from '../src/providers/review/ruleBasedReview.js';

function target(platformId, site = 'US', language = 'English') {
  const rulesSnapshot = getPlatformRuleSnapshot({
    platformId,
    site,
    language,
    category: 'electronics_storage'
  });
  return {
    id: `target-${platformId}`,
    targetId: `target-${platformId}`,
    platformId,
    platformName: rulesSnapshot.platformName,
    site: rulesSnapshot.site,
    language: rulesSnapshot.language,
    categoryId: 'electronics_storage',
    category: 'electronics_storage',
    rulesSnapshot,
    platformRuleSnapshot: rulesSnapshot,
    categoryRuleSnapshot: null
  };
}

function task(overrides = {}) {
  return {
    id: `mp-task-${nanoid(6)}`,
    platform: 'Amazon',
    sku: 'MP-001',
    productInfoConfirmed: {
      sku: 'MP-001',
      productName: 'Portable External SSD',
      name: 'Portable External SSD',
      category: 'External SSD',
      sellingPoints: ['Compact design'],
      packageIncluded: ['Drive', 'USB-C cable'],
      visibleSpecs: ['USB-C port']
    },
    fieldEvidence: {
      sellingPoints: [{ source: 'visible_text', text: 'Compact design' }],
      packageIncluded: [{ source: 'visible_text', text: 'USB-C cable' }]
    },
    inferredCandidates: [],
    sourceImages: [{ id: 'source-1', imageIndex: 0, filePath: 'uploads/source.png', displayName: '01-main.png' }],
    targets: [target('amazon'), target('temu')],
    imagePlans: [],
    generatedImages: [],
    reviewResults: [],
    ...overrides
  };
}

test('imagePlanService creates eight image plans for each target platform', () => {
  const plans = generateImagePlans(task());

  assert.equal(plans.length, 16);
  assert.equal(plans.filter((plan) => plan.targetId === 'target-amazon').length, 8);
  assert.equal(plans.filter((plan) => plan.targetId === 'target-temu').length, 8);

  const amazonMain = plans.find((plan) => plan.platformId === 'amazon' && plan.type === 'main_image');
  const temuMain = plans.find((plan) => plan.platformId === 'temu' && plan.type === 'main_image');
  assert.equal(amazonMain.background, 'pure_white');
  assert.equal(amazonMain.platformRuleSnapshot.textAllowed, false);
  assert.notEqual(amazonMain.platformRuleSnapshot.backgroundRule.recommended, temuMain.platformRuleSnapshot.backgroundRule.recommended);
  assert.equal(temuMain.platformId, 'temu');
  assert.equal(temuMain.categoryRuleSnapshot.categoryId, 'electronics_storage');
});

test('generated images and review results can trace targetId and platformId', async () => {
  const current = task();
  const plans = generateImagePlans(current);
  const generated = await generateMockImageForPlan({ task: { ...current, imagePlans: plans }, plan: plans[0], outputIndex: 1 });

  assert.equal(generated.targetId, plans[0].targetId);
  assert.equal(generated.platformId, plans[0].platformId);
  assert.equal(generated.imageType, plans[0].type);
  assert.match(generated.fileName, /amazon/i);

  const review = runRuleBasedReviewChecks({
    task: current,
    image: generated,
    plan: plans[0],
    generationRequest: generated.generationRequest
  });
  assert.equal(review.platformChecks.platformRuleSnapshot.platformId, 'amazon');
  assert.equal(review.platformChecks.categoryRuleSnapshot.categoryId, 'electronics_storage');
});

test('export metadata can be built per target and as master metadata', () => {
  const current = task();
  const plans = generateImagePlans(current);
  const generatedImages = plans.slice(0, 2).map((plan, index) => ({
    id: `${plan.id}-image`,
    planId: plan.id,
    targetId: plan.targetId,
    platformId: plan.platformId,
    type: plan.type,
    imageType: plan.type,
    fileName: `${plan.platformId}-${plan.type}.jpg`,
    provider: 'mock',
    isMockPreview: true,
    generationRequestSummary: plan.generationRequestSummary
  }));
  const currentTask = { ...current, imagePlans: plans, generatedImages, reviewResults: [] };

  const amazonMetadata = buildTargetExportMetadata(currentTask, 'target-amazon');
  assert.equal(amazonMetadata.targetId, 'target-amazon');
  assert.equal(amazonMetadata.platformId, 'amazon');
  assert.ok(amazonMetadata.images.every((image) => image.targetId === 'target-amazon'));
  assert.equal(amazonMetadata.platformRuleSnapshot.platformId, 'amazon');
  assert.equal(amazonMetadata.categoryRuleSnapshot.categoryId, 'electronics_storage');

  const master = buildMasterMetadata(currentTask);
  assert.equal(master.targets.length, 2);
  assert.equal(master.platformSummaries.length, 2);
  assert.equal(master.totalImages, 2);

  const metadata = buildExportMetadata(currentTask);
  assert.ok(metadata.platformSummaries.some((item) => item.platformId === 'amazon'));
});
