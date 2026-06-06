import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import {
  buildAutoFixExecutionDownload,
  buildAutoFixPlanDownload,
  getAutoFixExecutionDisplayModel,
  getAutoFixPlanDisplayModel
} from '../src/utils/autoFixPlan.js';

function plan(overrides = {}) {
  return {
    meta: {
      taskId: 'task-1',
      mode: 'dryRun',
      source: 'fixSuggestions',
      planVersion: 'v1'
    },
    summary: {
      totalFixSuggestions: 5,
      autoFixCandidateCount: 2,
      manualConfirmRequiredCount: 1,
      mockOnlyCount: 1,
      noActionNeededCount: 1,
      plannedActionCount: 2,
      blockedActionCount: 1,
      requiresUserConfirmation: true
    },
    plannedActions: [
      {
        actionId: 'plan-001',
        actionType: 'removeText',
        title: '删除中文文案',
        dryRunOnly: true,
        previewChange: { before: '中文 Copy', after: '', changeType: 'remove' }
      }
    ],
    manualActions: [
      {
        actionId: 'manual-001',
        actionType: 'manualCheck',
        title: '人工检查接口冲突',
        recommendedSteps: ['打开商品确认页。']
      }
    ],
    blockedActions: [
      {
        actionId: 'blocked-001',
        actionType: 'confirmFieldEvidence',
        reason: '容量字段需要人工确认证据，不能自动修正。',
        fieldKey: 'capacity',
        fieldLabel: '容量'
      }
    ],
    mockOnlyActions: [
      {
        actionId: 'mock-001',
        actionType: 'skipMockOnly',
        title: 'mock 流程提示'
      }
    ],
    noActionNeededActions: [
      {
        actionId: 'none-001',
        actionType: 'noActionNeeded',
        title: '无需处理'
      }
    ],
    warnings: ['当前仅生成修正计划，不会自动修改图片方案、文字排版或生成结果。'],
    nextSuggestedAction: '请人工确认修正计划。',
    ...overrides
  };
}

test('getAutoFixPlanDisplayModel exposes dry-run plan sections for ReviewPage', () => {
  const model = getAutoFixPlanDisplayModel(plan());

  assert.equal(model.emptyText, '');
  assert.equal(model.summaryCards.some((card) => card.label === '可自动修正候选' && card.value === 2), true);
  assert.equal(model.summaryCards.some((card) => card.label === '被阻止的自动操作' && card.value === 1), true);
  assert.equal(model.plannedActions[0].actionTypeLabel, '删除违规文案');
  assert.equal(model.manualActions[0].title, '人工检查接口冲突');
  assert.equal(model.blockedActions[0].fieldLabel, '容量');
  assert.equal(model.mockOnlyActions[0].actionType, 'skipMockOnly');
  assert.equal(model.noActionNeededActions[0].actionType, 'noActionNeeded');
  assert.match(model.warnings.join('\n'), /不会自动修改图片方案/);
});

test('getAutoFixPlanDisplayModel returns safe empty state when plan is missing', () => {
  const model = getAutoFixPlanDisplayModel(null);

  assert.match(model.emptyText, /暂无可生成修正计划/);
  assert.deepEqual(model.plannedActions, []);
  assert.deepEqual(model.blockedActions, []);
});

test('buildAutoFixPlanDownload creates sanitized auto-fix-plan JSON', () => {
  const download = buildAutoFixPlanDownload({
    plan: plan({
      plannedActions: [
        {
          actionId: 'plan-001',
          actionType: 'removeText',
          title: 'API_KEY=abc sk-secret123 D:\\Code\\app.sqlite node_modules .env',
          dryRunOnly: true
        }
      ]
    }),
    taskId: 'task-1',
    timestamp: '2026-06-01T12-00-00-000Z'
  });

  assert.equal(download.fileName, 'auto-fix-plan-task-1-2026-06-01T12-00-00-000Z.json');
  assert.equal(download.mimeType, 'application/json');
  assert.equal(download.json.includes('sk-secret123'), false);
  assert.equal(download.json.includes('API_KEY'), false);
  assert.equal(download.json.includes('D:\\Code'), false);
  assert.equal(download.json.includes('app.sqlite'), false);
  assert.equal(download.json.includes('node_modules'), false);
  assert.equal(download.json.includes('.env'), false);
  assert.equal(download.json.includes('plannedActions'), true);
});

test('getAutoFixPlanDisplayModel marks executable plannedActions and keeps unsafe buckets unselectable', () => {
  const model = getAutoFixPlanDisplayModel(plan({
    plannedActions: [
      { actionId: 'plan-1', actionType: 'removeText', title: '删除中文文案', dryRunOnly: true },
      { actionId: 'plan-2', actionType: 'regenerateMock', title: '重新生成 mock', dryRunOnly: true },
      { actionId: 'plan-3', actionType: 'editTextLayout', title: '清空主图文字', target: { imageType: 'main_image' }, dryRunOnly: true }
    ]
  }));

  assert.equal(model.plannedActions.find((item) => item.actionId === 'plan-1').selectable, true);
  assert.equal(model.plannedActions.find((item) => item.actionId === 'plan-2').selectable, false);
  assert.equal(model.plannedActions.find((item) => item.actionId === 'plan-3').selectable, true);
  assert.equal(model.manualActions.every((item) => item.selectable === false), true);
  assert.equal(model.blockedActions.every((item) => item.selectable === false), true);
  assert.equal(model.mockOnlyActions.every((item) => item.selectable === false), true);
});

test('execution display model and download expose sanitized diff and result summary', () => {
  const executionResult = {
    status: 'completed',
    persisted: true,
    savedAt: '2026-06-01T12:00:00.000Z',
    summary: { executedCount: 1, savedCount: 1, skippedCount: 1, blockedCount: 1, failedCount: 0 },
    executedActions: [{ actionId: 'plan-1', actionType: 'removeText', title: '删除中文文案' }],
    skippedActions: [{ actionId: 'none-1', actionType: 'noActionNeeded', reason: '无需处理' }],
    blockedActions: [{ actionId: 'blocked-1', actionType: 'manualCheck', reason: '需要人工复查' }],
    failedActions: [],
    diff: [{ targetType: 'imagePlan', imageType: 'feature_image', changeType: 'removeTextBlock', before: '中文 API_KEY=abc sk-secret D:\\Code\\.env app.sqlite node_modules', after: '', reason: '删除中文文案' }],
    beforeSnapshot: { imagePlanSummary: '1 plan before', textLayoutSummary: '1 text before' },
    afterSnapshot: { imagePlanSummary: '1 plan after', textLayoutSummary: '0 text after' },
    patchedImagePlans: [{ id: 'feature-plan', type: 'feature_image' }],
    savedImagePlans: [{ id: 'feature-plan', type: 'feature_image' }],
    postFixStatus: {
      persisted: true,
      needsRegenerateMock: true,
      needsReviewAgain: true,
      autoRegenerateTriggered: false,
      autoReviewTriggered: false
    },
    nextValidationChecklist: {
      statusText: '文字修正已保存，请手动重新生成 mock 图片并再次审核。',
      shouldRegenerateMock: true,
      shouldRunReviewAgain: true,
      shouldCompareIssueCounts: true,
      manualSteps: ['重新生成 mock 图片', '再次执行审核'],
      expectedImprovements: ['中文文案相关问题应减少']
    },
    warnings: ['当前为局部修正结果预览，尚未写入任务数据。'],
    nextSuggestedAction: '文字修正已生成。请重新生成 mock 图片并再次审核。'
  };
  const model = getAutoFixExecutionDisplayModel(executionResult);
  const download = buildAutoFixExecutionDownload({
    executionResult,
    taskId: 'task-1',
    timestamp: '2026-06-01T12-00-00-000Z'
  });

  assert.equal(model.summaryCards.some((card) => card.label === '执行数量' && card.value === 1), true);
  assert.equal(model.summaryCards.some((card) => card.label === '保存数量' && card.value === 1), true);
  assert.equal(model.diffRows[0].changeType, 'removeTextBlock');
  assert.equal(model.hasPatchedImagePlans, true);
  assert.equal(model.persisted, true);
  assert.equal(model.hasSavedImagePlans, true);
  assert.equal(model.postFixStatus.needsRegenerateMock, true);
  assert.equal(model.postFixStatus.autoRegenerateTriggered, false);
  assert.equal(model.nextValidationChecklist.manualSteps.includes('重新生成 mock 图片'), true);
  assert.equal(download.fileName, 'auto-fix-execution-task-1-2026-06-01T12-00-00-000Z.json');
  assert.equal(download.json.includes('persisted'), true);
  assert.equal(download.json.includes('postFixStatus'), true);
  assert.equal(download.json.includes('nextValidationChecklist'), true);
  assert.equal(download.json.includes('savedImagePlans'), true);
  assert.equal(download.json.includes('beforeSnapshot'), true);
  assert.equal(download.json.includes('afterSnapshot'), true);
  assert.equal(download.json.includes('sk-secret'), false);
  assert.equal(download.json.includes('API_KEY'), false);
  assert.equal(download.json.includes('D:\\Code'), false);
  assert.equal(download.json.includes('app.sqlite'), false);
  assert.equal(download.json.includes('node_modules'), false);
  assert.equal(download.json.includes('.env'), false);
});

test('ReviewPage contains auto fix plan preview buttons and no executable repair copy', () => {
  const source = fs.readFileSync(path.resolve('src/pages/ReviewPage.jsx'), 'utf8');

  assert.match(source, /自动修正计划（预览）/);
  assert.match(source, /生成修正计划/);
  assert.match(source, /导出修正计划 JSON/);
  assert.match(source, /执行已选择的文字修正/);
  assert.match(source, /本次只会执行低风险文字修正/);
  assert.match(source, /修正执行结果/);
  assert.match(source, /导出执行结果 JSON/);
  assert.match(source, /确认保存文字修正到图片方案/);
  assert.match(source, /本次只会保存低风险文字修正到图片方案/);
  assert.match(source, /confirmSave/);
  assert.match(source, /persist: true/);
  assert.match(source, /修正后验证步骤/);
  assert.match(source, /前往重新生成 mock 图片/);
  assert.match(source, /再次执行审核/);
  assert.match(source, /nextValidationChecklist/);
  assert.match(source, /postFixStatus/);
  assert.match(source, /navigate\(`\/tasks\/\$\{taskId\}\/generate`/);
  assert.match(source, /selectedAutoFixActionIds/);
  assert.match(source, /当前仅生成修正计划，不会自动修改图片方案/);
  assert.doesNotMatch(source, /一键修复/);
  assert.doesNotMatch(source, /立即自动修正/);
  assert.doesNotMatch(source, /自动重生成/);
  assert.doesNotMatch(source, /批量自动修复/);
});
