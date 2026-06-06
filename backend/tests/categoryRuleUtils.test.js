import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  categoryRuleSnapshotForImage,
  detectCategoryFromProductInfo,
  getCategoryRule,
  getEvidenceRequiredFields,
  getForbiddenClaimsWithoutEvidence,
  summarizeCategoryRulesForPrompt
} from '../src/rules/categoryRuleUtils.js';
import { runRuleBasedReviewChecks } from '../src/providers/review/ruleBasedReview.js';
import { buildGenerationRequest } from '../src/services/generationRequestService.js';
import { buildTextLayout } from '../src/services/textLayoutService.js';
import { buildReviewPrompt } from '../src/providers/review/reviewPrompt.js';
import { getPlatformRuleSnapshot } from '../src/rules/platformRules.js';
import { generateImagePlans } from '../src/services/imagePlanService.js';
import { buildExportMetadata } from '../src/services/exportService.js';

function task(overrides = {}) {
  return {
    id: 'category-rule-task',
    platform: 'Amazon',
    platformId: 'amazon',
    site: 'US',
    language: 'English',
    productInfoConfirmed: {
      productName: 'Portable External SSD',
      category: 'External hard drive storage device',
      brand: 'Acme',
      model: 'X1',
      capacity: ['5TB'],
      compatibleDevices: ['Laptop', 'Phone'],
      packageIncluded: ['External SSD', 'USB-C cable'],
      sellingPoints: ['Compact design']
    },
    fieldEvidence: {},
    inferredCandidates: [{ field: 'capacity', value: '5TB', reason: 'No visible evidence' }],
    sourceImages: [{ id: 'source-1', imageIndex: 0, filePath: 'uploads/source.jpg' }],
    targets: [{
      id: 'target-1',
      platformId: 'amazon',
      site: 'US',
      language: 'English',
      category: 'electronics_storage',
      rulesSnapshot: getPlatformRuleSnapshot({ platformId: 'amazon', site: 'US', language: 'English', category: 'electronics_storage' })
    }],
    ...overrides
  };
}

function plan(type = 'feature_image', overrides = {}) {
  return {
    id: `${type}-plan`,
    targetId: 'target-1',
    type,
    platform: 'Amazon',
    site: 'US',
    language: 'English',
    title: `${type} title`,
    goal: `${type} goal`,
    layout: 'Clean layout',
    background: 'clean',
    size: '2000x2000',
    textBlocks: [],
    riskWarnings: [],
    complianceNotes: [],
    rulesSnapshot: getPlatformRuleSnapshot({ platformId: 'amazon' }).imageTypes[type],
    promptVersion: 'v1.5',
    ...overrides
  };
}

test('category rule utils detect electronics storage products and expose evidence rules', () => {
  assert.equal(detectCategoryFromProductInfo({ productName: 'Portable external SSD 1TB', category: 'Storage Device' }), 'electronics_storage');
  const rule = getCategoryRule({ productInfoConfirmed: task().productInfoConfirmed });
  assert.equal(rule.categoryId, 'electronics_storage');
  assert.ok(rule.criticalFields.includes('capacity'));
  assert.equal(getEvidenceRequiredFields('electronics_storage').capacity, 'visible_text');
  assert.ok(getForbiddenClaimsWithoutEvidence('electronics_storage').includes('waterproof'));

  const snapshot = categoryRuleSnapshotForImage({
    imageType: 'feature_image',
    productInfoConfirmed: task().productInfoConfirmed
  });
  assert.equal(snapshot.categoryId, 'electronics_storage');
  assert.ok(snapshot.highRiskFields.includes('speed'));
});

test('ruleBasedReview flags electronics storage claims without evidence', () => {
  const result = runRuleBasedReviewChecks({
    task: task(),
    plan: plan('feature_image', {
      textBlocks: [
        { text: '5TB Capacity', sourceFields: ['capacity'] },
        { text: 'Universal compatibility with all devices', sourceFields: ['compatibleDevices'] },
        { text: '5-year warranty', sourceFields: ['warranty'] },
        { text: 'CE certified', sourceFields: ['certifications'] }
      ]
    }),
    image: { id: 'image-1', planId: 'feature_image-plan', type: 'feature_image', provider: 'openai', isRealGenerated: true }
  });

  assert.ok(result.issues.some((issue) => issue.type === 'category_unconfirmed_capacity' && issue.level === 'high' && issue.category === 'category'));
  assert.ok(result.issues.some((issue) => issue.type === 'category_universal_compatibility' && issue.categoryId === 'electronics_storage'));
  assert.ok(result.issues.some((issue) => issue.type === 'category_unconfirmed_warranty' && issue.level === 'high'));
  assert.ok(result.issues.some((issue) => issue.type === 'category_unconfirmed_certification' && issue.level === 'high'));
});

test('generationRequest and review prompt include category rules', () => {
  const request = buildGenerationRequest({
    task: task(),
    plan: plan('feature_image', { textBlocks: [{ id: 'speed', text: 'Up to 1000MB/s', sourceFields: ['speed'] }] })
  });

  assert.equal(request.categoryRuleSnapshot.categoryId, 'electronics_storage');
  assert.equal(request.providerHints.safeForRealGeneration, false);
  assert.ok(request.providerHints.blockingIssues.some((issue) => /category|speed|evidence/i.test(issue)));

  const summary = summarizeCategoryRulesForPrompt({ productInfoConfirmed: task().productInfoConfirmed });
  assert.match(summary, /Electronics \/ Storage Devices/);
  assert.match(summary, /high-risk fields/i);

  const prompt = buildReviewPrompt({ task: task(), plan: plan('feature_image'), image: { type: 'feature_image' }, generationRequest: request });
  assert.match(prompt, /Category rule summary/);
  assert.match(prompt, /electronics_storage/);
  assert.match(prompt, /unsupported electronic product claims/i);
});

test('textLayoutService filters electronics storage claims without category evidence', () => {
  const layout = buildTextLayout({
    task: task(),
    plan: plan('feature_image', {
      textBlocks: [
        { id: 'capacity', text: '5TB Capacity', role: 'bullet', sourceField: 'capacity', evidenceStatus: 'needs_confirmation' },
        { id: 'speed', text: 'Up to 1000MB/s', role: 'bullet', sourceField: 'speed', evidenceStatus: 'needs_confirmation' },
        { id: 'safe', text: 'Compact design', role: 'bullet', sourceField: 'sellingPoints', evidenceStatus: 'confirmed' }
      ]
    })
  });

  assert.ok(layout.textElements.some((item) => item.text === 'Compact design'));
  assert.doesNotMatch(JSON.stringify(layout.textElements), /5TB|1000MB/);
  assert.ok(layout.excludedTextBlocks.some((item) => item.reason === 'category_evidence_required'));
});

test('image plans and export metadata carry category rule snapshots', () => {
  const missingSizeTask = task({
    productInfoConfirmed: {
      productName: 'Portable External SSD',
      category: 'External SSD',
      sellingPoints: ['Compact design'],
      packageIncluded: ['Drive']
    },
    fieldEvidence: {},
    inferredCandidates: []
  });
  const plans = generateImagePlans(missingSizeTask);
  const sizePlan = plans.find((item) => item.type === 'size_image');
  assert.equal(sizePlan.categoryRuleSnapshot.categoryId, 'electronics_storage');
  assert.ok(sizePlan.blockingIssues.some((item) => item.code === 'MISSING_DIMENSIONS'));

  const metadata = buildExportMetadata({
    ...missingSizeTask,
    imagePlans: plans,
    generatedImages: [{
      id: 'image-1',
      planId: sizePlan.id,
      type: 'size_image',
      fileName: 'size.png',
      provider: 'mock',
      isMockPreview: true,
      generationRequestSummary: sizePlan.generationRequestSummary
    }],
    reviewResults: []
  });
  assert.ok(metadata.categoryRuleSnapshots.some((item) => item.categoryId === 'electronics_storage'));
  assert.equal(metadata.generatedImages[0].categoryRuleSnapshot.categoryId, 'electronics_storage');
});
