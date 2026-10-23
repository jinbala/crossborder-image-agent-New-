import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import AdmZip from 'adm-zip';
import sharp from 'sharp';
import { parseCollectionSpreadsheet, parseSkuMetadataSpreadsheet } from '../src/services/collectionSpreadsheetService.js';
import {
  applyReplacementRules,
  createCollectionJob,
  extractProductPage,
  originalImageUrl,
  getCollectionJob,
  previewCollectionManifestRepair,
  repairCollectionManifest,
  pauseRunningCollections,
  pauseCollectionJob,
  importBrowserImage,
  runCollectionJob,
  safeRequestBuffer
} from '../src/services/collectionJobService.js';
import { WORKBENCH_DIR } from '../src/services/workbenchService.js';

const cleanupPaths = [];

test('collection returns transient manual pause acknowledgement and resumes only remaining rows', async () => {
  const job=await createCollectionJob({rows:[1,2,3].map(id=>({sku:`STOP-${id}`,imageUrls:[`https://img.example/${id}.png`]})),options:{extraWaitMs:0}});
  cleanupPaths.push(path.join(WORKBENCH_DIR,job.id));
  const image=await sharp({create:{width:8,height:8,channels:3,background:'#ffffff'}}).png().toBuffer();let calls=0;
  const stopped=await runCollectionJob(job.id,{limit:3},{imageFetcher:async()=>{calls++;await pauseCollectionJob(job.id);return image;}});
  assert.equal(stopped.status,'paused');assert.equal(stopped.stopRequested,'pause');assert.equal(stopped.summary.pendingCount,2);assert.equal(calls,1);
  assert.equal(Object.hasOwn(await getCollectionJob(job.id),'stopRequested'),false);
  const resumed=await runCollectionJob(job.id,{limit:3},{imageFetcher:async()=>{calls++;return image;}});
  assert.equal(resumed.status,'completed');assert.equal(resumed.summary.downloadedCount,3);assert.equal(calls,3);assert.equal(Object.hasOwn(resumed,'stopRequested'),false);
});

test('collection cancellation stays cancelled after pause, preserves checkpoints and rejects late browser uploads', async () => {
  const job=await createCollectionJob({rows:[1,2].map(id=>({sku:`CANCEL-${id}`,imageUrls:[`https://img.example/${id}.png`]})),options:{extraWaitMs:0}});
  cleanupPaths.push(path.join(WORKBENCH_DIR,job.id));
  const image=await sharp({create:{width:8,height:8,channels:3,background:'#ffffff'}}).png().toBuffer();let calls=0;
  const stopped=await runCollectionJob(job.id,{limit:2},{imageFetcher:async()=>{calls++;await pauseCollectionJob(job.id,true);await pauseCollectionJob(job.id,false);return image;}});
  assert.equal(stopped.status,'cancelled');assert.equal(stopped.stopRequested,'cancel');assert.equal(stopped.summary.pendingCount,1);assert.equal(stopped.summary.downloadedCount,1);assert.equal(calls,1);
  assert.equal((await pauseCollectionJob(job.id,false)).manifest.status,'cancelled');
  const before=await fs.readFile(path.join(WORKBENCH_DIR,job.id,'manifest.json'),'utf8');
  await assert.rejects(importBrowserImage(job.id,{itemId:job.items[1].id,sourceUrl:job.items[1].imageUrls[0]}),error=>error.statusCode===409&&error.message.includes('已取消'));
  assert.equal(await fs.readFile(path.join(WORKBENCH_DIR,job.id,'manifest.json'),'utf8'),before);
  const resumed=await runCollectionJob(job.id,{limit:2},{imageFetcher:async()=>{calls++;return image;}});
  assert.equal(resumed.status,'completed');assert.equal(resumed.summary.downloadedCount,2);assert.equal(calls,2);
});

test('1000-row spreadsheet import and local validation completes within ten seconds', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'collection-1000-')); cleanupPaths.push(directory);
  const file = path.join(directory, '中文商品.csv');
  await fs.writeFile(file, 'SKU,销量,商品链接,图片链接\n' + Array.from({ length: 1000 }, (_, index) => `SKU-${index},${index},https://shop.example/item/${index},https://img.example/${index}.png`).join('\n'));
  const start = performance.now();
  const result = await parseCollectionSpreadsheet(file, '中文商品.csv');
  assert.equal(result.records.length, 1000); assert.ok(performance.now() - start < 10000);
});

test('100-product XLSX fixture filters, resumes after lost manifest, isolates failures and exports consistent ZIP', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'collection-flow-100-')); cleanupPaths.push(directory);
  const file = path.join(directory, '商品100.xlsx'), sheet = new AdmZip();
  const values = [['SKU', '销量', '商品链接', '图片链接', '商品标题'], ...Array.from({ length: 100 }, (_, index) => [`SKU-${index}`, String(index), `https://shop.example/${index}`, `https://img.example/${index}.png`, `商品${index}`])];
  sheet.addFile('xl/worksheets/sheet1.xml', Buffer.from(`<worksheet><sheetData>${values.map((row, index) => `<row r="${index + 1}">${row.map((value, column) => `<c r="${String.fromCharCode(65 + column)}${index + 1}" t="inlineStr"><is><t>${value}</t></is></c>`).join('')}</row>`).join('')}</sheetData></worksheet>`));
  sheet.writeZip(file);
  const parsed = await parseCollectionSpreadsheet(file, '商品100.xlsx'); assert.equal(parsed.records.length, 100);
  const job = await createCollectionJob({ rows: parsed.records, options: { minSales: 50, maxAttempts: 1, downloadOriginal: false } });
  const jobRoot = path.join(WORKBENCH_DIR, job.id); cleanupPaths.push(jobRoot);
  const image = await sharp({ create: { width: 16, height: 16, channels: 3, background: '#1278ab' } }).png().toBuffer(), calls = new Map();
  const deps = { imageFetcher: async (url) => { calls.set(url, (calls.get(url) || 0) + 1); if (url.endsWith('/75.png')) throw Object.assign(new Error('fixture failure'), { code: 'FIXTURE_FAILURE' }); return { buffer: image }; } };
  const first = await runCollectionJob(job.id, { limit: 10 }, deps); assert.equal(first.status, 'paused'); assert.equal(first.summary.completedCount, 10);
  await fs.writeFile(path.join(jobRoot, 'manifest.json'), '{broken');
  assert.equal((await getCollectionJob(job.id)).manifestRead.readOnly, true);
  await assert.rejects(runCollectionJob(job.id, { limit: 50 }, deps), error => error.code === 'COLLECTION_REPAIR_REQUIRED');
  const repair = await previewCollectionManifestRepair(job.id);
  await repairCollectionManifest(job.id, { confirm: true, previewHash: repair.previewHash, sourceHash: repair.sourceHash });
  let done;
  do { done = await runCollectionJob(job.id, { limit: 50 }, deps); } while (done.summary.pendingCount);
  assert.equal(done.summary.skippedCount, 50); assert.equal(done.summary.completedCount, 49); assert.equal(done.summary.failedCount, 1); assert.equal(done.summary.downloadedCount, 49);
  assert.ok([...calls.values()].every((count) => count === 1));
  const zip = new AdmZip(path.join(jobRoot, `${job.id}.zip`));
  assert.equal(zip.getEntries().filter((entry) => entry.entryName.endsWith('.png')).length, 49);
  assert.deepEqual(JSON.parse(zip.getEntry('manifest.json').getData()).summary, done.summary);
});

test('collection resumes interrupted running items and reclaims a dead owner lock', async () => {
  const job = await createCollectionJob({ rows: [{ sku: 'RECOVER', imageUrls: ['https://img.example/recover.png'], title: 'Recovery', sales: 1 }] });
  const folder = path.join(WORKBENCH_DIR, job.id);
  cleanupPaths.push(folder);
  job.items[0].status = 'running';
  await fs.writeFile(path.join(folder, 'manifest.json'), JSON.stringify(job));
  await fs.writeFile(path.join(folder, 'run.lock'), JSON.stringify({ pid: 2147483647 }));
  const image = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#ffffff' } }).png().toBuffer();
  const result = await runCollectionJob(job.id, {}, { imageFetcher: async () => image });
  assert.equal(result.status, 'completed');
  assert.equal(result.summary.downloadedCount, 1);
});

test('corrupt collection manifest is recovered from backup without rewriting on read', async () => {
  const job = await createCollectionJob({ rows: [{ imageUrls: ['https://img.example/a.png'] }] });
  const folder = path.join(WORKBENCH_DIR, job.id);
  cleanupPaths.push(folder);
  await fs.writeFile(path.join(folder, 'manifest.json'), '{broken');
  const recovered = await getCollectionJob(job.id);
  assert.equal(recovered.id, job.id);
  assert.equal(recovered.recoveredFromBackup, true);
  assert.equal(await fs.readFile(path.join(folder, 'manifest.json'), 'utf8'), '{broken');
});

test('global pause stops collection after the current product and preserves remaining rows', async () => {
  const job = await createCollectionJob({ rows: [1, 2].map((id) => ({ title: `Item ${id}`, sales: 1, imageUrls: [`https://img.example/${id}.png`] })) });
  cleanupPaths.push(path.join(WORKBENCH_DIR, job.id));
  const image = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#ffffff' } }).png().toBuffer();
  const result = await runCollectionJob(job.id, {}, { imageFetcher: async () => { pauseRunningCollections(); return image; } });
  assert.equal(result.status, 'paused');
  assert.equal(result.summary.completedCount, 1);
  assert.equal(result.summary.pendingCount, 1);
});

afterEach(async () => {
  await Promise.all(cleanupPaths.splice(0).map((value) => fs.rm(value, { recursive: true, force: true })));
});

async function tempDir() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'collection-job-test-'));
  cleanupPaths.push(directory);
  return directory;
}

test('collection spreadsheet parser reads CSV rows and image columns safely', async () => {
  const directory = await tempDir();
  const filePath = path.join(directory, 'products.csv');
  await fs.writeFile(filePath, '\uFEFFSKU,商品标题,销量,商品链接,主图链接,附图链接\nSKU-1,"红色, 连衣裙",128,https://shop.example/item/1,https://img.example/1.jpg,"https://img.example/2.jpg;https://img.example/3.jpg"\n', 'utf8');
  const result = await parseCollectionSpreadsheet(filePath, 'products.csv');
  assert.equal(result.records.length, 1);
  assert.equal(result.records[0].sku, 'SKU-1');
  assert.equal(result.records[0].title, '红色, 连衣裙');
  assert.equal(result.records[0].sales, 128);
  assert.deepEqual(result.records[0].imageUrls, ['https://img.example/1.jpg', 'https://img.example/2.jpg', 'https://img.example/3.jpg']);
  assert.equal(result.safeMode.formulasExecuted, false);
});

test('collection spreadsheet parser reads a simple XLSX without running formulas', async () => {
  const directory = await tempDir();
  const filePath = path.join(directory, 'products.xlsx');
  const zip = new AdmZip();
  zip.addFile('xl/sharedStrings.xml', Buffer.from('<?xml version="1.0"?><sst><si><t>SKU</t></si><si><t>商品链接</t></si><si><t>图片链接</t></si><si><t>SKU-X</t></si><si><t>https://shop.example/x</t></si><si><t>https://img.example/x.jpg</t></si></sst>'));
  zip.addFile('xl/worksheets/sheet1.xml', Buffer.from('<?xml version="1.0"?><worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>2</v></c></row><row r="2"><c r="A2" t="s"><v>3</v></c><c r="B2" t="s"><v>4</v></c><c r="C2" t="s"><v>5</v></c></row></sheetData></worksheet>'));
  zip.writeZip(filePath);
  const result = await parseCollectionSpreadsheet(filePath, 'products.xlsx');
  assert.equal(result.records[0].sku, 'SKU-X');
  assert.equal(result.records[0].productUrl, 'https://shop.example/x');
  assert.deepEqual(result.records[0].imageUrls, ['https://img.example/x.jpg']);
});

test('SKU metadata spreadsheet reads SKU SPU spec variant and title fields', async () => {
  const directory = await tempDir();
  const filePath = path.join(directory, 'sku-metadata.csv');
  await fs.writeFile(filePath, 'SKU,货号,规格,变种SKU,商品标题\nSKU-1,SPU-9,红色/L,VAR-RED-L,红色连衣裙\n', 'utf8');
  const result = await parseSkuMetadataSpreadsheet(filePath, 'sku-metadata.csv');
  assert.deepEqual(result.records[0], { sku: 'SKU-1', spu: 'SPU-9', spec: '红色/L', variantSku: 'VAR-RED-L', title: '红色连衣裙' });
  assert.equal(result.safeMode.formulasExecuted, false);
});

test('product page extraction finds title sales structured and HTML images', () => {
  const result = extractProductPage(`<!doctype html><title>页面标题</title><script type="application/ld+json">{"@type":"Product","name":"结构化标题","image":["/a.jpg"]}</script><div>已售 1.2万 件</div><img data-src="https://cdn.example/b.jpg">`, 'https://shop.example/item/1');
  assert.equal(result.title, '结构化标题');
  assert.equal(result.sales, 12000);
  assert.deepEqual(result.images, ['https://shop.example/a.jpg', 'https://cdn.example/b.jpg']);
});

test('Amazon and Pinterest original adapters and explicit replacement rules are deterministic', () => {
  assert.equal(originalImageUrl('https://m.media-amazon.com/images/I/demo._AC_SL1500_.jpg'), 'https://m.media-amazon.com/images/I/demo.jpg');
  assert.equal(originalImageUrl('https://i.pinimg.com/236x/aa/bb/demo.jpg'), 'https://i.pinimg.com/originals/aa/bb/demo.jpg');
  assert.equal(applyReplacementRules('https://old.example/a.jpg', [{ mode: 'prefix', from: 'https://old.example/', to: 'https://new.example/' }]), 'https://new.example/a.jpg');
});

test('safe request rejects private DNS targets before opening a connection', async () => {
  await assert.rejects(
    () => safeRequestBuffer('https://public-name.example/image.jpg', { maxBytes: 1024, timeoutMs: 1000, resolver: async () => [{ address: '127.0.0.1', family: 4 }] }),
    (error) => error.code === 'PRIVATE_ADDRESS'
  );
});

test('collection job filters sales, checkpoints every item, continues failures and produces ZIP', async () => {
  const image = await sharp({ create: { width: 320, height: 240, channels: 3, background: '#246b65' } }).jpeg().toBuffer();
  const job = await createCollectionJob({
    rows: [
      { sku: 'SKU-GOOD', productUrl: 'https://shop.example/good' },
      { sku: 'SKU-LOW', sales: '3', imageUrls: ['https://img.example/low.jpg'] },
      { sku: 'SKU-BAD', sales: '100', imageUrls: ['https://img.example/bad.jpg'] }
    ],
    options: { name: '采集测试', minSales: 10, maxImagesPerProduct: 5, downloadOriginal: true, randomFileNames: true }
  });
  cleanupPaths.push(path.join(WORKBENCH_DIR, job.id));
  const result = await runCollectionJob(job.id, { limit: 10 }, {
    pageFetcher: async () => ({ finalUrl: 'https://shop.example/good', html: '<meta property="og:title" content="测试商品"><div>销量 88</div><meta property="og:image" content="https://m.media-amazon.com/images/I/demo._AC_SL1500_.jpg">' }),
    imageFetcher: async (url) => {
      if (url.includes('/bad.jpg')) throw Object.assign(new Error('simulated download failure'), { code: 'SIMULATED' });
      assert.equal(url, 'https://m.media-amazon.com/images/I/demo.jpg');
      return { buffer: image, contentType: 'image/jpeg', finalUrl: url };
    }
  });
  assert.equal(result.status, 'completed_with_errors');
  assert.equal(result.summary.completedCount, 1);
  assert.equal(result.summary.skippedCount, 1);
  assert.equal(result.summary.failedCount, 1);
  assert.equal(result.summary.downloadedCount, 1);
  assert.equal(result.items[0].title, '测试商品');
  assert.equal(result.items[0].sales, 88);
  assert.match(result.items[0].images[0].sha256, /^[a-f0-9]{64}$/);
  assert.equal(result.items[0].images[0].addressChanges[0].kind, 'original-adapter');
  assert.equal(result.items[0].images[0].finalUrl, 'https://m.media-amazon.com/images/I/demo.jpg');
  assert.match(result.items[0].images[0].file, /^SKU-GOOD\/[a-f0-9]{12}\.jpg$/);
  const jobDir = path.join(WORKBENCH_DIR, job.id);
  assert.ok((await fs.stat(path.join(jobDir, 'manifest.json'))).size > 0);
  assert.ok((await fs.stat(path.join(jobDir, 'manifest.backup.json'))).size > 0);
  assert.ok((await fs.stat(path.join(jobDir, `${job.id}.zip`))).size > 0);
});

test('collection job pauses at a batch boundary and resumes remaining products', async () => {
  const image = await sharp({ create: { width: 100, height: 100, channels: 3, background: '#ffffff' } }).png().toBuffer();
  const job = await createCollectionJob({
    rows: [
      { sku: 'SKU-1', imageUrls: ['https://img.example/1.png'] },
      { sku: 'SKU-2', imageUrls: ['https://img.example/2.png'] }
    ],
    options: { downloadOriginal: false }
  });
  cleanupPaths.push(path.join(WORKBENCH_DIR, job.id));
  const deps = { imageFetcher: async () => ({ buffer: image }) };
  const first = await runCollectionJob(job.id, { limit: 1 }, deps);
  assert.equal(first.status, 'paused');
  assert.equal(first.summary.pendingCount, 1);
  const second = await runCollectionJob(job.id, { limit: 1 }, deps);
  assert.equal(second.status, 'completed');
  assert.equal(second.summary.downloadedCount, 2);
});

test('collection job preserves unknown-sales filtering and unique files for duplicate SKUs', async () => {
  const image = await sharp({ create: { width: 80, height: 60, channels: 3, background: '#225577' } }).jpeg().toBuffer();
  const filtered = await createCollectionJob({
    rows: [{ sku: 'UNKNOWN', productUrl: 'https://www.temu.com/goods.html?goods_id=1', imageUrls: ['https://img.example/unknown.jpg'] }],
    options: { mode: 'temu-deep', minSales: 1, downloadOriginal: false }
  });
  cleanupPaths.push(path.join(WORKBENCH_DIR, filtered.id));
  const filteredResult = await runCollectionJob(filtered.id, { limit: 1 }, {
    pageFetcher: async () => { throw new Error('Temu deep rows must not require a second static fetch'); },
    imageFetcher: async () => ({ buffer: image })
  });
  assert.equal(filteredResult.items[0].status, 'skipped');
  assert.equal(filteredResult.items[0].error.code, 'SALES_UNKNOWN');
  assert.equal(filteredResult.summary.downloadedCount, 0);

  const duplicates = await createCollectionJob({
    rows: [
      { sku: 'SAME-SKU', sales: 10, imageUrls: ['https://img.example/one.jpg'] },
      { sku: 'SAME-SKU', sales: 10, imageUrls: ['https://img.example/two.jpg'] }
    ],
    options: { downloadOriginal: false, randomFileNames: false }
  });
  cleanupPaths.push(path.join(WORKBENCH_DIR, duplicates.id));
  const duplicateResult = await runCollectionJob(duplicates.id, { limit: 2 }, { imageFetcher: async () => ({ buffer: image }) });
  assert.notEqual(duplicateResult.items[0].images[0].file, duplicateResult.items[1].images[0].file);
  assert.equal(new Set(duplicateResult.items.map((item) => item.images[0].file)).size, 2);
});
