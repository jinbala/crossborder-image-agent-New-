import assert from 'node:assert/strict';
import { test } from 'node:test';
import express from 'express';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { createCleanupRouter } from '../src/routes/cleanupRoutes.js';

async function makeApp() {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'cia-cleanup-routes-'));
  await fs.mkdir(path.join(projectRoot, '.vision-tmp'), { recursive: true });
  const filePath = path.join(projectRoot, '.vision-tmp', 'route-old.tmp');
  await fs.writeFile(filePath, 'route-data');
  const oldDate = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);
  await fs.utimes(filePath, oldDate, oldDate);

  const app = express();
  app.use(express.json());
  app.use('/api/cleanup', createCleanupRouter({ projectRoot }));
  app.use((err, _req, res, _next) => {
    res.status(err.statusCode || 500).json({ error: err.message });
  });
  return { app, filePath };
}

test('cleanup summary API returns runtime file totals', async () => {
  const { app } = await makeApp();

  await request(app)
    .get('/api/cleanup/summary')
    .expect(200)
    .expect((res) => {
      assert.equal(typeof res.body.totalBytes, 'number');
      assert.equal(res.body.groups.some((group) => group.groupName === 'visionTmp'), true);
    });
});

test('cleanup preview API does not delete files', async () => {
  const { app, filePath } = await makeApp();

  await request(app)
    .post('/api/cleanup/preview')
    .send({ olderThanDays: 30, groups: ['visionTmp'] })
    .expect(200)
    .expect((res) => {
      assert.equal(res.body.totalFiles, 1);
      assert.equal(res.body.groups[0].files[0].relativePath, '.vision-tmp/route-old.tmp');
    });

  await fs.access(filePath);
});

test('cleanup run API requires confirm true and deletes after server-side preview', async () => {
  const { app, filePath } = await makeApp();

  await request(app)
    .post('/api/cleanup/run')
    .send({ olderThanDays: 30, groups: ['visionTmp'] })
    .expect(400)
    .expect((res) => {
      assert.match(res.body.error, /confirm=true/);
    });

  await fs.access(filePath);

  await request(app)
    .post('/api/cleanup/run')
    .send({
      olderThanDays: 30,
      groups: ['visionTmp'],
      files: ['../../.env', '.vision-tmp/route-old.tmp'],
      confirm: true
    })
    .expect(200)
    .expect((res) => {
      assert.equal(res.body.deletedFiles, 1);
      assert.equal(res.body.errors.length, 0);
    });

  await assert.rejects(() => fs.access(filePath));
});
