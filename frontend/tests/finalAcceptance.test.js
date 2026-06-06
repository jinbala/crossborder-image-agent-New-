import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import {
  applyModuleManualAcceptance,
  applySkuManualAcceptance,
  addFinalAcceptanceIssue,
  buildFinalAcceptanceCsvDownload,
  buildFinalAcceptanceIssuesCsvDownload,
  buildFinalAcceptanceJsonDownload,
  buildRealApiAcceptanceJsonDownload,
  canRunRealApiAcceptance,
  deleteFinalAcceptanceIssue,
  finalAcceptanceNotice,
  getFinalAcceptanceDisplayModel,
  getRealApiAcceptanceDisplayModel,
  normalizeRealApiAcceptancePayload,
  updateFinalAcceptanceIssue
} from '../src/utils/finalAcceptance.js';

function report(overrides = {}) {
  return {
    meta: {
      reportId: 'final-acceptance-2026',
      generatedAt: '2026-06-01T12:00:00.000Z',
      version: 'v6.1-stage1',
      mode: 'manual-acceptance',
      target: 'local-workstation'
    },
    summary: {
      totalSku: 5,
      completedSku: 0,
      passedSku: 1,
      failedSku: 1,
      pendingSku: 3,
      blockedSku: 1,
      overallStatus: 'partial',
      readinessLevel: 'local-workbench'
    },
    skuAcceptance: [
      {
        sku: 'SKU-READY',
        taskId: 'task-ready',
        productName: 'Black SSD',
        testAssetStatus: 'available',
        overallStatus: 'passed',
        steps: [
          { stepKey: 'upload', stepLabel: 'upload image', status: 'passed', notes: '', evidence: [] },
          { stepKey: 'review', stepLabel: 'structured review', status: 'passed', notes: '', evidence: [] }
        ],
        riskSummary: { recognitionRisk: 'low', templateRisk: 'low', reviewRisk: 'low', exportRisk: 'low', uploadDryRunRisk: 'low' },
        manualNotes: '',
        nextSuggestedAction: ''
      },
      {
        sku: 'SKU-MISSING',
        taskId: '',
        productName: '',
        testAssetStatus: 'missing',
        overallStatus: 'pending',
        steps: [{ stepKey: 'upload', stepLabel: 'upload image', status: 'pending', notes: '', evidence: [] }],
        riskSummary: { recognitionRisk: 'unknown' },
        manualNotes: '',
        nextSuggestedAction: 'add test asset'
      }
    ],
    moduleAcceptance: [
      { moduleKey: 'recognition', moduleName: 'recognition', status: 'passed', issues: [], notes: '' },
      { moduleKey: 'uploadReadiness', moduleName: 'upload dry-run readiness', status: 'pending', issues: ['missing data'], notes: '' }
    ],
    blockingIssues: [{ code: 'REVIEW_FATAL', message: 'fatal risk exists' }],
    warnings: [{ code: 'MISSING_TEST_ASSET', message: 'missing test asset' }],
    recommendations: ['check each SKU manually'],
    nextSuggestedAction: 'continue manual acceptance',
    ...overrides
  };
}

test('final acceptance display model shows overview SKU rows module rows and pending state', () => {
  const model = getFinalAcceptanceDisplayModel(report());

  assert.equal(model.emptyText, '');
  assert.equal(model.summaryCards.some((card) => card.value === '5'), true);
  assert.equal(model.summaryCards.some((card) => card.label === 'overallStatus' && card.value === 'partial'), true);
  assert.equal(model.skuRows.length, 2);
  assert.equal(model.skuRows[1].testAssetStatus, 'missing');
  assert.equal(model.skuRows[1].stepSummary.includes('pending'), true);
  assert.equal(model.moduleRows.length, 2);
  assert.equal(model.blockingText.includes('REVIEW_FATAL'), true);
  assert.equal(model.warningText.includes('MISSING_TEST_ASSET'), true);
  assert.match(model.notice, /Provider/);
});

test('final acceptance v6.2 helpers preserve manual acceptance and batch rows', () => {
  const source = report({
    meta: { version: 'v6.2-stage2', mode: 'manual-acceptance-multi-batch', targetSkuCount: 10, multiBatch: true },
    batchAcceptance: [
      {
        batchId: 'batch-a',
        batchName: 'Batch A',
        skuCount: 6,
        pendingSku: 4,
        blockedSku: 1,
        status: 'partial',
        manualAcceptance: { status: 'pending', reviewer: '', checkedAt: '', notes: '' }
      }
    ],
    skuAcceptance: [
      {
        sku: 'SKU-READY',
        taskId: 'task-ready',
        productName: 'Black SSD',
        testAssetStatus: 'available',
        overallStatus: 'pending',
        steps: [{ stepKey: 'review', stepLabel: 'review', status: 'pending', notes: '', evidence: [] }],
        riskSummary: { reviewRisk: 'unknown' },
        manualAcceptance: { status: 'pending', reviewer: '', checkedAt: '', notes: '' },
        nextSuggestedAction: ''
      }
    ],
    moduleAcceptance: [
      {
        moduleKey: 'reviewReport',
        moduleName: 'review report',
        status: 'pending',
        issues: [],
        notes: '',
        manualAcceptance: { status: 'pending', reviewer: '', checkedAt: '', notes: '' }
      }
    ]
  });

  const model = getFinalAcceptanceDisplayModel(source);
  assert.equal(model.batchRows.length, 1);
  assert.equal(model.batchRows[0].batchId, 'batch-a');
  assert.equal(model.skuRows[0].manualAcceptance.status, 'pending');
  assert.equal(model.moduleRows[0].manualAcceptance.status, 'pending');

  const withSkuManual = applySkuManualAcceptance(source, 'SKU-READY', {
    status: 'failed',
    reviewer: 'ops',
    notes: 'needs CSV check API_KEY=abc sk-secret D:\\Code\\.env'
  });
  assert.equal(source.skuAcceptance[0].manualAcceptance.status, 'pending');
  assert.equal(withSkuManual.skuAcceptance[0].manualAcceptance.status, 'failed');
  assert.equal(withSkuManual.skuAcceptance[0].manualAcceptance.reviewer, 'ops');

  const withModuleManual = applyModuleManualAcceptance(source, 'reviewReport', {
    status: 'passed',
    reviewer: 'module-ops',
    notes: 'manual review complete'
  });
  assert.equal(source.moduleAcceptance[0].manualAcceptance.status, 'pending');
  assert.equal(withModuleManual.moduleAcceptance[0].manualAcceptance.status, 'passed');

  const jsonDownload = buildFinalAcceptanceJsonDownload({ report: withSkuManual, timestamp: '2026-06-01T12-00-00-000Z' });
  const csvDownload = buildFinalAcceptanceCsvDownload({ report: withSkuManual, timestamp: '2026-06-01T12-00-00-000Z' });
  assert.match(jsonDownload.content, /"manualAcceptance"/);
  assert.match(csvDownload.content.split('\n')[0], /manualStatus,manualReviewer,manualNotes/);
  assert.match(buildFinalAcceptanceCsvDownload({ report: withModuleManual }).content, /module-ops/);
  assert.doesNotMatch(jsonDownload.content, /\.env|API_KEY|sk-secret|(?:^|[^A-Za-z0-9])sk-[A-Za-z0-9_-]{6,}|[A-Z]:\\/i);
  assert.doesNotMatch(csvDownload.content, /\.env|API_KEY|sk-secret|(?:^|[^A-Za-z0-9])sk-[A-Za-z0-9_-]{6,}|[A-Z]:\\/i);
});

test('final acceptance v6.3 issue helpers add edit delete summarize and sanitize exports', () => {
  const source = report({ summary: { overallStatus: 'passed', totalSku: 1 } });
  const withIssue = addFinalAcceptanceIssue(source, {
    issueId: 'issue-001',
    title: 'Upload blocker API_KEY=abc',
    description: 'Provider secret platform token D:\\Code\\.env app.sqlite node_modules',
    relatedSku: 'SKU-READY',
    relatedTaskId: 'task-ready',
    relatedBatchId: 'batch-a',
    moduleKey: 'uploadReadiness',
    stepKey: 'uploadReadiness',
    severity: 'blocker',
    isBlockingFinalRelease: true,
    status: 'open',
    reproduceSteps: ['open acceptance', 'export report'],
    expectedResult: 'safe export',
    actualResult: 'blocked',
    suggestedFix: 'fix dry-run issue',
    createdAt: '2026-06-01T12:00:00.000Z',
    updatedAt: '2026-06-01T12:00:00.000Z'
  });

  assert.equal(source.issueLogs, undefined);
  assert.equal(withIssue.issueLogs.length, 1);
  assert.equal(withIssue.issueSummary.blockerCount, 1);
  assert.equal(withIssue.issueSummary.openCount, 1);
  assert.equal(withIssue.issueSummary.blockingFinalReleaseCount, 1);
  assert.notEqual(withIssue.summary.overallStatus, 'passed');

  const edited = updateFinalAcceptanceIssue(withIssue, 'issue-001', {
    status: 'verified',
    severity: 'low',
    isBlockingFinalRelease: false,
    title: 'Verified low issue'
  });
  assert.equal(edited.issueLogs[0].status, 'verified');
  assert.equal(edited.issueSummary.verifiedCount, 1);
  assert.equal(edited.issueSummary.lowCount, 1);
  assert.equal(edited.issueSummary.blockingFinalReleaseCount, 0);

  const deleted = deleteFinalAcceptanceIssue(edited, 'issue-001');
  assert.equal(deleted.issueLogs.length, 0);
  assert.equal(deleted.issueSummary.totalIssues, 0);

  const model = getFinalAcceptanceDisplayModel(withIssue);
  assert.equal(model.issueRows.length, 1);
  assert.equal(model.issueSummaryCards.some((card) => card.label === 'blocker' && card.value === '1'), true);
  assert.match(model.issueBlockingText, /blocker/);

  const jsonDownload = buildFinalAcceptanceJsonDownload({ report: withIssue, timestamp: '2026-06-01T12-00-00-000Z' });
  const csvDownload = buildFinalAcceptanceCsvDownload({ report: withIssue, timestamp: '2026-06-01T12-00-00-000Z' });
  const issuesCsv = buildFinalAcceptanceIssuesCsvDownload({ report: withIssue, timestamp: '2026-06-01T12-00-00-000Z' });
  assert.match(jsonDownload.content, /"issueLogs"/);
  assert.match(csvDownload.content, /issue-001/);
  assert.match(issuesCsv.fileName, /final-acceptance-issues-2026-06-01T12-00-00-000Z\.csv/);
  assert.match(issuesCsv.content.split('\n')[0], /issueId,title,severity,status,isBlockingFinalRelease/);
  assert.doesNotMatch(jsonDownload.content, /\.env|API_KEY|Provider secret|platform token|[A-Z]:\\|app\.sqlite|node_modules/i);
  assert.doesNotMatch(issuesCsv.content, /\.env|API_KEY|Provider secret|platform token|[A-Z]:\\|app\.sqlite|node_modules/i);
});

test('final acceptance warnings are merged and display targetSkuCount details', () => {
  const duplicateWarnings = Array.from({ length: 10 }, () => ({
    code: 'MISSING_TEST_ASSET',
    message: '当前可用于最终验收的 SKU 不足 5 个，缺失项保持 missing / pending。',
    targetSkuCount: 10,
    availableSkuCount: 0,
    missingSkuCount: 10
  }));
  const source = addFinalAcceptanceIssue(report({
    meta: { targetSkuCount: 10 },
    warnings: duplicateWarnings
  }), {
    issueId: 'issue-warning-safety',
    title: 'issue remains editable',
    severity: 'info',
    status: 'open'
  });

  const model = getFinalAcceptanceDisplayModel(source);
  assert.equal((model.warningText.match(/MISSING_TEST_ASSET/g) || []).length, 1);
  assert.match(model.warningText, /不足 10 个/);
  assert.match(model.warningText, /目标 SKU 数: 10/);
  assert.match(model.warningText, /可用 SKU 数: 0/);
  assert.match(model.warningText, /缺失 SKU 数: 10/);
  assert.equal(model.issueRows.length, 1);

  const jsonDownload = buildFinalAcceptanceJsonDownload({ report: source, timestamp: '2026-06-01T12-00-00-000Z' });
  const json = JSON.parse(jsonDownload.content);
  assert.equal(json.warnings.filter((warning) => warning.code === 'MISSING_TEST_ASSET').length, 1);
  assert.equal(json.warnings[0].targetSkuCount, 10);

  const csvDownload = buildFinalAcceptanceCsvDownload({ report: source, timestamp: '2026-06-01T12-00-00-000Z' });
  assert.equal((csvDownload.content.match(/MISSING_TEST_ASSET/g) || []).length <= 1, true);
});

test('final acceptance JSON and CSV downloads are sanitized', () => {
  const unsafeReport = report({
    skuAcceptance: [{
      sku: 'SKU API_KEY=abc sk-secret D:\\Code\\.env app.sqlite node_modules',
      taskId: 'task-1',
      productName: 'Unsafe',
      steps: [{ stepKey: 'upload', stepLabel: 'upload image', status: 'pending', notes: 'Provider secret platform token C:\\tmp' }],
      riskSummary: { uploadDryRunRisk: 'unknown' },
      nextSuggestedAction: 'check'
    }]
  });
  const jsonDownload = buildFinalAcceptanceJsonDownload({ report: unsafeReport, timestamp: '2026-06-01T12-00-00-000Z' });
  const csvDownload = buildFinalAcceptanceCsvDownload({ report: unsafeReport, timestamp: '2026-06-01T12-00-00-000Z' });

  assert.equal(jsonDownload.fileName, 'final-acceptance-report-2026-06-01T12-00-00-000Z.json');
  assert.equal(csvDownload.fileName, 'final-acceptance-report-2026-06-01T12-00-00-000Z.csv');
  assert.match(csvDownload.content.split('\n')[0], /reportId,sku,taskId,productName,stepKey,stepLabel,status,riskLevel,notes,nextSuggestedAction/);
  assert.doesNotMatch(jsonDownload.content, /\.env|API_KEY|sk-secret|(?:^|[^A-Za-z0-9])sk-[A-Za-z0-9_-]{6,}|Provider secret|platform token|[A-Z]:\\|app\.sqlite|node_modules/i);
  assert.doesNotMatch(csvDownload.content, /\.env|API_KEY|sk-secret|(?:^|[^A-Za-z0-9])sk-[A-Za-z0-9_-]{6,}|Provider secret|platform token|[A-Z]:\\|app\.sqlite|node_modules/i);
});

test('FinalAcceptancePage route nav API and safe copy are wired', () => {
  const appSource = fs.readFileSync(path.resolve('src/App.jsx'), 'utf8');
  const layoutSource = fs.readFileSync(path.resolve('src/components/Layout.jsx'), 'utf8');
  const apiSource = fs.readFileSync(path.resolve('src/services/api.js'), 'utf8');
  const pageSource = fs.readFileSync(path.resolve('src/pages/FinalAcceptancePage.jsx'), 'utf8');

  assert.match(appSource, /FinalAcceptancePage/);
  assert.match(appSource, /final-acceptance/);
  assert.match(layoutSource, /FinalAcceptancePage|final-acceptance|鏈€缁堥獙鏀?/);
  assert.match(apiSource, /getFinalAcceptanceTemplate/);
  assert.match(apiSource, /getFinalAcceptanceReport/);
  assert.match(apiSource, /targetSkuCount/);
  assert.match(apiSource, /multiBatch/);
  assert.match(apiSource, /exportFinalAcceptanceReport/);
  assert.match(apiSource, /runRealApiAcceptance/);
  assert.match(apiSource, /exportRealApiAcceptanceReport/);
  assert.match(pageSource, /10 SKU/);
  assert.match(pageSource, /1 SKU/);
  assert.match(pageSource, /confirmRealApi/);
  assert.match(pageSource, /confirmPaidApi/);
  assert.match(pageSource, /不会上传平台|涓嶄細涓婁紶骞冲彴/);
  assert.match(pageSource, /成本|鎴愭湰/);
  assert.match(pageSource, /多批次|澶氭壒娆?/);
  assert.match(pageSource, /人工结论|浜哄伐缁撹/);
  assert.match(pageSource, /applySkuManualAcceptance/);
  assert.match(pageSource, /applyModuleManualAcceptance/);
  assert.match(pageSource, /Issue Log|issueLogs|验收问题记录/);
  assert.match(pageSource, /addFinalAcceptanceIssue/);
  assert.match(pageSource, /updateFinalAcceptanceIssue/);
  assert.match(pageSource, /deleteFinalAcceptanceIssue/);
  assert.match(pageSource, /不写入数据库|issue log is kept/);
  assert.match(pageSource, /瀵煎嚭 JSON|JSON/);
  assert.match(pageSource, /瀵煎嚭 CSV|CSV/);
  assert.match(pageSource, /妯″潡楠屾敹琛?|moduleRows/);
  assert.match(finalAcceptanceNotice, /Provider/);
  assert.match(finalAcceptanceNotice, /Image2/);
  assert.match(finalAcceptanceNotice, /passed/);
  assert.doesNotMatch(pageSource, /batchGenerate|batchReview|startBatchQueue|Image2|uploadPlatform|submitPlatformUpload|realProvider|localStorage\.setItem/);
});

test('real API acceptance frontend helpers require confirmations and sanitize JSON export', () => {
  const base = {
    taskId: 'task-real-api-ui',
    enableVision: true,
    imageTypes: ['main_image', 'feature_image', 'detail_image', 'size_image'],
    enableReview: true,
    maxRealApiCalls: 8,
    confirmRealApi: false,
    confirmPaidApi: true,
    confirmNoPlatformUpload: true
  };

  assert.equal(canRunRealApiAcceptance(base), false);
  assert.equal(canRunRealApiAcceptance({ ...base, confirmRealApi: true }), true);

  const payload = normalizeRealApiAcceptancePayload({ ...base, confirmRealApi: true });
  assert.equal(payload.taskId, 'task-real-api-ui');
  assert.equal(payload.confirmRealApi, true);
  assert.equal(payload.confirmPaidApi, true);
  assert.equal(payload.maxRealApiCalls, 3);
  assert.deepEqual(payload.imageTypes, ['main_image', 'feature_image']);
  assert.equal(payload.enableReview, false);
  assert.equal(payload.platformUploadEnabled, false);

  const model = getRealApiAcceptanceDisplayModel({
    meta: { taskId: 'task-real-api-ui', sku: 'SKU-1', platformUploadEnabled: false },
    summary: {
      overallStatus: 'partial',
      realApiCallCount: 2,
      fallbackCount: 1,
      estimatedCost: 0.12,
      readyForPlatformUpload: false
    },
    apiCalls: [{ provider: 'fake', model: 'fake-v1', apiType: 'vision', durationMs: 10, fallbackUsed: false }],
    warnings: [{ code: 'SAFE_NOTE', message: 'OPENAI_API_KEY=sk-secret D:\\Code\\.env' }]
  });
  assert.equal(model.emptyText, '');
  assert.equal(model.summaryCards.some((card) => card.label === 'API 调用次数' && card.value === '2'), true);
  assert.match(model.warningText, /\[credential removed\]|\[local path removed\]/);

  const download = buildRealApiAcceptanceJsonDownload({
    report: {
      meta: { taskId: 'task-real-api-ui', generatedAt: '2026-06-01T12:00:00.000Z' },
      apiCalls: [{ errorMessage: 'OPENAI_API_KEY=sk-secret D:\\Code\\.env app.sqlite node_modules' }]
    },
    timestamp: '2026-06-01T12-00-00-000Z'
  });
  assert.equal(download.fileName, 'real-api-acceptance-report-task-real-api-ui-2026-06-01T12-00-00-000Z.json');
  assert.doesNotMatch(download.content, /\.env|OPENAI_API_KEY|sk-secret|[A-Z]:\\|app\.sqlite|node_modules/i);
});

test('real API acceptance API helper sends no-platform-upload confirmation', async () => {
  const { api } = await import('../src/services/api.js');
  let capturedOptions = null;

  global.fetch = async (_url, options) => {
    capturedOptions = options;
    return {
      ok: true,
      json: async () => ({ report: { meta: { taskId: 'task-real-api-ui' } } })
    };
  };

  await api.runRealApiAcceptance({
    taskId: 'task-real-api-ui',
    confirmRealApi: true,
    confirmPaidApi: true,
    confirmNoPlatformUpload: true
  });

  const body = JSON.parse(capturedOptions.body);
  assert.equal(body.confirmRealApi, true);
  assert.equal(body.confirmPaidApi, true);
  assert.equal(body.confirmNoPlatformUpload, true);
});
