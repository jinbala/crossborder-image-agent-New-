import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import request from 'supertest';
import app from '../src/app.js';
import { createBatchTask, createTask, getBatchTask, resetDatabaseForTests, paths } from '../src/services/db.js';

const now = '2026-06-01T12:00:00.000Z';
const listingDir = path.join(paths.outputDir, 'listing-csv');

beforeEach(async () => {
  await resetDatabaseForTests();
  await fs.rm(listingDir, { recursive: true, force: true });
});

async function seedRouteBatch() {
  await createBatchTask({
    id: 'batch-listing-route',
    name: 'Listing Route Batch',
    status: 'reviewed',
    createdAt: now,
    updatedAt: now,
    skuTasks: [
      { skuId: 'SKU-ROUTE', taskId: 'task-listing-route', displayName: 'SKU-ROUTE', status: 'reviewed', currentStep: 'review' }
    ]
  });
  await createTask({
    id: 'task-listing-route',
    batchId: 'batch-listing-route',
    sku: 'SKU-ROUTE',
    status: 'reviewed',
    platformId: 'amazon',
    categoryId: 'electronics_storage',
    productInfoConfirmed: {
      sku: 'SKU-ROUTE',
      name: 'Route Product',
      sellingPoints: ['Safe feature'],
      description: 'Safe description'
    },
    recognitionQuality: {},
    generatedImages: [{
      id: 'route-main',
      imageType: 'main_image',
      type: 'main_image',
      status: 'succeeded',
      provider: 'mock',
      isMockPreview: true,
      platformId: 'amazon'
    }],
    review: { reviewedAt: now, reviewMode: 'mock', overallStatus: 'passed', items: [] }
  });
}

async function seedNoReviewMissingRouteBatch() {
  await createBatchTask({
    id: 'batch-listing-route-missing',
    name: 'Listing Route Missing Batch',
    status: 'generated',
    createdAt: now,
    updatedAt: now,
    skuTasks: [
      { skuId: 'SKU-NOREVIEW', taskId: 'task-listing-route-noreview', displayName: 'SKU-NOREVIEW', status: 'generated', currentStep: 'review' }
    ]
  });
  await createTask({
    id: 'task-listing-route-noreview',
    batchId: 'batch-listing-route-missing',
    sku: 'SKU-NOREVIEW',
    status: 'generated',
    platformId: 'amazon',
    categoryId: 'electronics_storage',
    productInfoConfirmed: {
      sku: 'SKU-NOREVIEW',
      name: '',
      sellingPoints: ['Safe feature'],
      description: ''
    },
    recognitionQuality: {},
    generatedImages: [],
    review: null
  });
}

test('GET /api/batches/:batchId/listing-csv/preview returns read-only sanitized preview', async () => {
  await seedRouteBatch();
  const beforeBatch = await getBatchTask('batch-listing-route');

  await request(app)
    .get('/api/batches/batch-listing-route/listing-csv/preview?platforms=amazon,temu&includeMockImages=true')
    .expect(200)
    .expect((res) => {
      assert.equal(res.body.preview.batchId, 'batch-listing-route');
      assert.equal(res.body.preview.mode, 'preview');
      assert.equal(res.body.preview.summary.rowsByPlatform.amazon, 1);
      assert.equal(res.body.preview.files.some((file) => file.fileName === 'amazon-listing.csv'), true);
      assert.doesNotMatch(JSON.stringify(res.body), /\.env|API_KEY|sk-|[A-Z]:\\|app\.sqlite|node_modules/i);
    });

  assert.equal(await getBatchTask('batch-listing-route').then((batch) => JSON.stringify(batch)), JSON.stringify(beforeBatch));
  await assert.rejects(fs.stat(listingDir), /ENOENT/);
});

test('POST /api/batches/:batchId/listing-csv requires confirmExport and returns safe files', async () => {
  await seedRouteBatch();
  const beforeBatch = await getBatchTask('batch-listing-route');

  await request(app)
    .post('/api/batches/batch-listing-route/listing-csv')
    .send({ platforms: ['amazon'], includeMockImages: true })
    .expect(400)
    .expect((res) => assert.match(String(res.body.error), /confirmExport=true/));

  await request(app)
    .post('/api/batches/batch-listing-route/listing-csv')
    .send({ platforms: ['amazon'], includeMockImages: true, confirmExport: true })
    .expect(201)
    .expect((res) => {
      assert.match(res.body.exportId, /^listing-csv-batch-listing-route-/);
      assert.equal(res.body.files.some((file) => file.fileName === 'amazon-listing.csv'), true);
      assert.equal(res.body.files.some((file) => file.fileName === 'listing-field-mapping.json'), true);
      assert.equal(res.body.files.some((file) => file.fileName === 'listing-export-summary.json'), true);
      assert.ok(res.body.files.every((file) => !/[A-Z]:\\/.test(file.relativePath)));
      assert.doesNotMatch(JSON.stringify(res.body), /\.env|API_KEY|sk-|[A-Z]:\\|app\.sqlite|node_modules/i);
    });

  assert.equal(await getBatchTask('batch-listing-route').then((batch) => JSON.stringify(batch)), JSON.stringify(beforeBatch));
});

test('POST /api/batches/:batchId/listing-csv still exports noReview and missing field SKU with warnings', async () => {
  await seedNoReviewMissingRouteBatch();
  const beforeBatch = await getBatchTask('batch-listing-route-missing');

  await request(app)
    .post('/api/batches/batch-listing-route-missing/listing-csv')
    .send({ platforms: ['amazon', 'temu'], includeMockImages: true, confirmExport: true })
    .expect(201)
    .expect((res) => {
      assert.equal(res.body.files.some((file) => file.fileName === 'amazon-listing.csv'), true);
      assert.equal(res.body.files.some((file) => file.fileName === 'temu-listing.csv'), true);
      assert.equal(res.body.files.some((file) => file.fileName === 'listing-field-mapping.json'), true);
      assert.equal(res.body.files.some((file) => file.fileName === 'listing-export-summary.json'), true);
      assert.equal(res.body.summary.rowsByPlatform.amazon, 1);
      assert.equal(res.body.summary.rowsByPlatform.temu, 1);
      assert.equal(res.body.summary.noReviewSku.includes('SKU-NOREVIEW'), true);
      assert.equal(res.body.summary.missingRequiredFields.some((item) => item.field === 'product_title'), true);
      assert.equal(res.body.summary.missingRequiredFields.some((item) => item.field === 'product_name'), true);
      assert.equal(res.body.summary.missingRequiredFields.some((item) => item.field === 'main_image'), true);
      assert.equal(res.body.warnings.some((warning) => /noReview/i.test(warning)), true);
      assert.ok(res.body.files.every((file) => !/[A-Z]:\\/.test(file.relativePath)));
      assert.doesNotMatch(JSON.stringify(res.body), /\.env|API_KEY|sk-|[A-Z]:\\|app\.sqlite|node_modules/i);
    });

  assert.equal(await getBatchTask('batch-listing-route-missing').then((batch) => JSON.stringify(batch)), JSON.stringify(beforeBatch));

  const listingRoots = await fs.readdir(listingDir);
  const latestRoot = listingRoots.find((item) => item.includes('batch-listing-route-missing'));
  const amazonCsv = await fs.readFile(path.join(listingDir, latestRoot, 'amazon-listing.csv'), 'utf8');
  const temuCsv = await fs.readFile(path.join(listingDir, latestRoot, 'temu-listing.csv'), 'utf8');
  assert.match(amazonCsv, /noReview/);
  assert.match(amazonCsv, /product_title:missing/);
  assert.match(amazonCsv, /main_image:missing/);
  assert.match(temuCsv, /product_name:missing/);
  assert.match(temuCsv, /main_image:missing/);
});
