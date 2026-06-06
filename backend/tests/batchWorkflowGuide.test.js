import assert from 'node:assert/strict';
import { test } from 'node:test';
import { getBatchGuideState } from '../../frontend/src/utils/batchWorkflowGuide.js';

function batchWithSku(status, patch = {}) {
  return {
    id: 'batch-1',
    skuTasks: [
      {
        skuId: 'sku-1',
        taskId: 'task-1',
        status,
        currentStep: status,
        ...patch
      }
    ]
  };
}

test('batch guide chooses import for an empty batch', () => {
  assert.equal(getBatchGuideState({ id: 'batch-empty', skuTasks: [] }).currentStepId, 'import');
});

test('batch guide chooses recognize for uploaded SKU after template', () => {
  assert.equal(getBatchGuideState({ ...batchWithSku('uploaded'), workflowTemplateSnapshot: { id: 'tpl' } }).currentStepId, 'recognize');
});

test('batch guide chooses confirm for recognized SKU', () => {
  assert.equal(getBatchGuideState({ ...batchWithSku('recognized'), workflowTemplateSnapshot: { id: 'tpl' } }).currentStepId, 'confirm');
});

test('batch guide chooses targets for confirmed SKU', () => {
  assert.equal(getBatchGuideState({ ...batchWithSku('confirmed'), workflowTemplateSnapshot: { id: 'tpl' } }).currentStepId, 'targets');
});

test('batch guide chooses plan generate review and export by SKU status', () => {
  assert.equal(getBatchGuideState({ ...batchWithSku('rules_selected'), workflowTemplateSnapshot: { id: 'tpl' } }).currentStepId, 'plan');
  assert.equal(getBatchGuideState({ ...batchWithSku('planned'), workflowTemplateSnapshot: { id: 'tpl' } }).currentStepId, 'generate');
  assert.equal(getBatchGuideState({ ...batchWithSku('generated'), workflowTemplateSnapshot: { id: 'tpl' } }).currentStepId, 'review');
  assert.equal(getBatchGuideState({ ...batchWithSku('reviewed'), workflowTemplateSnapshot: { id: 'tpl' } }).currentStepId, 'export');
});

test('batch guide surfaces retryable failures and user-action errors', () => {
  const retryable = getBatchGuideState({
    id: 'batch-retry',
    workflowTemplateSnapshot: { id: 'tpl' },
    skuTasks: [
      { skuId: 'sku-timeout', status: 'failed', retryable: true, lastErrorCategory: 'timeout', lastErrorCode: 'JOB_TIMEOUT' }
    ]
  });
  assert.ok(retryable.warnings.some((warning) => warning.code === 'RETRYABLE_FAILURES'));
  assert.ok(retryable.steps.find((step) => step.id === retryable.currentStepId).secondaryActions.some((action) => action.id === 'retry_failed'));

  const userAction = getBatchGuideState({
    id: 'batch-action',
    workflowTemplateSnapshot: { id: 'tpl' },
    skuTasks: [
      { skuId: 'sku-key', status: 'failed', requiresUserAction: true, lastUserActionType: 'provide_key', lastErrorCode: 'MISSING_API_KEY' }
    ]
  });
  assert.ok(userAction.warnings.some((warning) => warning.code === 'REQUIRES_USER_ACTION'));
});
