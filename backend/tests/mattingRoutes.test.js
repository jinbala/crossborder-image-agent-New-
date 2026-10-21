import assert from 'node:assert/strict';
import { test } from 'node:test';
import express from 'express';
import request from 'supertest';
import { createMattingRouter } from '../src/routes/mattingRoutes.js';

function makeApp(service) {
  const app = express();
  app.use(express.json());
  app.use('/api/matting', createMattingRouter(service));
  app.use((err, _req, res, _next) => {
    res.status(err.statusCode || 500).json({ error: err.message });
  });
  return app;
}

test('matting config API does not return API Key', async () => {
  const app = makeApp({
    getMattingConfig: () => ({
      currentProvider: 'sharp',
      externalConfigured: false,
      availableProviders: ['sharp', 'external', 'auto'],
      defaultProvider: 'sharp',
      timeoutMs: 60000,
      warning: '第三方抠图 API 未配置。当前将使用 sharp 本地抠图，不会产生第三方 API 成本。',
      apiKey: 'secret-key'
    })
  });

  await request(app)
    .get('/api/matting/config')
    .expect(200)
    .expect((res) => {
      assert.equal(JSON.stringify(res.body).includes('secret-key'), false);
      assert.equal(res.body.currentProvider, 'sharp');
      assert.equal(res.body.externalConfigured, false);
    });
});

test('matting run and compare routes return sanitized results', async () => {
  const app = makeApp({
    runMatting: async (input) => ({
      status: 'success',
      providerUsed: input.provider === 'external' ? 'sharp' : 'sharp',
      fallbackUsed: input.provider === 'external',
      fallbackReason: input.provider === 'external' ? '第三方抠图失败，已 fallback 到 sharp。' : '',
      originalImage: { id: input.imageId, displayName: 'source.png', previewUrl: '/uploads/source.png' },
      mattedImage: { previewUrl: '/outputs/task-1/matting-test/source.png' },
      qualityScore: { score: 80, level: 'good', warnings: [], details: {} },
      durationMs: 10
    }),
    compareMatting: async () => ({
      sharp: { status: 'success', providerUsed: 'sharp', qualityScore: { score: 80, level: 'good', warnings: [] } },
      external: { status: 'skipped', message: '第三方抠图 API 未配置。' }
    })
  });

  await request(app)
    .post('/api/matting/run')
    .send({ taskId: 'task-1', imageId: 'image-1', provider: 'external' })
    .expect(200)
    .expect((res) => {
      assert.equal(res.body.fallbackUsed, true);
      assert.equal(JSON.stringify(res.body).includes('D:\\'), false);
    });

  await request(app)
    .post('/api/matting/compare')
    .send({ taskId: 'task-1', imageId: 'image-1' })
    .expect(200)
    .expect((res) => {
      assert.equal(res.body.sharp.status, 'success');
      assert.equal(res.body.external.status, 'skipped');
    });
});

test('matting routes expose Image2 fields without leaking secrets', async () => {
  const app = makeApp({
    getMattingConfig: () => ({
      currentProvider: 'sharp',
      externalConfigured: false,
      image2Available: true,
      externalProviders: ['sharp', 'image2'],
      image2ModeLabel: '实验性抠图',
      costNotice: 'Image2 抠图测试可能产生 API 成本，仅在点击按钮时调用。',
      availableProviders: ['sharp', 'external', 'image2', 'auto'],
      defaultProvider: 'sharp',
      timeoutMs: 60000,
      warning: 'Image2 可用。',
      apiKey: 'sk-secret'
    }),
    runMatting: async (input) => ({
      status: 'success',
      requestedProvider: input.provider,
      providerUsed: 'image2',
      outputType: 'edited-background-removed',
      fallbackUsed: false,
      fallbackReason: '',
      originalImage: { id: input.imageId, displayName: 'source.png', previewUrl: '/uploads/source.png' },
      mattedImage: { previewUrl: '/outputs/task-1/matting-test/image2.png' },
      qualityScore: { score: 70, level: 'medium', warnings: [], details: {} },
      rawProviderMeta: { token: 'sk-secret' }
    }),
    compareMatting: async () => ({
      sharp: { status: 'success', providerUsed: 'sharp', qualityScore: { score: 80, level: 'good', warnings: [] } },
      image2: { status: 'success', requestedProvider: 'image2', providerUsed: 'image2', outputType: 'edited-background-removed', qualityScore: { score: 70, level: 'medium', warnings: [] } }
    })
  });

  await request(app)
    .get('/api/matting/config')
    .expect(200)
    .expect((res) => {
      assert.equal(res.body.image2Available, true);
      assert.equal(res.body.externalProviders.includes('image2'), true);
      assert.equal(JSON.stringify(res.body).includes('sk-secret'), false);
    });

  await request(app)
    .post('/api/matting/run')
    .send({ taskId: 'task-1', imageId: 'image-1', provider: 'image2', confirmExternal: true, confirmDataTransfer: true })
    .expect(200)
    .expect((res) => {
      assert.equal(res.body.requestedProvider, 'image2');
      assert.equal(res.body.providerUsed, 'image2');
      assert.equal(res.body.outputType, 'edited-background-removed');
      assert.equal(JSON.stringify(res.body).includes('sk-secret'), false);
    });

  await request(app)
    .post('/api/matting/compare')
    .send({ taskId: 'task-1', imageId: 'image-1', confirmExternal: true, confirmDataTransfer: true })
    .expect(200)
    .expect((res) => {
      assert.equal(res.body.sharp.status, 'success');
      assert.equal(res.body.image2.status, 'success');
    });
});

test('remote matting and compare require per-task cost and data transfer confirmation before any call', async () => {
  let calls = 0;
  const app = makeApp({ getMattingConfig: () => ({ image2Available: true, externalConfigured: true }), runMatting: async () => { calls++; return { ok: true }; }, compareMatting: async () => { calls++; return { ok: true }; } });
  await request(app).post('/api/matting/run').send({ taskId: 't', provider: 'image2' }).expect(400);
  await request(app).post('/api/matting/compare').send({ taskId: 't', confirmExternal: true }).expect(400);
  assert.equal(calls, 0);
  await request(app).post('/api/matting/run').send({ taskId: 't', provider: 'image2', confirmExternal: true, confirmDataTransfer: true }).expect(200);
  assert.equal(calls, 1);
});
