import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import request from 'supertest';
import app from '../src/app.js';
import { createBatchTask, createTask, readDb, resetDatabaseForTests } from '../src/services/db.js';

beforeEach(async () => {
  await resetDatabaseForTests();
});

test('GET /api/final-acceptance/template returns a blank read-only acceptance template', async () => {
  const beforeDb = await readDb();

  await request(app)
    .get('/api/final-acceptance/template')
    .expect(200)
    .expect((res) => {
      assert.equal(res.body.meta.version, 'v6.1-stage1');
      assert.equal(res.body.meta.mode, 'manual-acceptance');
      assert.equal(res.body.summary.totalSku, 5);
      assert.equal(res.body.skuAcceptance.length, 5);
      assert.equal(res.body.skuAcceptance.every((item) => item.overallStatus === 'pending'), true);
    });

  assert.equal(JSON.stringify(await readDb()), JSON.stringify(beforeDb));
});

test('GET /api/final-acceptance/template supports v6.2 ten SKU multi-batch query options', async () => {
  const beforeDb = await readDb();

  await request(app)
    .get('/api/final-acceptance/template?version=v6.2-stage2&targetSkuCount=10&multiBatch=true')
    .expect(200)
    .expect((res) => {
      assert.equal(res.body.meta.version, 'v6.2-stage2');
      assert.equal(res.body.meta.mode, 'manual-acceptance-multi-batch');
      assert.equal(res.body.meta.targetSkuCount, 10);
      assert.equal(res.body.meta.multiBatch, true);
      assert.equal(res.body.summary.totalSku, 10);
      assert.equal(res.body.skuAcceptance.length, 10);
      assert.equal(res.body.skuAcceptance.every((item) => item.manualAcceptance?.status === 'pending'), true);
      assert.deepEqual(res.body.batchAcceptance, []);
    });

  assert.equal(JSON.stringify(await readDb()), JSON.stringify(beforeDb));
});

test('GET /api/final-acceptance/report returns a sanitized prefilled report without mutating tasks', async () => {
  await createTask({
    id: 'task-final-route',
    sku: 'ROUTE-SKU',
    status: 'reviewed',
    productInfoConfirmed: { sku: 'ROUTE-SKU', name: 'Route Product API_KEY=sk-secret D:\\Code\\.env' },
    sourceImages: [{ id: 'source-1', displayName: 'front.jpg' }],
    productInfoRaw: { name: 'Route Product' },
    imagePlans: [{ id: 'plan-1', type: 'main_image' }],
    generatedImages: [{ id: 'img-1', type: 'main_image', status: 'succeeded', isMockPreview: true }],
    review: { overallStatus: 'passed', items: [] }
  });
  const beforeDb = await readDb();

  await request(app)
    .get('/api/final-acceptance/report')
    .expect(200)
    .expect((res) => {
      assert.equal(res.body.meta.version, 'v6.1-stage1');
      assert.equal(res.body.skuAcceptance.length, 5);
      assert.equal(res.body.skuAcceptance.some((item) => item.sku === 'ROUTE-SKU'), true);
      assert.doesNotMatch(JSON.stringify(res.body), /\.env|API_KEY|sk-secret|(?:^|[^A-Za-z0-9])sk-[A-Za-z0-9_-]{6,}|[A-Z]:\\|app\.sqlite|node_modules/i);
    });

  assert.equal(JSON.stringify(await readDb()), JSON.stringify(beforeDb));
});

test('GET /api/final-acceptance/report supports v6.2 ten SKU multi-batch report without mutating data', async () => {
  const batch = {
    id: 'batch-final-route-v62',
    name: 'Route Batch API_KEY=sk-secret D:\\Code\\.env',
    status: 'reviewed',
    createdAt: '2026-06-01T12:00:00.000Z',
    updatedAt: '2026-06-01T12:00:00.000Z',
    skuTasks: []
  };
  for (let index = 0; index < 10; index += 1) {
    const taskId = `task-final-route-v62-${index + 1}`;
    const sku = `ROUTE-V62-${index + 1}`;
    batch.skuTasks.push({ skuId: sku, taskId, status: 'reviewed' });
    await createTask({
      id: taskId,
      sku,
      status: 'reviewed',
      productInfoConfirmed: { sku, name: `Route Product ${index + 1}` },
      sourceImages: [{ id: 'source-1', displayName: 'front.jpg' }],
      productInfoRaw: { name: `Route Product ${index + 1}` },
      imagePlans: [{ id: 'plan-1', type: 'main_image' }],
      generatedImages: [{ id: 'img-1', type: 'main_image', status: 'succeeded', isMockPreview: true }],
      review: { overallStatus: 'passed', items: [] }
    });
  }
  await createBatchTask(batch);
  const beforeDb = await readDb();

  await request(app)
    .get('/api/final-acceptance/report?version=v6.2-stage2&targetSkuCount=10&multiBatch=true')
    .expect(200)
    .expect((res) => {
      assert.equal(res.body.meta.version, 'v6.2-stage2');
      assert.equal(res.body.skuAcceptance.length, 10);
      assert.equal(res.body.batchAcceptance.length, 1);
      assert.equal(res.body.batchAcceptance[0].batchId, 'batch-final-route-v62');
      assert.equal(res.body.skuAcceptance.every((item) => item.manualAcceptance?.status === 'pending'), true);
      assert.doesNotMatch(JSON.stringify(res.body), /\.env|API_KEY|sk-secret|(?:^|[^A-Za-z0-9])sk-[A-Za-z0-9_-]{6,}|[A-Z]:\\|app\.sqlite|node_modules/i);
    });

  assert.equal(JSON.stringify(await readDb()), JSON.stringify(beforeDb));
});

test('POST /api/final-acceptance/export returns sanitized JSON and CSV content', async () => {
  const report = {
    meta: { reportId: 'final-acceptance-test', generatedAt: '2026-06-01T12:00:00.000Z' },
    summary: { overallStatus: 'passed' },
    skuAcceptance: [{
      sku: 'ROUTE API_KEY=abc sk-secret D:\\Code\\.env',
      taskId: 'task-route',
      productName: 'Route Product',
      steps: [{ stepKey: 'upload', stepLabel: '上传图片', status: 'pending', notes: 'Provider secret platform token C:\\tmp' }],
      riskSummary: { uploadDryRunRisk: 'unknown' },
      nextSuggestedAction: 'manual check'
    }],
    issueLogs: [{
      issueId: 'issue-route',
      title: 'Route blocker API_KEY=abc',
      severity: 'blocker',
      status: 'open',
      isBlockingFinalRelease: true,
      description: 'Provider secret platform token D:\\Code\\.env',
      moduleKey: 'finalAcceptance'
    }]
  };

  await request(app)
    .post('/api/final-acceptance/export')
    .send({ report, format: 'json', timestamp: '2026-06-01T12-00-00-000Z' })
    .expect(200)
    .expect((res) => {
      assert.equal(res.body.fileName, 'final-acceptance-report-2026-06-01T12-00-00-000Z.json');
      assert.equal(res.body.mimeType, 'application/json');
      const content = JSON.parse(res.body.content);
      assert.equal(content.issueSummary.blockingFinalReleaseCount, 1);
      assert.notEqual(content.summary.overallStatus, 'passed');
      assert.equal(content.issueLogs[0].issueId, 'issue-route');
      assert.doesNotMatch(res.body.content, /\.env|API_KEY|sk-secret|(?:^|[^A-Za-z0-9])sk-[A-Za-z0-9_-]{6,}|Provider secret|platform token|[A-Z]:\\/i);
    });

  await request(app)
    .post('/api/final-acceptance/export')
    .send({ report, format: 'csv', timestamp: '2026-06-01T12-00-00-000Z' })
    .expect(200)
    .expect((res) => {
      assert.equal(res.body.fileName, 'final-acceptance-report-2026-06-01T12-00-00-000Z.csv');
      assert.equal(res.body.mimeType, 'text/csv');
      assert.match(res.body.content, /stepKey/);
      assert.match(res.body.content, /issue-route/);
      assert.match(res.body.content, /issueId,title,severity,status,isBlockingFinalRelease/);
      assert.doesNotMatch(res.body.content, /\.env|API_KEY|sk-secret|(?:^|[^A-Za-z0-9])sk-[A-Za-z0-9_-]{6,}|Provider secret|platform token|[A-Z]:\\/i);
    });
});
