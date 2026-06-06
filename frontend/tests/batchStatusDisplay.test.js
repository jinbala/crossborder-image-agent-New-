import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  getSkuDisplayQueueHint,
  getSkuDisplayQueueStatus
} from '../src/utils/batchStatusDisplay.js';

test('blocked resume-plan SKU displays blocked instead of running', () => {
  const sku = { taskId: 'task-blocked', skuId: 'SKU-BLOCKED', queueStatus: 'running' };
  const batchResumePlan = {
    resumeGroups: {
      blocked: [{
        taskId: 'task-blocked',
        sku: 'SKU-BLOCKED',
        blockedReason: '第一阶段暂不执行识别重试，避免重复调用真实识别 Provider 或污染识别字段'
      }]
    }
  };

  const display = getSkuDisplayQueueStatus(sku, null, batchResumePlan);

  assert.equal(display.status, 'blocked');
  assert.equal(display.label, '已阻止');
  assert.equal(display.text, 'blocked / 已阻止');
  assert.notEqual(display.text, 'running');
});

test('fresh current batch SKU waiting recognition is not overridden by stale blocked resume plan', () => {
  const sku = {
    taskId: 'task-fresh',
    skuId: 'SKU-FRESH',
    status: 'uploaded',
    currentStep: 'imported',
    queueStatus: 'pending',
    sourceType: 'batch',
    rowSource: 'currentBatchTask'
  };
  const batchResumePlan = {
    resumeGroups: {
      blocked: [{
        taskId: 'task-fresh',
        sku: 'SKU-FRESH',
        blockedReason: '第一阶段暂不执行识别重试，避免重复调用真实识别 Provider 或污染识别字段。'
      }]
    }
  };

  const display = getSkuDisplayQueueStatus(sku, null, batchResumePlan);
  const hint = getSkuDisplayQueueHint(sku, null, batchResumePlan);

  assert.equal(display.status, 'pending');
  assert.equal(display.text, 'pending / 待处理');
  assert.doesNotMatch(display.text, /blocked/);
  assert.match(hint, /等待开始批量识别|真实识别可能产生 API 成本/);
  assert.doesNotMatch(hint, /第一阶段暂不执行识别重试/);
});

test('failed recognition retry SKU still displays blocked from resume plan', () => {
  const sku = {
    taskId: 'task-recognition-failed',
    skuId: 'SKU-RECOGNITION-FAILED',
    status: 'failed',
    currentStep: 'recognition',
    queueStatus: 'failed',
    sourceType: 'batch',
    rowSource: 'currentBatchTask'
  };
  const batchResumePlan = {
    resumeGroups: {
      blocked: [{
        taskId: 'task-recognition-failed',
        sku: 'SKU-RECOGNITION-FAILED',
        blockedReason: '第一阶段暂不执行识别重试，避免重复调用真实识别 Provider 或污染识别字段。'
      }]
    }
  };

  const display = getSkuDisplayQueueStatus(sku, null, batchResumePlan);

  assert.equal(display.status, 'blocked');
});

test('blocked reason is shown as a short Chinese hint', () => {
  const sku = { taskId: 'task-blocked', skuId: 'SKU-BLOCKED', queueStatus: 'running' };
  const batchResumePlan = {
    resumeGroups: {
      blocked: [{
        taskId: 'task-blocked',
        blockedReason: '第一阶段暂不执行识别重试，避免重复调用真实识别 Provider 或污染识别字段'
      }]
    }
  };

  const hint = getSkuDisplayQueueHint(sku, null, batchResumePlan);

  assert.match(hint, /^已阻止：/);
  assert.match(hint, /第一阶段暂不执行识别重试/);
});

test('missing blocked reason falls back to resume-plan hint', () => {
  const sku = { taskId: 'task-blocked', skuId: 'SKU-BLOCKED', queueStatus: 'running' };
  const batchResumePlan = {
    resumeGroups: {
      blocked: [{ taskId: 'task-blocked' }]
    }
  };

  assert.equal(
    getSkuDisplayQueueHint(sku, null, batchResumePlan),
    '已阻止：请先查看批量恢复计划'
  );
});

test('without batch resume plan keeps original queue status display', () => {
  const sku = { taskId: 'task-running', skuId: 'SKU-RUNNING', queueStatus: 'running' };

  const display = getSkuDisplayQueueStatus(sku, null, null);

  assert.equal(display.status, 'running');
  assert.equal(display.label, '运行中');
  assert.equal(display.text, 'running / 运行中');
});

test('empty or incomplete resume plan does not throw', () => {
  const sku = { taskId: 'task-running', skuId: 'SKU-RUNNING', queueStatus: 'running' };

  assert.doesNotThrow(() => getSkuDisplayQueueStatus(sku, {}, { resumeGroups: {} }));
  assert.equal(
    getSkuDisplayQueueStatus(sku, {}, { resumeGroups: {} }).text,
    'running / 运行中'
  );
});

test('scan candidate SKU displays new instead of old queue states', () => {
  const sku = { skuId: 'sku001-hard-drive', status: 'new', queueStatus: 'new', sourceType: 'scan' };

  const display = getSkuDisplayQueueStatus(sku, null, null);

  assert.equal(display.status, 'new');
  assert.equal(display.text, 'new / 可重新导入');
});

test('current batch task new status does not hide a real running queue state', () => {
  const sku = {
    taskId: 'task-running',
    skuId: 'SKU-RUNNING',
    status: 'new',
    currentStep: 'recognizing',
    queueStatus: 'running',
    sourceType: 'batch',
    rowSource: 'currentBatchTask'
  };

  const display = getSkuDisplayQueueStatus(sku, null, null);

  assert.equal(display.status, 'running');
});

test('imported elsewhere scan candidate is explicit and does not look like running batch state', () => {
  const sku = {
    skuId: 'SKU-IMPORTED',
    status: 'imported',
    queueStatus: 'imported',
    sourceType: 'scan',
    rowSource: 'importedElsewhere'
  };

  const display = getSkuDisplayQueueStatus(sku, null, null);

  assert.equal(display.status, 'imported');
  assert.match(display.text, /imported/);
  assert.doesNotMatch(display.text, /running/);
});

test('stability failure displays failed when SKU is not blocked', () => {
  const sku = { taskId: 'task-failed', skuId: 'SKU-FAILED', queueStatus: 'running' };
  const batchStabilityReport = {
    failures: [{ taskId: 'task-failed', sku: 'SKU-FAILED' }]
  };

  const display = getSkuDisplayQueueStatus(sku, batchStabilityReport, null);

  assert.equal(display.status, 'failed');
  assert.equal(display.text, 'failed / 失败');
});
