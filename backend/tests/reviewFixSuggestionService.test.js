import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildFixSuggestions,
  buildFixSummary
} from '../src/services/reviewFixSuggestionService.js';

function issue(overrides = {}) {
  return {
    code: 'GENERIC',
    severity: 'medium',
    category: 'text',
    imageType: 'feature_image',
    message: 'generic issue',
    suggestion: '人工复核。',
    isRealComplianceRisk: true,
    isMockOnly: false,
    canAutoFixLater: false,
    requiresManualConfirm: false,
    ...overrides
  };
}

test('maps review issue types to human fix suggestions', () => {
  const suggestions = buildFixSuggestions({
    issues: [
      issue({ code: 'CHINESE_TEXT_DETECTED', message: 'Chinese text detected' }),
      issue({ code: 'PROMOTION_PRICE_TEXT', message: 'coupon sale price' }),
      issue({ code: 'MAIN_IMAGE_TEXT', imageType: 'main_image', category: 'platform' }),
      issue({ code: 'UNCONFIRMED_CAPACITY', category: 'field', fieldKey: 'capacity', fieldLabel: '容量' }),
      issue({ code: 'INTERFACE_CONFLICT', category: 'field', fieldKey: 'interfaceType', fieldLabel: '接口类型' }),
      issue({ code: 'SUBJECT_PRESERVE_RISK', category: 'realGeneration', message: 'subject preserve risk' }),
      issue({ code: 'MOCK_PREVIEW_SOURCE', severity: 'mockInfo', category: 'mock', isMockOnly: true, isRealComplianceRisk: false }),
      issue({ code: 'INFO_ONLY', severity: 'info', category: 'unknown', isRealComplianceRisk: false })
    ]
  });

  assert.equal(suggestions.find((item) => item.issueCode === 'CHINESE_TEXT_DETECTED').actionType, 'removeText');
  assert.equal(suggestions.find((item) => item.issueCode === 'PROMOTION_PRICE_TEXT').title, '删除价格或促销信息');
  assert.equal(suggestions.find((item) => item.issueCode === 'MAIN_IMAGE_TEXT').actionType, 'editTextLayout');
  assert.equal(suggestions.find((item) => item.issueCode === 'UNCONFIRMED_CAPACITY').actionType, 'confirmFieldEvidence');
  assert.equal(suggestions.find((item) => item.issueCode === 'INTERFACE_CONFLICT').actionType, 'manualCheck');
  assert.equal(suggestions.find((item) => item.issueCode === 'SUBJECT_PRESERVE_RISK').actionType, 'manualCheck');
  assert.equal(suggestions.find((item) => item.issueCode === 'MOCK_PREVIEW_SOURCE').actionType, 'skipMockOnly');
  assert.equal(suggestions.find((item) => item.issueCode === 'INFO_ONLY').actionType, 'noActionNeeded');
  assert.equal(suggestions[0].severity, 'fatal');
});

test('buildFixSummary counts action types without treating mockInfo as real compliance fix', () => {
  const suggestions = buildFixSuggestions({
    issues: [
      issue({ code: 'MAIN_IMAGE_TEXT', severity: 'fatal', imageType: 'main_image' }),
      issue({ code: 'UNCONFIRMED_WARRANTY', severity: 'fatal', category: 'field', fieldKey: 'warranty', requiresManualConfirm: true }),
      issue({ code: 'MOCK_PREVIEW_SOURCE', severity: 'mockInfo', category: 'mock', isMockOnly: true, isRealComplianceRisk: false })
    ]
  });
  const summary = buildFixSummary(suggestions);

  assert.equal(summary.total, 3);
  assert.equal(summary.autoFixCandidateCount, 1);
  assert.equal(summary.manualConfirmRequiredCount, 1);
  assert.equal(summary.mockOnlyCount, 1);
  assert.equal(summary.byActionType.editTextLayout, 1);
  assert.equal(summary.byActionType.confirmFieldEvidence, 1);
  assert.equal(summary.byActionType.skipMockOnly, 1);
});
