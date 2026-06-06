import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  getCategoryRules,
  getEffectiveRules,
  getPlatformRules,
  listCategoryRules,
  listPlatformCategoryRules
} from '../src/services/platformCategoryRuleService.js';

test('platform rule service returns strict Amazon rules', () => {
  const rules = getPlatformRules('amazon');

  assert.equal(rules.platformId, 'amazon');
  assert.equal(rules.platformName, 'Amazon');
  assert.equal(rules.defaultLocale, 'en-US');
  assert.equal(rules.mainImageRules.background, 'pure_white');
  assert.equal(rules.mainImageRules.textAllowed, false);
  assert.equal(rules.mainImageRules.iconsAllowed, false);
  assert.equal(rules.mainImageRules.priceAllowed, false);
  assert.equal(rules.mainImageRules.promotionAllowed, false);
  assert.equal(rules.secondaryImageRules.textAllowed, true);
  assert.equal(rules.textRules.allowChinese, false);
  assert.ok(rules.bannedWords.includes('price'));
  assert.ok(rules.bannedWords.includes('discount'));
  assert.ok(rules.bannedWords.includes('no.1'));
  assert.ok(rules.cautionWords.includes('waterproof'));
});

test('platform rule service returns conservative Temu Noon Ozon and Rakuten rules', () => {
  const registry = listPlatformCategoryRules();

  for (const platformId of ['temu', 'noon', 'ozon', 'rakuten']) {
    const rules = getPlatformRules(platformId);

    assert.equal(rules.platformId, platformId);
    assert.equal(Boolean(rules.platformName), true);
    assert.equal(rules.secondaryImageRules.textAllowed, true);
    assert.equal(rules.textRules.allowChinese, false);
    assert.equal(rules.textRules.priceAllowed, false);
    assert.equal(rules.bannedWords.includes('coupon'), true);
    assert.equal(rules.cautionWords.includes('high speed'), true);
  }
  assert.deepEqual(
    registry.platforms.map((item) => item.platformId).sort(),
    ['amazon', 'noon', 'ozon', 'rakuten', 'temu']
  );
});

test('category rule service returns electronics storage high-risk evidence rules', () => {
  const rules = getCategoryRules('electronics_storage');

  assert.equal(rules.categoryId, 'electronics_storage');
  assert.equal(rules.categoryName, 'Electronics / Storage Devices');
  for (const field of [
    'capacity',
    'dimensions',
    'interfaceType',
    'certifications',
    'warranty',
    'material',
    'model',
    'brand',
    'packageIncluded',
    'compatibleDevices',
    'speed',
    'waterproof',
    'shockproof'
  ]) {
    assert.ok(rules.highRiskFields.includes(field), `${field} should be high risk`);
    assert.ok(rules.requiredEvidenceFields.includes(field), `${field} should require evidence`);
  }
  assert.ok(rules.bannedClaims.includes('official certification'));
  assert.ok(rules.cautionClaims.includes('high speed'));
});

test('category rule service includes generic ecommerce and placeholder categories', () => {
  const generic = getCategoryRules('generic_ecommerce');
  const categories = listCategoryRules().map((item) => item.categoryId);

  assert.equal(generic.categoryId, 'generic_ecommerce');
  for (const categoryId of ['apparel', 'beauty', 'home', 'tools', 'pet', 'medical_device']) {
    assert.ok(categories.includes(categoryId));
    assert.equal(getCategoryRules(categoryId).placeholder, true);
  }
});

test('effective rules merge platform and category restrictions', () => {
  const effective = getEffectiveRules('amazon', 'electronics_storage');

  assert.equal(effective.platformId, 'amazon');
  assert.equal(effective.categoryId, 'electronics_storage');
  assert.equal(effective.effectiveMainImageRules.background, 'pure_white');
  assert.equal(effective.effectiveMainImageRules.textAllowed, false);
  assert.ok(effective.effectiveHighRiskFields.includes('capacity'));
  assert.ok(effective.effectiveHighRiskFields.includes('speed'));
  assert.ok(effective.effectiveBannedWords.includes('price'));
  assert.ok(effective.effectiveBannedWords.includes('official certification'));
  assert.ok(effective.effectiveCautionWords.includes('waterproof'));
  assert.ok(effective.effectiveEvidenceRequirements.capacity);
  assert.ok(effective.recommendations.some((item) => /Amazon 主图/.test(item)));
  assert.ok(effective.recommendations.some((item) => /存储设备/.test(item)));
});
