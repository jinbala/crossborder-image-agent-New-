import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import app from '../src/app.js';
import {
  createBatchTask,
  createTask,
  getBatchTask,
  listImportedFolders,
  markImportedFolders,
  resetDatabaseForTests
} from '../src/services/db.js';

const now = '2026-06-01T12:00:00.000Z';

async function seedRouteControlBatch(batchId = 'batch-control-route') {
  const skuFolder = await fs.mkdtemp(path.join(os.tmpdir(), `${batchId}-sku-`));
  await fs.writeFile(path.join(skuFolder, 'main.jpg'), 'fake-image');
  await createBatchTask({
    id: batchId,
    name: 'Route Control Batch',
    status: 'imported',
    createdAt: now,
    updatedAt: now,
    queue: { status: 'idle', action: 'recognize', pendingJobs: 0, runningJobs: 0 },
    locks: { isRunning: false },
    skuTasks: [
      { skuId: `${batchId}-sku`, taskId: `${batchId}-task`, status: 'imported', currentStep: 'imported', sourceFolderPath: skuFolder }
    ]
  });
  await createTask({
    id: `${batchId}-task`,
    batchId,
    sku: `${batchId}-sku`,
    status: 'uploaded',
    sourceImages: []
  });
  await markImportedFolders([{
    folderPath: skuFolder,
    folderName: `${batchId}-sku`,
    importedAt: now,
    batchId,
    taskIds: [`${batchId}-task`]
  }]);
  return { skuFolder };
}

beforeEach(async () => {
  await resetDatabaseForTests();
});

test('POST /api/batches/:batchId/cancel cancels batch without deleting files', async () => {
  const { skuFolder } = await seedRouteControlBatch();

  await request(app)
    .post('/api/batches/batch-control-route/cancel')
    .send({ confirm: true })
    .expect(200)
    .expect((res) => {
      assert.equal(res.body.result.status, 'cancelled');
      assert.equal(res.body.result.deletedFiles, false);
      assert.equal(res.body.result.originalFoldersPreserved, true);
      assert.equal(res.body.batchTask.status, 'cancelled');
      assert.equal(res.body.batchTask.queue.status, 'cancelled');
    });

  assert.equal(await fs.stat(path.join(skuFolder, 'main.jpg')).then((stat) => stat.isFile()), true);
});

test('DELETE /api/batches/:batchId removes only the target batch record and import flags', async () => {
  const first = await seedRouteControlBatch('batch-delete-route-a');
  await seedRouteControlBatch('batch-delete-route-b');

  await request(app)
    .delete('/api/batches/batch-delete-route-a')
    .send({ confirm: true })
    .expect(200)
    .expect((res) => {
      assert.equal(res.body.result.status, 'deleted');
      assert.equal(res.body.result.deletedFiles, false);
      assert.equal(res.body.result.originalFoldersPreserved, true);
    });

  assert.equal(await getBatchTask('batch-delete-route-a'), null);
  assert.notEqual(await getBatchTask('batch-delete-route-b'), null);
  assert.equal((await listImportedFolders()).some((record) => record.batchId === 'batch-delete-route-a'), false);
  assert.equal((await listImportedFolders()).some((record) => record.batchId === 'batch-delete-route-b'), true);
  assert.equal(await fs.stat(path.join(first.skuFolder, 'main.jpg')).then((stat) => stat.isFile()), true);
});

test('POST /api/batches/:batchId/reset-import clears import flags for rescanning', async () => {
  await seedRouteControlBatch('batch-reset-route');

  await request(app)
    .post('/api/batches/batch-reset-route/reset-import')
    .send({ confirm: true })
    .expect(200)
    .expect((res) => {
      assert.equal(res.body.result.status, 'reset');
      assert.equal(res.body.result.deletedFiles, false);
      assert.equal(res.body.result.originalFoldersPreserved, true);
      assert.equal(res.body.result.batchInvalidated, true);
      assert.equal(res.body.result.currentBatch, null);
      assert.equal(Object.hasOwn(res.body, 'batchTask'), false);
    });

  assert.equal((await listImportedFolders()).some((record) => record.batchId === 'batch-reset-route'), false);
});

test('batch control routes require confirmation and return 404 for missing batch', async () => {
  await seedRouteControlBatch();

  await request(app)
    .delete('/api/batches/batch-control-route')
    .send({ confirm: false })
    .expect(400)
    .expect((res) => assert.match(String(res.body.error), /confirm=true/));

  await request(app)
    .post('/api/batches/missing-batch/cancel')
    .send({ confirm: true })
    .expect(404);
});
