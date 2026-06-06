import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import {
  buildBatchListRowsForBatchPage,
  buildSkuListRows,
  buildSkuRowsForBatchPage,
  batchControlStateTransition,
  resetImportActionMode,
  shouldApplyBatchScopedResponse,
  shouldShowResetImportStatusAction,
  shouldRenderScanCandidates
} from '../src/utils/batchControlState.js';

test('reset import transition clears current batch and stale reports from BatchPage display', () => {
  const transition = batchControlStateTransition('batch-reset-import', {
    result: {
      status: 'reset',
      clearClientState: true
    },
    batchTask: {
      id: 'old-batch',
      skuTasks: [{ skuId: 'sku001-hard-drive', queueStatus: 'running' }]
    }
  });

  assert.equal(transition.clearCurrentBatch, true);
  assert.equal(transition.navigateToBatchList, true);
  assert.equal(transition.clearSkuTasks, true);
  assert.equal(transition.clearReports, true);
  assert.equal(transition.feedback, '导入状态已重置，请重新扫描目录并重新导入 SKU。');
});

test('delete batch transition removes current batch and clears stale SKU/report state', () => {
  const transition = batchControlStateTransition('batch-delete', {
    result: {
      status: 'deleted',
      clearClientState: true
    }
  });

  assert.equal(transition.clearCurrentBatch, true);
  assert.equal(transition.navigateToBatchList, true);
  assert.equal(transition.clearSkuTasks, true);
  assert.equal(transition.clearReports, true);
  assert.equal(transition.feedback, 'batch 记录已删除，本地图片未删除。');
});

test('scan candidates render when reset/import control cleared the current batch', () => {
  assert.equal(shouldRenderScanCandidates(null), true);
  assert.equal(shouldRenderScanCandidates({ id: 'active-batch', skuTasks: [] }), false);
});

test('after delete and rescan SKU list rows mirror scan candidates as new without old blocked state', () => {
  const rows = buildSkuListRows({
    batchTask: null,
    scanResult: {
      candidates: [{
        skuId: 'sku001-hard-drive',
        displayName: 'sku001-hard-drive',
        folderName: 'sku001-hard-drive',
        folderPath: 'D:/import/sku001-hard-drive',
        imageCount: 3,
        status: 'new'
      }]
    }
  });

  assert.equal(rows.length, 1);
  assert.equal(rows[0].skuId, 'sku001-hard-drive');
  assert.equal(rows[0].status, 'new');
  assert.equal(rows[0].queueStatus, 'new');
  assert.equal(rows[0].currentStep, 'new');
  assert.equal(rows[0].sourceType, 'scan');
  assert.equal(rows[0].rowSource, 'scanCandidate');
  assert.equal(rows[0].taskId, null);
});

test('active batch rows take priority over scan rows until reset or delete clears the batch', () => {
  const rows = buildSkuListRows({
    batchTask: {
      id: 'active-batch',
      skuTasks: [{ skuId: 'sku001-hard-drive', status: 'imported', queueStatus: 'blocked' }]
    },
    scanResult: {
      candidates: [{ skuId: 'sku001-hard-drive', status: 'new' }]
    }
  });

  assert.equal(rows.length, 1);
  assert.equal(rows[0].sourceType, 'batch');
  assert.equal(rows[0].rowSource, 'currentBatchTask');
  assert.equal(rows[0].queueStatus, 'blocked');
});

test('imported scan candidates are marked as imported elsewhere instead of current batch SKU', () => {
  const rows = buildSkuRowsForBatchPage({
    batchTask: null,
    scanResult: {
      candidates: [{
        skuId: 'sku002',
        folderPath: 'D:/import/sku002',
        imageCount: 2,
        status: 'imported',
        existingBatchId: 'other-batch',
        existingTaskId: 'other-task'
      }]
    }
  });

  assert.equal(rows.length, 1);
  assert.equal(rows[0].sourceType, 'scan');
  assert.equal(rows[0].rowSource, 'importedElsewhere');
  assert.equal(rows[0].status, 'imported');
  assert.equal(rows[0].queueStatus, 'imported');
  assert.match(rows[0].displayHint, /batch|已导入|宸插鍏/);
});

test('batch scoped async responses are ignored after batch invalidation or id change', () => {
  assert.equal(shouldApplyBatchScopedResponse({
    requestBatchId: 'batch-1',
    currentBatchId: 'batch-1',
    requestGeneration: 2,
    currentGeneration: 2,
    batchInvalidated: false
  }), true);

  assert.equal(shouldApplyBatchScopedResponse({
    requestBatchId: 'batch-1',
    currentBatchId: '',
    requestGeneration: 2,
    currentGeneration: 3,
    batchInvalidated: true
  }), false);

  assert.equal(shouldApplyBatchScopedResponse({
    requestBatchId: 'batch-1',
    currentBatchId: 'batch-2',
    requestGeneration: 2,
    currentGeneration: 2,
    batchInvalidated: false
  }), false);
});

test('current imported batch is shown in batch list even before listBatches refresh returns', () => {
  const rows = buildBatchListRowsForBatchPage({
    batches: [],
    batchTask: {
      id: 'batch-real-test',
      name: 'real-test batch',
      status: 'imported',
      workflowTemplateSnapshot: {
        id: 'real_api_small_batch_test',
        name: '真实 API 小批量测试（系统）'
      },
      summary: {
        totalSku: 1,
        waitingConfirmSku: 1,
        failedSku: 0,
        completedSku: 0
      },
      skuTasks: [{ skuId: 'sku001-hard-drive' }]
    }
  });

  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, 'batch-real-test');
  assert.equal(rows[0].summary.totalSku, 1);
  assert.equal(rows[0].templateName, '真实 API 小批量测试（系统）');
  assert.equal(rows[0].isCurrentBatch, true);
});

test('current batch list fallback does not include unselected scan candidates', () => {
  const rows = buildBatchListRowsForBatchPage({
    batches: [],
    batchTask: {
      id: 'batch-one-sku',
      name: 'Only selected SKU',
      status: 'imported',
      skuTasks: [{ skuId: 'sku001-hard-drive' }]
    }
  });

  assert.equal(rows[0].summary.totalSku, 1);
  assert.equal(rows[0].skuIds.includes('sku001-hard-drive'), true);
  assert.equal(rows[0].skuIds.includes('sku002-hard-drive'), false);
});

test('batch list replaces stale row with current batch details when ids match', () => {
  const rows = buildBatchListRowsForBatchPage({
    batches: [{
      id: 'batch-real-test',
      name: 'old row',
      status: 'pending',
      summary: { totalSku: 0 }
    }],
    batchTask: {
      id: 'batch-real-test',
      name: 'fresh row',
      status: 'imported',
      workflowTemplateSnapshot: { name: '真实 API 小批量测试（系统）' },
      skuTasks: [{ skuId: 'sku001-hard-drive' }]
    }
  });

  assert.equal(rows.length, 1);
  assert.equal(rows[0].name, 'fresh row');
  assert.equal(rows[0].summary.totalSku, 1);
  assert.equal(rows[0].templateName, '真实 API 小批量测试（系统）');
});

test('reset import action remains visible after delete when scan candidates exist', () => {
  const state = {
    batchTask: null,
    scanResult: { candidates: [{ skuId: 'sku001-hard-drive', status: 'new' }] }
  };

  assert.equal(shouldShowResetImportStatusAction(state), true);
  assert.equal(resetImportActionMode(state), 'refresh-scan');
});

test('reset import action calls backend only when current batch exists', () => {
  assert.equal(shouldShowResetImportStatusAction({
    batchTask: { id: 'batch-1' },
    scanResult: null
  }), true);
  assert.equal(resetImportActionMode({
    batchTask: { id: 'batch-1' },
    scanResult: null
  }), 'reset-current-batch');

  assert.equal(shouldShowResetImportStatusAction({ batchTask: null, scanResult: { candidates: [] } }), false);
  assert.equal(resetImportActionMode({ batchTask: null, scanResult: { candidates: [] } }), 'hidden');
});

test('BatchPage uses batch control state transition before rendering stale SKU rows', () => {
  const pageSource = fs.readFileSync(path.resolve('src/pages/BatchPage.jsx'), 'utf8');

  assert.match(pageSource, /batchControlStateTransition/);
  assert.match(pageSource, /buildBatchListRowsForBatchPage/);
  assert.match(pageSource, /buildSkuRowsForBatchPage/);
  assert.match(pageSource, /shouldShowResetImportStatusAction/);
  assert.match(pageSource, /resetImportActionMode/);
  assert.match(pageSource, /shouldApplyBatchScopedResponse/);
  assert.match(pageSource, /skuListRows/);
  assert.match(pageSource, /batchInvalidated/);
  assert.match(pageSource, /clearCurrentBatch/);
  assert.match(pageSource, /setBatchStabilityReport\(null\)/);
  assert.match(pageSource, /setBatchResumePlan\(null\)/);
  assert.match(pageSource, /setExportPackagePreview\(null\)/);
  assert.match(pageSource, /setUploadReadinessReport\(null\)/);
});
