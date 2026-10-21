import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import {
  buildListingCsvDownloadUrl,
  getListingExportDisplayModel,
  listingExportConfirmText,
  listingExportNotice,
  listingExportJson,
  normalizeListingExportOptions
} from '../src/utils/listingExport.js';

function preview(overrides = {}) {
  return {
    batchId: 'batch-1',
    mode: 'preview',
    platforms: ['amazon', 'temu'],
    summary: {
      rowsByPlatform: { amazon: 2, temu: 2 },
      missingRequiredFields: [{ sku: 'SKU001', platform: 'amazon', field: 'brand' }],
      blockedFields: [{ sku: 'SKU001', field: 'capacity', status: 'blocked_missing_evidence' }],
      noReviewSku: ['SKU002'],
      failedSku: [{ sku: 'SKU003', failedStep: 'generate' }],
      warnings: ['Some fields are blank.'],
      recommendations: ['Review noReview SKU before platform handoff.']
    },
    files: [
      { platform: 'amazon', fileName: 'amazon-listing.csv', relativePath: 'outputs/listing-csv/listing-1/amazon-listing.csv' },
      { platform: 'temu', fileName: 'temu-listing.csv', relativePath: 'outputs/listing-csv/listing-1/temu-listing.csv' },
      { platform: 'mapping', fileName: 'listing-field-mapping.json', relativePath: 'outputs/listing-csv/listing-1/listing-field-mapping.json' }
    ],
    ...overrides
  };
}

test('normalizeListingExportOptions keeps supported platforms and requires explicit confirmation', () => {
  assert.deepEqual(normalizeListingExportOptions({ platforms: ['amazon', 'temu', 'bad'], confirmExport: true }), {
    platforms: ['amazon', 'temu'],
    includeMockImages: true,
    includeRealSamples: false,
    confirmExport: true
  });
  assert.deepEqual(normalizeListingExportOptions({ platforms: [] }).platforms, ['amazon']);
});

test('getListingExportDisplayModel shows rows missing blocked noReview warnings and files', () => {
  const model = getListingExportDisplayModel({ preview: preview(), result: preview({ exportId: 'listing-csv-1' }) });

  assert.equal(model.emptyText, '');
  assert.match(model.resultText, /listing-csv-1/);
  assert.equal(model.platformRows.some((row) => row.platform === 'amazon' && row.rows === 2), true);
  assert.match(model.missingText, /brand/);
  assert.match(model.blockedText, /capacity/);
  assert.match(model.noReviewText, /SKU002/);
  assert.match(model.warningText, /Some fields/);
  assert.equal(model.fileRows.some((file) => file.fileName === 'amazon-listing.csv'), true);
});

test('listing export API helper posts confirmed export body and display keeps generated files', async () => {
  const { api } = await import('../src/services/api.js');
  const captured = [];
  global.fetch = async (url, options = {}) => {
    captured.push({ url, options });
    return {
      ok: true,
      json: async () => preview({ exportId: 'listing-csv-accepted' })
    };
  };

  const result = await api.createListingCsvExport('batch-accepted', {
    platforms: ['amazon', 'temu'],
    includeMockImages: true,
    confirmExport: true
  });
  const body = JSON.parse(captured[0].options.body);
  const model = getListingExportDisplayModel({ result });

  assert.equal(captured[0].url, '/api/batches/batch-accepted/listing-csv');
  assert.equal(captured[0].options.method, 'POST');
  assert.deepEqual(body.platforms, ['amazon', 'temu']);
  assert.equal(body.includeMockImages, true);
  assert.equal(body.confirmExport, true);
  assert.match(model.resultText, /listing-csv-accepted/);
  assert.equal(model.fileRows.some((file) => file.fileName === 'amazon-listing.csv'), true);
  assert.equal(model.fileRows.some((file) => file.fileName === 'temu-listing.csv'), true);
});

test('listing export JSON and URLs are sanitized', () => {
  const json = listingExportJson(preview({ summary: { warnings: ['API_KEY=abc sk-secret D:\\Code\\.env app.sqlite node_modules'] } }));
  assert.doesNotMatch(json, /\.env/i);
  assert.doesNotMatch(json, /API_KEY/i);
  assert.doesNotMatch(json, /sk-secret/i);
  assert.doesNotMatch(json, /[A-Z]:\\/);
  assert.doesNotMatch(json, /app\.sqlite/i);
  assert.doesNotMatch(json, /node_modules/i);
  assert.equal(buildListingCsvDownloadUrl('outputs/listing-csv/listing-1/amazon-listing.csv'), '/outputs/listing-csv/listing-1/amazon-listing.csv');
  assert.equal(buildListingCsvDownloadUrl('D:\\Code\\secret.csv'), '');
});

test('BatchPage wires listing CSV preview and confirmed export without platform upload', () => {
  const pageSource = fs.readFileSync(path.resolve('src/pages/BatchPage.jsx'), 'utf8');
  const apiSource = fs.readFileSync(path.resolve('src/services/api.js'), 'utf8');

  assert.match(pageSource, /平台上架表格 \/ CSV 导出/);
  assert.match(pageSource, /预览 CSV/);
  assert.match(pageSource, /生成 CSV/);
  assert.match(pageSource, /listingExportConfirmText/);
  assert.match(pageSource, /api\.getListingCsvPreview/);
  assert.match(pageSource, /api\.createListingCsvExport/);
  assert.match(pageSource, /buildListingCsvDownloadUrl/);
  assert.match(pageSource, /listingExportDisplay\.resultText/);
  assert.match(pageSource, /CSV 生成失败，请查看错误信息后重试。/);
  assert.match(pageSource, /CSV 已生成/);
  assert.match(apiSource, /getListingCsvPreview/);
  assert.match(apiSource, /createListingCsvExport/);
  assert.equal(listingExportConfirmText, '本次只会生成本地 CSV/JSON 文件，不会自动提交到任何平台。');
  assert.match(listingExportNotice, /不会自动提交到任何平台/);

  assert.doesNotMatch(pageSource, /uploadPlatform|platformApi|realReviewProvider|Image2/);
});
