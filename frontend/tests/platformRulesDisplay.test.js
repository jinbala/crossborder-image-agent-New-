import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  buildRulesSummary,
  fieldDisplayName,
  platformRulesEmptyText,
  ruleListText,
  sanitizeRulesDisplay
} from '../src/utils/platformRulesDisplay.js';

function effectiveRules(overrides = {}) {
  return {
    platformId: 'amazon',
    platformName: 'Amazon',
    categoryId: 'electronics_storage',
    categoryName: 'Electronics / Storage Devices',
    effectiveMainImageRules: {
      background: 'pure_white',
      textAllowed: false,
      iconsAllowed: false,
      priceAllowed: false,
      promotionAllowed: false,
      productCentered: true
    },
    effectiveSecondaryImageRules: {
      textAllowed: true,
      chineseAllowed: false,
      priceAllowed: false,
      promotionAllowed: false,
      unconfirmedCertificationAllowed: false,
      unconfirmedWarrantyAllowed: false,
      unconfirmedCapacityAllowed: false,
      unconfirmedSpeedAllowed: false,
      absoluteClaimsAllowed: false
    },
    effectiveHighRiskFields: [
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
    ],
    effectiveBannedWords: ['price', 'discount', 'sale', 'coupon', 'best', 'no.1', 'guaranteed'],
    effectiveCautionWords: ['waterproof', 'shockproof', 'certified', 'warranty', 'high speed'],
    recommendations: [
      'Amazon 主图必须保持白底无文字。',
      '容量、接口、认证、保修等字段必须有证据后才能进入图片文案。'
    ],
    ...overrides
  };
}

test('platform rules summary displays platform category main and secondary rules', () => {
  const summary = buildRulesSummary(effectiveRules());

  assert.match(summary.platformText, /Amazon/);
  assert.match(summary.categoryText, /Electronics \/ Storage Devices/);
  assert.match(summary.mainImageText, /白底/);
  assert.match(summary.mainImageText, /无文字/);
  assert.match(summary.mainImageText, /无 icon/);
  assert.match(summary.secondaryImageText, /允许英文卖点/);
  assert.match(summary.secondaryImageText, /不允许中文/);
  assert.match(summary.secondaryImageText, /不允许价格/);
});

test('platform rules summary displays high-risk fields with Chinese labels and keys', () => {
  const summary = buildRulesSummary(effectiveRules());

  assert.ok(summary.highRiskFields.some((item) => item === '容量 capacity'));
  assert.ok(summary.highRiskFields.some((item) => item === '接口类型 interfaceType'));
  assert.ok(summary.highRiskFields.some((item) => item === '兼容设备 compatibleDevices'));
  assert.equal(fieldDisplayName('shockproof'), '防摔');
});

test('platform rules summary displays banned caution words and Chinese recommendations', () => {
  const summary = buildRulesSummary(effectiveRules());

  assert.match(ruleListText(summary.bannedWords), /price/);
  assert.match(ruleListText(summary.bannedWords), /discount/);
  assert.match(ruleListText(summary.cautionWords), /waterproof/);
  assert.match(summary.recommendations.join('\n'), /Amazon 主图/);
  assert.match(summary.recommendations.join('\n'), /必须有证据/);
});

test('platform rules summary handles unknown or missing rules without blank screen', () => {
  assert.match(platformRulesEmptyText(null), /暂无该平台或类目的规则配置/);
  assert.match(buildRulesSummary(null).emptyText, /暂无该平台或类目的规则配置/);
  assert.match(buildRulesSummary({ platformId: 'unknown' }).platformText, /unknown/);
});

test('platform rules display sanitizer hides secrets env and local paths', () => {
  const safe = sanitizeRulesDisplay({
    recommendations: ['OPENAI_API_KEY=sk-secret D:\\Code\\.env C:\\tmp\\app.sqlite node_modules'],
    nested: { value: 'sk-should-not-show' }
  });
  const json = JSON.stringify(safe);

  assert.doesNotMatch(json, /OPENAI_API_KEY/i);
  assert.doesNotMatch(json, /sk-secret|sk-should-not-show/);
  assert.doesNotMatch(json, /\.env/i);
  assert.doesNotMatch(json, /[A-Z]:\\/);
  assert.doesNotMatch(json, /node_modules/i);
  assert.doesNotMatch(json, /app\.sqlite/i);
});

test('rules API helpers and PlatformRulesPage summary are wired', async () => {
  const { api } = await import('../src/services/api.js');
  const captured = [];
  global.fetch = async (url) => {
    captured.push(url);
    return {
      ok: true,
      json: async () => ({ ok: true })
    };
  };

  await api.listRulePlatforms();
  await api.listRuleCategories();
  await api.getEffectiveRules({ platformId: 'amazon', categoryId: 'electronics_storage' });
  const page = readFileSync(new URL('../src/pages/PlatformRulesPage.jsx', import.meta.url), 'utf8');

  assert.equal(captured[0], '/api/rules/platforms');
  assert.equal(captured[1], '/api/rules/categories');
  assert.equal(captured[2], '/api/rules/effective?platformId=amazon&categoryId=electronics_storage');
  assert.match(page, /平台 \/ 类目规则摘要/);
  assert.match(page, /buildRulesSummary/);
  assert.match(page, /getEffectiveRules/);
});
