import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import AdmZip from 'adm-zip';
import request from 'supertest';
import app from '../src/app.js';
import { paths } from '../src/services/db.js';
import { planWorkbookFill, previewTemplateFill, executeTemplateFill } from '../src/services/xlsxTemplateFillService.js';

const cleanup = [];
afterEach(async () => { for (const target of cleanup.splice(0)) await fs.rm(target, { recursive: true, force: true }); });

function workbook() {
  const zip = new AdmZip();
  zip.addFile('xl/workbook.xml', Buffer.from('<workbook><sheets><sheet name="Upload" sheetId="1"/></sheets></workbook>'));
  zip.addFile('xl/styles.xml', Buffer.from('<styleSheet><numFmts count="1"><numFmt numFmtId="164" formatCode="0.00"/></numFmts></styleSheet>'));
  zip.addFile('xl/worksheets/sheet2.xml', Buffer.from('<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Instructions</t></is></c></row></sheetData></worksheet>'));
  zip.addFile('xl/worksheets/sheet1.xml', Buffer.from('<worksheet><dimension ref="A1:F2"/><cols><col min="1" max="6" width="20"/></cols><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>SKU</t></is></c><c r="B1" t="inlineStr"><is><t>Title</t></is></c><c r="C1" t="inlineStr"><is><t>Price</t></is></c><c r="D1" t="inlineStr"><is><t>Stock</t></is></c><c r="E1" t="inlineStr"><is><t>Main image</t></is></c></row><row r="2"><c r="C2" s="1"/><c r="F2"><f>C2*2</f><v>0</v></c></row></sheetData><dataValidations count="1"><dataValidation sqref="D2:D100" type="whole"/></dataValidations></worksheet>'));
  return zip;
}

test('template fill writes only a copy and preserves other entries, styles, formulas and validations', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'xlsx-fill-'));
  cleanup.push(directory);
  const source = path.join(directory, 'template.xlsx');
  const original = workbook();
  const sourceBuffer = original.toBuffer();
  await fs.writeFile(source, sourceBuffer);
  const preview = await previewTemplateFill(source, { platformId: 'amazon', originalName: 'template.xlsx', records: [{ sku: '=SUM(1,1)', title: '商品 <标题> & detail', price: 12.3, stock: 5, mainImageUrl: 'https://example.com/a.png' }] });
  cleanup.push(path.join(paths.outputDir, 'workbench', preview.id));
  assert.equal(preview.canExecute, true);
  await assert.rejects(executeTemplateFill(preview.id, { previewHash: preview.previewHash }), /确认/);
  await assert.rejects(executeTemplateFill(preview.id, { confirm: true, previewHash: 'stale' }), /已变化/);
  const result = await executeTemplateFill(preview.id, { confirm: true, previewHash: preview.previewHash });
  const primary = path.join(paths.outputDir, 'workbench', preview.id, 'manifest.json');
  assert.deepEqual(await fs.readFile(primary), await fs.readFile(`${primary}.backup`));
  assert.equal(JSON.parse(await fs.readFile(`${primary}.backup`)).status, 'completed');
  const output = new AdmZip(path.join(paths.rootDir, result.downloadUrl.slice(1)));
  assert.deepEqual(await fs.readFile(source), sourceBuffer);
  for (const entry of original.getEntries().filter((entry) => entry.entryName !== 'xl/worksheets/sheet1.xml')) assert.deepEqual(output.getEntry(entry.entryName).getData(), entry.getData());
  const sheet = output.readAsText('xl/worksheets/sheet1.xml');
  assert.match(sheet, /<f>C2\*2<\/f>/);
  assert.match(sheet, /<c r="C2" s="1" t="n"><v>12.3<\/v>/);
  assert.match(sheet, /<t xml:space="preserve">=SUM\(1,1\)<\/t>/);
  assert.match(sheet, /商品 &lt;标题&gt; &amp; detail/);
  assert.match(sheet, /sqref="D2:D100"/);
  assert.equal(result.summary.changedCells, 5);
});

test('fill preview protects formulas and occupied cells, and validates mapping', () => {
  const sheet = workbook().readAsText('xl/worksheets/sheet1.xml');
  const result = planWorkbookFill(sheet, [{ value: 9 }], { value: 5 }, { startRow: 2, overwriteCells: true });
  assert.equal(result.blocked[0].reason, 'FORMULA_PRESERVED');
  assert.equal(result.sheet, sheet);
  const occupied = planWorkbookFill(sheet.replace('<c r="C2" s="1"/>', '<c r="A2" t="inlineStr"><is><t>old</t></is></c>'), [{ sku: 'new' }], { sku: 0 }, { startRow: 2 });
  assert.equal(occupied.blocked[0].reason, 'CELL_NOT_EMPTY');
});

test('fill creates ordered new rows and rejects invalid mappings and protected worksheets', () => {
  const sheet = workbook().readAsText('xl/worksheets/sheet1.xml');
  const result = planWorkbookFill(sheet, [{ sku: 'A' }, { sku: 'B' }], { sku: 0 }, { startRow: 3 });
  assert.ok(result.sheet.indexOf('r="A3"') < result.sheet.indexOf('r="A4"'));
  assert.match(result.sheet, /ref="A1:F4"/);
  assert.throws(() => planWorkbookFill(sheet, [{ sku: 'A' }], { sku: -1 }, { startRow: 2 }), /映射/);
  assert.throws(() => planWorkbookFill(sheet, [{ sku: 'A' }], { sku: 0, title: 0 }, { startRow: 2 }), /同一列/);
  assert.throws(() => planWorkbookFill(sheet.replace('</worksheet>', '<sheetProtection/></worksheet>'), [{ sku: 'A' }], { sku: 0 }, { startRow: 2 }), /受保护/);
});

test('template multipart API requires approved preview and serves a filled copy', async () => {
  const response = await request(app).post('/api/workbench/template-fills/preview')
    .field('options', JSON.stringify({ platformId: 'amazon', records: [{ sku: 'HTTP-1', title: 'HTTP template', price: 3, stock: 10, mainImageUrl: 'https://example.org/main.png' }] }))
    .attach('template', workbook().toBuffer(), { filename: '恢复-业务原文.xlsx', contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }).expect(200);
  cleanup.push(path.join(paths.outputDir, 'workbench', response.body.id));
  const saved = await request(app).get(`/api/workbench/jobs/${response.body.id}`).expect(200);
  assert.equal(saved.body.status, 'waiting_user'); assert.equal(saved.body.previewHash, response.body.previewHash);
  assert.equal(saved.body.originalName, '恢复-业务原文.xlsx');
  assert.equal(saved.body.canExecute, true);
  assert.ok((await request(app).get('/api/platform/task-center?state=waiting_user').expect(200)).body.records.some((item) => item.id === response.body.id));
  const savedBytes = await fs.readFile(path.join(paths.outputDir, 'workbench', response.body.id, 'manifest.json'));
  const recovery = await request(app).get('/api/desktop/runtime?pageSize=100').expect(200);
  const recovered = recovery.body.recovery.find(item => item.id === response.body.id);
  assert.equal(recovered?.state, 'waiting_user'); assert.equal(recovered.href, `/results/${response.body.id}`);
  assert.deepEqual(await fs.readFile(path.join(paths.outputDir, 'workbench', response.body.id, 'manifest.json')), savedBytes);
  await assert.rejects(fs.access(path.join(paths.outputDir, 'workbench', response.body.id, 'filled-template.xlsx')), { code: 'ENOENT' });
  await request(app).post(`/api/workbench/template-fills/${response.body.id}/execute`).send({ previewHash: response.body.previewHash }).expect(400);
  const completed = await request(app).post(`/api/workbench/template-fills/${response.body.id}/execute`).send({ confirm: true, previewHash: response.body.previewHash }).expect(200);
  assert.equal(completed.body.status, 'completed');
  await request(app).get(completed.body.downloadUrl).expect(200);
  assert.equal(completed.body.summary.changedCells, 5);
  assert.ok(!(await request(app).get('/api/desktop/runtime?pageSize=100').expect(200)).body.recovery.some(item => item.id === response.body.id));
});
