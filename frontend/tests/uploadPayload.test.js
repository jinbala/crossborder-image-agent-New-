import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import {
  buildUploadPayloadDownload,
  buildUploadSandboxDownload,
  getUploadPayloadDisplayModel,
  getUploadSandboxDisplayModel,
  uploadPayloadJson,
  uploadPayloadNotice
} from '../src/utils/uploadPayload.js';

function payloadPreview(overrides = {}) {
  return {
    meta: { batchId: 'batch-1', mode: 'payloadPreview', targetPlatforms: ['temu'], realNetworkCalled: false },
    summary: { totalSku: 2, readyPayloadCount: 1, warningPayloadCount: 1, blockedPayloadCount: 0 },
    platformPayloads: [{ platformId: 'temu', totalPayloads: 2, readyPayloadCount: 1, warningPayloadCount: 1, blockedPayloadCount: 0 }],
    skuPayloads: [
      {
        platformId: 'temu',
        sku: 'SKU001',
        status: 'warning',
        payload: { sku: 'SKU001', productName: 'Product', images: { main: 'Temu/SKU001/01_main.jpg', gallery: ['Temu/SKU001/02_feature.jpg'] } },
        missingFields: [],
        blockedFields: [],
        warnings: [{ code: 'MOCK_IMAGE_WARNING', message: 'mock image warning' }],
        riskNotes: []
      }
    ],
    blockedPayloads: [],
    warnings: [{ code: 'MOCK_IMAGE_WARNING', message: 'mock image warning' }],
    recommendations: ['Check payload before upload.'],
    ...overrides
  };
}

function sandboxReport(overrides = {}) {
  return {
    meta: { batchId: 'batch-1', mode: 'sandboxSubmitSimulation', realNetworkCalled: false, externalApiCalled: false, uploaded: false },
    summary: { totalPayloads: 2, accepted: 1, acceptedWithWarnings: 1, blocked: 0 },
    simulatedResults: [
      { platformId: 'temu', sku: 'SKU001', simulatedStatus: 'accepted_with_warnings', sandboxRequestId: 'sandbox-temu-2026-SKU001', uploaded: false, realNetworkCalled: false, externalApiCalled: false, blockingIssues: [], warnings: [] }
    ],
    blockedResults: [],
    warnings: [],
    recommendations: ['This is simulation only.'],
    ...overrides
  };
}

test('upload payload display model exposes summary platform SKU fields and warnings', () => {
  const model = getUploadPayloadDisplayModel(payloadPreview());

  assert.equal(model.emptyText, '');
  assert.equal(model.summaryCards.some((card) => card.label === 'ready payload' && card.value === '1'), true);
  assert.equal(model.platformRows[0].platformId, 'temu');
  assert.equal(model.skuRows[0].fieldSummary.includes('sku'), true);
  assert.equal(model.skuRows[0].imageCount, 2);
  assert.match(model.warningText, /MOCK_IMAGE_WARNING/);
});

test('upload sandbox display model exposes uploaded and network safety flags', () => {
  const model = getUploadSandboxDisplayModel(sandboxReport());

  assert.equal(model.emptyText, '');
  assert.equal(model.summaryCards.some((card) => card.label === 'uploaded' && card.value === 'false'), true);
  assert.equal(model.resultRows[0].uploadedText, 'false');
  assert.equal(model.resultRows[0].realNetworkCalledText, 'false');
  assert.equal(model.resultRows[0].externalApiCalledText, 'false');
});

test('upload payload and sandbox JSON downloads are sanitized and use required file names', () => {
  const payloadDownload = buildUploadPayloadDownload({
    batchId: 'batch-1',
    preview: payloadPreview({ warnings: [{ message: 'API_KEY=abc sk-secret D:\\Code\\.env app.sqlite node_modules temu token' }] }),
    timestamp: '2026-06-01T12-00-00-000Z'
  });
  const sandboxDownload = buildUploadSandboxDownload({
    batchId: 'batch-1',
    report: sandboxReport({ warnings: [{ message: 'provider secret C:\\tmp app.sqlite node_modules' }] }),
    timestamp: '2026-06-01T12-00-00-000Z'
  });

  assert.equal(payloadDownload.fileName, 'upload-payload-preview-batch-1-2026-06-01T12-00-00-000Z.json');
  assert.equal(sandboxDownload.fileName, 'upload-sandbox-report-batch-1-2026-06-01T12-00-00-000Z.json');
  assert.doesNotMatch(payloadDownload.json, /\.env|API_KEY|sk-|[A-Z]:\\|app\.sqlite|node_modules|token|secret/i);
  assert.doesNotMatch(sandboxDownload.json, /\.env|API_KEY|sk-|[A-Z]:\\|app\.sqlite|node_modules|token|secret/i);
  assert.doesNotMatch(uploadPayloadJson(payloadPreview({ localStorageAccount: 'seller raw token' })), /seller|token/i);
});

test('BatchPage wires upload payload preview and sandbox simulation without real upload actions', () => {
  const pageSource = fs.readFileSync(path.resolve('src/pages/BatchPage.jsx'), 'utf8');
  const apiSource = fs.readFileSync(path.resolve('src/services/api.js'), 'utf8');

  assert.match(pageSource, /上传 Payload 预览/);
  assert.match(pageSource, /沙盒模拟/);
  assert.match(pageSource, /生成 Payload 预览/);
  assert.match(pageSource, /执行沙盒提交模拟/);
  assert.match(pageSource, /uploadPayloadNotice/);
  assert.match(pageSource, /api\.previewUploadPayload/);
  assert.match(pageSource, /api\.simulateUploadSandbox/);
  assert.match(pageSource, /downloadUploadPayloadJson/);
  assert.match(pageSource, /downloadUploadSandboxJson/);
  assert.match(apiSource, /previewUploadPayload/);
  assert.match(apiSource, /simulateUploadSandbox/);
  assert.match(uploadPayloadNotice, /不会上传平台/);
  assert.match(uploadPayloadNotice, /不会调用平台 API/);
  assert.doesNotMatch(pageSource, /uploadPlatform|submitProduct|platformApi|realUploadEnabled: true|MIAOSHOU_API_KEY/);
});
