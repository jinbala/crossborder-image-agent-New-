import assert from 'node:assert/strict';
import { test } from 'node:test';
import { executeApprovedAutoFixPlan } from '../src/services/autoFixExecutionService.js';

function planAction(overrides = {}) {
  return {
    actionId: 'plan-001',
    sourceSuggestionId: 'fix-001',
    issueCode: 'CHINESE_TEXT_DETECTED',
    actionType: 'removeText',
    target: {
      imageType: 'feature_image',
      fieldKey: null,
      textBlockId: null,
      scope: 'imagePlan'
    },
    title: '删除中文文案',
    description: '删除图片文案中的中文。',
    dryRunOnly: true,
    canExecuteLater: true,
    requiresManualConfirm: false,
    riskLevel: 'low',
    previewChange: { before: '中文文案', after: '', changeType: 'remove' },
    ...overrides
  };
}

function autoFixPlan(overrides = {}) {
  return {
    meta: { taskId: 'exec-task', mode: 'dryRun', source: 'fixSuggestions', planVersion: 'v1' },
    plannedActions: [
      planAction({
        actionId: 'plan-remove-text',
        actionType: 'removeText',
        issueCode: 'CHINESE_TEXT_DETECTED',
        target: { imageType: 'feature_image', textBlockId: 'feature-cn', scope: 'imagePlan' }
      }),
      planAction({
        actionId: 'plan-remove-claim',
        actionType: 'removeClaim',
        issueCode: 'UNVERIFIED_CLAIM',
        target: { imageType: 'detail_image', textBlockId: 'claim-1', scope: 'imagePlan' },
        title: '删除无证据 claim'
      }),
      planAction({
        actionId: 'plan-main-layout',
        actionType: 'editTextLayout',
        issueCode: 'MAIN_IMAGE_TEXT',
        target: { imageType: 'main_image', scope: 'imagePlan' },
        title: '清空 Amazon 主图文字'
      })
    ],
    blockedActions: [
      { actionId: 'blocked-field', actionType: 'confirmFieldEvidence', fieldKey: 'capacity', title: '确认容量证据' }
    ],
    manualActions: [
      { actionId: 'manual-check', actionType: 'manualCheck', title: '人工复查接口冲突' }
    ],
    mockOnlyActions: [
      { actionId: 'mock-only', actionType: 'skipMockOnly', title: 'mock 提示' }
    ],
    noActionNeededActions: [
      { actionId: 'none-1', actionType: 'noActionNeeded', title: '无需处理' }
    ],
    ...overrides
  };
}

function task(overrides = {}) {
  return {
    id: 'exec-task',
    platformId: 'amazon',
    productInfoConfirmed: { sku: 'EXEC-001', name: 'Portable Drive' },
    recognitionQuality: { status: 'exists' },
    fieldEvidence: { capacity: [{ source: 'ocr', text: '1TB' }] },
    generatedImages: [{ id: 'img-main', type: 'main_image', planId: 'main-plan', fileName: 'main.png' }],
    imagePlans: [
      {
        id: 'feature-plan',
        type: 'feature_image',
        textBlocks: [
          { id: 'feature-cn', text: '中文卖点' },
          { id: 'feature-safe', text: 'Fast transfer' }
        ],
        textLayout: {
          textElements: [
            { id: 'feature-cn', text: '中文卖点' },
            { id: 'feature-safe', text: 'Fast transfer' }
          ]
        }
      },
      {
        id: 'detail-plan',
        type: 'detail_image',
        textBlocks: [
          { id: 'claim-1', text: 'Best No.1 Guaranteed speed' },
          { id: 'detail-safe', text: 'Aluminum shell' }
        ],
        textLayout: {
          textElements: [
            { id: 'claim-1', text: 'Best No.1 Guaranteed speed' },
            { id: 'detail-safe', text: 'Aluminum shell' }
          ]
        }
      },
      {
        id: 'main-plan',
        type: 'main_image',
        platformId: 'amazon',
        textBlocks: [{ id: 'main-text', text: 'Main image text' }],
        textLayout: {
          textElements: [{ id: 'main-text', text: 'Main image text' }]
        }
      }
    ],
    ...overrides
  };
}

test('executeApprovedAutoFixPlan requires explicit confirmation and approved actions', () => {
  assert.throws(() => executeApprovedAutoFixPlan({
    task: task(),
    autoFixPlan: autoFixPlan(),
    approvedActionIds: ['plan-remove-text'],
    options: { confirmExecute: false }
  }), /confirmExecute=true/);

  assert.throws(() => executeApprovedAutoFixPlan({
    task: task(),
    autoFixPlan: autoFixPlan(),
    approvedActionIds: [],
    options: { confirmExecute: true }
  }), /approvedActionIds/);
});

test('executes allowlisted text fixes and returns diff without mutating source task', () => {
  const sourceTask = task();
  const before = structuredClone(sourceTask);
  const result = executeApprovedAutoFixPlan({
    task: sourceTask,
    autoFixPlan: autoFixPlan(),
    approvedActionIds: ['plan-remove-text', 'plan-remove-claim', 'plan-main-layout', 'blocked-field', 'manual-check', 'mock-only', 'none-1', 'missing-action'],
    options: { confirmExecute: true, mode: 'textLayoutOnly', dryRun: false }
  });

  assert.equal(result.status, 'completed');
  assert.equal(result.summary.approvedCount, 8);
  assert.equal(result.summary.executedCount, 3);
  assert.equal(result.summary.savedCount, 0);
  assert.equal(result.summary.blockedCount, 2);
  assert.equal(result.summary.skippedCount, 3);
  assert.equal(result.persisted, false);
  assert.equal(result.savedAt, null);
  assert.ok(result.beforeSnapshot.imagePlanSummary);
  assert.ok(result.afterSnapshot.imagePlanSummary);
  assert.deepEqual(result.savedImagePlans, []);
  assert.equal(result.executedActions.map((item) => item.actionType).join(','), 'removeText,removeClaim,editTextLayout');
  assert.equal(result.blockedActions.some((item) => item.actionId === 'blocked-field'), true);
  assert.equal(result.blockedActions.some((item) => item.actionId === 'manual-check'), true);
  assert.equal(result.skippedActions.some((item) => item.actionId === 'mock-only'), true);
  assert.equal(result.skippedActions.some((item) => item.actionId === 'none-1'), true);
  assert.equal(result.skippedActions.some((item) => item.actionId === 'missing-action'), true);
  assert.equal(result.diff.length >= 3, true);
  assert.equal(result.diff.some((item) => item.changeType === 'removeTextBlock' && item.before === '中文卖点'), true);
  assert.equal(result.diff.some((item) => item.changeType === 'removePhrase' && /Best/.test(item.before)), true);
  assert.equal(result.diff.some((item) => item.changeType === 'clearMainImageText' && item.imageType === 'main_image'), true);
  assert.equal(result.patchedImagePlans.find((item) => item.id === 'feature-plan').textBlocks.some((block) => block.id === 'feature-cn'), false);
  assert.equal(result.patchedImagePlans.find((item) => item.id === 'detail-plan').textBlocks[0].text, 'speed');
  assert.deepEqual(result.patchedImagePlans.find((item) => item.id === 'main-plan').textBlocks, []);
  assert.deepEqual(result.patchedImagePlans.find((item) => item.id === 'main-plan').textLayout.textElements, []);
  assert.deepEqual(sourceTask, before);
  assert.deepEqual(sourceTask.productInfoConfirmed, before.productInfoConfirmed);
  assert.deepEqual(sourceTask.recognitionQuality, before.recognitionQuality);
  assert.deepEqual(sourceTask.fieldEvidence, before.fieldEvidence);
  assert.deepEqual(sourceTask.generatedImages, before.generatedImages);
});

test('preview execution stays unpersisted unless persist and confirmSave are both true', () => {
  const preview = executeApprovedAutoFixPlan({
    task: task(),
    autoFixPlan: autoFixPlan(),
    approvedActionIds: ['plan-remove-text'],
    options: { confirmExecute: true, persist: false }
  });

  assert.equal(preview.persisted, false);
  assert.equal(preview.summary.savedCount, 0);
  assert.deepEqual(preview.savedImagePlans, []);
  assert.match(preview.nextSuggestedAction, /尚未写入|灏氭湭鍐欏叆/);
});

test('persist intent result includes manual post-fix validation guidance without mutating task data', () => {
  const sourceTask = task();
  const before = structuredClone(sourceTask);
  const result = executeApprovedAutoFixPlan({
    task: sourceTask,
    autoFixPlan: autoFixPlan(),
    approvedActionIds: ['plan-remove-text'],
    options: { confirmExecute: true, confirmSave: true, persist: true }
  });

  assert.equal(result.summary.executedCount, 1);
  assert.equal(result.persisted, false);
  assert.equal(result.postFixStatus.persisted, false);
  assert.equal(result.postFixStatus.autoRegenerateTriggered, false);
  assert.equal(result.postFixStatus.autoReviewTriggered, false);
  assert.equal(result.nextValidationChecklist.shouldRegenerateMock, false);
  assert.equal(result.nextValidationChecklist.shouldRunReviewAgain, false);
  assert.ok(Array.isArray(result.nextValidationChecklist.manualSteps));
  assert.ok(Array.isArray(result.nextValidationChecklist.expectedImprovements));
  assert.deepEqual(sourceTask.generatedImages, before.generatedImages);
  assert.deepEqual(sourceTask.review, before.review);
  assert.deepEqual(sourceTask, before);
});

test('service rejects save intent without confirmSave=true', () => {
  assert.throws(() => executeApprovedAutoFixPlan({
    task: task(),
    autoFixPlan: autoFixPlan(),
    approvedActionIds: ['plan-remove-text'],
    options: { confirmExecute: true, persist: true, confirmSave: false }
  }), /confirmSave=true/);
});

test('blocks unsafe editTextLayout and sanitizes execution result', () => {
  const result = executeApprovedAutoFixPlan({
    task: task({
      platformId: 'amazon',
      imagePlans: [
        {
          id: 'feature-plan',
          type: 'feature_image',
          textBlocks: [{ id: 'feature-text', text: 'API_KEY=abc sk-secret D:\\Code\\.env app.sqlite node_modules' }],
          textLayout: { textElements: [{ id: 'feature-text', text: 'API_KEY=abc sk-secret D:\\Code\\.env app.sqlite node_modules' }] }
        }
      ]
    }),
    autoFixPlan: autoFixPlan({
      plannedActions: [
        planAction({
          actionId: 'plan-unsafe-layout',
          actionType: 'editTextLayout',
          target: { imageType: 'feature_image', scope: 'imagePlan' }
        }),
        planAction({
          actionId: 'plan-secret',
          actionType: 'removeText',
          target: { imageType: 'feature_image', textBlockId: 'feature-text', scope: 'imagePlan' }
        })
      ]
    }),
    approvedActionIds: ['plan-unsafe-layout', 'plan-secret'],
    options: { confirmExecute: true, mode: 'textLayoutOnly' }
  });
  const json = JSON.stringify(result);

  assert.equal(result.blockedActions.some((item) => item.actionId === 'plan-unsafe-layout'), true);
  assert.equal(result.executedActions.some((item) => item.actionId === 'plan-secret'), true);
  assert.doesNotMatch(json, /\.env/i);
  assert.doesNotMatch(json, /API_KEY/i);
  assert.doesNotMatch(json, /sk-secret/i);
  assert.doesNotMatch(json, /[A-Z]:\\/);
  assert.doesNotMatch(json, /app\.sqlite/i);
  assert.doesNotMatch(json, /node_modules/i);
});
