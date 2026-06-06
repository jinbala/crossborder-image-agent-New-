import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  groupReviewIssues,
  normalizeReviewIssue,
  normalizeReviewIssues
} from '../src/services/reviewIssueService.js';

test('normalizes Chinese price and Amazon main image text issues into fatal compliance risks', () => {
  const issues = normalizeReviewIssues([
    { type: 'chinese_text', imageType: 'feature_image', message: 'Chinese text detected' },
    { type: 'promotion_text', imageType: 'feature_image', message: 'sale coupon free shipping' },
    { type: 'main_image_text', imageType: 'main_image', message: 'main image has text' }
  ], { source: 'ruleAudit' });

  assert.deepEqual(issues.map((issue) => issue.severity), ['fatal', 'fatal', 'fatal']);
  assert.equal(issues.every((issue) => issue.isRealComplianceRisk), true);
  assert.equal(issues.every((issue) => issue.isMockOnly === false), true);
  assert.match(issues[0].suggestion, /删除图片中的中文/);
  assert.match(issues[1].suggestion, /价格|折扣|coupon|sale|free shipping/);
  assert.match(issues[2].suggestion, /Amazon 主图/);
});

test('normalizes high-risk missing evidence fields with Chinese suggestions', () => {
  const capacity = normalizeReviewIssue({ type: 'unconfirmed_capacity', fieldKey: 'capacity', imageType: 'feature_image' });
  const certification = normalizeReviewIssue({ type: 'category_unconfirmed_certification', fieldKey: 'certifications', imageType: 'detail_image' });
  const warranty = normalizeReviewIssue({ type: 'category_unconfirmed_warranty', fieldKey: 'warranty', imageType: 'detail_image' });
  const interfaceConflict = normalizeReviewIssue({ type: 'interface_conflict', fieldKey: 'interfaceType', imageType: 'detail_image' });

  assert.equal(capacity.severity, 'fatal');
  assert.equal(certification.severity, 'fatal');
  assert.equal(warranty.severity, 'fatal');
  assert.equal(interfaceConflict.severity, 'fatal');
  assert.match(capacity.suggestion, /容量属于高风险字段/);
  assert.match(certification.suggestion, /认证信息必须有明确证据/);
  assert.match(warranty.suggestion, /保修信息必须有明确证据/);
  assert.match(interfaceConflict.suggestion, /接口字段存在冲突/);
});

test('normalizes mock preview hints as mockInfo without real compliance risk', () => {
  const issue = normalizeReviewIssue({ type: 'mock_preview', imageType: 'main_image', message: 'Mock preview image cannot be used as final upload.' });

  assert.equal(issue.severity, 'mockInfo');
  assert.equal(issue.category, 'mock');
  assert.equal(issue.isMockOnly, true);
  assert.equal(issue.isRealComplianceRisk, false);
  assert.match(issue.suggestion, /mock 预览图/);
});

test('does not downgrade real compliance risk to mockInfo', () => {
  const issue = normalizeReviewIssue({
    type: 'chinese_text',
    imageType: 'feature_image',
    message: 'mock preview still contains Chinese text',
    source: 'mockReview'
  });

  assert.equal(issue.severity, 'fatal');
  assert.equal(issue.isMockOnly, false);
  assert.equal(issue.isRealComplianceRisk, true);
});

test('groups same code image type field and mock hints', () => {
  const issues = normalizeReviewIssues([
    { type: 'unconfirmed_capacity', fieldKey: 'capacity', imageType: 'feature_image', message: 'capacity missing evidence A' },
    { type: 'unconfirmed_capacity', fieldKey: 'capacity', imageType: 'feature_image', message: 'capacity missing evidence B' },
    { type: 'mock_preview', imageType: 'main_image', message: 'mock preview A' },
    { type: 'mock_preview', imageType: 'feature_image', message: 'mock preview B' }
  ]);
  const groups = groupReviewIssues(issues);

  const capacityGroup = groups.find((group) => group.groupKey.includes('capacity'));
  const mockGroup = groups.find((group) => group.severity === 'mockInfo');

  assert.equal(capacityGroup.count, 2);
  assert.deepEqual(capacityGroup.imageTypes, ['feature_image']);
  assert.match(capacityGroup.suggestion, /容量属于高风险字段/);
  assert.equal(mockGroup.count, 2);
  assert.deepEqual(mockGroup.imageTypes, ['main_image', 'feature_image']);
});
