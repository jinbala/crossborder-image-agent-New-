import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import request from 'supertest';
import sharp from 'sharp';
import AdmZip from 'adm-zip';
import app from '../src/app.js';
import { WORKBENCH_DIR } from '../src/services/workbenchService.js';

const createdJobIds = [];

afterEach(async () => {
  await Promise.all(createdJobIds.splice(0).map((id) => fs.rm(path.join(WORKBENCH_DIR, id), { recursive: true, force: true })));
});

test('workbench overview exposes implementation boundaries', async () => {
  const response = await request(app).get('/api/workbench/overview').expect(200);
  assert.equal(response.body.scope, 'clean-room-reimplementation');
  assert.equal(response.body.modules.find((item) => item.id === 'image-pack').status, 'available');
  assert.equal(response.body.modules.find((item) => item.id === 'temu-deep').status, 'available-runtime-required');
  assert.equal(response.body.modules.find((item) => item.id === 'store-automation').status, 'not-connected');
});

test('collection rows route creates a resumable job from pasted product links', async () => {
  const response = await request(app)
    .post('/api/workbench/collection-jobs/rows')
    .send({
      rows: [{ productUrl: 'https://shop.example/item/one' }, { productUrl: 'https://shop.example/item/two' }],
      options: { name: '粘贴链接采集', extraWaitMs: 0 }
    })
    .expect(201);
  createdJobIds.push(response.body.id);
  assert.equal(response.body.type, 'collection-job');
  assert.equal(response.body.source.type, 'browser-or-manual');
  assert.equal(response.body.summary.inputCount, 2);
  assert.equal(response.body.summary.pendingCount, 2);
});

test('collection plan validates and persists source URLs', async () => {
  const response = await request(app)
    .post('/api/workbench/collection-plans')
    .send({ name: '参考图计划', urls: ['https://example.com/item/1', 'https://example.com/item/1', 'https://example.com/item/2'] })
    .expect(201);
  createdJobIds.push(response.body.id);
  assert.equal(response.body.type, 'collection-plan');
  assert.equal(response.body.summary.inputCount, 2);
  assert.equal(response.body.mode, 'manual-import');
  assert.match(response.body.manifestUrl, /^\/outputs\/workbench\//);
});

test('collection job route imports CSV and creates a resumable manifest', async () => {
  const csv = Buffer.from('\uFEFFSKU,销量,商品链接,主图链接\nSKU-COLLECT,66,https://shop.example/item/1,https://img.example/item-1.jpg\n');
  const response = await request(app)
    .post('/api/workbench/collection-jobs')
    .field('options', JSON.stringify({ name: '表格采集', minSales: 10, extraWaitMs: 0 }))
    .attach('sheet', csv, { filename: 'collection.csv', contentType: 'text/csv' })
    .expect(201);
  createdJobIds.push(response.body.id);
  assert.equal(response.body.type, 'collection-job');
  assert.equal(response.body.status, 'queued');
  assert.equal(response.body.summary.pendingCount, 1);
  assert.equal(response.body.source.safeMode.formulasExecuted, false);
  assert.match(response.body.backupUrl, /manifest\.backup\.json$/);
  assert.ok((await fs.stat(path.join(WORKBENCH_DIR, response.body.id, 'manifest.backup.json'))).size > 0);

  const loaded = await request(app).get(`/api/workbench/collection-jobs/${response.body.id}`).expect(200);
  assert.equal(loaded.body.items[0].sku, 'SKU-COLLECT');
});

test('collection rows route rejects rows without valid public URLs', async () => {
  await request(app)
    .post('/api/workbench/collection-jobs/rows')
    .send({ rows: [{ productUrl: 'not-a-url' }, { imageUrls: ['file:///secret.png'] }] })
    .expect(400);
});

test('browser collector preserves variants and imports authorized-session image bytes', async () => {
  const sourceUrl = 'https://img.example/variant-red.png';
  const created = await request(app)
    .post('/api/workbench/collection-jobs/rows')
    .send({
      rows: [{
        sku: 'TEMU-1',
        productUrl: 'https://www.temu.com/goods.html?goods_id=1',
        imageUrls: [sourceUrl],
        variants: [{ id: 'red-l', name: '红色 L', imageUrls: [sourceUrl] }],
        extraction: { sourceCounts: { structuredData: 1 }, totalFound: 1, returned: 1, scannedScriptBytes: 500 }
      }],
      options: { mode: 'temu-deep' }
    })
    .expect(201);
  createdJobIds.push(created.body.id);
  assert.equal(created.body.items[0].variants[0].name, '红色 L');
  assert.equal(created.body.items[0].extraction.sourceCounts.structuredData, 1);

  const image = await sharp({ create: { width: 320, height: 240, channels: 3, background: '#ca3142' } }).png().toBuffer();
  const imported = await request(app)
    .post(`/api/workbench/collection-jobs/${created.body.id}/browser-images`)
    .field('itemId', created.body.items[0].id)
    .field('sourceUrl', sourceUrl)
    .attach('image', image, { filename: 'variant-red.png', contentType: 'image/png' })
    .expect(201);
  assert.equal(imported.body.image.adapter, 'authorized-browser-session');
  assert.equal(imported.body.image.width, 320);
  assert.equal(imported.body.summary.downloadedCount, 1);
  assert.match(imported.body.image.sha256, /^[a-f0-9]{64}$/);

  const loaded = await request(app).get(`/api/workbench/collection-jobs/${created.body.id}`).expect(200);
  assert.equal(loaded.body.items[0].images[0].sourceUrl, sourceUrl);
  assert.equal(loaded.body.status, 'completed');
  await request(app).get(loaded.body.downloadUrl).expect(200);
});

test('SKU metadata import route returns replacement fields from CSV', async () => {
  const csv = Buffer.from('\uFEFFSKU,货号,规格,变种SKU,商品标题\nSKU-META,SPU-1,黑色/L,BLACK-L,黑色上衣\n');
  const response = await request(app)
    .post('/api/workbench/sku-metadata-imports')
    .attach('sheet', csv, { filename: 'metadata.csv', contentType: 'text/csv' })
    .expect(200);
  assert.deepEqual(response.body.records[0], { sku: 'SKU-META', spu: 'SPU-1', spec: '黑色/L', variantSku: 'BLACK-L', title: '黑色上衣' });
});

test('image pack converts an image and produces a ZIP', async () => {
  const input = await sharp({ create: { width: 900, height: 600, channels: 3, background: '#2f766f' } }).png().toBuffer();
  const response = await request(app)
    .post('/api/workbench/image-packs')
    .field('name', '方图测试')
    .field('prefix', 'sku-test')
    .field('format', 'jpeg')
    .field('quality', '80')
    .field('square', 'true')
    .field('squareSize', '640')
    .attach('images', input, { filename: 'source.png', contentType: 'image/png' })
    .expect(201);

  createdJobIds.push(response.body.id);
  assert.equal(response.body.status, 'completed');
  assert.equal(response.body.summary.outputCount, 1);
  assert.equal(response.body.items[0].output.width, 640);
  assert.equal(response.body.items[0].output.height, 640);
  assert.equal(response.body.items[0].fileName, 'sku-test-001.jpg');
  assert.match(response.body.downloadUrl, /\.zip$/);
  const zipPath = path.join(WORKBENCH_DIR, response.body.id, `${response.body.id}.zip`);
  assert.ok((await fs.stat(zipPath)).size > 0);
});

test('SKU folder pack groups files, recognizes roles, applies placeholders and creates a square image', async () => {
  const main = await sharp({ create: { width: 900, height: 600, channels: 3, background: '#2f766f' } }).png().toBuffer();
  const detail = await sharp({ create: { width: 500, height: 800, channels: 3, background: '#c78f45' } }).png().toBuffer();
  const options = {
    name: 'SKU 图包测试',
    format: 'jpeg',
    quality: 82,
    maxDimension: 700,
    squareSize: 640,
    preserveOriginals: true,
    preprocessOriginals: true,
    generateSquare: true,
    namingTemplate: '{sku}-{spu}-{spec}-{variantSku}-{role}-{index}',
    metadata: { 'SKU-001': { spu: 'SPU-77', spec: 'L', variantSku: 'VAR-RED', title: '红色连衣裙' } }
  };
  const response = await request(app)
    .post('/api/workbench/sku-packs')
    .field('relativePaths', JSON.stringify(['图包根目录/SKU-001/main1.png', '图包根目录/SKU-001/detail1.png']))
    .field('options', JSON.stringify(options))
    .attach('images', main, { filename: 'main1.png', contentType: 'image/png' })
    .attach('images', detail, { filename: 'detail1.png', contentType: 'image/png' })
    .expect(201);

  createdJobIds.push(response.body.id);
  assert.equal(response.body.type, 'sku-pack');
  assert.equal(response.body.status, 'completed');
  assert.deepEqual(response.body.summary, {
    completedSkuCount: 1,
    unprocessedCount: 0,
    inputCount: 2,
    skuCount: 1,
    outputCount: 3,
    failedCount: 0,
    duplicateSkippedCount: 0,
    generatedSquareCount: 1,
    mattedCount: 0
  });
  assert.equal(response.body.skuResults[0].items[0].role, 'detail');
  assert.equal(response.body.skuResults[0].items[1].role, 'main');
  assert.equal(response.body.skuResults[0].items[2].role, 'square');
  assert.equal(response.body.skuResults[0].items[2].output.width, 640);
  assert.equal(response.body.skuResults[0].items[2].output.height, 640);

  const zipPath = path.join(WORKBENCH_DIR, response.body.id, `${response.body.id}.zip`);
  const entries = new AdmZip(zipPath).getEntries().map((entry) => entry.entryName);
  assert.ok(entries.some((entry) => entry === 'SKU-001/main/SKU-001-SPU-77-L-VAR-RED-main-001.jpg'));
  assert.ok(entries.some((entry) => entry === 'SKU-001/detail/SKU-001-SPU-77-L-VAR-RED-detail-001.jpg'));
  assert.ok(entries.some((entry) => entry === 'SKU-001/square/SKU-001-SPU-77-L-VAR-RED-square-001.jpg'));
  assert.equal(entries.filter((entry) => entry.startsWith('SKU-001/originals/') && !entry.endsWith('/')).length, 2);
  assert.equal(entries.filter((entry) => entry.startsWith('SKU-001/preprocessed/') && !entry.endsWith('/')).length, 2);
  assert.ok(entries.includes('manifest.json'));
});

test('SKU pack supports manual role overrides and local batch matting', async () => {
  const input = await sharp({ create: { width: 500, height: 500, channels: 3, background: '#ffffff' } })
    .composite([{ input: Buffer.from('<svg width="500" height="500"><rect x="120" y="80" width="260" height="340" rx="35" fill="#b83232"/></svg>') }])
    .png()
    .toBuffer();
  const relativePath = '图包根目录/SKU-MATTE/product.png';
  const response = await request(app)
    .post('/api/workbench/sku-packs')
    .field('relativePaths', JSON.stringify([relativePath]))
    .field('options', JSON.stringify({
      format: 'png',
      generateSquare: false,
      preserveOriginals: false,
      matteImages: true,
      mattingProvider: 'sharp',
      roleOverrides: { [relativePath]: 'swatch' }
    }))
    .attach('images', input, { filename: 'product.png', contentType: 'image/png' })
    .expect(201);

  createdJobIds.push(response.body.id);
  assert.equal(response.body.status, 'completed');
  assert.equal(response.body.summary.mattedCount, 1);
  const item = response.body.skuResults[0].items[0];
  assert.equal(item.role, 'swatch');
  assert.equal(item.roleSource, 'manual');
  assert.equal(item.matting.providerUsed, 'sharp');
  const outputPath = path.join(WORKBENCH_DIR, response.body.id, 'package', ...item.outputFile.split('/'));
  assert.equal((await sharp(outputPath).metadata()).hasAlpha, true);
});

test('SKU pack supports manual order, target KB compression and perceptual duplicate skipping', async () => {
  const pixels = Buffer.alloc(900 * 900 * 3);
  for (let index = 0; index < pixels.length; index += 1) pixels[index] = (index * 31 + Math.floor(index / 97) * 17) % 256;
  const original = await sharp(pixels, { raw: { width: 900, height: 900, channels: 3 } }).png().toBuffer();
  const other = await sharp({ create: { width: 900, height: 600, channels: 3, background: '#2458a6' } }).png().toBuffer();
  const paths = [
    '图包根目录/SKU-ORDER/a.png',
    '图包根目录/SKU-ORDER/a-copy.png',
    '图包根目录/SKU-ORDER/b.png'
  ];
  const response = await request(app)
    .post('/api/workbench/sku-packs')
    .field('relativePaths', JSON.stringify(paths))
    .field('options', JSON.stringify({
      format: 'jpeg',
      quality: 92,
      targetKilobytes: 80,
      maxDimension: 900,
      generateSquare: false,
      preserveOriginals: false,
      orderMode: 'manual',
      manualOrder: [paths[2], paths[0], paths[1]],
      deduplicateImages: true,
      duplicateThreshold: 0
    }))
    .attach('images', original, { filename: 'a.png', contentType: 'image/png' })
    .attach('images', original, { filename: 'a-copy.png', contentType: 'image/png' })
    .attach('images', other, { filename: 'b.png', contentType: 'image/png' })
    .expect(201);

  createdJobIds.push(response.body.id);
  const items = response.body.skuResults[0].items;
  assert.equal(items[0].sourceRelativePath, 'SKU-ORDER/b.png');
  assert.equal(items[1].sourceRelativePath, 'SKU-ORDER/a.png');
  assert.equal(items[2].status, 'skipped');
  assert.equal(items[2].skipReason, 'DUPLICATE_IMAGE');
  assert.equal(items[2].duplicateOf, 'SKU-ORDER/a.png');
  assert.equal(response.body.summary.duplicateSkippedCount, 1);
  assert.equal(items[1].output.targetMet, true);
  assert.ok(items[1].output.bytes <= 80 * 1024);
  assert.ok(items[1].output.compressionAttempts > 1);
});

test('SKU pack can classify strong visual swatch features without filename hints', async () => {
  const swatch = await sharp({ create: { width: 300, height: 300, channels: 3, background: '#2354d8' } }).png().toBuffer();
  const response = await request(app)
    .post('/api/workbench/sku-packs')
    .field('relativePaths', JSON.stringify(['图包根目录/SKU-VISUAL/product.png']))
    .field('options', JSON.stringify({
      format: 'png',
      generateSquare: false,
      preserveOriginals: false,
      visualRoleRecognition: true
    }))
    .attach('images', swatch, { filename: 'product.png', contentType: 'image/png' })
    .expect(201);
  createdJobIds.push(response.body.id);
  const item = response.body.skuResults[0].items[0];
  assert.equal(item.role, 'swatch');
  assert.equal(item.roleSource, 'visual-heuristic');
  assert.equal(item.roleRecognition.reason, 'small_square_low_entropy');
  assert.ok(item.roleRecognition.confidence >= 0.8);
});

test('listing dry run validates Temu rows and exports a safe CSV draft', async () => {
  const response = await request(app)
    .post('/api/workbench/listing-dry-runs')
    .send({
      name: 'Temu 草稿测试',
      platformId: 'temu',
      rows: [
        { sku: '=FORMULA', title: '合规标题', price: 19.9, stock: 10, weightGrams: 300, mainImageRef: 'material-001', description: '商品描述' },
        { sku: 'SKU-BLOCKED', title: '', price: 0, stock: 1, mainImageRef: '' }
      ]
    })
    .expect(201);
  createdJobIds.push(response.body.id);
  assert.equal(response.body.type, 'listing-dry-run');
  assert.equal(response.body.summary.readyCount, 1);
  assert.equal(response.body.summary.blockedCount, 1);
  assert.equal(response.body.templateType, 'preflight-draft');
  const csvPath = path.join(WORKBENCH_DIR, response.body.id, `${response.body.id}-temu-draft.csv`);
  const csv = await fs.readFile(csvPath, 'utf8');
  assert.match(csv, /"'=FORMULA"/);
  assert.match(csv, /material-001/);
});

test('pricing preview applies multiple rules without changing any store price', async () => {
  const response = await request(app)
    .post('/api/workbench/pricing-previews')
    .send({
      name: '两轮调价',
      rounding: 'cent',
      rules: [{ type: 'percent', value: -10 }, { type: 'fixed', value: 1 }],
      items: [{ sku: 'SKU-100', price: 100 }, { sku: 'SKU-INVALID', price: 0 }]
    })
    .expect(201);
  createdJobIds.push(response.body.id);
  assert.equal(response.body.type, 'pricing-preview');
  assert.equal(response.body.mode, 'local-preview');
  assert.equal(response.body.items[0].newPrice, 91);
  assert.equal(response.body.items[0].trace.length, 2);
  assert.equal(response.body.items[1].status, 'blocked');
  assert.equal(response.body.summary.totalBefore, 100);
  assert.equal(response.body.summary.totalAfter, 91);
});
