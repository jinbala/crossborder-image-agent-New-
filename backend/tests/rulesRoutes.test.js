import assert from 'node:assert/strict';
import { test } from 'node:test';
import request from 'supertest';
import app from '../src/app.js';

function assertSanitized(body) {
  const json = JSON.stringify(body);
  assert.doesNotMatch(json, /OPENAI_API_KEY|API_KEY/i);
  assert.doesNotMatch(json, /\.env/i);
  assert.doesNotMatch(json, /[A-Z]:\\/);
  assert.doesNotMatch(json, /sk-[A-Za-z0-9_-]+/);
}

test('GET /api/rules/platforms returns five supported platforms', async () => {
  await request(app)
    .get('/api/rules/platforms')
    .expect(200)
    .expect((res) => {
      assert.deepEqual(
        res.body.platforms.map((item) => item.platformId).sort(),
        ['amazon', 'noon', 'ozon', 'rakuten', 'temu']
      );
      const amazon = res.body.platforms.find((item) => item.platformId === 'amazon');
      assert.equal(amazon.platformName, 'Amazon');
      assert.equal(amazon.mainImageRules.textAllowed, false);
      assert.equal(amazon.mainImageRules.background, 'pure_white');
      assert.ok(amazon.bannedWords.includes('price'));
      assert.ok(amazon.cautionWords.includes('waterproof'));
      assertSanitized(res.body);
    });
});

test('GET /api/rules/categories returns storage and generic ecommerce rules', async () => {
  await request(app)
    .get('/api/rules/categories')
    .expect(200)
    .expect((res) => {
      const ids = res.body.categories.map((item) => item.categoryId);
      assert.ok(ids.includes('electronics_storage'));
      assert.ok(ids.includes('generic_ecommerce'));
      const storage = res.body.categories.find((item) => item.categoryId === 'electronics_storage');
      assert.ok(storage.highRiskFields.includes('capacity'));
      assert.ok(storage.requiredEvidenceFields.includes('interfaceType'));
      assert.ok(storage.bannedClaims.includes('official certification'));
      assert.ok(storage.cautionClaims.includes('high speed'));
      assertSanitized(res.body);
    });
});

test('GET /api/rules/effective returns merged platform and category rules', async () => {
  await request(app)
    .get('/api/rules/effective?platformId=amazon&categoryId=electronics_storage')
    .expect(200)
    .expect((res) => {
      assert.equal(res.body.effectiveRules.platformId, 'amazon');
      assert.equal(res.body.effectiveRules.categoryId, 'electronics_storage');
      assert.equal(res.body.effectiveRules.effectiveMainImageRules.background, 'pure_white');
      assert.equal(res.body.effectiveRules.effectiveMainImageRules.textAllowed, false);
      assert.ok(res.body.effectiveRules.effectiveHighRiskFields.includes('capacity'));
      assert.ok(res.body.effectiveRules.effectiveBannedWords.includes('price'));
      assert.ok(res.body.effectiveRules.effectiveCautionWords.includes('waterproof'));
      assert.ok(res.body.effectiveRules.recommendations.some((item) => /Amazon 主图/.test(item)));
      assertSanitized(res.body);
    });
});

test('GET /api/rules/effective returns 404 for unknown platform', async () => {
  await request(app)
    .get('/api/rules/effective?platformId=unknown&categoryId=electronics_storage')
    .expect(404)
    .expect((res) => {
      assert.match(res.body.error, /platform/i);
    });
});

test('GET /api/rules/effective falls back unknown category to generic ecommerce', async () => {
  await request(app)
    .get('/api/rules/effective?platformId=amazon&categoryId=unknown_category')
    .expect(200)
    .expect((res) => {
      assert.equal(res.body.effectiveRules.platformId, 'amazon');
      assert.equal(res.body.effectiveRules.categoryId, 'generic_ecommerce');
      assert.ok(res.body.effectiveRules.effectiveHighRiskFields.includes('warranty'));
      assertSanitized(res.body);
    });
});
