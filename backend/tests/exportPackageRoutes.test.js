import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import request from 'supertest';
import app from '../src/app.js';
import { createBatchTask, createTask, getBatchTask, resetDatabaseForTests, paths } from '../src/services/db.js';

const now = '2026-06-01T12:00:00.000Z';
const fixtureOutputDir = path.join(paths.outputDir, 'export-package-route-fixtures');
const exportPackagesDir = path.join(paths.outputDir, 'export-packages');

beforeEach(async () => {
  await resetDatabaseForTests();
  await fs.rm(fixtureOutputDir, { recursive: true, force: true });
  await fs.rm(exportPackagesDir, { recursive: true, force: true });
  await fs.mkdir(fixtureOutputDir, { recursive: true });
  await fs.writeFile(path.join(fixtureOutputDir, 'main_image.jpg'), 'route-main');
});

async function seedRouteBatch() {
  await createBatchTask({
    id: 'batch-export-route',
    name: 'Route Export Batch',
    status: 'reviewed',
    createdAt: now,
    updatedAt: now,
    skuTasks: [
      { skuId: 'SKU-ROUTE', taskId: 'task-export-route', displayName: 'SKU-ROUTE', status: 'reviewed', currentStep: 'review' }
    ]
  });
  await createTask({
    id: 'task-export-route',
    batchId: 'batch-export-route',
    sku: 'SKU-ROUTE',
    status: 'reviewed',
    platformId: 'amazon',
    categoryId: 'electronics_storage',
    productInfoConfirmed: { sku: 'SKU-ROUTE', name: 'Route Product D:\\Code\\.env API_KEY=sk-secret' },
    targets: [{ id: 'target-amazon', platformId: 'amazon', platformName: 'Amazon', categoryId: 'electronics_storage' }],
    imagePlans: [{ id: 'main-plan', type: 'main_image', imageType: 'main_image', targetId: 'target-amazon', textBlocks: [] }],
    generatedImages: [{
      id: 'route-main',
      planId: 'main-plan',
      type: 'main_image',
      imageType: 'main_image',
      status: 'succeeded',
      provider: 'mock',
      model: 'mock',
      isMockPreview: true,
      platformId: 'amazon',
      fileName: 'main_image.jpg',
      filePath: 'outputs/export-package-route-fixtures/main_image.jpg',
      mockPreview: {
        template: { templateName: 'Main Template', layoutStyle: 'main-layout', backgroundStyle: 'pure_white' }
      }
    }],
    review: { reviewedAt: now, reviewMode: 'mock', overallStatus: 'passed', items: [] }
  });
}

test('GET /api/batches/:batchId/export-package/preview returns read-only structured preview', async () => {
  await seedRouteBatch();
  const beforeBatch = await getBatchTask('batch-export-route');

  await request(app)
    .get('/api/batches/batch-export-route/export-package/preview?platforms=amazon,temu&includeReports=true&includeMockImages=true')
    .expect(200)
    .expect((res) => {
      assert.equal(res.body.preview.batchId, 'batch-export-route');
      assert.equal(res.body.preview.mode, 'preview');
      assert.deepEqual(res.body.preview.platforms, ['amazon', 'temu']);
      assert.equal(res.body.preview.summary.totalSku, 1);
      assert.equal(res.body.preview.summary.mockImageCount, 1);
      assert.ok(res.body.preview.directoryTree.some((item) => item.path === 'Amazon/SKU-ROUTE/01_main.jpg'));
      assert.doesNotMatch(JSON.stringify(res.body), /\.env|API_KEY|sk-secret|[A-Z]:\\|app\.sqlite|node_modules/i);
    });

  assert.equal(await getBatchTask('batch-export-route').then((batch) => JSON.stringify(batch)), JSON.stringify(beforeBatch));
  await assert.rejects(fs.stat(exportPackagesDir), /ENOENT/);
});

test('POST /api/batches/:batchId/export-package requires confirmExport and returns safe package result', async () => {
  await seedRouteBatch();
  const beforeBatch = await getBatchTask('batch-export-route');

  await request(app)
    .post('/api/batches/batch-export-route/export-package')
    .send({ platforms: ['amazon'], includeReports: true, includeMockImages: true })
    .expect(400)
    .expect((res) => {
      assert.match(String(res.body.error), /confirmExport=true/);
    });

  await request(app)
    .post('/api/batches/batch-export-route/export-package')
    .send({ platforms: ['amazon'], includeReports: true, includeMockImages: true, confirmExport: true })
    .expect(201)
    .expect((res) => {
      assert.match(res.body.packageId, /^export-package-batch-export-route-/);
      assert.match(res.body.zipFile, /\.zip$/);
      assert.match(res.body.relativePath, /^outputs\/export-packages\/.+\.zip$/);
      assert.equal(res.body.summary.totalSku, 1);
      assert.equal(res.body.summary.mockImageCount, 1);
      assert.equal(Array.isArray(res.body.failedSku), true);
      assert.doesNotMatch(JSON.stringify(res.body), /\.env|API_KEY|sk-secret|[A-Z]:\\|app\.sqlite|node_modules/i);
    });

  assert.equal(await getBatchTask('batch-export-route').then((batch) => JSON.stringify(batch)), JSON.stringify(beforeBatch));
});
