import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import AdmZip from 'adm-zip';
import { createBatchTask, createTask, getBatchTask, resetDatabaseForTests, paths } from '../src/services/db.js';
import {
  buildExportPackagePreview,
  createStructuredExportPackage
} from '../src/services/exportPackageService.js';

const now = '2026-06-01T12:00:00.000Z';
const exportPackagesDir = path.join(paths.outputDir, 'export-packages');
const fixtureOutputDir = path.join(paths.outputDir, 'export-package-fixtures');

const imageTypes = [
  'main_image',
  'feature_image',
  'size_image',
  'compatibility_image',
  'package_image',
  'lifestyle_image',
  'detail_image',
  'variant_image'
];

function generatedImage(type, overrides = {}) {
  return {
    id: `${overrides.taskId || 'task-export-a'}-${type}`,
    planId: `${type}-plan`,
    imageType: type,
    type,
    status: 'succeeded',
    provider: 'mock',
    model: 'mock-template',
    isMockPreview: true,
    platformId: 'amazon',
    fileName: `${type}.jpg`,
    filePath: `outputs/export-package-fixtures/${type}.jpg`,
    generatedAt: now,
    mockPreview: {
      template: {
        templateName: `${type} Template`,
        layoutStyle: `${type}-layout`
      }
    },
    ...overrides
  };
}

function task(overrides = {}) {
  const generatedImages = imageTypes.slice(0, 3).map((type) => generatedImage(type, overrides));
  return {
    id: overrides.id || 'task-export-a',
    batchId: 'batch-export-package',
    sku: overrides.sku || 'SKU001',
    status: 'reviewed',
    platformId: 'amazon',
    categoryId: 'electronics_storage',
    productInfoConfirmed: {
      sku: overrides.sku || 'SKU001',
      name: 'Portable Drive API_KEY=sk-secret D:\\Code\\.env app.sqlite node_modules',
      capacity: '1TB'
    },
    targets: [{ id: 'target-amazon', platformId: 'amazon', platformName: 'Amazon', categoryId: 'electronics_storage' }],
    imagePlans: imageTypes.map((type) => ({
      id: `${type}-plan`,
      type,
      imageType: type,
      platformId: 'amazon',
      targetId: 'target-amazon',
      textBlocks: type === 'main_image' ? [] : [{ text: 'Fast backup', sourceFields: ['sellingPoints'] }],
      templateSeed: {
        templateName: `${type} Template`,
        layoutStyle: `${type}-layout`,
        backgroundStyle: type === 'main_image' ? 'pure_white' : 'soft'
      }
    })),
    generatedImages,
    recognitionQuality: {
      summary: { confirmedWithEvidence: 3, needsManualConfirm: 1 },
      blockedHighRiskFields: [{ field: 'capacity', reason: 'missingEvidence' }]
    },
    review: {
      reviewedAt: now,
      reviewMode: 'mock',
      overallStatus: 'failed',
      items: [
        {
          imageId: `${overrides.id || 'task-export-a'}-main_image`,
          imageType: 'main_image',
          fileName: 'main_image.jpg',
          issues: [{ type: 'mock_preview', category: 'source', message: 'mock only' }]
        }
      ]
    },
    normalizedReviewReport: null,
    ...overrides
  };
}

async function seedBatch() {
  await fs.mkdir(fixtureOutputDir, { recursive: true });
  await Promise.all(imageTypes.slice(0, 3).map((type) => fs.writeFile(path.join(fixtureOutputDir, `${type}.jpg`), `fake-${type}`)));
  await createBatchTask({
    id: 'batch-export-package',
    name: 'Export Package Batch API_KEY=sk-secret D:\\Code\\.env',
    status: 'reviewed',
    createdAt: now,
    updatedAt: now,
    skuTasks: [
      { skuId: 'SKU001', taskId: 'task-export-a', displayName: 'SKU001', status: 'reviewed', currentStep: 'review' },
      { skuId: 'SKU002', taskId: 'task-export-missing', displayName: 'SKU002', status: 'failed', currentStep: 'generate', error: { message: 'source missing C:\\tmp\\.env sk-secret' } }
    ]
  });
  await createTask(task({ id: 'task-export-a', sku: 'SKU001' }));
}

beforeEach(async () => {
  await resetDatabaseForTests();
  await fs.rm(exportPackagesDir, { recursive: true, force: true });
  await fs.rm(fixtureOutputDir, { recursive: true, force: true });
});

test('buildExportPackagePreview returns structured package summary without writing files', async () => {
  await seedBatch();
  const beforeBatch = await getBatchTask('batch-export-package');

  const preview = await buildExportPackagePreview('batch-export-package', {
    platforms: ['amazon', 'temu'],
    includeReports: true,
    includeMockImages: true
  });

  assert.equal(preview.batchId, 'batch-export-package');
  assert.equal(preview.mode, 'preview');
  assert.deepEqual(preview.platforms, ['amazon', 'temu']);
  assert.equal(preview.summary.totalSku, 2);
  assert.equal(preview.summary.totalExpectedImages, 16);
  assert.equal(preview.summary.mockImageCount, 3);
  assert.ok(preview.summary.missingImageCount > 0);
  assert.equal(preview.directoryTree.some((item) => item.path === 'Amazon/SKU001/01_main.jpg' && item.status === 'ready'), true);
  assert.equal(preview.directoryTree.some((item) => item.path === 'Temu/SKU001/01_main.jpg' && item.status === 'missing'), true);
  assert.match(preview.reports.join('\n'), /review-report\.json/);
  assert.equal(await getBatchTask('batch-export-package').then((batch) => JSON.stringify(batch)), JSON.stringify(beforeBatch));
  await assert.rejects(fs.stat(exportPackagesDir), /ENOENT/);
});

test('createStructuredExportPackage requires confirmExport and creates sanitized ZIP with manifests and reports', async () => {
  await seedBatch();
  const beforeBatch = await getBatchTask('batch-export-package');

  await assert.rejects(
    createStructuredExportPackage('batch-export-package', { platforms: ['amazon'], confirmExport: false }),
    /confirmExport=true/
  );

  const result = await createStructuredExportPackage('batch-export-package', {
    platforms: ['amazon'],
    includeReports: true,
    includeMockImages: true,
    includeRealSamples: false,
    confirmExport: true
  });

  assert.equal(result.batchId, 'batch-export-package');
  assert.match(result.packageId, /^export-package-batch-export-package-/);
  assert.match(result.zipFile, /^export-package-batch-export-package-.*\.zip$/);
  assert.match(result.relativePath, /^outputs\/export-packages\/export-package-batch-export-package-.*\.zip$/);
  assert.doesNotMatch(result.relativePath, /[A-Z]:\\/);
  assert.equal(result.summary.totalSku, 2);
  assert.equal(result.summary.mockImageCount, 3);
  assert.ok(result.summary.missingImageCount > 0);
  assert.equal(result.failedSku.length, 1);

  const zipPath = path.join(paths.rootDir, result.relativePath);
  const zip = new AdmZip(zipPath);
  const entries = zip.getEntries().map((entry) => entry.entryName);
  assert.ok(entries.includes(`${result.packageId}/manifest.json`));
  assert.ok(entries.includes(`${result.packageId}/Amazon/SKU001/01_main.jpg`));
  assert.ok(entries.includes(`${result.packageId}/Amazon/SKU001/manifest.json`));
  assert.ok(entries.includes(`${result.packageId}/reports/review-report.json`));
  assert.ok(entries.includes(`${result.packageId}/reports/review-report.csv`));
  assert.ok(entries.includes(`${result.packageId}/reports/product-info-confirmed.json`));
  assert.ok(entries.includes(`${result.packageId}/reports/generation-log.json`));
  assert.ok(entries.includes(`${result.packageId}/reports/cost-report.json`));
  assert.ok(entries.includes(`${result.packageId}/reports/failed-sku-report.json`));
  assert.ok(entries.includes(`${result.packageId}/reports/failed-sku-report.csv`));
  assert.ok(entries.includes(`${result.packageId}/reports/template-audit-summary.json`));
  assert.ok(entries.includes(`${result.packageId}/reports/rule-audit-summary.json`));
  assert.ok(entries.includes(`${result.packageId}/reports/listing-csv/amazon-listing.csv`));
  assert.ok(entries.includes(`${result.packageId}/reports/listing-csv/listing-field-mapping.json`));
  assert.ok(entries.includes(`${result.packageId}/reports/listing-csv/listing-export-summary.json`));

  const rootManifest = JSON.parse(zip.readAsText(`${result.packageId}/manifest.json`));
  assert.equal(rootManifest.batchId, 'batch-export-package');
  assert.deepEqual(rootManifest.platforms, ['amazon']);
  assert.equal(rootManifest.totalSku, 2);
  assert.equal(rootManifest.successSku, 1);
  assert.equal(rootManifest.failedSku, 1);
  assert.equal(rootManifest.mockImageCount, 3);
  assert.ok(rootManifest.files.every((file) => !/[A-Z]:\\/.test(file.path)));

  const skuManifest = JSON.parse(zip.readAsText(`${result.packageId}/Amazon/SKU001/manifest.json`));
  assert.equal(skuManifest.sku, 'SKU001');
  assert.equal(skuManifest.images.length, 8);
  assert.equal(skuManifest.images[0].fileName, '01_main.jpg');
  assert.equal(skuManifest.images[0].sourceType, 'mock');
  assert.equal(skuManifest.images.filter((image) => image.exists === false).length, 5);
  assert.ok(skuManifest.recognitionQualitySummary);
  assert.ok(skuManifest.templateAuditSummary);
  assert.ok(skuManifest.ruleAuditSummary);

  const costReport = JSON.parse(zip.readAsText(`${result.packageId}/reports/cost-report.json`));
  assert.equal(costReport.currency, 'USD');
  assert.equal(costReport.estimatedTotalCost, 0);

  const reviewCsv = zip.readAsText(`${result.packageId}/reports/review-report.csv`);
  assert.match(reviewCsv, /sku,taskId,platform,reviewStatus,fatalCount,highCount,mediumCount,lowCount,mockInfoCount,realComplianceIssueCount,topIssues,nextSuggestedAction/);
  const listingCsv = zip.readAsText(`${result.packageId}/reports/listing-csv/amazon-listing.csv`);
  assert.match(listingCsv, /sku,product_title,brand,category/);
  assert.match(listingCsv, /Amazon\/SKU001\/01_main\.jpg/);

  const zipText = entries
    .filter((entry) => entry.endsWith('.json') || entry.endsWith('.csv'))
    .map((entry) => zip.readAsText(entry))
    .join('\n');
  assert.doesNotMatch(zipText, /\.env/i);
  assert.doesNotMatch(zipText, /API_KEY/i);
  assert.doesNotMatch(zipText, /sk-secret/i);
  assert.doesNotMatch(zipText, /[A-Z]:\\/);
  assert.doesNotMatch(zipText, /app\.sqlite/i);
  assert.doesNotMatch(zipText, /node_modules/i);
  assert.equal(await getBatchTask('batch-export-package').then((batch) => JSON.stringify(batch)), JSON.stringify(beforeBatch));
});
