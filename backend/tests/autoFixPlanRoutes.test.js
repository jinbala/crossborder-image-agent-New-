import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import request from 'supertest';
import app from '../src/app.js';
import { createTask, getTask, resetDatabaseForTests } from '../src/services/db.js';

function reviewTask(overrides = {}) {
  return {
    id: 'auto-fix-route-task',
    status: 'reviewed',
    platformId: 'amazon',
    categoryId: 'electronics_storage',
    productInfoConfirmed: {
      sku: 'AF-ROUTE-001',
      name: 'Portable Drive'
    },
    imagePlans: [
      {
        id: 'plan-feature',
        type: 'feature_image',
        textLayout: { blocks: [{ id: 'text-1', text: '中文文案' }] }
      }
    ],
    generatedImages: [
      {
        id: 'img-feature',
        planId: 'plan-feature',
        type: 'feature_image',
        fileName: 'feature.png'
      }
    ],
    review: {
      reviewedAt: '2026-06-01T12:00:00.000Z',
      reviewMode: 'mock',
      overallStatus: 'failed',
      items: [
        {
          imageId: 'img-feature',
          type: 'feature_image',
          issues: [
            { type: 'chinese_text', category: 'text', level: 'high', message: 'Chinese text detected' },
            { type: 'unconfirmed_capacity', category: 'evidence', level: 'high', fieldKey: 'capacity', fieldLabel: '容量', message: 'Capacity evidence missing D:\\Code\\.env OPENAI_API_KEY=sk-secret app.sqlite node_modules' }
          ]
        }
      ]
    },
    ...overrides
  };
}

beforeEach(async () => {
  await resetDatabaseForTests();
});

test('GET /api/tasks/:id/auto-fix-plan returns a read-only dry-run plan', async () => {
  await createTask(reviewTask());
  const before = await getTask('auto-fix-route-task');

  await request(app)
    .get('/api/tasks/auto-fix-route-task/auto-fix-plan')
    .expect(200)
    .expect((res) => {
      assert.equal(res.body.autoFixPlan.meta.taskId, 'auto-fix-route-task');
      assert.equal(res.body.autoFixPlan.meta.mode, 'dryRun');
      assert.equal(res.body.autoFixPlan.summary.plannedActionCount >= 1, true);
      assert.equal(res.body.autoFixPlan.summary.blockedActionCount >= 1, true);
      assert.equal(res.body.autoFixPlan.plannedActions.some((item) => item.actionType === 'removeText'), true);
      assert.equal(res.body.autoFixPlan.blockedActions.some((item) => item.actionType === 'confirmFieldEvidence'), true);
      assert.equal(res.body.autoFixPlan.plannedActions.every((item) => item.dryRunOnly === true), true);
      assert.match(res.body.autoFixPlan.nextSuggestedAction, /不会修改任何图片方案或生成结果/);
    });

  const after = await getTask('auto-fix-route-task');
  assert.deepEqual(after.imagePlans, before.imagePlans);
  assert.deepEqual(after.generatedImages, before.generatedImages);
  assert.deepEqual(after.review, before.review);
});

test('auto-fix-plan API returns empty plan when review is missing and sanitizes output', async () => {
  await createTask(reviewTask({
    review: null,
    productInfoConfirmed: {
      sku: 'AF-ROUTE-002',
      name: 'OPENAI_API_KEY=sk-secret C:\\Users\\secret\\.env app.sqlite node_modules'
    }
  }));

  await request(app)
    .get('/api/tasks/auto-fix-route-task/auto-fix-plan')
    .expect(200)
    .expect((res) => {
      assert.equal(res.body.autoFixPlan.summary.totalFixSuggestions, 0);
      assert.match(res.body.autoFixPlan.warnings.join('\n'), /暂无可生成修正计划的审核报告/);
      const json = JSON.stringify(res.body);
      assert.doesNotMatch(json, /\.env/i);
      assert.doesNotMatch(json, /OPENAI_API_KEY/i);
      assert.doesNotMatch(json, /sk-secret/i);
      assert.doesNotMatch(json, /[A-Z]:\\/);
      assert.doesNotMatch(json, /app\.sqlite/i);
      assert.doesNotMatch(json, /node_modules/i);
    });
});

test('auto-fix-plan API returns 404 for missing task', async () => {
  await request(app)
    .get('/api/tasks/not-found/auto-fix-plan')
    .expect(404);
});

test('POST /api/tasks/:id/auto-fix-plan/execute requires confirmation and returns dry text execution result without mutating task', async () => {
  await createTask(reviewTask({
    imagePlans: [
      {
        id: 'feature-plan',
        type: 'feature_image',
        textBlocks: [
          { id: 'feature-cn', text: '中文文案' },
          { id: 'feature-safe', text: 'Fast transfer' }
        ],
        textLayout: {
          textElements: [
            { id: 'feature-cn', text: '中文文案' },
            { id: 'feature-safe', text: 'Fast transfer' }
          ]
        }
      }
    ],
    generatedImages: [
      { id: 'img-feature', planId: 'feature-plan', type: 'feature_image', fileName: 'feature.png' }
    ]
  }));
  const planResponse = await request(app).get('/api/tasks/auto-fix-route-task/auto-fix-plan').expect(200);
  const approvedActionId = planResponse.body.autoFixPlan.plannedActions.find((item) => item.actionType === 'removeText')?.actionId;
  const before = await getTask('auto-fix-route-task');

  await request(app)
    .post('/api/tasks/auto-fix-route-task/auto-fix-plan/execute')
    .send({ approvedActionIds: [approvedActionId], confirmExecute: false, mode: 'textLayoutOnly' })
    .expect(400);

  await request(app)
    .post('/api/tasks/auto-fix-route-task/auto-fix-plan/execute')
    .send({ approvedActionIds: [approvedActionId], confirmExecute: true, mode: 'textLayoutOnly' })
    .expect(200)
    .expect((res) => {
      assert.equal(res.body.executionResult.summary.executedCount, 1);
      assert.equal(res.body.executionResult.executedActions[0].actionType, 'removeText');
      assert.equal(res.body.executionResult.diff.some((item) => item.changeType === 'removeTextBlock'), true);
      assert.ok(Array.isArray(res.body.executionResult.patchedImagePlans));
      assert.match(res.body.executionResult.nextSuggestedAction, /局部修正结果预览|重新生成 mock/);
    });

  const after = await getTask('auto-fix-route-task');
  assert.deepEqual(after.imagePlans, before.imagePlans);
  assert.deepEqual(after.generatedImages, before.generatedImages);
  assert.deepEqual(after.productInfoConfirmed, before.productInfoConfirmed);
});

test('POST /api/tasks/:id/auto-fix-plan/execute persists only imagePlans after confirmSave', async () => {
  await createTask(reviewTask({
    productInfoConfirmed: { sku: 'AF-ROUTE-003', name: 'Portable Drive' },
    recognitionQuality: { status: 'reviewed' },
    fieldEvidence: { capacity: [{ source: 'ocr', text: '1TB' }] },
    visibleText: ['1TB'],
    risks: [{ field: 'capacity', level: 'medium' }],
    imagePlans: [
      {
        id: 'feature-plan',
        type: 'feature_image',
        textBlocks: [
          { id: 'feature-cn', text: '中文文案' },
          { id: 'feature-safe', text: 'Fast transfer' }
        ],
        textLayout: {
          textElements: [
            { id: 'feature-cn', text: '中文文案' },
            { id: 'feature-safe', text: 'Fast transfer' }
          ]
        }
      }
    ],
    generatedImages: [
      { id: 'img-feature', planId: 'feature-plan', type: 'feature_image', fileName: 'feature.png' }
    ],
    review: {
      reviewedAt: '2026-06-01T12:00:00.000Z',
      reviewMode: 'mock',
      overallStatus: 'failed',
      items: [
        {
          imageId: 'img-feature',
          type: 'feature_image',
          issues: [
            { type: 'chinese_text', category: 'text', level: 'high', message: 'Chinese text detected' },
            { type: 'unconfirmed_capacity', category: 'evidence', level: 'high', fieldKey: 'capacity', fieldLabel: '容量', message: 'Capacity evidence missing' }
          ]
        }
      ]
    }
  }));
  const planResponse = await request(app).get('/api/tasks/auto-fix-route-task/auto-fix-plan').expect(200);
  const removeTextId = planResponse.body.autoFixPlan.plannedActions.find((item) => item.actionType === 'removeText')?.actionId;
  const blockedId = planResponse.body.autoFixPlan.blockedActions.find((item) => item.actionType === 'confirmFieldEvidence')?.actionId;
  const before = await getTask('auto-fix-route-task');

  await request(app)
    .post('/api/tasks/auto-fix-route-task/auto-fix-plan/execute')
    .send({ approvedActionIds: [removeTextId], confirmExecute: true, confirmSave: false, persist: true, mode: 'textLayoutOnly' })
    .expect(400);

  await request(app)
    .post('/api/tasks/auto-fix-route-task/auto-fix-plan/execute')
    .send({ approvedActionIds: [removeTextId, blockedId], confirmExecute: true, confirmSave: true, persist: true, mode: 'textLayoutOnly' })
    .expect(200)
    .expect((res) => {
      assert.equal(res.body.executionResult.persisted, true);
      assert.equal(res.body.executionResult.summary.savedCount, 1);
      assert.equal(res.body.executionResult.blockedActions.some((item) => item.actionType === 'confirmFieldEvidence'), true);
      assert.equal(res.body.executionResult.savedImagePlans.length, 1);
      assert.ok(res.body.executionResult.savedAt);
      assert.ok(res.body.executionResult.beforeSnapshot.imagePlanSummary);
      assert.ok(res.body.executionResult.afterSnapshot.imagePlanSummary);
      assert.match(res.body.executionResult.nextSuggestedAction, /重新生成 mock|閲嶆柊鐢熸垚 mock/);
    });

  const after = await getTask('auto-fix-route-task');
  assert.equal(after.imagePlans[0].textBlocks.some((block) => block.id === 'feature-cn'), false);
  assert.equal(after.imagePlans[0].textLayout.textElements.some((element) => element.id === 'feature-cn'), false);
  assert.deepEqual(after.productInfoConfirmed, before.productInfoConfirmed);
  assert.deepEqual(after.recognitionQuality, before.recognitionQuality);
  assert.deepEqual(after.fieldEvidence, before.fieldEvidence);
  assert.deepEqual(after.visibleText, before.visibleText);
  assert.deepEqual(after.risks, before.risks);
  assert.deepEqual(after.generatedImages, before.generatedImages);
  assert.deepEqual(after.review, before.review);
  assert.equal(after.status, before.status);
});

test('POST /api/tasks/:id/auto-fix-plan/execute returns post-fix validation checklist after confirmed save', async () => {
  await createTask(reviewTask({
    id: 'auto-fix-validation-task',
    imagePlans: [
      {
        id: 'feature-plan',
        type: 'feature_image',
        textBlocks: [
          { id: 'feature-cn', text: '中文文案' },
          { id: 'feature-safe', text: 'Fast transfer' }
        ],
        textLayout: {
          textElements: [
            { id: 'feature-cn', text: '中文文案' },
            { id: 'feature-safe', text: 'Fast transfer' }
          ]
        }
      }
    ],
    generatedImages: [
      { id: 'img-feature', planId: 'feature-plan', type: 'feature_image', fileName: 'feature.png' }
    ],
    review: {
      reviewedAt: '2026-06-01T12:00:00.000Z',
      reviewMode: 'mock',
      overallStatus: 'failed',
      items: [
        {
          imageId: 'img-feature',
          type: 'feature_image',
          issues: [{ type: 'chinese_text', category: 'text', level: 'high', message: 'Chinese text detected' }]
        }
      ]
    }
  }));
  const planResponse = await request(app).get('/api/tasks/auto-fix-validation-task/auto-fix-plan').expect(200);
  const removeTextId = planResponse.body.autoFixPlan.plannedActions.find((item) => item.actionType === 'removeText')?.actionId;
  const before = await getTask('auto-fix-validation-task');

  await request(app)
    .post('/api/tasks/auto-fix-validation-task/auto-fix-plan/execute')
    .send({ approvedActionIds: [removeTextId], confirmExecute: true, confirmSave: true, persist: true, mode: 'textLayoutOnly' })
    .expect(200)
    .expect((res) => {
      const result = res.body.executionResult;
      assert.equal(result.persisted, true);
      assert.equal(result.postFixStatus.persisted, true);
      assert.equal(result.postFixStatus.needsRegenerateMock, true);
      assert.equal(result.postFixStatus.needsReviewAgain, true);
      assert.equal(result.postFixStatus.autoRegenerateTriggered, false);
      assert.equal(result.postFixStatus.autoReviewTriggered, false);
      assert.equal(result.nextValidationChecklist.shouldRegenerateMock, true);
      assert.equal(result.nextValidationChecklist.shouldRunReviewAgain, true);
      assert.equal(result.nextValidationChecklist.shouldCompareIssueCounts, true);
      assert.equal(result.nextValidationChecklist.manualSteps.includes('重新生成 mock 图片'), true);
      assert.equal(result.nextValidationChecklist.manualSteps.includes('再次执行审核'), true);
      assert.ok(Array.isArray(result.nextValidationChecklist.expectedImprovements));
    });

  const after = await getTask('auto-fix-validation-task');
  assert.deepEqual(after.generatedImages, before.generatedImages);
  assert.deepEqual(after.review, before.review);
  assert.equal(after.status, before.status);
});
