import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import request from 'supertest';
import app from '../src/app.js';
import { createTask, readDb, resetDatabaseForTests } from '../src/services/db.js';

function routeTask() {
  return {
    id: 'task-real-api-route',
    sku: 'ROUTE-REAL-API',
    status: 'reviewed',
    platformId: 'amazon',
    categoryId: 'electronics_storage',
    productInfoConfirmed: {
      sku: 'ROUTE-REAL-API',
      name: 'Route External Drive',
      category: 'External Storage'
    },
    sourceImages: [{ id: 'source-1', displayName: 'front.jpg', filePath: 'uploads/front.jpg', previewUrl: '/uploads/front.jpg' }],
    imagePlans: [{
      id: 'main-image-plan',
      type: 'main_image',
      platformId: 'amazon',
      categoryId: 'electronics_storage',
      title: 'Main image'
    }],
    generatedImages: [],
    review: null,
    createdAt: '2026-06-01T12:00:00.000Z',
    updatedAt: '2026-06-01T12:00:00.000Z'
  };
}

beforeEach(async () => {
  await resetDatabaseForTests();
});

test('POST /api/final-acceptance/real-api/run rejects missing confirmation and never mutates DB', async () => {
  await createTask(routeTask());
  const beforeDb = await readDb();

  await request(app)
    .post('/api/final-acceptance/real-api/run')
    .send({ taskId: 'task-real-api-route', confirmRealApi: false, confirmPaidApi: true })
    .expect(400)
    .expect((res) => {
      assert.match(String(res.body.error), /confirmRealApi=true/);
    });

  assert.equal(JSON.stringify(await readDb()), JSON.stringify(beforeDb));
});

test('POST /api/final-acceptance/real-api/run rejects missing no-platform-upload confirmation before task lookup', async () => {
  const beforeDb = await readDb();

  await request(app)
    .post('/api/final-acceptance/real-api/run')
    .send({
      taskId: 'missing-task-real-api-route',
      confirmRealApi: true,
      confirmPaidApi: true
    })
    .expect(400)
    .expect((res) => {
      assert.match(String(res.body.error), /confirmNoPlatformUpload=true/);
    });

  await request(app)
    .post('/api/final-acceptance/real-api/run')
    .send({
      taskId: 'missing-task-real-api-route',
      confirmRealApi: true,
      confirmPaidApi: true,
      confirmNoPlatformUpload: false
    })
    .expect(400)
    .expect((res) => {
      assert.match(String(res.body.error), /confirmNoPlatformUpload=true/);
    });

  assert.equal(JSON.stringify(await readDb()), JSON.stringify(beforeDb));
});

test('POST /api/final-acceptance/real-api/run rejects batch real API runs', async () => {
  await request(app)
    .post('/api/final-acceptance/real-api/run')
    .send({
      taskId: 'task-real-api-route',
      batchId: 'batch-001',
      confirmRealApi: true,
      confirmPaidApi: true,
      confirmNoPlatformUpload: true
    })
    .expect(400)
    .expect((res) => {
      assert.match(String(res.body.error), /Batch or multi-SKU/);
    });
});

test('POST /api/final-acceptance/real-api/export returns sanitized report JSON', async () => {
  await request(app)
    .post('/api/final-acceptance/real-api/export')
    .send({
      report: {
        meta: { taskId: 'task-real-api-route', generatedAt: '2026-06-01T12:00:00.000Z' },
        apiCalls: [{ errorMessage: 'OPENAI_API_KEY=sk-secret D:\\Code\\.env app.sqlite node_modules' }]
      },
      timestamp: '2026-06-01T12-00-00-000Z'
    })
    .expect(200)
    .expect((res) => {
      assert.equal(res.body.fileName, 'real-api-acceptance-report-task-real-api-route-2026-06-01T12-00-00-000Z.json');
      assert.equal(res.body.mimeType, 'application/json');
      assert.doesNotMatch(res.body.content, /OPENAI_API_KEY|sk-secret|[A-Z]:\\|\.env|app\.sqlite|node_modules/i);
    });
});
