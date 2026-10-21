import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import AdmZip from 'adm-zip';
import sharp from 'sharp';
import { createHash } from 'node:crypto';
import fsSync from 'node:fs';
import { PassThrough } from 'node:stream';
import { mock } from 'node:test';
import { createBatchTask, createTask, getBatchTask, updateTask, resetDatabaseForTests, paths } from '../src/services/db.js';
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
  await Promise.all(imageTypes.slice(0, 3).map((type) => sharp({ create: { width: 16, height: 12, channels: 3, background: '#406080' } }).jpeg().toFile(path.join(fixtureOutputDir, `${type}.jpg`))));
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

test('final package counts, per-image errors, manifest and embedded listing reflect missing and corrupt source images', async () => {
  await seedBatch();
  const before = JSON.stringify(await getBatchTask('batch-export-package'));
  const preview = await buildExportPackagePreview('batch-export-package', { platforms: ['amazon'] });
  assert.equal(preview.summary.readyImageCount, 3);
  await fs.unlink(path.join(fixtureOutputDir, 'feature_image.jpg'));
  await fs.writeFile(path.join(fixtureOutputDir, 'size_image.jpg'), 'not an image');
  const result = await createStructuredExportPackage('batch-export-package', { platforms: ['amazon'], includeReports: true, confirmExport: true });
  const zip = new AdmZip(path.join(paths.rootDir, result.relativePath));
  const root = JSON.parse(zip.readAsText(`${result.packageId}/manifest.json`));
  const sku = JSON.parse(zip.readAsText(`${result.packageId}/Amazon/SKU001/manifest.json`));
  assert.equal(result.summary.readyImageCount, 1); assert.equal(result.summary.missingImageCount, 7);
  assert.equal(result.summary.mockImageCount, 1); assert.equal(root.missingImageCount, 7); assert.equal(root.mockImageCount, 1);
  assert.equal(sku.images.filter(image => image.exists).length, 1);
  assert.equal(sku.images[1].errorCode, 'SOURCE_FILE_MISSING'); assert.equal(sku.images[2].errorCode, 'IMAGE_DECODE_FAILED');
  assert.equal(zip.getEntry(`${result.packageId}/Amazon/SKU001/02_feature.jpg`), null);
  assert.equal(zip.getEntry(`${result.packageId}/Amazon/SKU001/03_size.jpg`), null);
  assert.equal(result.directoryTree.find(row => row.path.endsWith('/02_feature.jpg')).status, 'missing');
  const listing = zip.readAsText(`${result.packageId}/reports/listing-csv/amazon-listing.csv`);
  assert.match(listing, /Amazon\/SKU001\/01_main\.jpg/); assert.doesNotMatch(listing, /02_feature\.jpg|03_size\.jpg/);
  assert.equal(JSON.stringify(await getBatchTask('batch-export-package')), before);
});

test('fixed JPEG names contain decoded JPEG pixels, white transparency, source/output hashes and a verifiable ZIP checksum', async () => {
  await seedBatch();
  const file = path.join(fixtureOutputDir, 'main_image.jpg');
  const png = await sharp({ create: { width: 16, height: 12, channels: 4, background: { r: 20, g: 40, b: 60, alpha: 0 } } }).png().toBuffer();
  await fs.writeFile(file, png); // Deliberately mismatched source extension; inspect actual bytes.
  const result = await createStructuredExportPackage('batch-export-package', { platforms: ['amazon'], includeReports: false, confirmExport: true });
  const bytes = await fs.readFile(path.join(paths.rootDir, result.relativePath)), zip = new AdmZip(bytes);
  const jpeg = zip.readFile(`${result.packageId}/Amazon/SKU001/01_main.jpg`);
  const meta = await sharp(jpeg).metadata(); assert.equal(meta.format, 'jpeg'); assert.equal(meta.width, 16); assert.equal(meta.height, 12); assert.equal(Boolean(meta.hasAlpha), false);
  const pixel = await sharp(jpeg).raw().toBuffer(); assert.ok(pixel.every(value => value >= 250));
  const row = JSON.parse(zip.readAsText(`${result.packageId}/Amazon/SKU001/manifest.json`)).images[0];
  const hash = value => createHash('sha256').update(value).digest('hex');
  assert.equal(row.sourceSha256, hash(png)); assert.equal(row.sha256, hash(jpeg)); assert.equal(row.format, 'jpeg'); assert.equal(row.bytes, jpeg.length);
  assert.equal(result.sha256, hash(bytes)); assert.equal(result.bytes, bytes.length);
  assert.equal(hash(await fs.readFile(file)), hash(png));
});

test('sanitized case-insensitive SKU path collisions fail during preview before any output can be overwritten', async () => {
  await seedBatch();
  await createTask(task({ id:'task-export-collision',sku:'sku001' }));
  const { updateBatchTask } = await import('../src/services/db.js');
  await updateBatchTask('batch-export-package', batch => ({skuTasks:[...batch.skuTasks,{skuId:'sku001',taskId:'task-export-collision',status:'reviewed'}]}));
  await assert.rejects(buildExportPackagePreview('batch-export-package',{platforms:['amazon']}),error=>error.code==='EXPORT_PATH_COLLISION'&&error.statusCode===409);
  await assert.rejects(createStructuredExportPackage('batch-export-package',{platforms:['amazon'],confirmExport:true}),error=>error.code==='EXPORT_PATH_COLLISION');
  await assert.rejects(fs.stat(exportPackagesDir),/ENOENT/);
});

test('Windows dot, traversal, device, trailing-dot and overlong export folders are rejected before writing',async()=>{
  await seedBatch();
  const {updateTask}=await import('../src/services/db.js');
  for(const sku of ['.','..','CON','nul.jpg','LPT1','SKU.','A'.repeat(201)]){
    await updateTask('task-export-a',task=>({productInfoConfirmed:{...task.productInfoConfirmed,sku}}));
    await assert.rejects(buildExportPackagePreview('batch-export-package',{platforms:['amazon']}),error=>error.code==='EXPORT_PATH_INVALID'&&error.statusCode===400);
  }
  await updateTask('task-export-a',task=>({productInfoConfirmed:{...task.productInfoConfirmed,sku:'SAFE-SKU'}}));
  await assert.rejects(createStructuredExportPackage('batch-export-package',{platforms:['..'],confirmExport:true}),error=>error.code==='EXPORT_PATH_INVALID');
  await assert.rejects(fs.stat(exportPackagesDir),/ENOENT/);
});

test('ZIP output errors reject the request instead of becoming an unhandled stream error or reporting success', async () => {
  await seedBatch();
  const stub=mock.method(fsSync,'createWriteStream',()=>{
    const output=new PassThrough();queueMicrotask(()=>output.destroy(Object.assign(new Error('fixture disk full'),{code:'ENOSPC'})));return output;
  });
  try { await assert.rejects(createStructuredExportPackage('batch-export-package',{platforms:['amazon'],includeReports:false,confirmExport:true}),error=>error.code==='ENOSPC'); }
  finally { stub.mock.restore(); }
});

test('preview decodes current source files and exposes existing missing/corrupt images without writing a package',async()=>{
  await seedBatch();await fs.unlink(path.join(fixtureOutputDir,'feature_image.jpg'));await fs.writeFile(path.join(fixtureOutputDir,'size_image.jpg'),'bad image');
  const preview=await buildExportPackagePreview('batch-export-package',{platforms:['amazon']});
  assert.equal(preview.summary.readyImageCount,1);assert.equal(preview.summary.missingImageCount,7);
  assert.equal(preview.directoryTree.find(row=>row.path.endsWith('/02_feature.jpg')).errorCode,'SOURCE_FILE_MISSING');
  assert.equal(preview.directoryTree.find(row=>row.path.endsWith('/03_size.jpg')).errorCode,'IMAGE_DECODE_FAILED');
  assert.equal(preview.preflight.sourceFilesChecked,3);await assert.rejects(fs.stat(exportPackagesDir),/ENOENT/);
});

test('same-platform country targets export separate pixels, target manifests and CSV rows without overwriting',async()=>{
  await seedBatch();
  const targets=[{id:'us',platformId:'amazon',site:'US',language:'English'},{id:'de',platformId:'amazon',site:'DE',language:'German'}];
  await sharp({create:{width:16,height:12,channels:3,background:'#c03020'}}).jpeg().toFile(path.join(fixtureOutputDir,'feature_image.jpg'));
  await updateTask('task-export-a',()=>({targets,generatedImages:[generatedImage('main_image',{targetId:'us'}),generatedImage('main_image',{targetId:'de',filePath:'outputs/export-package-fixtures/feature_image.jpg'})]}));
  const preview=await buildExportPackagePreview('batch-export-package',{platforms:['amazon']});assert.equal(preview.summary.totalExpectedImages,16);assert.equal(preview.summary.readyImageCount,2);
  const result=await createStructuredExportPackage('batch-export-package',{platforms:['amazon'],includeReports:true,confirmExport:true});
  const zip=new AdmZip(path.join(paths.rootDir,result.relativePath)),root=JSON.parse(zip.readAsText(`${result.packageId}/manifest.json`));
  assert.equal(root.targets.length,2);assert.deepEqual(root.targets.map(row=>row.targetId),['us','de']);
  const folders=root.targets.map(row=>row.folder);assert.equal(new Set(folders.map(value=>value.toLowerCase())).size,2);
  const hashes=folders.map(folder=>createHash('sha256').update(zip.readFile(`${result.packageId}/${folder}/01_main.jpg`)).digest('hex'));assert.notEqual(hashes[0],hashes[1]);
  for(const [index,folder] of folders.entries()){const manifest=JSON.parse(zip.readAsText(`${result.packageId}/${folder}/manifest.json`));assert.equal(manifest.targetId,targets[index].id);assert.equal(manifest.site,targets[index].site);}
  const csv=zip.readAsText(`${result.packageId}/reports/listing-csv/amazon-listing.csv`);assert.match(csv,/target_id,site,language/);for(const folder of folders)assert.ok(csv.includes(`${folder}/01_main.jpg`));
  const mapping=JSON.parse(zip.readAsText(`${result.packageId}/reports/listing-csv/listing-field-mapping.json`));assert.equal(mapping.platforms.amazon.targets.length,2);
});

test('real-only export excludes fallback mock even with a real label and samples need a separate opt-in',async()=>{
  await seedBatch();
  await updateTask('task-export-a',()=>({generatedImages:[generatedImage('main_image',{fallbackToMock:true,sourceType:'real'}),generatedImage('feature_image',{provider:'custom',isRealGenerated:true,isMockPreview:false,mockPreview:null}),generatedImage('size_image',{sourceType:'realSample',provider:'custom',isRealGenerated:true,isMockPreview:false,mockPreview:null})]}));
  const preview=await buildExportPackagePreview('batch-export-package',{platforms:['amazon'],includeMockImages:false});assert.equal(preview.summary.readyImageCount,1);
  assert.equal(preview.directoryTree.find(row=>row.path.endsWith('/01_main.jpg')).exclusionCode,'IMAGE_EXCLUDED_MOCK');
  assert.equal((await buildExportPackagePreview('batch-export-package',{platforms:['amazon'],includeMockImages:false,includeRealSamples:true})).summary.readyImageCount,2);
  const result=await createStructuredExportPackage('batch-export-package',{platforms:['amazon'],includeMockImages:false,includeReports:true,confirmExport:true});const zip=new AdmZip(path.join(paths.rootDir,result.relativePath));
  assert.equal(result.summary.readyImageCount,1);assert.equal(result.summary.fallbackMockImageCount,0);assert.equal(zip.getEntry(`${result.packageId}/Amazon/SKU001/01_main.jpg`),null);
  assert.doesNotMatch(zip.readAsText(`${result.packageId}/reports/listing-csv/amazon-listing.csv`),/01_main.jpg|03_size.jpg/);
});

test('unassigned same-platform images are reported instead of being borrowed by every target',async()=>{
  await seedBatch();await updateTask('task-export-a',()=>({targets:[{id:'us',platformId:'amazon',site:'US'},{id:'de',platformId:'amazon',site:'DE'}],imagePlans:[],generatedImages:[generatedImage('main_image',{planId:'no-plan'})]}));
  const preview=await buildExportPackagePreview('batch-export-package',{platforms:['amazon']});assert.equal(preview.summary.readyImageCount,0);assert.equal(preview.targetWarnings[0].code,'IMAGE_TARGET_AMBIGUOUS');
});
