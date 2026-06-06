import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  createBatchTask,
  createTask,
  getBatchTask,
  getTask,
  listBatchTasks,
  listImportedFolders,
  markImportedFolders,
  resetDatabaseForTests
} from '../src/services/db.js';
import {
  cancelBatch,
  deleteBatch,
  resetBatchImportState
} from '../src/services/batchControlService.js';

const now = '2026-06-01T12:00:00.000Z';

async function seedControlBatch({ batchId = 'batch-control', taskId = 'task-control', folderPath } = {}) {
  await createBatchTask({
    id: batchId,
    name: 'Control Batch',
    status: 'imported',
    createdAt: now,
    updatedAt: now,
    sourceFolderPath: path.dirname(folderPath || ''),
    queue: { status: 'running', action: 'recognize', pendingJobs: 1, runningJobs: 1 },
    locks: { isRunning: true, lockedBy: 'test-lock', lockedAt: now, expiresAt: '2099-01-01T00:00:00.000Z' },
    skuTasks: [
      { skuId: 'SKU-CTRL', taskId, displayName: 'SKU-CTRL', status: 'imported', currentStep: 'imported', sourceFolderPath: folderPath }
    ]
  });
  await createTask({
    id: taskId,
    batchId,
    sku: 'SKU-CTRL',
    status: 'uploaded',
    sourceImages: [],
    productInfo: {},
    productInfoConfirmed: {}
  });
  await markImportedFolders([{
    folderPath,
    folderName: 'SKU-CTRL',
    importedAt: now,
    batchId,
    taskIds: [taskId]
  }]);
}

beforeEach(async () => {
  await resetDatabaseForTests();
});

test('cancelBatch marks current batch cancelled without deleting original SKU folder', async () => {
  const skuFolder = await fs.mkdtemp(path.join(os.tmpdir(), 'batch-control-sku-'));
  await fs.writeFile(path.join(skuFolder, 'main.jpg'), 'fake-image');
  await seedControlBatch({ folderPath: skuFolder });

  const result = await cancelBatch('batch-control');
  const batch = await getBatchTask('batch-control');

  assert.equal(result.status, 'cancelled');
  assert.equal(result.batchId, 'batch-control');
  assert.equal(result.deletedFiles, false);
  assert.equal(result.originalFoldersPreserved, true);
  assert.equal(batch.status, 'cancelled');
  assert.equal(batch.queue.status, 'cancelled');
  assert.equal(batch.locks.isRunning, false);
  assert.equal(await fs.stat(path.join(skuFolder, 'main.jpg')).then((stat) => stat.isFile()), true);
});

test('deleteBatch removes only the selected batch task records and imported flags', async () => {
  const firstFolder = await fs.mkdtemp(path.join(os.tmpdir(), 'batch-control-delete-a-'));
  const secondFolder = await fs.mkdtemp(path.join(os.tmpdir(), 'batch-control-delete-b-'));
  await fs.writeFile(path.join(firstFolder, 'main.jpg'), 'fake-image');
  await fs.writeFile(path.join(secondFolder, 'main.jpg'), 'fake-image');
  await seedControlBatch({ batchId: 'batch-delete-a', taskId: 'task-delete-a', folderPath: firstFolder });
  await seedControlBatch({ batchId: 'batch-delete-b', taskId: 'task-delete-b', folderPath: secondFolder });

  const result = await deleteBatch('batch-delete-a');

  assert.equal(result.status, 'deleted');
  assert.equal(result.affectedSku, 1);
  assert.equal(result.deletedFiles, false);
  assert.equal(result.originalFoldersPreserved, true);
  assert.equal(result.clearClientState, true);
  assert.equal(result.clearClientReports, true);
  assert.equal(result.batchInvalidated, true);
  assert.equal(result.currentBatch, null);
  assert.equal(Object.hasOwn(result, 'batchTask'), false);
  assert.equal(await getBatchTask('batch-delete-a'), null);
  assert.equal(await getTask('task-delete-a'), null);
  assert.notEqual(await getBatchTask('batch-delete-b'), null);
  assert.notEqual(await getTask('task-delete-b'), null);
  assert.equal((await listBatchTasks()).some((batch) => batch.id === 'batch-delete-a'), false);
  assert.equal((await listImportedFolders()).some((record) => record.batchId === 'batch-delete-a'), false);
  assert.equal((await listImportedFolders()).some((record) => record.batchId === 'batch-delete-b'), true);
  assert.equal(await fs.stat(path.join(firstFolder, 'main.jpg')).then((stat) => stat.isFile()), true);
});

test('resetBatchImportState clears imported folder flags so SKU can be scanned as new again', async () => {
  const skuFolder = await fs.mkdtemp(path.join(os.tmpdir(), 'batch-control-reset-'));
  await seedControlBatch({ folderPath: skuFolder });

  const result = await resetBatchImportState('batch-control');

  assert.equal(result.status, 'reset');
  assert.equal(result.affectedSku, 1);
  assert.equal(result.deletedFiles, false);
  assert.equal(result.originalFoldersPreserved, true);
  assert.equal(result.clearClientState, true);
  assert.equal(result.clearClientReports, true);
  assert.equal(result.batchInvalidated, true);
  assert.equal(result.currentBatch, null);
  assert.equal(Object.hasOwn(result, 'batchTask'), false);
  assert.match(result.nextSuggestedAction, /SKU/);
  assert.deepEqual(result.clearClientReportKeys, [
    'batchStabilityReport',
    'batchResumePlan',
    'batchReviewReport',
    'exportPackagePreview',
    'listingCsvPreview',
    'uploadReadinessReport',
    'uploadPayloadPreview',
    'sandboxReport'
  ]);
  assert.equal((await listImportedFolders()).some((record) => record.batchId === 'batch-control'), false);
  assert.equal((await getBatchTask('batch-control')).importResetAt !== undefined, true);
});

test('batch control operations return reasonable errors for missing batch', async () => {
  await assert.rejects(cancelBatch('missing-batch'), /Batch task not found/);
  await assert.rejects(deleteBatch('missing-batch'), /Batch task not found/);
  await assert.rejects(resetBatchImportState('missing-batch'), /Batch task not found/);
});
