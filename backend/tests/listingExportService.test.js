import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createBatchTask, createTask, getBatchTask, resetDatabaseForTests, paths } from '../src/services/db.js';
import {
  buildListingCsvPreview,
  createListingCsvExport
} from '../src/services/listingExportService.js';

const now = '2026-06-01T12:00:00.000Z';
const listingDir = path.join(paths.outputDir, 'listing-csv');

function image(type, platformId = 'amazon') {
  const fileNameByType = {
    main_image: '01_main.jpg',
    feature_image: '02_feature.jpg',
    size_image: '03_size.jpg',
    compatibility_image: '04_compatibility.jpg',
    package_image: '05_package.jpg',
    lifestyle_image: '06_lifestyle.jpg',
    detail_image: '07_detail.jpg',
    variant_image: '08_variant.jpg'
  };
  return {
    id: `${platformId}-${type}`,
    planId: `${platformId}-${type}-plan`,
    imageType: type,
    type,
    status: 'succeeded',
    provider: 'mock',
    isMockPreview: true,
    platformId,
    fileName: fileNameByType[type],
    filePath: `outputs/example/${platformId}/${fileNameByType[type]}`,
    mockPreview: { template: { templateName: `${type} Template`, layoutStyle: `${type}-layout` } }
  };
}

function task(overrides = {}) {
  const imageTypes = ['main_image', 'feature_image', 'size_image', 'compatibility_image', 'package_image', 'lifestyle_image', 'detail_image', 'variant_image'];
  const generatedImages = [
    ...imageTypes.map((type) => image(type, 'amazon')),
    ...imageTypes.map((type) => image(type, 'temu'))
  ];
  return {
    id: overrides.id || 'task-listing-a',
    batchId: 'batch-listing',
    sku: overrides.sku || 'SKU001',
    status: 'reviewed',
    platformId: 'amazon',
    categoryId: 'electronics_storage',
    targets: [
      { id: 'target-amazon', platformId: 'amazon', platformName: 'Amazon', categoryId: 'electronics_storage' },
      { id: 'target-temu', platformId: 'temu', platformName: 'Temu', categoryId: 'electronics_storage' }
    ],
    productInfoConfirmed: {
      sku: overrides.sku || 'SKU001',
      name: 'Portable Drive, 1TB',
      brand: '',
      category: 'External Storage',
      sellingPoints: [
        'Compact metal shell',
        'USB-C connection',
        'Works with laptops',
        'Includes cable',
        'Clean desk setup',
        '中文 Best $19.99 discount'
      ],
      description: 'Portable drive for everyday backups.',
      color: 'Silver',
      material: 'Aluminum',
      compatibleDevices: ['Laptop', 'Desktop'],
      packageIncluded: ['Drive', 'USB-C cable'],
      capacity: '1TB',
      certifications: 'CE',
      warranty: '2 years',
      speed: '1000MB/s'
    },
    recognitionQuality: {
      blockedHighRiskFields: [{ field: 'capacity', reason: 'missingEvidence' }],
      missingEvidenceFields: [{ field: 'capacity' }, { field: 'warranty' }, { field: 'speed' }],
      conflictFields: [{ field: 'brand', values: ['Brand A', 'Brand B'] }],
      inferredOnlyFields: [{ field: 'certifications' }]
    },
    inferredCandidates: [{ field: 'capacity', value: '2TB' }],
    imagePlans: [],
    generatedImages,
    review: {
      reviewedAt: now,
      reviewMode: 'mock',
      overallStatus: 'passed',
      items: []
    },
    ...overrides
  };
}

async function seedBatch() {
  await createBatchTask({
    id: 'batch-listing',
    name: 'Listing Batch',
    status: 'reviewed',
    createdAt: now,
    updatedAt: now,
    skuTasks: [
      { skuId: 'SKU001', taskId: 'task-listing-a', displayName: 'SKU001', status: 'reviewed', currentStep: 'review' },
      { skuId: 'SKU002', taskId: 'task-listing-noreview', displayName: 'SKU002', status: 'generated', currentStep: 'review' },
      { skuId: 'SKU003', taskId: 'task-listing-missing', displayName: 'SKU003', status: 'failed', currentStep: 'generate', error: { message: 'D:\\Code\\.env API_KEY=sk-secret app.sqlite node_modules' } }
    ]
  });
  await createTask(task());
  await createTask(task({
    id: 'task-listing-noreview',
    sku: 'SKU002',
    status: 'generated',
    productInfoConfirmed: { sku: 'SKU002', name: 'No Review Product', sellingPoints: ['Simple storage case'] },
    generatedImages: [image('main_image', 'amazon')],
    review: null
  }));
}

beforeEach(async () => {
  await resetDatabaseForTests();
  await fs.rm(listingDir, { recursive: true, force: true });
});

test('buildListingCsvPreview summarizes rows blocked fields noReview and does not write files', async () => {
  await seedBatch();
  const beforeBatch = await getBatchTask('batch-listing');

  const preview = await buildListingCsvPreview('batch-listing', { platforms: ['amazon', 'temu'], includeMockImages: true });

  assert.equal(preview.batchId, 'batch-listing');
  assert.equal(preview.mode, 'preview');
  assert.deepEqual(preview.platforms, ['amazon', 'temu']);
  assert.equal(preview.summary.rowsByPlatform.amazon, 2);
  assert.equal(preview.summary.rowsByPlatform.temu, 2);
  assert.equal(preview.summary.noReviewSku.includes('SKU002'), true);
  assert.equal(preview.summary.blockedFields.some((item) => item.field === 'capacity' && item.status === 'blocked_missing_evidence'), true);
  assert.equal(preview.files.some((file) => file.fileName === 'amazon-listing.csv'), true);
  assert.equal(await getBatchTask('batch-listing').then((batch) => JSON.stringify(batch)), JSON.stringify(beforeBatch));
  await assert.rejects(fs.stat(listingDir), /ENOENT/);
});

test('createListingCsvExport requires confirmation and writes sanitized platform CSV mapping and summary', async () => {
  await seedBatch();
  const beforeBatch = await getBatchTask('batch-listing');

  await assert.rejects(
    createListingCsvExport('batch-listing', { platforms: ['amazon', 'temu'], confirmExport: false }),
    /confirmExport=true/
  );

  const result = await createListingCsvExport('batch-listing', {
    platforms: ['amazon', 'temu', 'noon'],
    includeMockImages: true,
    confirmExport: true
  });

  assert.match(result.exportId, /^listing-csv-batch-listing-/);
  assert.equal(result.files.some((file) => file.platform === 'amazon' && file.fileName === 'amazon-listing.csv'), true);
  assert.equal(result.files.some((file) => file.platform === 'temu' && file.fileName === 'temu-listing.csv'), true);
  assert.equal(result.files.some((file) => file.platform === 'noon' && file.fileName === 'noon-listing.csv'), true);
  assert.equal(result.files.some((file) => file.fileName === 'listing-field-mapping.json'), true);
  assert.equal(result.files.some((file) => file.fileName === 'listing-export-summary.json'), true);
  assert.ok(result.files.every((file) => !/[A-Z]:\\/.test(file.relativePath)));

  const exportRoot = path.join(paths.rootDir, result.relativePath);
  const amazonCsv = await fs.readFile(path.join(exportRoot, 'amazon-listing.csv'), 'utf8');
  const temuCsv = await fs.readFile(path.join(exportRoot, 'temu-listing.csv'), 'utf8');
  const noonCsv = await fs.readFile(path.join(exportRoot, 'noon-listing.csv'), 'utf8');
  const mapping = JSON.parse(await fs.readFile(path.join(exportRoot, 'listing-field-mapping.json'), 'utf8'));
  const summary = JSON.parse(await fs.readFile(path.join(exportRoot, 'listing-export-summary.json'), 'utf8'));

  assert.match(amazonCsv.split('\n')[0], /sku,product_title,brand,category,bullet_point_1,bullet_point_2,bullet_point_3,bullet_point_4,bullet_point_5,product_description,main_image,other_image_1/);
  assert.match(temuCsv.split('\n')[0], /sku,product_name,category,product_description,selling_point_1,selling_point_2/);
  assert.match(amazonCsv, /"Portable Drive, 1TB"/);
  assert.match(amazonCsv, /Amazon\/SKU001\/01_main\.jpg/);
  assert.match(temuCsv, /Temu\/SKU001\/01_main\.jpg/);
  assert.match(noonCsv, /placeholder_status/);
  assert.match(amazonCsv, /noReview/);
  assert.doesNotMatch(amazonCsv + temuCsv, /1TB,Aluminum/);
  assert.doesNotMatch(amazonCsv + temuCsv, /中文|Best|\$19\.99|discount|1000MB\/s|2 years|CE/);
  assert.doesNotMatch(amazonCsv + temuCsv, /\.env|API_KEY|sk-secret|[A-Z]:\\|app\.sqlite|node_modules/i);
  assert.equal(mapping.platforms.amazon.fields.capacity.status, 'blocked_missing_evidence');
  assert.equal(mapping.platforms.amazon.fields.brand.status, 'blocked_conflicted');
  assert.equal(summary.batchId, 'batch-listing');
  assert.equal(summary.rowsByPlatform.amazon, 2);
  assert.equal(summary.noReviewSku.includes('SKU002'), true);
  assert.equal(summary.failedSku.some((item) => item.sku === 'SKU003'), true);
  assert.equal(summary.blockedFields.some((item) => item.field === 'capacity'), true);
  assert.equal(await getBatchTask('batch-listing').then((batch) => JSON.stringify(batch)), JSON.stringify(beforeBatch));
});
