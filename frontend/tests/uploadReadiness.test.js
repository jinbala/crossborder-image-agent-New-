import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import {
  buildUploadReadinessDownload,
  getUploadReadinessDisplayModel,
  loadUploadSandboxConfig,
  normalizeUploadReadinessOptions,
  normalizeUploadSandboxConfig,
  saveUploadSandboxConfig,
  uploadSandboxNotice,
  uploadReadinessJson,
  uploadReadinessNotice
} from '../src/utils/uploadReadiness.js';

function report(overrides = {}) {
  return {
    meta: {
      reportId: 'upload-readiness-batch-1-2026',
      batchId: 'batch-1',
      packageId: 'package-1',
      generatedAt: '2026-06-01T12:00:00.000Z',
      mode: 'dryRun',
      targetPlatforms: ['temu', 'miaoshou'],
      realUploadEnabled: false
    },
    summary: {
      totalSku: 3,
      readySku: 1,
      blockedSku: 1,
      warningSku: 1,
      missingImageCount: 2,
      missingFieldCount: 3,
      noReviewSku: 1,
      highRiskSku: 1,
      mockImageSku: 2,
      canUploadNow: false
    },
    platformReports: [
      { platformId: 'temu', platformName: 'Temu', provider: 'dryRun', requiredFields: ['sku'], requiredImages: ['main_image'], readySku: 1, blockedSku: 1, warnings: [], recommendations: [] }
    ],
    skuReports: [
      { sku: 'SKU001', taskId: 'task-1', platformId: 'temu', status: 'blocked', missingFields: ['product_name'], missingImages: ['main_image'], reviewStatus: 'noReview', usesMockImages: true, hasHighRiskIssues: false, blockingIssues: [], warnings: [], recommendations: [] }
    ],
    blockingIssues: [{ code: 'MISSING_MAIN_IMAGE', sku: 'SKU001', message: 'Missing main image' }],
    warnings: [{ code: 'MOCK_IMAGE_WARNING', message: 'mock image warning' }],
    recommendations: ['Fix blocking issues first.'],
    nextSuggestedAction: 'Fix blocking issues first.',
    ...overrides
  };
}

test('normalizeUploadReadinessOptions keeps dry-run platform selection safe', () => {
  assert.deepEqual(normalizeUploadReadinessOptions({ platforms: ['temu', 'miaoshou', 'bad'] }), {
    platforms: ['temu', 'miaoshou']
  });
  assert.deepEqual(normalizeUploadReadinessOptions({ platforms: [] }).platforms, ['temu', 'miaoshou']);
});

test('upload sandbox config normalizes local-only account data and strips credentials from export JSON', () => {
  const config = normalizeUploadSandboxConfig({
    temu: { enabled: true, accountName: 'Temu seller', credential: 'sk-secret temu token D:\\Code\\.env' },
    miaoshou: { enabled: true, accountName: 'Miaoshou seller', credential: 'provider secret app.sqlite node_modules' },
    amazon: { enabled: true, accountName: 'Reserved', credential: 'do-not-use' }
  });

  assert.deepEqual(Object.keys(config), ['temu', 'miaoshou', 'amazon']);
  assert.equal(config.temu.enabled, true);
  assert.equal(config.temu.configured, true);
  assert.equal(config.temu.accountName, 'Temu seller');
  assert.equal(config.temu.credential, 'sk-secret temu token D:\\Code\\.env');
  assert.doesNotMatch(uploadReadinessJson({ config }), /sk-|token|secret|[A-Z]:\\|app\.sqlite|node_modules/i);
});

test('upload sandbox config can be saved to and loaded from localStorage only', () => {
  const store = {};
  const storage = {
    getItem: (key) => store[key] || null,
    setItem: (key, value) => { store[key] = value; }
  };

  const saved = saveUploadSandboxConfig({
    temu: { enabled: true, accountName: 'Temu seller', credential: 'local credential' }
  }, storage);
  const loaded = loadUploadSandboxConfig(storage);

  assert.equal(saved.temu.configured, true);
  assert.equal(loaded.temu.accountName, 'Temu seller');
  assert.equal(store.uploadSandboxConfig.includes('local credential'), true);
});

test('getUploadReadinessDisplayModel exposes summary platform SKU issues and recommendations', () => {
  const model = getUploadReadinessDisplayModel(report());

  assert.equal(model.emptyText, '');
  assert.equal(model.summaryCards.some((card) => card.label === 'blocked SKU' && card.value === '1'), true);
  assert.equal(model.summaryCards.some((card) => card.label === 'canUploadNow' && card.value === 'false'), true);
  assert.equal(model.platformRows[0].platformId, 'temu');
  assert.equal(model.skuRows[0].missingFieldsText, 'product_name');
  assert.match(model.blockingText, /MISSING_MAIN_IMAGE/);
  assert.match(model.warningText, /mock image/);
  assert.match(model.recommendationText, /Fix blocking/);
});

test('upload readiness JSON export is sanitized and uses required file name', () => {
  const download = buildUploadReadinessDownload({
    batchId: 'batch-1',
    report: report({ warnings: [{ message: 'API_KEY=abc sk-secret D:\\Code\\.env app.sqlite node_modules temu token' }] }),
    timestamp: '2026-06-01T12-00-00-000Z'
  });

  assert.equal(download.fileName, 'upload-readiness-report-batch-1-2026-06-01T12-00-00-000Z.json');
  assert.equal(download.mimeType, 'application/json');
  assert.doesNotMatch(download.json, /\.env/i);
  assert.doesNotMatch(download.json, /API_KEY/i);
  assert.doesNotMatch(download.json, /sk-secret/i);
  assert.doesNotMatch(download.json, /[A-Z]:\\/);
  assert.doesNotMatch(download.json, /app\.sqlite/i);
  assert.doesNotMatch(download.json, /node_modules/i);
  assert.doesNotMatch(uploadReadinessJson(report({ warnings: [{ message: 'platform token secret' }] })), /token|secret/i);
});

test('BatchPage wires upload readiness dry-run area without real upload actions', () => {
  const pageSource = fs.readFileSync(path.resolve('src/pages/BatchPage.jsx'), 'utf8');
  const apiSource = fs.readFileSync(path.resolve('src/services/api.js'), 'utf8');

  assert.match(pageSource, /平台上传前检查/);
  assert.match(pageSource, /执行上传前检查/);
  assert.match(pageSource, /uploadReadinessNotice/);
  assert.match(pageSource, /api\.getUploadReadinessPreview/);
  assert.match(pageSource, /downloadUploadReadinessJson/);
  assert.match(pageSource, /Temu/);
  assert.match(pageSource, /妙手/);
  assert.match(apiSource, /getUploadReadinessPreview/);
  assert.match(apiSource, /postUploadReadinessPreview/);
  assert.match(uploadReadinessNotice, /不会上传商品/);
  assert.match(uploadReadinessNotice, /不会调用平台 API/);

  assert.match(uploadSandboxNotice, /不会上传平台/);
  assert.match(pageSource, /uploadSandboxNotice/);
  assert.match(pageSource, /uploadSandboxConfig/);
  assert.match(pageSource, /saveUploadSandboxConfig/);
  assert.match(pageSource, /postUploadReadinessPreview/);
  assert.doesNotMatch(pageSource, /uploadPlatform|submitProduct|platformApi|realUploadEnabled: true|MIAOSHOU_API_KEY/);
});
