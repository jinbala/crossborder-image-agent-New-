import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import request from 'supertest';
import app from '../src/app.js';
import { createTask, getTask, resetDatabaseForTests } from '../src/services/db.js';

function plan(type) {
  return {
    id: `${type}-plan`,
    type,
    platformId: 'amazon',
    platformName: 'Amazon',
    categoryId: 'electronics_storage',
    title: `${type} plan`,
    background: type === 'main_image' ? 'pure_white' : 'clean_neutral',
    textBlocks: type === 'main_image' ? [] : [{ text: 'Portable design', sourceFields: ['sellingPoints'] }],
    templateSeed: {
      templateType: type,
      templateName: `${type} Template`,
      layoutStyle: `${type}-layout`,
      backgroundStyle: type === 'main_image' ? 'pure_white' : 'clean_neutral',
      iconHints: []
    }
  };
}

function task() {
  return {
    id: 'route-single-real-task',
    status: 'generated',
    platformId: 'amazon',
    categoryId: 'electronics_storage',
    platform: 'Amazon',
    productInfoConfirmed: {
      sku: 'ROUTE-REAL-001',
      name: 'Portable External Drive',
      category: 'External Storage'
    },
    sourceImages: [{
      id: 'source-1',
      displayName: 'main.jpg',
      previewUrl: '/uploads/main.jpg',
      filePath: 'uploads/main.jpg'
    }],
    imagePlans: ['main_image', 'feature_image', 'detail_image'].map(plan),
    generatedImages: [],
    inferredCandidates: [],
    recognitionQuality: {}
  };
}

beforeEach(async () => {
  await resetDatabaseForTests();
});

test('single-image HTTP route refuses missing approval instead of falling through to local or Image2 processing', async () => {
  await createTask(task()); const before = await getTask('route-single-real-task');
  for (const confirmReal of [undefined, false, 'true']) await request(app).post('/api/generate/single-image')
    .send({ taskId: before.id, imageType: 'main_image', mattingProvider: 'image2', confirmReal }).expect(403);
  assert.deepEqual(await getTask(before.id), before);
});

test('POST /api/generate/single-image returns sanitized single image report without mutating task', async () => {
  await createTask(task());
  const before = await getTask('route-single-real-task');

  await request(app)
    .post('/api/generate/single-image')
    .send({
      taskId: 'route-single-real-task',
      confirmReal: true,
      imageType: 'main_image',
      realMode: 'text_to_image',
      mattingProvider: 'sharp'
    })
    .expect(200)
    .expect((res) => {
      assert.equal(res.body.report.singleImageGeneration.taskId, 'route-single-real-task');
      assert.equal(res.body.report.singleImageGeneration.imageType, 'main_image');
      assert.ok(res.body.report.templateAudit);
      assert.ok(res.body.report.ruleAuditSummary);
      assert.ok(res.body.report.qualityScore);
      const json = JSON.stringify(res.body);
      assert.doesNotMatch(json, /\.env/i);
      assert.doesNotMatch(json, /API_KEY/i);
      assert.doesNotMatch(json, /sk-secret/i);
      assert.doesNotMatch(json, /[A-Z]:\\/);
      assert.doesNotMatch(json, /app\.sqlite/i);
      assert.doesNotMatch(json, /node_modules/i);
    });

  const after = await getTask('route-single-real-task');
  assert.deepEqual(after.generatedImages, before.generatedImages);
  assert.deepEqual(after.imagePlans, before.imagePlans);
});

test('GET /api/generate/:taskId/report returns latest in-memory report', async () => {
  await createTask(task());
  await request(app)
    .post('/api/generate/single-image')
    .send({ taskId: 'route-single-real-task', imageType: 'detail_image', confirmReal: true })
    .expect(200);

  await request(app)
    .get('/api/generate/route-single-real-task/report')
    .expect(200)
    .expect((res) => {
      assert.equal(res.body.report.taskId, 'route-single-real-task');
      assert.equal(res.body.report.latest.singleImageGeneration.imageType, 'detail_image');
      assert.ok(res.body.report.latest.ruleAuditSummary);
    });
});

test('POST /api/generate/single-image rejects unsupported image type and batch payloads', async () => {
  await createTask(task());

  await request(app)
    .post('/api/generate/single-image')
    .send({ taskId: 'route-single-real-task', imageType: 'size_image' })
    .expect(400);

  await request(app)
    .post('/api/generate/single-image')
    .send({ taskIds: ['route-single-real-task'], imageType: 'main_image' })
    .expect(400);
});

test('POST /api/generate/three-sample returns aggregate report without mutating task', async () => {
  await createTask(task());
  const before = await getTask('route-single-real-task');

  await request(app)
    .post('/api/generate/three-sample')
    .send({
      taskId: 'route-single-real-task',
      confirmPaidApi: true,
      mattingProvider: 'sharp',
      samples: [
        { sampleId: 's1', imageType: 'main_image', imageId: 'source-1' },
        { sampleId: 's2', imageType: 'feature_image', imageId: 'source-1' },
        { sampleId: 's3', imageType: 'detail_image', imageId: 'source-1' }
      ]
    })
    .expect(200)
    .expect((res) => {
      assert.match(['completed', 'partial', 'failed'].join(','), new RegExp(res.body.status));
      assert.equal(res.body.aggregateReport.meta.testMode, 'three-sample-real-generation');
      assert.equal(res.body.aggregateReport.summary.totalSamples, 3);
      assert.equal(res.body.sampleReports.length, 3);
      assert.ok(res.body.aggregateReport.manualChecklist);
      assert.equal(res.body.aggregateReport.conclusion.keepExperimentalOnly, true);
      const json = JSON.stringify(res.body);
      assert.doesNotMatch(json, /\.env/i);
      assert.doesNotMatch(json, /API_KEY/i);
      assert.doesNotMatch(json, /sk-secret/i);
      assert.doesNotMatch(json, /[A-Z]:\\/);
      assert.doesNotMatch(json, /app\.sqlite/i);
      assert.doesNotMatch(json, /node_modules/i);
    });

  const after = await getTask('route-single-real-task');
  assert.deepEqual(after.generatedImages, before.generatedImages);
  assert.deepEqual(after.imagePlans, before.imagePlans);
});

test('POST /api/generate/three-sample enforces confirmation and sample limit', async () => {
  await createTask(task());

  await request(app)
    .post('/api/generate/three-sample')
    .send({
      taskId: 'route-single-real-task',
      confirmPaidApi: false,
      samples: [{ sampleId: 's1', imageType: 'main_image' }]
    })
    .expect(400);

  await request(app)
    .post('/api/generate/three-sample')
    .send({
      taskId: 'route-single-real-task',
      confirmPaidApi: true,
      samples: [
        { sampleId: 's1', imageType: 'main_image' },
        { sampleId: 's2', imageType: 'feature_image' },
        { sampleId: 's3', imageType: 'detail_image' },
        { sampleId: 's4', imageType: 'main_image' }
      ]
    })
    .expect(400);
});

test('GET /api/generate/:taskId/three-sample-report returns latest aggregate report', async () => {
  await createTask(task());
  await request(app)
    .post('/api/generate/three-sample')
    .send({
      taskId: 'route-single-real-task',
      confirmPaidApi: true,
      samples: [{ sampleId: 's1', imageType: 'main_image', imageId: 'source-1' }]
    })
    .expect(200);

  await request(app)
    .get('/api/generate/route-single-real-task/three-sample-report')
    .expect(200)
    .expect((res) => {
      assert.equal(res.body.report.taskId, 'route-single-real-task');
      assert.equal(res.body.report.latest.aggregateReport.meta.testMode, 'three-sample-real-generation');
    });
});
