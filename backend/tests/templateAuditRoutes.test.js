import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import request from 'supertest';
import app from '../src/app.js';
import { createTask, resetDatabaseForTests } from '../src/services/db.js';

function task(overrides = {}) {
  return {
    id: 'route-template-audit-task',
    status: 'generated',
    platform: 'Amazon',
    productInfoConfirmed: {
      sku: 'AUDIT-ROUTE-001',
      name: 'Portable External Drive'
    },
    imagePlans: [],
    generatedImages: [],
    inferredCandidates: [],
    recognitionQuality: {},
    ...overrides
  };
}

function generatedImage(type, index, overrides = {}) {
  return {
    id: `${type}-image`,
    planId: `${type}-plan`,
    type,
    imageType: type,
    status: 'succeeded',
    textBlocks: type === 'main_image' ? [] : [{ text: `Safe copy ${index}`, sourceFields: ['sellingPoints'] }],
    mockPreview: {
      type,
      usedTextBlocks: type === 'main_image' ? [] : [{ text: `Safe preview copy ${index}`, sourceFields: ['sellingPoints'] }],
      template: {
        templateType: type,
        templateName: `${type} Template`,
        layoutStyle: `${type}-layout`,
        variantId: `${type}-seed`,
        layoutSeed: `${type}-layout-seed`,
        backgroundStyle: type === 'main_image' ? 'pure_white' : 'safe-bg',
        productPlacement: 'centered with safe margin',
        iconHints: type === 'main_image' ? [] : ['check']
      }
    },
    ...overrides
  };
}

beforeEach(async () => {
  await resetDatabaseForTests();
});

test('GET /api/tasks/:id/template-audit returns a read-only template audit report', async () => {
  const imageTypes = [
    'main_image',
    'feature_image',
    'size_image',
    'compatibility_image',
    'package_image',
    'lifestyle_image',
    'detail_image',
    'variant_image'
  ];
  const generatedImages = imageTypes.map((type, index) => generatedImage(type, index + 1));
  await createTask(task({
    imagePlans: generatedImages.map((image) => ({ id: image.planId, type: image.type, textBlocks: image.textBlocks })),
    generatedImages
  }));

  await request(app)
    .get('/api/tasks/route-template-audit-task/template-audit')
    .expect(200)
    .expect((res) => {
      assert.equal(res.body.templateAudit.meta.taskId, 'route-template-audit-task');
      assert.equal(res.body.templateAudit.meta.imageCount, 8);
      assert.equal(res.body.templateAudit.imageTypeCoverage.every((item) => item.exists), true);
      assert.equal(res.body.templateAudit.amazonMainImageCheck.pass, true);
      assert.equal(res.body.templateAudit.ruleAuditSummary.platformId, 'amazon');
      assert.equal(res.body.templateAudit.ruleAuditSummary.issueCounts.error, 0);
      assert.equal(res.body.templateAudit.ruleAuditSummary.categoryId, 'generic_ecommerce');
      assert.ok(res.body.templateAudit.ruleAuditSummary.effectiveRulesSummary);
      assert.ok(Array.isArray(res.body.templateAudit.ruleAuditSummary.recommendations));
      assert.equal(typeof res.body.templateAudit.ruleAuditSummary.issueCounts.warning, 'number');
    });
});

test('template audit API returns safe empty state when generatedImages are empty', async () => {
  await createTask(task());

  await request(app)
    .get('/api/tasks/route-template-audit-task/template-audit')
    .expect(200)
    .expect((res) => {
      assert.equal(res.body.templateAudit.meta.imageCount, 0);
      assert.equal(res.body.templateAudit.imageTypeCoverage.every((item) => item.exists === false), true);
      assert.match(res.body.templateAudit.recommendations.join('\n'), /缺少|缂哄皯/);
    });
});

test('template audit API sanitizes secrets env markers and local paths', async () => {
  await createTask(task({
    generatedImages: [
      generatedImage('main_image', 1),
      generatedImage('feature_image', 2, {
        textBlocks: [{
          text: '中文促销 $19.99 OPENAI_API_KEY=sk-secret D:\\Code\\app.sqlite node_modules .env',
          sourceFields: ['sellingPoints']
        }],
        prompt: 'C:\\Users\\secret\\.env sk-should-not-export'
      })
    ]
  }));

  const before = await request(app).get('/api/tasks/route-template-audit-task').expect(200);
  await request(app)
    .get('/api/tasks/route-template-audit-task/template-audit')
    .expect(200)
    .expect((res) => {
      const json = JSON.stringify(res.body);
      assert.ok(res.body.templateAudit.ruleAuditSummary);
      assert.doesNotMatch(json, /\.env/i);
      assert.doesNotMatch(json, /OPENAI_API_KEY/i);
      assert.doesNotMatch(json, /sk-secret|sk-should-not-export/);
      assert.doesNotMatch(json, /[A-Z]:\\/);
      assert.doesNotMatch(json, /node_modules/i);
      assert.doesNotMatch(json, /app\.sqlite/i);
    });
  const after = await request(app).get('/api/tasks/route-template-audit-task').expect(200);

  assert.deepEqual(after.body.task.generatedImages, before.body.task.generatedImages);
});

test('template audit API returns 404 for missing task', async () => {
  await request(app)
    .get('/api/tasks/not-found/template-audit')
    .expect(404);
});
