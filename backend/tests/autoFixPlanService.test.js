import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildAutoFixPlan } from '../src/services/autoFixPlanService.js';

function suggestion(overrides = {}) {
  return {
    suggestionId: 'fix-001',
    issueCode: 'CHINESE_TEXT_DETECTED',
    severity: 'fatal',
    imageType: 'feature_image',
    fieldKey: '',
    fieldLabel: '',
    actionType: 'removeText',
    title: '删除中文文案',
    description: '计划从图片文案中移除中文内容。',
    recommendedSteps: ['回到图片方案。', '删除中文文案。'],
    canAutoFixLater: true,
    requiresManualConfirm: false,
    isMockOnly: false,
    isRealComplianceRisk: true,
    ...overrides
  };
}

function task(overrides = {}) {
  return {
    id: 'auto-fix-task',
    sku: 'AF-001',
    productInfoConfirmed: {
      sku: 'AF-001',
      name: 'Portable Drive'
    },
    imagePlans: [
      {
        id: 'plan-feature',
        type: 'feature_image',
        textLayout: { blocks: [{ id: 'text-1', text: '中文 Copy' }] }
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
    ...overrides
  };
}

test('buildAutoFixPlan creates a dry-run plan from fixSuggestions and separates action buckets', () => {
  const sourceTask = task();
  const before = structuredClone(sourceTask);
  const plan = buildAutoFixPlan({
    task: sourceTask,
    normalizedReviewReport: {
      fixSuggestions: [
        suggestion({ suggestionId: 'fix-remove', actionType: 'removeText', issueCode: 'CHINESE_TEXT_DETECTED' }),
        suggestion({ suggestionId: 'fix-layout', actionType: 'editTextLayout', issueCode: 'MAIN_IMAGE_TEXT', imageType: 'main_image', title: '主图移除文字' }),
        suggestion({ suggestionId: 'fix-claim', actionType: 'removeClaim', issueCode: 'UNVERIFIED_CLAIM', title: '删除未确认卖点' }),
        suggestion({ suggestionId: 'fix-field', actionType: 'confirmFieldEvidence', issueCode: 'UNCONFIRMED_CAPACITY', fieldKey: 'capacity', fieldLabel: '容量', requiresManualConfirm: true, canAutoFixLater: false }),
        suggestion({ suggestionId: 'fix-manual', actionType: 'manualCheck', issueCode: 'INTERFACE_CONFLICT', fieldKey: 'interfaceType', fieldLabel: '接口类型', requiresManualConfirm: true, canAutoFixLater: false }),
        suggestion({ suggestionId: 'fix-real', actionType: 'regenerateRealSample', issueCode: 'REAL_SAMPLE_FAILED', canAutoFixLater: true }),
        suggestion({ suggestionId: 'fix-mock', actionType: 'skipMockOnly', issueCode: 'MOCK_PREVIEW_SOURCE', severity: 'mockInfo', isMockOnly: true, isRealComplianceRisk: false, canAutoFixLater: false }),
        suggestion({ suggestionId: 'fix-none', actionType: 'noActionNeeded', issueCode: 'INFO_ONLY', severity: 'info', canAutoFixLater: false, isRealComplianceRisk: false })
      ]
    }
  });

  assert.equal(plan.meta.taskId, 'auto-fix-task');
  assert.equal(plan.meta.mode, 'dryRun');
  assert.equal(plan.meta.source, 'fixSuggestions');
  assert.equal(plan.meta.planVersion, 'v1');
  assert.equal(plan.summary.totalFixSuggestions, 8);
  assert.equal(plan.summary.plannedActionCount, 3);
  assert.equal(plan.summary.blockedActionCount, 2);
  assert.equal(plan.summary.manualConfirmRequiredCount, 2);
  assert.equal(plan.summary.mockOnlyCount, 1);
  assert.equal(plan.summary.noActionNeededCount, 1);
  assert.equal(plan.summary.requiresUserConfirmation, true);
  assert.deepEqual(plan.plannedActions.map((item) => item.actionType), ['removeText', 'editTextLayout', 'removeClaim']);
  assert.equal(plan.plannedActions.every((item) => item.dryRunOnly === true && item.canExecuteLater === true), true);
  assert.equal(plan.blockedActions.some((item) => item.actionType === 'confirmFieldEvidence' && item.fieldKey === 'capacity'), true);
  assert.equal(plan.blockedActions.some((item) => item.actionType === 'regenerateRealSample'), true);
  assert.equal(plan.manualActions[0].actionType, 'manualCheck');
  assert.equal(plan.mockOnlyActions[0].actionType, 'skipMockOnly');
  assert.equal(plan.noActionNeededActions[0].actionType, 'noActionNeeded');
  assert.match(plan.nextSuggestedAction, /人工确认修正计划/);
  assert.deepEqual(sourceTask, before);
});

test('buildAutoFixPlan returns a safe empty plan when review report is missing', () => {
  const plan = buildAutoFixPlan({ task: task(), normalizedReviewReport: null });

  assert.equal(plan.summary.totalFixSuggestions, 0);
  assert.equal(plan.summary.plannedActionCount, 0);
  assert.deepEqual(plan.plannedActions, []);
  assert.match(plan.warnings.join('\n'), /暂无可生成修正计划的审核报告/);
  assert.match(plan.nextSuggestedAction, /请先执行审核/);
});

test('buildAutoFixPlan sanitizes exported content', () => {
  const plan = buildAutoFixPlan({
    task: task({
      productInfoConfirmed: {
        sku: 'AF-001',
        name: 'OPENAI_API_KEY=sk-secret D:\\Code\\app.sqlite node_modules .env'
      }
    }),
    normalizedReviewReport: {
      fixSuggestions: [
        suggestion({
          description: 'API_KEY=abc sk-secret123 C:\\Users\\secret\\.env app.sqlite node_modules',
          recommendedSteps: ['Provider secret should be hidden']
        })
      ]
    }
  });
  const json = JSON.stringify(plan);

  assert.doesNotMatch(json, /\.env/i);
  assert.doesNotMatch(json, /API_KEY/i);
  assert.doesNotMatch(json, /sk-secret/i);
  assert.doesNotMatch(json, /[A-Z]:\\/);
  assert.doesNotMatch(json, /app\.sqlite/i);
  assert.doesNotMatch(json, /node_modules/i);
});
