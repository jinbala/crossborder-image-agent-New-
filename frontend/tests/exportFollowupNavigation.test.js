import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildExportFollowupNavigation,
  findBatchContainingTask
} from '../src/utils/exportFollowupNavigation.js';

test('export follow-up navigation links to next pending confirmation SKU and queue', () => {
  const task = { id: 'task-exported', batchId: 'batch-1', status: 'exported' };
  const batches = [{
    id: 'batch-1',
    skuTasks: [
      { taskId: 'task-exported', skuId: 'sku001', status: 'exported' },
      { taskId: 'task-next', skuId: 'sku002', status: 'recognized' },
      { taskId: 'task-later', skuId: 'sku003', currentStep: 'waiting_confirm' }
    ]
  }];

  const navigation = buildExportFollowupNavigation({ task, batches });

  assert.equal(navigation.batchId, 'batch-1');
  assert.equal(navigation.pendingCount, 2);
  assert.equal(navigation.nextPendingSku.skuId, 'sku002');
  assert.equal(navigation.nextPendingUrl, '/tasks/task-next/product');
  assert.equal(navigation.pendingQueueUrl, '/batches/batch-1?focus=confirm');
});

test('export follow-up navigation can find batch even when task has no batchId', () => {
  const task = { id: 'task-exported', status: 'exported' };
  const batches = [{
    id: 'batch-2',
    skuTasks: [
      { taskId: 'task-exported', skuId: 'sku001', status: 'exported' },
      { taskId: 'task-next', skuId: 'sku002', currentStep: 'waiting_confirm' }
    ]
  }];

  const batch = findBatchContainingTask({ task, batches });
  const navigation = buildExportFollowupNavigation({ task, batches });

  assert.equal(batch.id, 'batch-2');
  assert.equal(navigation.nextPendingUrl, '/tasks/task-next/product');
  assert.equal(navigation.pendingQueueUrl, '/batches/batch-2?focus=confirm');
});

test('export follow-up navigation hides next SKU link when no pending confirmation remains', () => {
  const task = { id: 'task-exported', batchId: 'batch-1' };
  const batches = [{
    id: 'batch-1',
    skuTasks: [
      { taskId: 'task-exported', skuId: 'sku001', status: 'exported' },
      { taskId: 'task-done', skuId: 'sku002', status: 'reviewed' }
    ]
  }];

  const navigation = buildExportFollowupNavigation({ task, batches });

  assert.equal(navigation.pendingCount, 0);
  assert.equal(navigation.nextPendingSku, null);
  assert.equal(navigation.nextPendingUrl, '');
  assert.equal(navigation.pendingQueueUrl, '/batches/batch-1?focus=confirm');
});
