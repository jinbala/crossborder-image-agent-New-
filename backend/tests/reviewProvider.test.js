import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runRuleBasedReviewChecks, mergeReviewData } from '../src/providers/review/ruleBasedReview.js';
import { normalizeReviewResult } from '../src/providers/review/normalizeReviewResult.js';
import { getReviewProvider } from '../src/providers/review/index.js';
import { MockReviewProvider } from '../src/providers/review/MockReviewProvider.js';
import { parseJsonFromModelOutput } from '../src/providers/vision/robustJsonParser.js';
import { buildExportMetadata } from '../src/services/exportService.js';

function baseTask(overrides = {}) {
  return {
    id: 'review-task',
    platform: 'Amazon',
    productInfoConfirmed: {
      productName: 'Portable External SSD',
      category: 'External Storage',
      capacity: ['1TB']
    },
    fieldEvidence: {
      capacity: [{ source: 'visible_text', text: '1TB', value: '1TB' }]
    },
    inferredCandidates: [{ field: 'capacity', value: '5TB', reason: 'No image evidence' }],
    ...overrides
  };
}

function image(overrides = {}) {
  return {
    id: 'image-1',
    planId: 'main-plan',
    type: 'main_image',
    fileName: 'amazon-main-image.jpg',
    title: 'Main image',
    provider: 'mock',
    model: 'mock-image-v0.3',
    isMockPreview: true,
    isRealGenerated: false,
    textLayout: null,
    ...overrides
  };
}

function plan(overrides = {}) {
  return {
    id: 'main-plan',
    type: 'main_image',
    platform: 'Amazon',
    textBlocks: [],
    generationRequestSummary: {
      imageType: 'main_image',
      platform: 'Amazon',
      safeForRealGeneration: true
    },
    ...overrides
  };
}

test('rule-based review flags mock previews and main image text', () => {
  const result = runRuleBasedReviewChecks({
    task: baseTask(),
    image: image(),
    plan: plan({ textBlocks: [{ text: 'Fast backup' }] })
  });

  assert.equal(result.pass, false);
  assert.equal(result.riskLevel, 'high');
  assert.ok(result.issues.some((issue) => issue.type === 'mock_preview'));
  assert.ok(result.issues.some((issue) => issue.type === 'main_image_text'));
  assert.equal(result.sourceChecks.isMockPreview, true);
  assert.equal(result.platformChecks.mainImageTextAllowed, false);
});

test('rule-based review flags textLayout blocking issues and unconfirmed capacity', () => {
  const result = runRuleBasedReviewChecks({
    task: baseTask(),
    image: image({
      type: 'feature_image',
      isMockPreview: false,
      isRealGenerated: true,
      textLayout: {
        blockingIssues: [{ code: 'TEXT_BLOCKED_UNCONFIRMED_CAPACITY', message: '5TB blocked', text: '5TB' }],
        warnings: [{ code: 'TEXT_FILTERED_CHINESE', message: 'Chinese removed' }]
      }
    }),
    plan: plan({ type: 'feature_image' })
  });

  assert.equal(result.pass, false);
  assert.ok(result.issues.some((issue) => issue.type === 'text_layout_blocking_issue'));
  assert.equal(result.evidenceChecks.unconfirmedCapacityUsed, true);
});

test('mergeReviewData keeps highest risk and combines rule and vision checks', () => {
  const rule = runRuleBasedReviewChecks({ task: baseTask(), image: image(), plan: plan() });
  const vision = normalizeReviewResult({
    pass: true,
    riskLevel: 'low',
    issues: [],
    textChecks: { hasChinese: false },
    notes: ['vision ok']
  });
  const merged = mergeReviewData(rule, vision);

  assert.equal(merged.pass, false);
  assert.equal(merged.riskLevel, 'medium');
  assert.ok(merged.sourceChecks.isMockPreview);
  assert.equal(merged.textChecks.hasChinese, false);
});

test('review JSON parser and normalize fill defaults', () => {
  const parsed = parseJsonFromModelOutput('```json\n{"pass":false,"riskLevel":"high","issues":[{"type":"watermark","level":"high","message":"Watermark visible"}]}\n```');
  const normalized = normalizeReviewResult(parsed);

  assert.equal(normalized.pass, false);
  assert.equal(normalized.riskLevel, 'high');
  assert.equal(normalized.issues[0].type, 'watermark');
  assert.deepEqual(normalized.fixSuggestions, []);
  assert.equal(normalized.visualChecks.productVisible, null);
});

test('real review provider reports missing API key without calling network', async () => {
  const previous = {
    REVIEW_PROVIDER: process.env.REVIEW_PROVIDER,
    GEMINI_API_KEY: process.env.GEMINI_API_KEY
  };
  process.env.REVIEW_PROVIDER = 'gemini';
  delete process.env.GEMINI_API_KEY;
  try {
    const provider = getReviewProvider('real');
    const result = await provider.review({ task: baseTask(), image: image(), plan: plan() });
    assert.equal(result.status, 'failed');
    assert.equal(result.error.code, 'MISSING_API_KEY');
    assert.equal(result.data, null);
  } finally {
    if (previous.REVIEW_PROVIDER == null) delete process.env.REVIEW_PROVIDER;
    else process.env.REVIEW_PROVIDER = previous.REVIEW_PROVIDER;
    if (previous.GEMINI_API_KEY == null) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = previous.GEMINI_API_KEY;
  }
});

test('fallback mock review marks real review error', async () => {
  const provider = new MockReviewProvider();
  const result = await provider.review({
    task: baseTask(),
    image: image(),
    plan: plan(),
    fallbackToMockReview: true,
    realReviewError: { code: 'MISSING_API_KEY', message: 'missing key' }
  });

  assert.equal(result.status, 'success');
  assert.equal(result.data.fallbackToMockReview, true);
  assert.equal(result.data.realReviewError.code, 'MISSING_API_KEY');
  assert.equal(result.data.isRealReview, false);
});

test('export metadata summarizes review results', () => {
  const metadata = buildExportMetadata({
    ...baseTask(),
    sourceImages: [],
    targets: [],
    imagePlans: [plan()],
    generatedImages: [image()],
    reviewResults: [
      { imageId: 'image-1', pass: false, riskLevel: 'high', isRealReview: true, fallbackToMockReview: false },
      { imageId: 'image-2', pass: true, riskLevel: 'low', isRealReview: false, fallbackToMockReview: true }
    ],
    exports: []
  });

  assert.equal(metadata.reviewSummary.totalImages, 2);
  assert.equal(metadata.reviewSummary.failCount, 1);
  assert.equal(metadata.reviewSummary.highRiskCount, 1);
  assert.equal(metadata.reviewSummary.realReviewCount, 1);
  assert.equal(metadata.reviewSummary.fallbackReviewCount, 1);
});
