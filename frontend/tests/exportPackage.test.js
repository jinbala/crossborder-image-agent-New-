import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import {
  buildExportPackageDownloadUrl,
  exportPackageConfirmText,
  exportPackageJson,
  getExportPackageDisplayModel,
  normalizeExportPackageOptions
} from '../src/utils/exportPackage.js';

function preview(overrides = {}) {
  return {
    batchId: 'batch-1',
    mode: 'preview',
    platforms: ['amazon', 'temu'],
    summary: {
      totalSku: 2,
      successSku: 1,
      failedSku: 1,
      totalExpectedImages: 32,
      readyImageCount: 3,
      missingImageCount: 29,
      mockImageCount: 3,
      realSampleImageCount: 0,
      reportCount: 9
    },
    reports: ['review-report.json', 'failed-sku-report.csv'],
    warnings: ['缺少部分图片，将在 manifest 中标记 missing。'],
    directoryTree: [
      { path: 'Amazon/SKU001/01_main.jpg', status: 'ready', sourceType: 'mock' },
      { path: 'Amazon/SKU001/02_feature.jpg', status: 'missing', sourceType: 'missing' }
    ],
    failedSku: [{ sku: 'SKU002', taskId: 'task-2', failedStep: 'generate', errorMessage: '生成失败' }],
    ...overrides
  };
}

test('normalizeExportPackageOptions keeps safe defaults and requires explicit export confirmation', () => {
  assert.deepEqual(normalizeExportPackageOptions({ platforms: ['amazon', 'temu'], includeRealSamples: true }), {
    platforms: ['amazon', 'temu'],
    includeReports: true,
    includeMockImages: true,
    includeRealSamples: true,
    format: 'zip',
    confirmExport: false
  });

  assert.deepEqual(normalizeExportPackageOptions({ platforms: [], confirmExport: true }).platforms, ['amazon']);
});

test('getExportPackageDisplayModel summarizes preview and package result for BatchPage', () => {
  const model = getExportPackageDisplayModel({
    preview: preview(),
    result: {
      packageId: 'export-package-batch-1-2026',
      zipFile: 'export-package-batch-1-2026.zip',
      relativePath: 'outputs/export-packages/export-package-batch-1-2026.zip',
      summary: preview().summary,
      warnings: ['导出完成，但部分 SKU 缺图。'],
      failedSku: preview().failedSku
    }
  });

  assert.equal(model.emptyText, '');
  assert.equal(model.summaryCards.some((card) => card.label === 'SKU 总数' && card.value === '2'), true);
  assert.equal(model.summaryCards.some((card) => card.label === '缺失图片' && card.value === '29'), true);
  assert.match(model.previewNotice, /不会上传平台/);
  assert.match(model.resultText, /export-package-batch-1-2026\.zip/);
  assert.match(model.warningText, /部分 SKU 缺图/);
  assert.equal(model.treeRows.length, 2);
  assert.equal(model.failedSkuRows[0].sku, 'SKU002');
});

test('final export result wins over stale preview counts, warnings and tree without changing either record', () => {
  const initial = preview(), result = { zipFile:'final.zip', relativePath:'outputs/export-packages/final.zip',
    summary:{...initial.summary,readyImageCount:1,missingImageCount:31,mockImageCount:1}, warnings:['final warning'],
    directoryTree:[{path:'Amazon/SKU001/01_main.jpg',status:'missing',sourceType:'mock'}],failedSku:[] };
  const original = JSON.stringify({initial,result}), model = getExportPackageDisplayModel({preview:initial,result});
  assert.equal(model.summaryCards.find(card=>card.label==='可导出图片').value,'1');
  assert.equal(model.summaryCards.find(card=>card.label==='缺失图片').value,'31');
  assert.equal(model.treeRows[0].status,'missing');assert.equal(model.failedSkuRows.length,0);
  assert.equal(model.warningText,'final warning');assert.equal(JSON.stringify({initial,result}),original);
});

test('unknown source types including prototype keys remain raw labels and option edits clear stale export evidence',()=>{
  const model=getExportPackageDisplayModel({preview:preview({directoryTree:[{path:'x',sourceType:'constructor'},{path:'y',sourceType:'__proto__'}]})});
  assert.deepEqual(model.treeRows.map(row=>row.sourceTypeDisplay),['constructor','__proto__']);
  const pageSource=fs.readFileSync(path.resolve('src/pages/BatchPage.jsx'),'utf8');
  for(const name of ['updateExportPackageOption','toggleExportPackagePlatform']){
    const block=pageSource.slice(pageSource.indexOf(`function ${name}`),pageSource.indexOf('\n  }',pageSource.indexOf(`function ${name}`)));
    assert.match(block,/if \(busy\) return/);assert.match(block,/setExportPackagePreview\(null\)/);assert.match(block,/setExportPackageResult\(null\)/);
  }
  assert.match(pageSource,/fieldset data-export-package-options disabled=\{Boolean\(busy\)\}/);
});

test('an unverified generated source is not presented as real generated evidence',()=>{
  const model=getExportPackageDisplayModel({preview:preview({directoryTree:[{path:'x',sourceType:'generated'}]})});
  assert.equal(model.treeRows[0].sourceTypeDisplay,'生成图片（来源未验证）');
});

test('exportPackageJson and download URL strip sensitive local details', () => {
  const json = exportPackageJson({
    preview: preview({ warnings: ['API_KEY=abc sk-secret D:\\Code\\.env app.sqlite node_modules'] }),
    result: { relativePath: 'outputs/export-packages/export.zip' }
  });
  assert.doesNotMatch(json, /\.env/i);
  assert.doesNotMatch(json, /API_KEY/i);
  assert.doesNotMatch(json, /sk-secret/i);
  assert.doesNotMatch(json, /[A-Z]:\\/);
  assert.doesNotMatch(json, /app\.sqlite/i);
  assert.doesNotMatch(json, /node_modules/i);

  assert.equal(buildExportPackageDownloadUrl('outputs/export-packages/export.zip'), '/outputs/export-packages/export.zip');
  assert.equal(buildExportPackageDownloadUrl('D:\\Code\\outputs\\export.zip'), '');
});

test('BatchPage wires structured export package preview and confirmed ZIP creation without provider calls', () => {
  const pageSource = fs.readFileSync(path.resolve('src/pages/BatchPage.jsx'), 'utf8');
  const apiSource = fs.readFileSync(path.resolve('src/services/api.js'), 'utf8');

  assert.match(pageSource, /上架前资料包导出/);
  assert.match(pageSource, /预览导出包/);
  assert.match(pageSource, /生成上架前资料包 ZIP/);
  assert.match(pageSource, /exportPackageConfirmText/);
  assert.match(pageSource, /includeMockImages/);
  assert.match(pageSource, /includeRealSamples/);
  assert.match(pageSource, /confirmExport: true/);
  assert.match(pageSource, /api\.getExportPackagePreview/);
  assert.match(pageSource, /api\.createExportPackage/);
  assert.match(pageSource, /buildExportPackageDownloadUrl/);
  assert.match(apiSource, /getExportPackagePreview/);
  assert.match(apiSource, /createExportPackage/);
  assert.equal(exportPackageConfirmText, '本次将生成本地 ZIP 文件，不会上传平台，不会调用真实 Provider。');

  assert.doesNotMatch(pageSource, /realReviewProvider|image2Provider|uploadPlatform|autoRegenerate/);
});
