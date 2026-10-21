import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import request from 'supertest';
import sharp from 'sharp';
import app from '../src/app.js';
import { paths, getBatchTask, getTask, readDb, resetDatabaseForTests, updateBatchTask, updateTask } from '../src/services/db.js';
import { cancelBatchQueue, pauseBatchQueue, retryFailedJobs, runBatchQueue } from '../src/services/batchQueueService.js';
import { computeBatchAnalytics } from '../src/services/batchAnalyticsService.js';
import { getProviderCostConfig } from '../src/config/providerCostConfig.js';
import { classifyError } from '../src/utils/errorClassifier.js';
import {
  applyTemplateToBatch,
  cloneTemplate,
  createUserTemplate,
  deleteUserTemplate,
  listTemplates
} from '../src/services/workflowTemplateService.js';

if (!process.env.CROSSBORDER_DATA_ROOT) throw new Error('端到端测试必须使用独立数据目录。请通过 npm test 运行。');
const rootDir = paths.rootDir;
const uploadDir = path.join(rootDir, 'uploads');
const outputDir = path.join(rootDir, 'outputs');

let sampleImagePath;
let sampleImagePathTwo;
let textFilePath;

function binaryParser(res, callback) {
  const chunks = [];
  res.on('data', (chunk) => chunks.push(chunk));
  res.on('end', () => callback(null, Buffer.concat(chunks)));
}

before(async () => {
  process.env.AI_PROVIDER = 'mock';
  process.env.VISION_PROVIDER = 'mock';
  await fs.rm(uploadDir, { recursive: true, force: true });
  await fs.rm(outputDir, { recursive: true, force: true });
  await fs.mkdir(path.join(os.tmpdir(), 'crossborder-image-agent-tests'), { recursive: true });
  sampleImagePath = path.join(os.tmpdir(), 'crossborder-image-agent-tests', 'sample-product.png');
  sampleImagePathTwo = path.join(os.tmpdir(), 'crossborder-image-agent-tests', 'sample-product-two.jpg');
  textFilePath = path.join(os.tmpdir(), 'crossborder-image-agent-tests', 'not-an-image.txt');
  await sharp({
    create: {
      width: 800,
      height: 800,
      channels: 3,
      background: '#f8fafc'
    }
  })
    .composite([
      {
        input: Buffer.from(
          '<svg width="800" height="800" xmlns="http://www.w3.org/2000/svg"><rect x="230" y="180" width="340" height="440" rx="36" fill="#38bdf8"/><text x="400" y="420" font-size="64" text-anchor="middle" fill="#0f172a">BOTTLE</text></svg>'
        )
      }
    ])
    .png()
    .toFile(sampleImagePath);
  await sharp({
    create: {
      width: 640,
      height: 640,
      channels: 3,
      background: '#ecfeff'
    }
  })
    .composite([
      {
        input: Buffer.from(
          '<svg width="640" height="640" xmlns="http://www.w3.org/2000/svg"><rect x="170" y="140" width="300" height="340" rx="28" fill="#14b8a6"/><text x="320" y="340" font-size="48" text-anchor="middle" fill="#0f172a">24 OZ</text></svg>'
        )
      }
    ])
    .jpeg()
    .toFile(sampleImagePathTwo);
  await fs.writeFile(textFilePath, 'not an image');
  await resetDatabaseForTests();
});

after(async () => {
  await fs.rm(uploadDir, { recursive: true, force: true });
  await fs.rm(outputDir, { recursive: true, force: true });
  await resetDatabaseForTests();
});

test('runs the complete single-product mock image workflow', async () => {
  const uploadResponse = await request(app)
    .post('/api/tasks/upload')
    .attach('image', sampleImagePath)
    .expect(201);

  const taskId = uploadResponse.body.task.id;
  assert.equal(uploadResponse.body.task.status, 'uploaded');
  assert.equal(uploadResponse.body.task.sourceImages.length, 1);
  assert.ok(taskId);

  await request(app)
    .post(`/api/tasks/${taskId}/image-plans`)
    .expect(409)
    .expect((res) => {
      assert.match(res.body.error, /requires task status/);
    });

  const recognizeResponse = await request(app)
    .post(`/api/tasks/${taskId}/recognize`)
    .expect(200);

  assert.equal(recognizeResponse.body.task.productInfoRaw.name, 'Insulated Stainless Steel Water Bottle');
  assert.equal(recognizeResponse.body.task.productInfo.language, 'English');
  assert.ok(recognizeResponse.body.task.visibleText.length >= 1);
  assert.ok(recognizeResponse.body.task.productInfoRaw.sellingPoints.length >= 3);

  await request(app)
    .patch(`/api/tasks/${taskId}/product`)
    .send({
      productInfo: {
        ...recognizeResponse.body.task.productInfo,
        color: 'Ocean Blue',
        sku: 'WB-OCEAN-001'
      }
    })
    .expect(200);

  await request(app)
    .post(`/api/tasks/${taskId}/platforms`)
    .send({ platform: 'Amazon', platformId: 'amazon', site: 'US', language: 'English', category: 'general' })
    .expect(200);

  const planResponse = await request(app)
    .post(`/api/tasks/${taskId}/image-plans`)
    .expect(200);

  assert.equal(planResponse.body.task.imagePlans.length, 8);
  assert.deepEqual(
    planResponse.body.task.imagePlans.map((plan) => plan.type),
    [
      'main_image',
      'feature_image',
      'size_image',
      'compatibility_image',
      'package_image',
      'lifestyle_image',
      'detail_image',
      'variant_image'
    ]
  );
  assert.ok(planResponse.body.task.imagePlans[0].targetId);
  assert.equal(planResponse.body.task.imagePlans[0].promptVersion, 'v1.5');
  assert.match(planResponse.body.task.imagePlans[0].prompt, /Amazon/);

  const editedPlanResponse = await request(app)
    .patch(`/api/tasks/${taskId}/image-plans/${planResponse.body.task.imagePlans[1].id}`)
    .send({
      title: 'Edited Feature Image',
      goal: 'Show confirmed backup benefit',
      textBlocks: [{ id: 'custom-1', label: 'Selling point', text: 'Fast file backup', sourceFields: ['sellingPoints'] }],
      riskWarnings: [{ field: 'sellingPoints', level: 'low', message: 'Confirmed copy' }]
    })
    .expect(200);

  assert.equal(editedPlanResponse.body.task.imagePlans[1].title, 'Edited Feature Image');
  assert.equal(editedPlanResponse.body.task.imagePlans[1].textBlocks[0].text, 'Fast file backup');

  const generateResponse = await request(app)
    .post(`/api/tasks/${taskId}/generate`)
    .expect(200);

  assert.equal(generateResponse.body.task.generatedImages.length, 8);
  for (const image of generateResponse.body.task.generatedImages) {
    const absolutePath = path.join(rootDir, image.filePath);
    const stats = await fs.stat(absolutePath);
    assert.ok(stats.size > 1000);
    assert.match(image.fileName, /^Amazon_WB-OCEAN-001_/);
    assert.equal(image.provider, 'mock');
    assert.equal(image.status, 'succeeded');
  }

  const reviewResponse = await request(app)
    .post(`/api/tasks/${taskId}/review`)
    .expect(200);

  assert.equal(reviewResponse.body.task.review.overallStatus, 'failed');
  assert.equal(reviewResponse.body.task.status, 'reviewed');
  assert.equal(reviewResponse.body.task.reviewResults.length, 8);
  assert.equal(reviewResponse.body.task.review.items.length, 8);
  assert.equal(reviewResponse.body.task.review.items[0].checks.noChinese.status, 'passed');
  assert.ok(reviewResponse.body.task.review.items[0].issues.some((issue) => issue.type === 'mock_preview'));

  const exportResponse = await request(app)
    .get(`/api/tasks/${taskId}/export`)
    .buffer(true)
    .parse(binaryParser)
    .expect(200)
    .expect('Content-Type', /zip/);

  assert.ok(exportResponse.body.length > 1000);

  const listResponse = await request(app).get('/api/tasks').expect(200);
  assert.equal(listResponse.body.tasks.length, 1);
  assert.equal(listResponse.body.tasks[0].id, taskId);
  assert.equal(listResponse.body.tasks[0].status, 'exported');
});

test('uploads multiple product images and keeps first image as originalImage', async () => {
  const uploadResponse = await request(app)
    .post('/api/tasks/upload')
    .attach('images', sampleImagePath)
    .attach('images', sampleImagePathTwo)
    .expect(201);

  const task = uploadResponse.body.task;
  assert.equal(task.status, 'uploaded');
  assert.equal(task.sourceImages.length, 2);
  assert.equal(task.originalImage.id, task.sourceImages[0].id);
  assert.equal(task.sourceImages[0].role, 'source');
  assert.equal(task.sourceImages[1].role, 'source');

  const recognizeResponse = await request(app)
    .post(`/api/tasks/${task.id}/recognize`)
    .expect(200);

  assert.equal(recognizeResponse.body.task.status, 'recognized');
  assert.ok(recognizeResponse.body.task.productInfoRaw.notes.some((note) => /2 source image/.test(note)));
});

test('stores readable display names for Chinese upload filenames', async () => {
  const uploadResponse = await request(app)
    .post('/api/tasks/upload')
    .attach('images', sampleImagePath, Buffer.from('主图1.png', 'utf8').toString('latin1'))
    .attach('images', sampleImagePathTwo, Buffer.from('尺寸图.png', 'utf8').toString('latin1'))
    .expect(201);

  const [first, second] = uploadResponse.body.task.sourceImages;
  assert.equal(first.originalName, '主图1.png');
  assert.equal(first.displayName, '主图1.png');
  assert.equal(second.originalName, '尺寸图.png');
  assert.equal(second.displayName, '尺寸图.png');
  assert.match(first.fileName, /^[0-9]+-[A-Za-z0-9_-]+\.(png|jpg|jpeg|webp)$/);
  assert.equal(uploadResponse.body.task.originalImage.displayName, '主图1.png');
});

test('rejects uploads with more than 15 images', async () => {
  const req = request(app).post('/api/tasks/upload');
  for (let i = 0; i < 16; i += 1) {
    req.attach('images', sampleImagePath);
  }
  await req
    .expect(400)
    .expect((res) => {
      assert.match(res.body.error, /最多只能上传 15 张商品图片|up to 15 images/i);
    });
});

test('rejects unsupported upload file formats', async () => {
  await request(app)
    .post('/api/tasks/upload')
    .attach('images', textFilePath)
    .expect(400)
    .expect((res) => {
      assert.match(res.body.error, /仅支持|Only image uploads|Unsupported/i);
    });
});

test('real vision provider failure does not advance task state or overwrite existing recognition data', async () => {
  process.env.VISION_PROVIDER = 'qwen';
  delete process.env.QWEN_API_KEY;

  const uploadResponse = await request(app)
    .post('/api/tasks/upload')
    .attach('image', sampleImagePath)
    .expect(201);

  const taskId = uploadResponse.body.task.id;
  await updateTask(taskId, () => ({
    productInfoRaw: { productName: 'Existing product' },
    productInfo: { productName: 'Existing product' }
  }));

  await request(app)
    .post(`/api/tasks/${taskId}/recognize`)
    .send({ confirmPaidApi: true })
    .expect(502)
    .expect((res) => {
      assert.equal(res.body.error.code, 'MISSING_API_KEY');
      assert.match(res.body.error.message, /QWEN_API_KEY/);
    });

  const task = await getTask(taskId);
  assert.equal(task.status, 'uploaded');
  assert.equal(task.productInfoRaw.productName, 'Existing product');

  process.env.VISION_PROVIDER = 'mock';
});

test('product confirmation does not copy inferredCandidates unless user puts them in the form', async () => {
  const uploadResponse = await request(app)
    .post('/api/tasks/upload')
    .attach('image', sampleImagePath)
    .expect(201);

  const taskId = uploadResponse.body.task.id;
  await request(app)
    .post(`/api/tasks/${taskId}/recognize`)
    .expect(200);

  await updateTask(taskId, () => ({
    inferredCandidates: [{ field: 'capacity', value: '5TB', reason: 'No visible text evidence' }]
  }));

  const response = await request(app)
    .patch(`/api/tasks/${taskId}/product`)
    .send({
      productInfo: {
        sku: 'NO-INFER-001',
        name: 'Manual Product',
        category: 'Storage',
        packageList: ['Drive'],
        sellingPoints: ['Portable'],
        capacity: ''
      }
    })
    .expect(200);

  assert.equal(response.body.task.productInfoConfirmed.capacity, '');
  assert.equal(response.body.task.inferredCandidates[0].value, '5TB');
});

test('returns structured platform rules for frontend platform selection', async () => {
  const response = await request(app)
    .get('/api/tasks/platform-rules')
    .expect(200);

  assert.ok(response.body.platforms.some((platform) => platform.platformId === 'amazon'));
  assert.ok(response.body.platforms.some((platform) => platform.platformId === 'rakuten'));
  assert.ok(response.body.platforms.some((platform) => platform.platformId === 'ozon'));
  assert.ok(response.body.imageTypes.includes('main_image'));
  assert.equal(response.body.rules.amazon.imageTypes.main_image.textAllowed, false);
});

test('saves multiple platform targets and generates per-target plans', async () => {
  const uploadResponse = await request(app)
    .post('/api/tasks/upload')
    .attach('image', sampleImagePath)
    .expect(201);
  const taskId = uploadResponse.body.task.id;
  const recognizeResponse = await request(app).post(`/api/tasks/${taskId}/recognize`).expect(200);
  await request(app)
    .patch(`/api/tasks/${taskId}/product`)
    .send({ productInfo: { ...recognizeResponse.body.task.productInfo, sku: 'MULTI-001', category: 'External SSD' } })
    .expect(200);

  const targetResponse = await request(app)
    .post(`/api/tasks/${taskId}/platforms`)
    .send({
      targets: [
        { platformId: 'amazon', site: 'US', language: 'English', categoryId: 'electronics_storage' },
        { platformId: 'temu', site: 'US', language: 'English', categoryId: 'electronics_storage' }
      ]
    })
    .expect(200);

  assert.equal(targetResponse.body.task.targets.length, 2);
  assert.equal(targetResponse.body.task.targets[0].platformId, 'amazon');
  assert.equal(targetResponse.body.task.targets[1].platformId, 'temu');

  const planResponse = await request(app).post(`/api/tasks/${taskId}/image-plans`).expect(200);
  assert.equal(planResponse.body.task.imagePlans.length, 16);
  assert.equal(planResponse.body.task.imagePlans.filter((plan) => plan.platformId === 'amazon').length, 8);
  assert.equal(planResponse.body.task.imagePlans.filter((plan) => plan.platformId === 'temu').length, 8);

  const generateResponse = await request(app).post(`/api/tasks/${taskId}/generate`).expect(200);
  assert.equal(generateResponse.body.task.generatedImages.length, 16);
  assert.ok(generateResponse.body.task.generatedImages.every((image) => image.targetId && image.platformId));

  const reviewResponse = await request(app).post(`/api/tasks/${taskId}/review`).expect(200);
  assert.equal(reviewResponse.body.task.reviewResults.length, 16);
  assert.ok(reviewResponse.body.task.reviewResults.every((item) => item.targetId && item.platformId));
});

test('updates one image plan and regenerates only its mock image version', async () => {
  const uploadResponse = await request(app)
    .post('/api/tasks/upload')
    .attach('image', sampleImagePath)
    .expect(201);
  const taskId = uploadResponse.body.task.id;

  const recognizeResponse = await request(app).post(`/api/tasks/${taskId}/recognize`).expect(200);
  await request(app)
    .patch(`/api/tasks/${taskId}/product`)
    .send({
      productInfo: {
        ...recognizeResponse.body.task.productInfo,
        sku: 'REGEN-001'
      }
    })
    .expect(200);
  await request(app)
    .post(`/api/tasks/${taskId}/platforms`)
    .send({ platform: 'Amazon', platformId: 'amazon', site: 'US', language: 'English', category: 'general' })
    .expect(200);
  const planResponse = await request(app).post(`/api/tasks/${taskId}/image-plans`).expect(200);
  const targetPlan = planResponse.body.task.imagePlans[2];
  const untouchedPlan = planResponse.body.task.imagePlans[0];

  const planEditResponse = await request(app)
    .post(`/api/tasks/${taskId}/plans/${targetPlan.id}`)
    .send({
      title: 'Edited Size Image',
      goal: 'Show confirmed size information',
      layout: 'Diagram with size callouts',
      textBlocks: [{ id: 'size-text-1', label: 'Size', text: 'Compact portable size', sourceFields: ['dimensions'] }],
      riskWarnings: [{ field: 'dimensions', level: 'medium', message: 'Need manual confirmation' }],
      complianceNotes: ['No Chinese text', 'Use confirmed specs only']
    })
    .expect(200);

  const editedTarget = planEditResponse.body.task.imagePlans.find((plan) => plan.id === targetPlan.id);
  const untouched = planEditResponse.body.task.imagePlans.find((plan) => plan.id === untouchedPlan.id);
  assert.equal(editedTarget.editedByUser, true);
  assert.ok(editedTarget.editedAt);
  assert.equal(editedTarget.version, 2);
  assert.equal(editedTarget.layout, 'Diagram with size callouts');
  assert.equal(editedTarget.complianceNotes[0], 'No Chinese text');
  assert.equal(untouched.version, 1);
  assert.equal(untouched.editedByUser, false);

  const generateResponse = await request(app).post(`/api/tasks/${taskId}/generate`).expect(200);
  const originalImages = generateResponse.body.task.generatedImages;
  const originalTargetImage = originalImages.find((image) => image.planId === targetPlan.id);
  const originalOtherImage = originalImages.find((image) => image.planId === untouchedPlan.id);
  assert.equal(originalTargetImage.version, 1);
  assert.ok(originalTargetImage.generatedAt);

  await request(app).post(`/api/tasks/${taskId}/review`).expect(200);

  const singleGenerateResponse = await request(app)
    .post(`/api/tasks/${taskId}/generate/${targetPlan.id}`)
    .expect(200);

  const regeneratedImages = singleGenerateResponse.body.task.generatedImages;
  const regeneratedTargetImage = regeneratedImages.find((image) => image.planId === targetPlan.id);
  const stillSameOtherImage = regeneratedImages.find((image) => image.planId === untouchedPlan.id);
  const staleReview = singleGenerateResponse.body.task.reviewResults.find((item) => item.imageId === originalTargetImage.id);

  assert.equal(regeneratedImages.length, originalImages.length);
  assert.equal(regeneratedTargetImage.version, 2);
  assert.ok(regeneratedTargetImage.regeneratedAt);
  assert.notEqual(regeneratedTargetImage.fileName, originalTargetImage.fileName);
  assert.equal(stillSameOtherImage.fileName, originalOtherImage.fileName);
  assert.equal(staleReview.stale, true);
  assert.match(staleReview.staleReason, /regenerated/i);
});

test('real background mode is limited to safe lifestyle images and falls back to mock on missing key', async () => {
  const previousEnv = {
    IMAGE_PROVIDER: process.env.IMAGE_PROVIDER,
    BACKGROUND_PROVIDER: process.env.BACKGROUND_PROVIDER,
    GEMINI_API_KEY: process.env.GEMINI_API_KEY,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY
  };
  process.env.IMAGE_PROVIDER = 'real';
  process.env.BACKGROUND_PROVIDER = 'openai';
  delete process.env.OPENAI_API_KEY;

  try {
    const uploadResponse = await request(app)
      .post('/api/tasks/upload')
      .attach('image', sampleImagePath)
      .expect(201);
    const taskId = uploadResponse.body.task.id;
    const recognizeResponse = await request(app).post(`/api/tasks/${taskId}/recognize`).expect(200);
    await request(app)
      .patch(`/api/tasks/${taskId}/product`)
      .send({
        productInfo: {
          ...recognizeResponse.body.task.productInfo,
          sku: 'REAL-BG-001'
        }
      })
      .expect(200);
    await request(app)
      .post(`/api/tasks/${taskId}/platforms`)
      .send({ platform: 'Amazon', platformId: 'amazon', site: 'US', language: 'English', category: 'general' })
      .expect(200);
    const planResponse = await request(app).post(`/api/tasks/${taskId}/image-plans`).expect(200);
    const mainPlan = planResponse.body.task.imagePlans.find((plan) => plan.type === 'main_image');
    const lifestylePlan = planResponse.body.task.imagePlans.find((plan) => plan.type === 'lifestyle_image');

    const skippedResponse = await request(app)
      .post(`/api/tasks/${taskId}/generate/${mainPlan.id}`)
      .send({ mode: 'real_background', confirmPaidApi: true })
      .expect(200);
    const skippedImage = skippedResponse.body.task.generatedImages.find((image) => image.planId === mainPlan.id);
    assert.equal(skippedImage.provider, 'mock');
    assert.equal(skippedImage.realGenerationSkipped, true);
    assert.match(skippedImage.skipReason, /lifestyle_image|background_replace/);

    const realTestResponse = await request(app)
      .post(`/api/tasks/${taskId}/generate/${mainPlan.id}`)
      .send({ mode: 'real-test', confirmPaidApi: true })
      .expect(200);
    const realTestImage = realTestResponse.body.task.generatedImages.find((image) => image.planId === mainPlan.id);
    assert.equal(realTestImage.fallbackToMock, true);
    assert.equal(realTestImage.isRealGenerated, false);
    assert.equal(realTestImage.realGenerationError.code, 'MISSING_API_KEY');

    const fallbackResponse = await request(app)
      .post(`/api/tasks/${taskId}/generate/${lifestylePlan.id}`)
      .send({ mode: 'real_background', realMode: 'text_to_image', confirmPaidApi: true })
      .expect(200);
    const fallbackImage = fallbackResponse.body.task.generatedImages.find((image) => image.planId === lifestylePlan.id);
    assert.equal(fallbackImage.provider, 'mock');
    assert.equal(fallbackImage.fallbackToMock, true);
    assert.equal(fallbackImage.isMockPreview, true);
    assert.equal(fallbackImage.isRealGenerated, false);
    assert.equal(fallbackImage.realGenerationError.code, 'MISSING_API_KEY');
    assert.match(fallbackImage.realGenerationError.message, /OPENAI_API_KEY/);
    assert.equal(fallbackImage.mode, 'background_replace');
    assert.equal(fallbackImage.generationStrategy.selectedMode, 'mock');
    assert.equal(fallbackImage.generationStrategy.recommendedMode, 'text_to_image');
    assert.equal(fallbackImage.preserveQuality.qualityLevel, 'unknown');
  } finally {
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value == null) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('updates lifestyle image reference and previews matting without changing task status', async () => {
  const uploadResponse = await request(app)
    .post('/api/tasks/upload')
    .attach('images', sampleImagePath)
    .attach('images', sampleImagePathTwo)
    .expect(201);
  const taskId = uploadResponse.body.task.id;

  const recognizeResponse = await request(app).post(`/api/tasks/${taskId}/recognize`).expect(200);
  await request(app)
    .patch(`/api/tasks/${taskId}/product`)
    .send({ productInfo: { ...recognizeResponse.body.task.productInfo, sku: 'REF-001' } })
    .expect(200);
  await request(app)
    .post(`/api/tasks/${taskId}/platforms`)
    .send({ platform: 'Amazon', platformId: 'amazon', site: 'US', language: 'English', category: 'general' })
    .expect(200);
  const planResponse = await request(app).post(`/api/tasks/${taskId}/image-plans`).expect(200);
  const lifestylePlan = planResponse.body.task.imagePlans.find((plan) => plan.type === 'lifestyle_image');
  const secondImage = planResponse.body.task.sourceImages[1];

  const referenceResponse = await request(app)
    .post(`/api/tasks/${taskId}/plans/${lifestylePlan.id}/reference`)
    .send({ sourceImageId: secondImage.id })
    .expect(200);
  const updatedPlan = referenceResponse.body.task.imagePlans.find((plan) => plan.id === lifestylePlan.id);
  assert.equal(updatedPlan.productReferenceOverride.sourceImageId, secondImage.id);
  assert.equal(updatedPlan.productReferenceOverride.setByUser, true);
  assert.equal(updatedPlan.editedByUser, true);
  assert.ok(updatedPlan.referenceEditedAt);
  assert.equal(referenceResponse.body.task.status, 'planned');

  await request(app)
    .post(`/api/tasks/${taskId}/plans/${lifestylePlan.id}/reference`)
    .send({ sourceImageId: 'not-from-task' })
    .expect(400);

  const previewResponse = await request(app)
    .post(`/api/tasks/${taskId}/plans/${lifestylePlan.id}/matting-preview`)
    .send({ sourceImageId: secondImage.id })
    .expect(200);
  assert.equal(previewResponse.body.task.status, 'planned');
  assert.equal(previewResponse.body.preview.sourceImageId, secondImage.id);
  assert.equal(previewResponse.body.preview.status, 'success');
  assert.ok(previewResponse.body.preview.subjectPng.previewUrl.startsWith('/outputs/'));
  assert.ok(previewResponse.body.preview.edgeQuality);
  assert.ok(Array.isArray(previewResponse.body.preview.warnings));

  const stored = await getTask(taskId);
  assert.equal(stored.status, 'planned');
  assert.equal(stored.imagePlans.find((plan) => plan.id === lifestylePlan.id).productReferenceOverride.sourceImageId, secondImage.id);
});

test('saves composite settings on one lifestyle plan without changing other plans', async () => {
  const uploadResponse = await request(app)
    .post('/api/tasks/upload')
    .attach('image', sampleImagePath)
    .expect(201);
  const taskId = uploadResponse.body.task.id;
  const recognizeResponse = await request(app).post(`/api/tasks/${taskId}/recognize`).expect(200);
  await request(app)
    .patch(`/api/tasks/${taskId}/product`)
    .send({ productInfo: { ...recognizeResponse.body.task.productInfo, sku: 'COMP-001' } })
    .expect(200);
  await request(app)
    .post(`/api/tasks/${taskId}/platforms`)
    .send({ platform: 'Amazon', platformId: 'amazon', site: 'US', language: 'English', category: 'general' })
    .expect(200);
  const planResponse = await request(app).post(`/api/tasks/${taskId}/image-plans`).expect(200);
  const lifestylePlan = planResponse.body.task.imagePlans.find((plan) => plan.type === 'lifestyle_image');
  const mainPlan = planResponse.body.task.imagePlans.find((plan) => plan.type === 'main_image');

  const response = await request(app)
    .post(`/api/tasks/${taskId}/plans/${lifestylePlan.id}`)
    .send({
      compositeSettings: {
        placement: 'right',
        scale: 0.66,
        offsetX: 80,
        shadowEnabled: true,
        edgeFeather: 2,
        colorMatch: 'basic'
      }
    })
    .expect(200);

  const updatedLifestyle = response.body.task.imagePlans.find((plan) => plan.id === lifestylePlan.id);
  const untouchedMain = response.body.task.imagePlans.find((plan) => plan.id === mainPlan.id);

  assert.equal(updatedLifestyle.compositeSettings.placement, 'right');
  assert.equal(updatedLifestyle.compositeSettings.scale, 0.66);
  assert.equal(updatedLifestyle.editedByUser, true);
  assert.equal(untouchedMain.compositeSettings, undefined);
});

test('saves and restores text layout override for one programmatic plan', async () => {
  const uploadResponse = await request(app)
    .post('/api/tasks/upload')
    .attach('image', sampleImagePath)
    .expect(201);
  const taskId = uploadResponse.body.task.id;
  const recognizeResponse = await request(app).post(`/api/tasks/${taskId}/recognize`).expect(200);
  await request(app)
    .patch(`/api/tasks/${taskId}/product`)
    .send({ productInfo: { ...recognizeResponse.body.task.productInfo, sku: 'LAYOUT-001' } })
    .expect(200);
  await request(app)
    .post(`/api/tasks/${taskId}/platforms`)
    .send({ platform: 'Amazon', platformId: 'amazon', site: 'US', language: 'English', category: 'general' })
    .expect(200);
  const planResponse = await request(app).post(`/api/tasks/${taskId}/image-plans`).expect(200);
  const featurePlan = planResponse.body.task.imagePlans.find((plan) => plan.type === 'feature_image');
  const mainPlan = planResponse.body.task.imagePlans.find((plan) => plan.type === 'main_image');

  const saveResponse = await request(app)
    .post(`/api/tasks/${taskId}/plans/${featurePlan.id}/text-layout`)
    .send({
      textLayoutOverride: {
        layoutVersion: 'v2.9',
        textElements: [
          { id: 'headline', text: 'Custom Feature Headline', x: 180, y: 140, width: 1000, height: 90, fontSize: 54 }
        ],
        iconElements: [],
        lineElements: []
      }
    })
    .expect(200);

  const updatedFeature = saveResponse.body.task.imagePlans.find((plan) => plan.id === featurePlan.id);
  assert.equal(updatedFeature.textLayoutOverride.layoutSource, 'user_override');
  assert.equal(updatedFeature.textLayoutOverride.layoutEditedByUser, true);
  assert.equal(updatedFeature.textLayoutOverride.textElements[0].text, 'Custom Feature Headline');

  await request(app)
    .post(`/api/tasks/${taskId}/plans/${mainPlan.id}/text-layout`)
    .send({ textLayoutOverride: { textElements: [] } })
    .expect(400);

  const restoreResponse = await request(app)
    .delete(`/api/tasks/${taskId}/plans/${featurePlan.id}/text-layout`)
    .expect(200);
  const restoredFeature = restoreResponse.body.task.imagePlans.find((plan) => plan.id === featurePlan.id);
  assert.equal(restoredFeature.textLayoutOverride, undefined);
  assert.equal(restoredFeature.textLayout.layoutSource, 'auto');
});

async function writeBatchSampleImage(filePath, label = 'SKU') {
  await sharp({
    create: {
      width: 420,
      height: 420,
      channels: 3,
      background: '#f8fafc'
    }
  })
    .composite([
      {
        input: Buffer.from(`<svg width="420" height="420" xmlns="http://www.w3.org/2000/svg"><rect x="90" y="120" width="240" height="180" rx="20" fill="#38bdf8"/><text x="210" y="220" font-size="42" text-anchor="middle" fill="#0f172a">${label}</text></svg>`)
      }
    ])
    .png()
    .toFile(filePath);
}

async function createBatchImportFolder() {
  const batchRoot = path.join(os.tmpdir(), `crossborder-batch-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  await fs.mkdir(path.join(batchRoot, 'sku001-hard-drive'), { recursive: true });
  await fs.mkdir(path.join(batchRoot, 'empty-sku'), { recursive: true });
  await fs.mkdir(path.join(batchRoot, 'too-many-images'), { recursive: true });
  await writeBatchSampleImage(path.join(batchRoot, 'sku001-hard-drive', '01-main.png'), 'SSD');
  await writeBatchSampleImage(path.join(batchRoot, 'sku001-hard-drive', '02-size.png'), '1TB');
  await fs.writeFile(path.join(batchRoot, 'sku001-hard-drive', 'readme.txt'), 'skip me');
  for (let index = 1; index <= 16; index += 1) {
    await writeBatchSampleImage(path.join(batchRoot, 'too-many-images', `${String(index).padStart(2, '0')}.png`), 'X');
  }
  return batchRoot;
}

test('imports a local folder into a batch task and creates one task per valid SKU folder', async () => {
  const batchRoot = await createBatchImportFolder();
  try {
    const response = await request(app)
      .post('/api/batches/import-folder')
      .send({
        folderPath: batchRoot,
        name: 'Hard drive batch',
        defaultTargets: [{ platformId: 'amazon', site: 'US', language: 'English', categoryId: 'electronics_storage' }]
      })
      .expect(201);

    const { batchTask, createdTasks } = response.body;
    assert.equal(batchTask.status, 'imported');
    assert.equal(createdTasks.length, 1);
    assert.equal(batchTask.skuTasks.length, 3);
    const validSku = batchTask.skuTasks.find((sku) => sku.skuId === 'sku001-hard-drive');
    assert.equal(validSku.imageCount, 2);
    assert.equal(validSku.status, 'uploaded');
    assert.ok(validSku.warnings.some((warning) => warning.code === 'UNSUPPORTED_FILE_SKIPPED'));
    assert.equal(batchTask.skuTasks.find((sku) => sku.skuId === 'empty-sku').status, 'failed');
    assert.equal(batchTask.skuTasks.find((sku) => sku.skuId === 'too-many-images').error.code, 'TOO_MANY_IMAGES');
  } finally {
    await fs.rm(batchRoot, { recursive: true, force: true });
  }
});

test('scans import root, imports selected new SKU folders, and marks them imported', async () => {
  const batchRoot = await createBatchImportFolder();
  const previous = {
    enabled: process.env.IMPORT_SCAN_ENABLED,
    root: process.env.IMPORT_ROOT_DIR,
    maxDepth: process.env.IMPORT_SCAN_MAX_DEPTH,
    maxSku: process.env.IMPORT_SCAN_MAX_SKU
  };
  try {
    process.env.IMPORT_SCAN_ENABLED = 'true';
    process.env.IMPORT_ROOT_DIR = batchRoot;
    process.env.IMPORT_SCAN_MAX_DEPTH = '2';
    process.env.IMPORT_SCAN_MAX_SKU = '200';

    const statusResponse = await request(app)
      .get('/api/import-scan/status')
      .expect(200);
    assert.equal(statusResponse.body.enabled, true);
    assert.equal(statusResponse.body.validRoot, true);

    const scanResponse = await request(app)
      .post('/api/import-scan/scan')
      .send({})
      .expect(200);

    const candidates = scanResponse.body.candidates;
    const valid = candidates.find((candidate) => candidate.skuId === 'sku001-hard-drive');
    const empty = candidates.find((candidate) => candidate.skuId === 'empty-sku');
    const tooMany = candidates.find((candidate) => candidate.skuId === 'too-many-images');
    assert.equal(valid.status, 'new');
    assert.equal(valid.imageCount, 2);
    assert.ok(valid.warnings.some((warning) => warning.code === 'NON_IMAGE_FILE_SKIPPED'));
    assert.equal(empty.status, 'empty');
    assert.equal(tooMany.status, 'too_many_images');

    const importResponse = await request(app)
      .post('/api/import-scan/import')
      .send({
        folderPaths: [valid.folderPath, empty.folderPath],
        batchName: 'Scanned batch',
        defaultTargets: [{ platformId: 'amazon', site: 'US', language: 'English', categoryId: 'electronics_storage' }]
      })
      .expect(201);

    assert.equal(importResponse.body.createdTasks.length, 1);
    assert.equal(importResponse.body.batchTask.status, 'imported');
    assert.equal(importResponse.body.batchTask.skuTasks.length, 1);
    assert.equal(importResponse.body.batchTask.skuTasks[0].status, 'uploaded');
    assert.ok(importResponse.body.skippedCandidates.some((candidate) => candidate.status === 'empty'));

    const task = await getTask(importResponse.body.createdTasks[0].id);
    assert.equal(task.status, 'uploaded');
    assert.equal(task.recognitionMeta, undefined);

    const db = await readDb();
    assert.ok(db.importedFolders.some((record) => record.folderPath === valid.folderPath));

    const rescanResponse = await request(app)
      .post('/api/import-scan/scan')
      .send({})
      .expect(200);
    assert.equal(rescanResponse.body.candidates.find((candidate) => candidate.skuId === 'sku001-hard-drive').status, 'imported');
  } finally {
    if (previous.enabled === undefined) delete process.env.IMPORT_SCAN_ENABLED; else process.env.IMPORT_SCAN_ENABLED = previous.enabled;
    if (previous.root === undefined) delete process.env.IMPORT_ROOT_DIR; else process.env.IMPORT_ROOT_DIR = previous.root;
    if (previous.maxDepth === undefined) delete process.env.IMPORT_SCAN_MAX_DEPTH; else process.env.IMPORT_SCAN_MAX_DEPTH = previous.maxDepth;
    if (previous.maxSku === undefined) delete process.env.IMPORT_SCAN_MAX_SKU; else process.env.IMPORT_SCAN_MAX_SKU = previous.maxSku;
    await fs.rm(batchRoot, { recursive: true, force: true });
  }
});

test('import scan status handles disabled config and rejects paths outside the safe root', async () => {
  const batchRoot = await createBatchImportFolder();
  const outsideRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'crossborder-outside-'));
  const previous = {
    enabled: process.env.IMPORT_SCAN_ENABLED,
    root: process.env.IMPORT_ROOT_DIR
  };
  try {
    process.env.IMPORT_SCAN_ENABLED = 'false';
    process.env.IMPORT_ROOT_DIR = batchRoot;
    const disabledResponse = await request(app)
      .get('/api/import-scan/status')
      .expect(200);
    assert.equal(disabledResponse.body.enabled, false);

    process.env.IMPORT_SCAN_ENABLED = 'true';
    await request(app)
      .post('/api/import-scan/scan')
      .send({ rootDir: outsideRoot })
      .expect(400)
      .expect((res) => {
        assert.equal(res.body.error.code, 'IMPORT_PATH_OUTSIDE_ROOT');
      });
  } finally {
    if (previous.enabled === undefined) delete process.env.IMPORT_SCAN_ENABLED; else process.env.IMPORT_SCAN_ENABLED = previous.enabled;
    if (previous.root === undefined) delete process.env.IMPORT_ROOT_DIR; else process.env.IMPORT_ROOT_DIR = previous.root;
    await fs.rm(batchRoot, { recursive: true, force: true });
    await fs.rm(outsideRoot, { recursive: true, force: true });
  }
});

test('workflow templates list clone sanitize and apply to batch without starting queue', async () => {
  const batchRoot = await createBatchImportFolder();
  const previousGeminiKey = process.env.GEMINI_API_KEY;
  try {
    delete process.env.GEMINI_API_KEY;
    const templates = await listTemplates();
    assert.ok(templates.some((template) => template.id === 'mock_preview_all_platforms'));
    assert.ok(templates.some((template) => template.id === 'hard_drive_multi_platform_balanced'));

    const templateListResponse = await request(app)
      .get('/api/workflow-templates')
      .expect(200);
    assert.ok(templateListResponse.body.templates.some((template) => template.id === 'real_lifestyle_test'));

    await assert.rejects(
      () => deleteUserTemplate('mock_preview_all_platforms'),
      /cannot be deleted/i
    );

    const cloned = await cloneTemplate('mock_preview_all_platforms');
    assert.equal(cloned.isSystemTemplate, false);
    assert.match(cloned.name, /Copy$/);

    const created = await createUserTemplate({
      name: 'Custom template with secret',
      defaultTargets: [{ platformId: 'amazon', site: 'US', language: 'English', categoryId: 'general' }],
      providers: { visionProvider: 'mock', imageProvider: 'mock', reviewProvider: 'mock' },
      apiKey: 'must-not-save',
      nested: { secretToken: 'must-not-save' }
    });
    assert.equal(created.apiKey, undefined);
    assert.equal(created.nested?.secretToken, undefined);

    const importResponse = await request(app)
      .post('/api/batches/import-folder')
      .send({ folderPath: batchRoot, name: 'Template batch' })
      .expect(201);
    const batchId = importResponse.body.batchTask.id;

    const applyResponse = await request(app)
      .post(`/api/batches/${batchId}/apply-template`)
      .send({ templateId: 'hard_drive_multi_platform_balanced' })
      .expect(200);

    assert.equal(applyResponse.body.batchTask.defaultTargets.length, 5);
    assert.equal(applyResponse.body.batchTask.workflowTemplateSnapshot.id, 'hard_drive_multi_platform_balanced');
    assert.equal(applyResponse.body.batchTask.queue.concurrency, 2);
    assert.notEqual(applyResponse.body.batchTask.queue.status, 'running');
    assert.equal(applyResponse.body.batchTask.locks?.isRunning || false, false);
    assert.ok(applyResponse.body.warnings.some((warning) => warning.envName === 'GEMINI_API_KEY'));

    const analytics = await computeBatchAnalytics(await getBatchTask(batchId));
    assert.equal(analytics.templateId, 'hard_drive_multi_platform_balanced');
    assert.equal(analytics.templateName, '移动硬盘多平台 balanced');
  } finally {
    if (previousGeminiKey === undefined) delete process.env.GEMINI_API_KEY; else process.env.GEMINI_API_KEY = previousGeminiKey;
    await fs.rm(batchRoot, { recursive: true, force: true });
  }
});

test('import scan can apply a workflow template while creating a batch', async () => {
  const batchRoot = await createBatchImportFolder();
  const previous = {
    enabled: process.env.IMPORT_SCAN_ENABLED,
    root: process.env.IMPORT_ROOT_DIR,
    maxDepth: process.env.IMPORT_SCAN_MAX_DEPTH,
    maxSku: process.env.IMPORT_SCAN_MAX_SKU
  };
  try {
    process.env.IMPORT_SCAN_ENABLED = 'true';
    process.env.IMPORT_ROOT_DIR = batchRoot;
    process.env.IMPORT_SCAN_MAX_DEPTH = '1';
    process.env.IMPORT_SCAN_MAX_SKU = '20';
    const scanResponse = await request(app)
      .post('/api/import-scan/scan')
      .send({})
      .expect(200);
    const folders = scanResponse.body.candidates
      .filter((candidate) => candidate.status === 'new')
      .map((candidate) => candidate.folderPath);

    const importResponse = await request(app)
      .post('/api/import-scan/import')
      .send({
        folderPaths: folders,
        batchName: 'Template scan import',
        templateId: 'mock_preview_all_platforms'
      })
      .expect(201);

    assert.equal(importResponse.body.batchTask.workflowTemplateSnapshot.id, 'mock_preview_all_platforms');
    assert.equal(importResponse.body.batchTask.defaultTargets.length, 3);
    assert.equal(importResponse.body.batchTask.queue.status, 'idle');
  } finally {
    if (previous.enabled === undefined) delete process.env.IMPORT_SCAN_ENABLED; else process.env.IMPORT_SCAN_ENABLED = previous.enabled;
    if (previous.root === undefined) delete process.env.IMPORT_ROOT_DIR; else process.env.IMPORT_ROOT_DIR = previous.root;
    if (previous.maxDepth === undefined) delete process.env.IMPORT_SCAN_MAX_DEPTH; else process.env.IMPORT_SCAN_MAX_DEPTH = previous.maxDepth;
    if (previous.maxSku === undefined) delete process.env.IMPORT_SCAN_MAX_SKU; else process.env.IMPORT_SCAN_MAX_SKU = previous.maxSku;
    await fs.rm(batchRoot, { recursive: true, force: true });
  }
});

test('batch analytics compute provider usage image sources review risks duration and estimated cost', async () => {
  const batchRoot = await createBatchImportFolder();
  const previousCost = {
    vision: process.env.COST_VISION_GEMINI_PER_CALL,
    image: process.env.COST_IMAGE_OPENAI_PER_CALL,
    review: process.env.COST_REVIEW_GEMINI_PER_CALL,
    matting: process.env.COST_MATTING_EXTERNAL_PER_CALL
  };
  try {
    process.env.COST_VISION_GEMINI_PER_CALL = '0.10';
    process.env.COST_IMAGE_OPENAI_PER_CALL = '0.50';
    process.env.COST_REVIEW_GEMINI_PER_CALL = '0.20';
    process.env.COST_MATTING_EXTERNAL_PER_CALL = '0.05';
    const importResponse = await request(app)
      .post('/api/batches/import-folder')
      .send({ folderPath: batchRoot, name: 'Analytics batch' })
      .expect(201);
    const batchId = importResponse.body.batchTask.id;
    const validSku = importResponse.body.batchTask.skuTasks.find((sku) => sku.taskId);
    await updateTask(validSku.taskId, () => ({
      status: 'reviewed',
      recognitionMeta: { provider: 'gemini', model: 'gemini-2.5-flash', durationMs: 1200, status: 'success' },
      generatedImages: [
        { id: 'img-mock', planId: 'plan-1', type: 'main_image', provider: 'mock', isMockPreview: true, isRealGenerated: false, durationMs: 50 },
        { id: 'img-real', planId: 'plan-2', type: 'lifestyle_image', provider: 'openai', model: 'gpt-image-2', isMockPreview: false, isRealGenerated: true, fallbackToMock: false, durationMs: 2000, mattingProvider: 'external', mattingModel: 'matting-v1' },
        { id: 'img-fallback', planId: 'plan-3', type: 'feature_image', provider: 'mock', isMockPreview: true, isRealGenerated: false, fallbackToMock: true, durationMs: 80 }
      ],
      reviewResults: [
        { id: 'rev-1', imageId: 'img-real', provider: 'gemini', model: 'gemini-2.5-flash', pass: false, riskLevel: 'high', isRealReview: true, durationMs: 600 },
        { id: 'rev-2', imageId: 'img-mock', provider: 'mock', pass: true, riskLevel: 'low', isRealReview: false, durationMs: 20 }
      ]
    }));
    await updateBatchTask(batchId, (current) => ({
      skuTasks: current.skuTasks.map((sku) => sku.taskId === validSku.taskId ? { ...sku, status: 'reviewed', queueStatus: 'completed' } : sku),
      executionLogs: [
        { id: 'log-a', skuId: validSku.skuId, durationMs: 1000 },
        { id: 'log-b', skuId: validSku.skuId, durationMs: 2000 }
      ]
    }));
    const analytics = await computeBatchAnalytics(await getBatchTask(batchId));
    assert.equal(analytics.sku.total, 3);
    assert.equal(analytics.sku.failed, 2);
    assert.equal(analytics.images.totalGenerated, 3);
    assert.equal(analytics.images.mockPreviewCount, 2);
    assert.equal(analytics.images.realGeneratedCount, 1);
    assert.equal(analytics.images.fallbackMockCount, 1);
    assert.equal(analytics.review.highRiskCount, 1);
    assert.equal(analytics.providers.vision.gemini.calls, 1);
    assert.equal(analytics.providers.image.openai.calls, 1);
    assert.equal(analytics.providers.review.gemini.calls, 1);
    assert.equal(analytics.providers.matting.external.calls, 1);
    assert.equal(analytics.duration.totalMs, 3000);
    assert.equal(analytics.cost.byAction.vision, 0.1);
    assert.equal(analytics.cost.byAction.image, 0.5);
    assert.equal(analytics.cost.byAction.review, 0.2);
    assert.equal(analytics.cost.byAction.matting, 0.05);
    assert.equal(analytics.failureSummary.totalFailed, 2);
    assert.ok(analytics.warnings.some((warning) => warning.code === 'FALLBACK_MOCK'));

    const refreshResponse = await request(app)
      .post(`/api/batches/${batchId}/analytics/refresh`)
      .expect(200);
    assert.equal(refreshResponse.body.analytics.images.realGeneratedCount, 1);

    const getResponse = await request(app)
      .get(`/api/batches/${batchId}/analytics`)
      .expect(200);
    assert.equal(getResponse.body.analytics.providers.image.openai.calls, 1);

    const summaryResponse = await request(app)
      .get('/api/batches/analytics/summary')
      .expect(200);
    assert.ok(summaryResponse.body.batchCount >= 1);
    assert.ok(summaryResponse.body.estimatedTotalCost >= 0.85);

    const exportResponse = await request(app)
      .get(`/api/batches/${batchId}/analytics/export`)
      .expect(200);
    assert.equal(exportResponse.body.analytics.images.fallbackMockCount, 1);
  } finally {
    if (previousCost.vision === undefined) delete process.env.COST_VISION_GEMINI_PER_CALL; else process.env.COST_VISION_GEMINI_PER_CALL = previousCost.vision;
    if (previousCost.image === undefined) delete process.env.COST_IMAGE_OPENAI_PER_CALL; else process.env.COST_IMAGE_OPENAI_PER_CALL = previousCost.image;
    if (previousCost.review === undefined) delete process.env.COST_REVIEW_GEMINI_PER_CALL; else process.env.COST_REVIEW_GEMINI_PER_CALL = previousCost.review;
    if (previousCost.matting === undefined) delete process.env.COST_MATTING_EXTERNAL_PER_CALL; else process.env.COST_MATTING_EXTERNAL_PER_CALL = previousCost.matting;
    await fs.rm(batchRoot, { recursive: true, force: true });
  }
});

test('provider cost config defaults to zero and reads environment overrides', () => {
  const previous = process.env.COST_IMAGE_OPENAI_PER_CALL;
  try {
    delete process.env.COST_IMAGE_OPENAI_PER_CALL;
    assert.equal(getProviderCostConfig().image.openai.perCall, 0);
    process.env.COST_IMAGE_OPENAI_PER_CALL = '1.25';
    assert.equal(getProviderCostConfig().image.openai.perCall, 1.25);
  } finally {
    if (previous === undefined) delete process.env.COST_IMAGE_OPENAI_PER_CALL; else process.env.COST_IMAGE_OPENAI_PER_CALL = previous;
  }
});

test('errorClassifier maps common batch failures to retry and user action policies', () => {
  assert.deepEqual(
    {
      category: classifyError(Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }), { action: 'recognize' }).errorCategory,
      retryable: classifyError(Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }), { action: 'recognize' }).retryable
    },
    { category: 'timeout', retryable: true }
  );
  const missingKey = classifyError(Object.assign(new Error('Missing API key'), { code: 'MISSING_API_KEY' }), { action: 'recognize' });
  assert.equal(missingKey.errorCategory, 'config');
  assert.equal(missingKey.userActionType, 'provide_key');
  assert.equal(missingKey.retryable, false);
  const rateLimit = classifyError({ statusCode: 429, message: 'rate limit exceeded' }, { action: 'review' });
  assert.equal(rateLimit.errorCode, 'PROVIDER_RATE_LIMIT');
  assert.equal(rateLimit.retryable, true);
  const quota = classifyError(new Error('insufficient_quota billing'), { action: 'generate' });
  assert.equal(quota.errorCode, 'PROVIDER_QUOTA_EXCEEDED');
  assert.equal(quota.requiresUserAction, true);
  const invalidState = classifyError(new Error('requires task status confirmed'), { action: 'plan' });
  assert.equal(invalidState.errorCategory, 'state');
  assert.equal(invalidState.retryable, false);
});

test('runs batch recognize apply-targets plan generate review and export without blocking on failed SKUs', async () => {
  const batchRoot = await createBatchImportFolder();
  try {
    const importResponse = await request(app)
      .post('/api/batches/import-folder')
      .send({
        folderPath: batchRoot,
        name: 'Batch flow',
        defaultTargets: [{ platformId: 'amazon', site: 'US', language: 'English', categoryId: 'electronics_storage' }]
      })
      .expect(201);
    const batchId = importResponse.body.batchTask.id;
    const validSku = importResponse.body.batchTask.skuTasks.find((sku) => sku.taskId);

    const recognizeResponse = await request(app)
      .post(`/api/batches/${batchId}/recognize`)
      .expect(200);
    assert.ok(recognizeResponse.body.results.some((item) => item.taskId === validSku.taskId && item.success));
    assert.ok(recognizeResponse.body.results.some((item) => item.skipped));

    const recognizedTask = await getTask(validSku.taskId);
    await updateTask(validSku.taskId, () => ({
      productInfoConfirmed: {
        ...recognizedTask.productInfo,
        name: recognizedTask.productInfo?.name || 'Portable External SSD',
        sku: 'SKU001',
        category: 'external SSD',
        packageIncluded: ['SSD', 'USB-C cable'],
        sellingPoints: ['Portable storage']
      },
      productInfo: {
        ...recognizedTask.productInfo,
        name: recognizedTask.productInfo?.name || 'Portable External SSD',
        sku: 'SKU001',
        category: 'external SSD',
        packageIncluded: ['SSD', 'USB-C cable'],
        sellingPoints: ['Portable storage']
      },
      status: 'confirmed'
    }));

    const targets = [
      { platformId: 'amazon', site: 'US', language: 'English', categoryId: 'electronics_storage' },
      { platformId: 'temu', site: 'US', language: 'English', categoryId: 'electronics_storage' }
    ];
    const targetsResponse = await request(app)
      .post(`/api/batches/${batchId}/apply-targets`)
      .send({ defaultTargets: targets })
      .expect(200);
    assert.ok(targetsResponse.body.results.some((item) => item.success));

    const planResponse = await request(app)
      .post(`/api/batches/${batchId}/plan`)
      .expect(200);
    assert.equal(planResponse.body.results.find((item) => item.taskId === validSku.taskId).success, true);
    const plannedTask = await getTask(validSku.taskId);
    assert.equal(plannedTask.imagePlans.length, 16);

    await request(app).post(`/api/batches/${batchId}/generate`).send({ mode: 'mock' }).expect(200);
    const generatedTask = await getTask(validSku.taskId);
    assert.equal(generatedTask.generatedImages.length, 16);

    await request(app).post(`/api/batches/${batchId}/review`).send({ mode: 'mock' }).expect(200);
    const reviewedTask = await getTask(validSku.taskId);
    assert.equal(reviewedTask.reviewResults.length, 16);

    const exportResponse = await request(app)
      .get(`/api/batches/${batchId}/export`)
      .buffer(true)
      .parse(binaryParser)
      .expect(200);
    assert.ok(exportResponse.body.length > 0);

    const listResponse = await request(app).get('/api/batches').expect(200);
    assert.ok(listResponse.body.batchTasks.some((batch) => batch.id === batchId));
  } finally {
    await fs.rm(batchRoot, { recursive: true, force: true });
  }
});

async function importQueueBatch() {
  const batchRoot = await createBatchImportFolder();
  const importResponse = await request(app)
    .post('/api/batches/import-folder')
    .send({
      folderPath: batchRoot,
      name: 'Queue batch',
      defaultTargets: [{ platformId: 'amazon', site: 'US', language: 'English', categoryId: 'electronics_storage' }]
    })
    .expect(201);
  return { batchRoot, batchId: importResponse.body.batchTask.id, batchTask: importResponse.body.batchTask };
}

test('runBatchQueue processes SKU jobs with capped concurrency and execution logs', async () => {
  const { batchRoot, batchId } = await importQueueBatch();
  const originalMax = process.env.BATCH_MAX_CONCURRENCY;
  try {
    process.env.BATCH_MAX_CONCURRENCY = '2';
    await runBatchQueue({ batchId, action: 'recognize', concurrency: 9, waitForCompletion: true });
    const batch = await getBatchTask(batchId);
    assert.equal(batch.queue.concurrency, 2);
    assert.equal(batch.queue.status, 'completed');
    assert.ok(batch.queue.skippedJobs > 0);
    assert.ok(batch.executionLogs.some((log) => log.message.includes('开始批量recognize')));
    assert.ok(batch.executionLogs.length <= 500);
    const validSku = batch.skuTasks.find((sku) => sku.taskId);
    assert.equal(validSku.queueStatus, 'completed');
  } finally {
    process.env.BATCH_MAX_CONCURRENCY = originalMax;
    await fs.rm(batchRoot, { recursive: true, force: true });
  }
});

test('runBatchQueue prepare waits for human confirmation and only then continues confirmed SKUs to planning', async () => {
  const batchRoot = path.join(os.tmpdir(), `crossborder-prepare-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  await fs.mkdir(path.join(batchRoot, 'sku001-hard-drive'), { recursive: true });
  await fs.mkdir(path.join(batchRoot, 'sku002-hard-drive'), { recursive: true });
  await fs.mkdir(path.join(batchRoot, 'empty-sku'), { recursive: true });
  await writeBatchSampleImage(path.join(batchRoot, 'sku001-hard-drive', '01-main.png'), 'SSD1');
  await writeBatchSampleImage(path.join(batchRoot, 'sku002-hard-drive', '01-main.png'), 'SSD2');
  try {
    const importResponse = await request(app)
      .post('/api/batches/import-folder')
      .send({
        folderPath: batchRoot,
        name: 'Prepare batch',
        defaultTargets: [
          { platformId: 'amazon', site: 'US', language: 'English', categoryId: 'electronics_storage' }
        ]
      })
      .expect(201);
    const batchId = importResponse.body.batchTask.id;

    await runBatchQueue({ batchId, action: 'prepare', concurrency: 1, waitForCompletion: true });

    const batch = await getBatchTask(batchId);
    const validSkus = batch.skuTasks.filter((sku) => sku.taskId);
    assert.equal(validSkus.length, 2);
    assert.ok(validSkus.every((sku) => sku.status === 'recognized' && sku.currentStep === 'waiting_confirm'));
    assert.ok(validSkus.every((sku) => sku.queueStatus === 'completed'));
    assert.ok(batch.skuTasks.some((sku) => sku.status === 'failed'));
    for (const sku of validSkus) {
      const task = await getTask(sku.taskId);
      assert.equal(task.status, 'recognized');
      assert.equal(task.productInfoConfirmed, null);
      assert.equal(task.imagePlans.length, 0);
      await request(app).patch(`/api/tasks/${sku.taskId}/product`).send({ productInfo: task.productInfo }).expect(200);
    }
    await runBatchQueue({ batchId, action: 'prepare', concurrency: 1, waitForCompletion: true });
    for (const sku of validSkus) {
      const task = await getTask(sku.taskId);
      assert.equal(task.status, 'planned');
      assert.ok(task.productInfoConfirmed?.name);
      assert.ok(task.targets?.length >= 1);
      assert.ok(task.imagePlans?.length >= 8);
    }
  } finally {
    await fs.rm(batchRoot, { recursive: true, force: true });
  }
});

test('runBatchQueue generate creates tracked images for every plan of every planned SKU', async () => {
  const batchRoot = path.join(os.tmpdir(), `crossborder-generate-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  await fs.mkdir(path.join(batchRoot, 'sku001-hard-drive'), { recursive: true });
  await fs.mkdir(path.join(batchRoot, 'sku002-hard-drive'), { recursive: true });
  await writeBatchSampleImage(path.join(batchRoot, 'sku001-hard-drive', '01-main.png'), 'SSD1');
  await writeBatchSampleImage(path.join(batchRoot, 'sku002-hard-drive', '01-main.png'), 'SSD2');
  try {
    const importResponse = await request(app)
      .post('/api/batches/import-folder')
      .send({
        folderPath: batchRoot,
        name: 'Generate batch',
        defaultTargets: [
          { platformId: 'amazon', site: 'US', language: 'English', categoryId: 'electronics_storage' }
        ]
      })
      .expect(201);
    const batchId = importResponse.body.batchTask.id;

    await runBatchQueue({ batchId, action: 'prepare', concurrency: 1, waitForCompletion: true });
    for (const sku of (await getBatchTask(batchId)).skuTasks.filter(item => item.taskId)) {
      const current = await getTask(sku.taskId);
      await request(app).patch(`/api/tasks/${sku.taskId}/product`).send({ productInfo: current.productInfo }).expect(200);
    }
    await runBatchQueue({ batchId, action: 'prepare', concurrency: 1, waitForCompletion: true });
    await runBatchQueue({ batchId, action: 'generate', concurrency: 1, mode: 'mock', waitForCompletion: true });

    const batch = await getBatchTask(batchId);
    const validSkus = batch.skuTasks.filter((sku) => sku.taskId);
    assert.ok(validSkus.every((sku) => sku.status === 'generated'));
    assert.ok(validSkus.every((sku) => sku.currentStep === 'generated'));
    assert.ok(validSkus.every((sku) => sku.generationProgress?.total >= 8));
    assert.ok(validSkus.every((sku) => sku.generationProgress?.completed === sku.generationProgress?.total));

    for (const sku of validSkus) {
      const task = await getTask(sku.taskId);
      assert.equal(task.status, 'generated');
      assert.equal(task.generatedImages.length, task.imagePlans.length);
      for (const image of task.generatedImages) {
        assert.equal(image.batchId, batchId);
        assert.equal(image.skuTaskId, sku.skuId);
        assert.ok(image.platformId);
        assert.ok(image.imageType);
        assert.ok(image.planId);
        assert.ok(Object.hasOwn(image, 'prompt'));
        assert.ok(image.provider);
        assert.ok(image.model);
        assert.ok(image.outputPath || image.imageUrl);
        assert.equal(image.status, 'succeeded');
        assert.equal(image.retryCount, 0);
      }
    }
  } finally {
    await fs.rm(batchRoot, { recursive: true, force: true });
  }
});

test('batch queue lock prevents duplicate start and cancel releases the lock', async () => {
  const { batchRoot, batchId } = await importQueueBatch();
  try {
    await updateBatchTask(batchId, () => ({
      locks: {
        isRunning: true,
        lockedBy: 'test-lock',
        lockedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 60000).toISOString()
      },
      queue: {
        enabled: true,
        action: 'recognize',
        status: 'running',
        concurrency: 1
      }
    }));
    await assert.rejects(
      () => runBatchQueue({ batchId, action: 'recognize', concurrency: 1, waitForCompletion: true }),
      /already running/
    );
    await cancelBatchQueue(batchId);
    const batch = await getBatchTask(batchId);
    assert.equal(batch.locks.isRunning, false);
    assert.equal(batch.queue.status, 'cancelled');
  } finally {
    await fs.rm(batchRoot, { recursive: true, force: true });
  }
});

test('retryFailedJobs only retries failed queue jobs', async () => {
  const { batchRoot, batchId } = await importQueueBatch();
  try {
    const batch = await getBatchTask(batchId);
    const validSku = batch.skuTasks.find((sku) => sku.taskId);
    await updateBatchTask(batchId, (current) => ({
      skuTasks: current.skuTasks.map((sku) => (
        sku.skuId === validSku.skuId
          ? { ...sku, queueStatus: 'failed', status: 'uploaded', error: { code: 'JOB_TIMEOUT', message: 'retry me' }, retryable: true, lastErrorCategory: 'timeout', lastErrorCode: 'JOB_TIMEOUT' }
          : { ...sku, queueStatus: 'skipped' }
      )),
      queue: { ...(current.queue || {}), action: 'recognize', status: 'partial_failed', concurrency: 1 },
      locks: { isRunning: false }
    }));
    await retryFailedJobs({ batchId, action: 'recognize', concurrency: 1, waitForCompletion: true });
    const updated = await getBatchTask(batchId);
    const retriedSku = updated.skuTasks.find((sku) => sku.skuId === validSku.skuId);
    assert.equal(retriedSku.queueStatus, 'completed');
    assert.ok(updated.executionLogs.some((log) => log.skuId === validSku.skuId && log.level === 'success'));
  } finally {
    await fs.rm(batchRoot, { recursive: true, force: true });
  }
});

test('retryFailedJobs filter=timeout only retries timeout classified failures', async () => {
  const { batchRoot, batchId } = await importQueueBatch();
  try {
    const batch = await getBatchTask(batchId);
    const validSku = batch.skuTasks.find((sku) => sku.taskId);
    await updateBatchTask(batchId, (current) => ({
      skuTasks: current.skuTasks.map((sku) => (
        sku.skuId === validSku.skuId
          ? { ...sku, queueStatus: 'failed', status: 'uploaded', retryable: true, lastErrorCategory: 'timeout', lastErrorCode: 'JOB_TIMEOUT' }
          : { ...sku, queueStatus: 'failed', status: 'failed', retryable: true, lastErrorCategory: 'provider', lastErrorCode: 'PARSE_ERROR' }
      )),
      queue: { ...(current.queue || {}), action: 'recognize', status: 'partial_failed', concurrency: 1 },
      locks: { isRunning: false }
    }));
    await retryFailedJobs({ batchId, action: 'recognize', concurrency: 1, filter: 'timeout', waitForCompletion: true });
    const updated = await getBatchTask(batchId);
    const retriedSku = updated.skuTasks.find((sku) => sku.skuId === validSku.skuId);
    const parseSku = updated.skuTasks.find((sku) => sku.skuId !== validSku.skuId && sku.lastErrorCode === 'PARSE_ERROR');
    assert.equal(retriedSku.queueStatus, 'completed');
    assert.equal(parseSku.queueStatus, 'failed');
  } finally {
    await fs.rm(batchRoot, { recursive: true, force: true });
  }
});

test('auto retry schedules retryable timeout failures and stops at retry limit', async () => {
  const { batchRoot, batchId } = await importQueueBatch();
  const previous = {
    enabled: process.env.BATCH_AUTO_RETRY_ENABLED,
    timeout: process.env.BATCH_JOB_TIMEOUT_MS,
    maxRetry: process.env.BATCH_MAX_RETRY_PER_JOB,
    delay: process.env.BATCH_RETRY_DELAY_MS
  };
  try {
    process.env.BATCH_AUTO_RETRY_ENABLED = 'true';
    process.env.BATCH_JOB_TIMEOUT_MS = '1';
    process.env.BATCH_MAX_RETRY_PER_JOB = '1';
    process.env.BATCH_RETRY_DELAY_MS = '1';
    await runBatchQueue({ batchId, action: 'recognize', concurrency: 1, waitForCompletion: true });
    const batch = await getBatchTask(batchId);
    const validSku = batch.skuTasks.find((sku) => sku.taskId);
    assert.ok((validSku.retryCount || 0) >= 1);
    assert.ok(batch.executionLogs.some((log) => String(log.message).includes('retry_scheduled')));
  } finally {
    if (previous.enabled === undefined) delete process.env.BATCH_AUTO_RETRY_ENABLED; else process.env.BATCH_AUTO_RETRY_ENABLED = previous.enabled;
    if (previous.timeout === undefined) delete process.env.BATCH_JOB_TIMEOUT_MS; else process.env.BATCH_JOB_TIMEOUT_MS = previous.timeout;
    if (previous.maxRetry === undefined) delete process.env.BATCH_MAX_RETRY_PER_JOB; else process.env.BATCH_MAX_RETRY_PER_JOB = previous.maxRetry;
    if (previous.delay === undefined) delete process.env.BATCH_RETRY_DELAY_MS; else process.env.BATCH_RETRY_DELAY_MS = previous.delay;
    await fs.rm(batchRoot, { recursive: true, force: true });
  }
});

test('pauseBatchQueue records paused state without deleting queued jobs', async () => {
  const { batchRoot, batchId } = await importQueueBatch();
  try {
    await updateBatchTask(batchId, (current) => ({
      queue: { ...(current.queue || {}), action: 'recognize', status: 'running', concurrency: 1 },
      locks: {
        isRunning: true,
        lockedBy: 'test-lock',
        lockedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 60000).toISOString()
      },
      skuTasks: current.skuTasks.map((sku) => ({ ...sku, queueAction: 'recognize', queueStatus: sku.taskId ? 'pending' : 'skipped' }))
    }));
    const paused = await pauseBatchQueue(batchId);
    assert.equal(paused.queue.status, 'paused');
    assert.ok(paused.executionLogs.some((log) => log.message.includes('暂停')));
  } finally {
    await fs.rm(batchRoot, { recursive: true, force: true });
  }
});
