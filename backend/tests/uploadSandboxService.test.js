import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { createBatchTask, createTask, getBatchTask, resetDatabaseForTests } from '../src/services/db.js';
import { simulateSandboxSubmit } from '../src/services/uploadSandboxService.js';

const now = '2026-06-01T12:00:00.000Z';

function image(type, overrides = {}) {
  return {
    id: `temu-${type}`,
    imageType: type,
    type,
    status: 'succeeded',
    provider: 'generated',
    sourceType: 'generated',
    platformId: 'temu',
    ...overrides
  };
}

function baseTask(overrides = {}) {
  return {
    id: overrides.id || 'task-ready',
    batchId: 'batch-sandbox',
    sku: overrides.sku || 'SKU-READY',
    status: 'reviewed',
    platformId: 'temu',
    productInfoConfirmed: {
      sku: overrides.sku || 'SKU-READY',
      name: 'Ready Product',
      category: 'Storage',
      description: 'Safe copy',
      sellingPoints: ['Point one']
    },
    generatedImages: [image('main_image'), image('feature_image')],
    review: { reviewedAt: now, reviewMode: 'mock', overallStatus: 'passed', items: [] },
    ...overrides
  };
}

async function seedSandboxBatch() {
  await createBatchTask({
    id: 'batch-sandbox',
    name: 'Sandbox Batch',
    status: 'reviewed',
    createdAt: now,
    updatedAt: now,
    skuTasks: [
      { skuId: 'SKU-READY', taskId: 'task-ready', status: 'reviewed' },
      { skuId: 'SKU-WARNING', taskId: 'task-warning', status: 'reviewed' },
      { skuId: 'SKU-BLOCKED', taskId: 'task-blocked', status: 'generated' }
    ]
  });
  await createTask(baseTask());
  await createTask(baseTask({
    id: 'task-warning',
    sku: 'SKU-WARNING',
    generatedImages: [
      image('main_image', { provider: 'mock', sourceType: 'mock', isMockPreview: true }),
      image('feature_image', { provider: 'mock', sourceType: 'mock', isMockPreview: true })
    ]
  }));
  await createTask(baseTask({
    id: 'task-blocked',
    sku: 'SKU-BLOCKED',
    review: null
  }));
}

beforeEach(async () => {
  await resetDatabaseForTests();
});

test('simulateSandboxSubmit requires confirmSandboxSubmit=true', async () => {
  await seedSandboxBatch();
  await assert.rejects(
    simulateSandboxSubmit('batch-sandbox', { platforms: ['temu'] }),
    /confirmSandboxSubmit=true/
  );
});

test('simulateSandboxSubmit maps ready warning and blocked payloads without network upload or database writes', async () => {
  await seedSandboxBatch();
  const beforeBatch = await getBatchTask('batch-sandbox');

  const report = await simulateSandboxSubmit('batch-sandbox', {
    platforms: ['temu'],
    packageId: 'export-package-sandbox-001',
    confirmSandboxSubmit: true
  });

  assert.equal(report.meta.batchId, 'batch-sandbox');
  assert.equal(report.meta.mode, 'sandboxSubmitSimulation');
  assert.equal(report.meta.realNetworkCalled, false);
  assert.equal(report.meta.externalApiCalled, false);
  assert.equal(report.meta.uploaded, false);
  assert.equal(report.summary.totalPayloads, 3);
  assert.equal(report.summary.accepted, 1);
  assert.equal(report.summary.acceptedWithWarnings, 1);
  assert.equal(report.summary.blocked, 1);
  assert.equal(report.simulatedResults.find((item) => item.sku === 'SKU-READY').simulatedStatus, 'accepted');
  assert.equal(report.simulatedResults.find((item) => item.sku === 'SKU-WARNING').simulatedStatus, 'accepted_with_warnings');
  assert.equal(report.simulatedResults.find((item) => item.sku === 'SKU-BLOCKED').simulatedStatus, 'blocked');
  assert.equal(report.simulatedResults.every((item) => item.uploaded === false), true);
  assert.equal(report.simulatedResults.every((item) => item.realNetworkCalled === false), true);
  assert.equal(report.simulatedResults.every((item) => item.externalApiCalled === false), true);
  assert.match(report.simulatedResults[0].sandboxRequestId, /^sandbox-temu-/);
  assert.equal(report.blockedResults.length, 1);
  assert.doesNotMatch(JSON.stringify(report), /\.env|API_KEY|sk-|[A-Z]:\\|app\.sqlite|node_modules|token|secret/i);
  assert.equal(await getBatchTask('batch-sandbox').then((batch) => JSON.stringify(batch)), JSON.stringify(beforeBatch));
});
