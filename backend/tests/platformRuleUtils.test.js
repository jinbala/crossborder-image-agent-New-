import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  getForbiddenElements,
  getPlatformRule,
  getRuleSeverity,
  isTextAllowed,
  summarizePlatformRulesForPrompt
} from '../src/rules/platformRuleUtils.js';
import { runRuleBasedReviewChecks } from '../src/providers/review/ruleBasedReview.js';
import { buildReviewPrompt } from '../src/providers/review/reviewPrompt.js';
import { buildGenerationRequest } from '../src/services/generationRequestService.js';

function task(overrides = {}) {
  return {
    id: 'platform-rule-task',
    platform: 'Amazon',
    productInfoConfirmed: { productName: 'Portable SSD', category: 'External Storage', capacity: ['5TB'] },
    fieldEvidence: {},
    inferredCandidates: [{ field: 'capacity', value: '5TB' }],
    targets: [{
      id: 'target-1',
      platformId: 'amazon',
      site: 'US',
      language: 'English',
      rulesSnapshot: {
        platformId: 'amazon',
        name: 'Amazon',
        site: 'US',
        language: 'English',
        imageTypes: {}
      }
    }],
    sourceImages: [{ id: 'source-1', filePath: 'uploads/source.jpg', imageIndex: 0 }]
  };
}

function plan(overrides = {}) {
  return {
    id: 'plan-1',
    targetId: 'target-1',
    type: 'main_image',
    platform: 'Amazon',
    language: 'English',
    textBlocks: [],
    ...overrides
  };
}

test('platform rule utils return Amazon main_image strict rules and fallback marketplace rules', () => {
  const amazonMain = getPlatformRule({ platformId: 'amazon', imageType: 'main_image' });
  assert.equal(amazonMain.platformId, 'amazon');
  assert.equal(amazonMain.imageType, 'main_image');
  assert.equal(amazonMain.rule.text.allowed, false);
  assert.equal(amazonMain.rule.background.recommended, 'pure_white');
  assert.equal(isTextAllowed({ platformId: 'amazon', imageType: 'main_image' }), false);
  assert.ok(getForbiddenElements({ platformId: 'amazon', imageType: 'main_image' }).includes('price'));
  assert.equal(getRuleSeverity({ platformId: 'amazon', imageType: 'main_image', issueType: 'text' }), 'high');

  const fallback = getPlatformRule({ platformId: 'unknown-platform', imageType: 'main_image' });
  assert.equal(fallback.platformId, 'marketplace');
  assert.equal(fallback.rule.text.allowed, false);
});

test('ruleBasedReview uses platform rules for main image text and auxiliary text', () => {
  const mainResult = runRuleBasedReviewChecks({
    task: task(),
    plan: plan({ textBlocks: [{ text: 'Fast backup' }] }),
    image: { id: 'image-1', planId: 'plan-1', type: 'main_image', fileName: 'main.jpg', isMockPreview: false, provider: 'openai' }
  });
  assert.ok(mainResult.issues.some((issue) => issue.type === 'main_image_text' && issue.level === 'high' && issue.ruleId));

  const featureResult = runRuleBasedReviewChecks({
    task: task(),
    plan: plan({ type: 'feature_image', textBlocks: [{ text: 'Fast backup' }] }),
    image: { id: 'image-2', planId: 'plan-1', type: 'feature_image', fileName: 'feature.jpg', isMockPreview: false, provider: 'openai' }
  });
  assert.equal(featureResult.issues.some((issue) => issue.type === 'main_image_text'), false);
});

test('ruleBasedReview marks Chinese promotion and inferred capacity with categories', () => {
  const result = runRuleBasedReviewChecks({
    task: task(),
    plan: plan({
      type: 'feature_image',
      textBlocks: [
        { text: '中文卖点' },
        { text: '50% discount' },
        { text: '5TB' }
      ]
    }),
    image: { id: 'image-3', planId: 'plan-1', type: 'feature_image', fileName: 'feature.jpg', isMockPreview: false, provider: 'openai' }
  });

  assert.ok(result.issues.some((issue) => issue.type === 'chinese_text' && issue.category === 'text'));
  assert.ok(result.issues.some((issue) => issue.type === 'promotion_text' && issue.category === 'text'));
  assert.ok(result.issues.some((issue) => issue.type === 'inferred_candidate_used' && issue.category === 'evidence'));
});

test('generationRequest and review prompt include platform rule summary', () => {
  const ruleSummary = summarizePlatformRulesForPrompt({ platformId: 'amazon', imageType: 'main_image', language: 'English' });
  assert.match(ruleSummary, /Amazon/);
  assert.match(ruleSummary, /text allowed: no/i);

  const request = buildGenerationRequest({ task: task(), plan: plan() });
  assert.equal(request.compliance.platformRulesSnapshot.platformId, 'amazon');
  assert.equal(request.compliance.platformRulesSnapshot.imageType, 'main_image');
  assert.equal(request.compliance.platformRulesSnapshot.textAllowed, false);

  const prompt = buildReviewPrompt({ task: task(), plan: plan(), image: { type: 'main_image' } });
  assert.match(prompt, /Platform rule summary/);
  assert.match(prompt, /Amazon/);
  assert.match(prompt, /forbiddenElements/);
});
