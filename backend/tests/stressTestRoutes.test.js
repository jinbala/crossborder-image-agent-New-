import assert from 'node:assert/strict';
import { test } from 'node:test';
import express from 'express';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { createStressTestRouter } from '../src/routes/stressTestRoutes.js';

async function makeApp() {
  const reportDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cia-stress-routes-'));
  const batch = {
    id: 'batch-route-1',
    name: '路由压测 batch',
    skuTasks: [
      { skuId: 'SKU-R1', taskId: 'task-r1', displayName: '路由 SKU 1', status: 'uploaded', currentStep: 'uploaded', imageCount: 1 }
    ]
  };
  const app = express();
  app.use(express.json());
  app.use('/api/stress-test', createStressTestRouter({
    reportDir,
    batchReader: async () => batch,
    listBatchesReader: async () => [batch]
  }));
  app.use((err, _req, res, _next) => {
    res.status(err.statusCode || 500).json({ error: err.message });
  });
  return app;
}

test('stress test API runs mockOnly and returns report by id', async () => {
  const app = await makeApp();
  let stressTestId = '';

  await request(app)
    .post('/api/stress-test/run')
    .send({ mode: 'mockOnly', skuCount: 1 })
    .expect(201)
    .expect((res) => {
      stressTestId = res.body.summary.stressTestId;
      assert.equal(res.body.summary.mode, 'mockOnly');
      assert.equal(res.body.summary.totalSku, 1);
    });

  await request(app)
    .get(`/api/stress-test/${stressTestId}`)
    .expect(200)
    .expect((res) => {
      assert.equal(res.body.summary.stressTestId, stressTestId);
      assert.equal(res.body.skuResults[0].skuId, 'SKU-R1');
    });

  await request(app)
    .get(`/api/stress-test/${stressTestId}/report`)
    .expect('Content-Type', /application\/json/)
    .expect(200)
    .expect((res) => {
      assert.equal(res.body.summary.stressTestId, stressTestId);
      assert.equal(res.headers['content-disposition'].includes(`${stressTestId}-report.json`), true);
    });
});

test('stress test API exposes real modes as disabled config without running providers', async () => {
  const app = await makeApp();

  await request(app)
    .get('/api/stress-test/config')
    .expect(200)
    .expect((res) => {
      const realVision = res.body.modes.find((mode) => mode.id === 'realVisionMockGenerate');
      const realReview = res.body.modes.find((mode) => mode.id === 'optionalRealReview');
      assert.equal(realVision.enabled, true);
      assert.equal(realReview.enabled, false);
      assert.match(realVision.costWarning, /可能产生 API 成本/);
      assert.match(realReview.costWarning, /本阶段不会调用真实 Provider/);
    });
});
