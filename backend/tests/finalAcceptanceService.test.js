import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { createBatchTask, createTask, readDb, resetDatabaseForTests } from '../src/services/db.js';
import {
  buildFinalAcceptanceReport,
  buildFinalAcceptanceTemplate,
  exportFinalAcceptanceReport
} from '../src/services/finalAcceptanceService.js';

const now = '2026-06-01T12:00:00.000Z';

function task(overrides = {}) {
  return {
    id: overrides.id || 'task-acceptance-ready',
    sku: overrides.sku || 'SKU-READY',
    status: 'reviewed',
    productInfoRaw: { name: 'Raw Product' },
    productInfoConfirmed: {
      sku: overrides.sku || 'SKU-READY',
      name: overrides.name || 'Ready Product',
      category: 'External Storage'
    },
    sourceImages: [{ id: 'source-1', displayName: 'front.jpg', filePath: 'D:\\Code\\.env\\front.jpg' }],
    recognitionQuality: { riskLevel: 'low', fieldStats: { total: 3 } },
    targets: [{ platformId: 'amazon', categoryId: 'electronics_storage' }],
    imagePlans: [{ id: 'plan-main', type: 'main_image' }],
    generatedImages: [{ id: 'img-main', type: 'main_image', status: 'succeeded', isMockPreview: true }],
    templateAudit: { summary: { overallStatus: 'passed' } },
    exportPackages: [{ id: 'export-package-1' }],
    listingCsvExports: [{ id: 'listing-csv-1' }],
    uploadReadinessReport: { summary: { blockedSku: 0, canUploadNow: false } },
    uploadSandboxReport: { summary: { blockedPayloads: 0 } },
    uploadSafetyReport: { summary: { readyForRealUpload: false } },
    review: { overallStatus: 'passed', reviewedAt: now, items: [] },
    ...overrides
  };
}

beforeEach(async () => {
  await resetDatabaseForTests();
});

test('buildFinalAcceptanceTemplate creates a blank five SKU checklist with pending statuses', () => {
  const template = buildFinalAcceptanceTemplate();

  assert.equal(template.meta.version, 'v6.1-stage1');
  assert.equal(template.meta.mode, 'manual-acceptance');
  assert.equal(template.summary.totalSku, 5);
  assert.equal(template.summary.pendingSku, 5);
  assert.equal(template.summary.overallStatus, 'pending');
  assert.equal(template.summary.readinessLevel, 'local-workbench');
  assert.equal(template.skuAcceptance.length, 5);
  assert.equal(template.skuAcceptance.every((sku) => sku.testAssetStatus === 'pending'), true);
  assert.equal(template.skuAcceptance.every((sku) => sku.overallStatus === 'pending'), true);
  assert.equal(template.skuAcceptance.every((sku) => sku.steps.length >= 23), true);
  assert.equal(template.skuAcceptance[0].steps.some((step) => step.stepKey === 'credentialSafety'), true);
  assert.equal(template.moduleAcceptance.length >= 19, true);
  assert.equal(template.moduleAcceptance.some((item) => item.moduleKey === 'healthCheck'), true);
});

test('buildFinalAcceptanceTemplate supports v6.2 ten SKU multi-batch manual fields', () => {
  const template = buildFinalAcceptanceTemplate({
    version: 'v6.2-stage2',
    targetSkuCount: 10,
    multiBatch: true
  });

  assert.equal(template.meta.version, 'v6.2-stage2');
  assert.equal(template.meta.mode, 'manual-acceptance-multi-batch');
  assert.equal(template.meta.targetSkuCount, 10);
  assert.equal(template.meta.multiBatch, true);
  assert.equal(template.summary.totalSku, 10);
  assert.equal(template.summary.pendingSku, 10);
  assert.equal(template.skuAcceptance.length, 10);
  assert.equal(template.skuAcceptance.every((sku) => sku.manualAcceptance?.status === 'pending'), true);
  assert.equal(template.skuAcceptance.every((sku) => sku.manualAcceptance?.reviewer === ''), true);
  assert.equal(template.moduleAcceptance.every((module) => module.manualAcceptance?.status === 'pending'), true);
  assert.deepEqual(template.batchAcceptance, []);
  assert.deepEqual(template.issueLogs, []);
  assert.deepEqual(template.issueSummary, {
    totalIssues: 0,
    blockerCount: 0,
    highCount: 0,
    mediumCount: 0,
    lowCount: 0,
    infoCount: 0,
    openCount: 0,
    fixedCount: 0,
    verifiedCount: 0,
    blockingFinalReleaseCount: 0
  });
});

test('buildFinalAcceptanceReport prefills from current data without marking missing or risky data as passed', async () => {
  await createBatchTask({
    id: 'batch-acceptance',
    name: 'Acceptance Batch API_KEY=sk-secret D:\\Code\\.env',
    status: 'reviewed',
    createdAt: now,
    updatedAt: now,
    skuTasks: [
      { skuId: 'SKU-READY', taskId: 'task-ready', status: 'reviewed' },
      { skuId: 'SKU-FATAL', taskId: 'task-fatal', status: 'reviewed' },
      { skuId: 'SKU-NOREVIEW', taskId: 'task-noreview', status: 'generated' }
    ]
  });
  await createTask(task({ id: 'task-ready', sku: 'SKU-READY', name: 'Black SSD' }));
  await createTask(task({
    id: 'task-fatal',
    sku: 'SKU-FATAL',
    name: 'Silver SSD',
    review: {
      overallStatus: 'failed',
      items: [{ imageId: 'img-main', issues: [{ severity: 'fatal', type: 'main_image_text', message: 'fatal risk' }] }]
    }
  }));
  await createTask(task({
    id: 'task-noreview',
    sku: 'SKU-NOREVIEW',
    name: 'Pending Review Product',
    review: null,
    generatedImages: [{ id: 'img-main', type: 'main_image', status: 'succeeded', isMockPreview: true }]
  }));
  const beforeDb = await readDb();

  const report = await buildFinalAcceptanceReport();

  assert.equal(report.meta.version, 'v6.1-stage1');
  assert.equal(report.summary.totalSku, 5);
  assert.equal(report.summary.completedSku, 0);
  assert.equal(report.summary.passedSku, 0);
  assert.equal(report.summary.pendingSku >= 2, true);
  assert.equal(report.summary.blockedSku >= 1, true);
  assert.equal(report.summary.overallStatus, 'partial');
  assert.equal(report.skuAcceptance.length, 5);

  const ready = report.skuAcceptance.find((item) => item.sku === 'SKU-READY');
  const fatal = report.skuAcceptance.find((item) => item.sku === 'SKU-FATAL');
  const noReview = report.skuAcceptance.find((item) => item.sku === 'SKU-NOREVIEW');
  const missing = report.skuAcceptance.find((item) => item.testAssetStatus === 'missing');

  assert.equal(ready.steps.find((step) => step.stepKey === 'upload').status, 'passed');
  assert.equal(ready.steps.find((step) => step.stepKey === 'recognition').status, 'passed');
  assert.equal(ready.steps.find((step) => step.stepKey === 'review').status, 'passed');
  assert.equal(fatal.steps.find((step) => step.stepKey === 'review').status, 'failed');
  assert.equal(fatal.riskSummary.reviewRisk, 'high');
  assert.notEqual(noReview.steps.find((step) => step.stepKey === 'review').status, 'passed');
  assert.equal(missing.overallStatus, 'pending');
  assert.equal(missing.testAssetStatus, 'missing');
  assert.equal(report.warnings.some((warning) => warning.code === 'MISSING_TEST_ASSET'), true);
  assert.doesNotMatch(JSON.stringify(report), /\.env|API_KEY|sk-secret|(?:^|[^A-Za-z0-9])sk-[A-Za-z0-9_-]{6,}|[A-Z]:\\|app\.sqlite|node_modules/i);
  assert.equal(JSON.stringify(await readDb()), JSON.stringify(beforeDb));
});

test('buildFinalAcceptanceReport supports v6.2 ten SKU across multiple batches without writes', async () => {
  const batchA = {
    id: 'batch-acceptance-a',
    name: 'Acceptance Batch A',
    status: 'reviewed',
    createdAt: now,
    updatedAt: '2026-06-01T12:00:00.000Z',
    skuTasks: []
  };
  const batchB = {
    id: 'batch-acceptance-b',
    name: 'Acceptance Batch B',
    status: 'reviewed',
    createdAt: now,
    updatedAt: '2026-06-01T12:05:00.000Z',
    skuTasks: []
  };

  for (let index = 0; index < 12; index += 1) {
    const batch = index < 6 ? batchA : batchB;
    const taskId = `task-v62-${index + 1}`;
    const sku = `SKU-V62-${index + 1}`;
    batch.skuTasks.push({ skuId: sku, taskId, status: 'reviewed' });
    await createTask(task({ id: taskId, sku, name: `Acceptance Product ${index + 1}` }));
  }
  await createBatchTask(batchA);
  await createBatchTask(batchB);
  const beforeDb = await readDb();

  const report = await buildFinalAcceptanceReport({
    version: 'v6.2-stage2',
    targetSkuCount: 10,
    multiBatch: true
  });

  assert.equal(report.meta.version, 'v6.2-stage2');
  assert.equal(report.meta.mode, 'manual-acceptance-multi-batch');
  assert.equal(report.meta.targetSkuCount, 10);
  assert.equal(report.meta.multiBatch, true);
  assert.equal(report.summary.totalSku, 10);
  assert.equal(report.skuAcceptance.length, 10);
  assert.equal(report.batchAcceptance.length, 2);
  assert.deepEqual(new Set(report.batchAcceptance.map((batch) => batch.batchId)), new Set(['batch-acceptance-a', 'batch-acceptance-b']));
  assert.equal(report.skuAcceptance.every((sku) => sku.manualAcceptance?.status === 'pending'), true);
  assert.equal(report.moduleAcceptance.every((module) => module.manualAcceptance?.status === 'pending'), true);
  assert.equal(report.batchAcceptance.every((batch) => batch.manualAcceptance?.status === 'pending'), true);
  assert.equal(JSON.stringify(await readDb()), JSON.stringify(beforeDb));
});

test('buildFinalAcceptanceReport merges missing asset warning and uses targetSkuCount', async () => {
  const tenSkuReport = await buildFinalAcceptanceReport({
    version: 'v6.2-stage2',
    targetSkuCount: 10,
    multiBatch: true
  });
  const tenWarnings = tenSkuReport.warnings.filter((warning) => warning.code === 'MISSING_TEST_ASSET');

  assert.equal(tenWarnings.length, 1);
  assert.match(tenWarnings[0].message, /不足 10 个/);
  assert.doesNotMatch(tenWarnings[0].message, /不足 5 个/);
  assert.equal(tenWarnings[0].targetSkuCount, 10);
  assert.equal(tenWarnings[0].availableSkuCount, 0);
  assert.equal(tenWarnings[0].missingSkuCount, 10);
  assert.equal(tenSkuReport.skuAcceptance.every((sku) => sku.overallStatus !== 'passed'), true);
  assert.equal(tenSkuReport.skuAcceptance.every((sku) => ['missing', 'pending'].includes(sku.testAssetStatus)), true);

  const fiveSkuReport = await buildFinalAcceptanceReport();
  const fiveWarnings = fiveSkuReport.warnings.filter((warning) => warning.code === 'MISSING_TEST_ASSET');
  assert.equal(fiveWarnings.length, 1);
  assert.match(fiveWarnings[0].message, /不足 5 个/);
  assert.equal(fiveWarnings[0].targetSkuCount, 5);
  assert.equal(fiveWarnings[0].availableSkuCount, 0);
  assert.equal(fiveWarnings[0].missingSkuCount, 5);
});

test('buildFinalAcceptanceReport omits missing asset warning when enough SKU are available', async () => {
  for (let index = 0; index < 5; index += 1) {
    await createTask(task({ id: `task-ready-${index + 1}`, sku: `SKU-READY-${index + 1}` }));
  }
  const beforeDb = await readDb();

  const report = await buildFinalAcceptanceReport();

  assert.equal(report.warnings.some((warning) => warning.code === 'MISSING_TEST_ASSET'), false);
  assert.equal(report.skuAcceptance.length, 5);
  assert.equal(JSON.stringify(await readDb()), JSON.stringify(beforeDb));
});

test('exportFinalAcceptanceReport returns sanitized JSON and CSV without writing data', () => {
  const template = buildFinalAcceptanceTemplate();
  template.skuAcceptance[0].sku = 'SKU API_KEY=abc sk-secret D:\\Code\\.env app.sqlite node_modules';
  template.skuAcceptance[0].manualNotes = 'Provider secret and platform token C:\\tmp';
  template.skuAcceptance[0].manualAcceptance = {
    status: 'failed',
    reviewer: 'ops',
    checkedAt: '2026-06-01T12:00:00.000Z',
    notes: 'API_KEY=abc sk-secret D:\\Code\\.env app.sqlite node_modules'
  };
  template.moduleAcceptance[0].manualAcceptance = {
    status: 'passed',
    reviewer: 'module-ops',
    checkedAt: '2026-06-01T12:00:00.000Z',
    notes: 'module manual conclusion'
  };
  template.summary.overallStatus = 'passed';
  template.issueLogs = [{
    issueId: 'issue-001',
    title: 'Upload blocker API_KEY=abc',
    description: 'Provider secret platform token D:\\Code\\.env app.sqlite node_modules',
    relatedSku: 'SKU-1',
    relatedTaskId: 'task-1',
    relatedBatchId: 'batch-1',
    moduleKey: 'uploadReadiness',
    stepKey: 'uploadReadiness',
    severity: 'blocker',
    isBlockingFinalRelease: true,
    status: 'open',
    reproduceSteps: ['open final acceptance', 'click export'],
    expectedResult: 'safe export',
    actualResult: 'blocked by issue',
    suggestedFix: 'fix dry-run issue',
    createdAt: now,
    updatedAt: now
  }, {
    issueId: 'issue-002',
    title: 'Verified low issue',
    moduleKey: 'finalAcceptance',
    severity: 'low',
    isBlockingFinalRelease: false,
    status: 'verified'
  }];

  const jsonExport = exportFinalAcceptanceReport(template, { format: 'json', timestamp: '2026-06-01T12-00-00-000Z' });
  const csvExport = exportFinalAcceptanceReport(template, { format: 'csv', timestamp: '2026-06-01T12-00-00-000Z' });
  const exportedReport = JSON.parse(jsonExport.content);

  assert.equal(jsonExport.fileName, 'final-acceptance-report-2026-06-01T12-00-00-000Z.json');
  assert.equal(jsonExport.mimeType, 'application/json');
  assert.equal(csvExport.fileName, 'final-acceptance-report-2026-06-01T12-00-00-000Z.csv');
  assert.equal(csvExport.mimeType, 'text/csv');
  assert.match(csvExport.content.split('\n')[0], /reportId,sku,taskId,productName,stepKey,stepLabel,status,riskLevel,notes,nextSuggestedAction/);
  assert.match(csvExport.content.split('\n')[0], /manualStatus,manualReviewer,manualNotes/);
  assert.match(jsonExport.content, /"manualAcceptance"/);
  assert.match(csvExport.content, /failed,ops/);
  assert.match(csvExport.content, /module-ops/);
  assert.equal(exportedReport.issueSummary.totalIssues, 2);
  assert.equal(exportedReport.issueSummary.blockerCount, 1);
  assert.equal(exportedReport.issueSummary.lowCount, 1);
  assert.equal(exportedReport.issueSummary.openCount, 1);
  assert.equal(exportedReport.issueSummary.verifiedCount, 1);
  assert.equal(exportedReport.issueSummary.blockingFinalReleaseCount, 1);
  assert.notEqual(exportedReport.summary.overallStatus, 'passed');
  assert.match(jsonExport.content, /"issueLogs"/);
  assert.match(csvExport.content, /issueId,title,severity,status,isBlockingFinalRelease/);
  assert.match(csvExport.content, /issue-001/);
  assert.doesNotMatch(jsonExport.content, /\.env|API_KEY|sk-secret|(?:^|[^A-Za-z0-9])sk-[A-Za-z0-9_-]{6,}|Provider secret|platform token|[A-Z]:\\|app\.sqlite|node_modules/i);
  assert.doesNotMatch(csvExport.content, /\.env|API_KEY|sk-secret|(?:^|[^A-Za-z0-9])sk-[A-Za-z0-9_-]{6,}|Provider secret|platform token|[A-Z]:\\|app\.sqlite|node_modules/i);
});
