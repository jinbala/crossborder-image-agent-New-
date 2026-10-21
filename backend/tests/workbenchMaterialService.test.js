import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import AdmZip from 'adm-zip';
import {
  exportMaterialRecordsCsv,
  importMaterialRecords,
  listMaterialRecords,
  updateMaterialRecord
} from '../src/services/workbenchMaterialService.js';
import { archiveMaterialRecord } from '../src/services/workbenchMaterialService.js';
import { inspectXlsxTemplate } from '../src/services/xlsxTemplateInspector.js';

const tempDirs = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function tempPath(fileName) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'workbench-material-test-'));
  tempDirs.push(dir);
  return path.join(dir, fileName);
}

test('material ledger imports, upserts, filters, updates and exports safely', async () => {
  const filePath = await tempPath('materials.json');
  const first = await importMaterialRecords([
    { sku: 'SKU-001', platformId: 'temu', materialId: '=MATERIAL-1', materialType: 'main', sourceRef: 'image-1.jpg' },
    { sku: 'SKU-002', platformId: 'amazon', materialId: 'https://example.com/2.jpg', materialType: 'additional' }
  ], { filePath });
  assert.equal(first.createdCount, 2);
  assert.equal(first.updatedCount, 0);

  const second = await importMaterialRecords([
    { sku: 'SKU-001', platformId: 'temu', materialId: '=MATERIAL-1', materialType: 'square', notes: 'updated' }
  ], { filePath });
  assert.equal(second.createdCount, 0);
  assert.equal(second.updatedCount, 1);

  const filtered = await listMaterialRecords({ platformId: 'temu' }, { filePath });
  assert.equal(filtered.summary.totalCount, 1);
  assert.equal(filtered.records[0].materialType, 'square');
  const updated = await updateMaterialRecord(filtered.records[0].id, { notes: 'reviewed' }, { filePath });
  assert.equal(updated.notes, 'reviewed');

  const csv = await exportMaterialRecordsCsv({}, { filePath });
  assert.match(csv, /"'=MATERIAL-1"/);
  assert.match(csv, /SKU-002/);
});

test('material pages, reversible archives and CSV exports preserve complete filtered records', async () => {
  const filePath = await tempPath('paged-materials.json');
  const imported = await importMaterialRecords(Array.from({ length: 5 }, (_, index) => ({ sku: `SKU-${index}`, platformId: 'temu', materialId: `M-${index}` })), { filePath });
  const page = await listMaterialRecords({ page: 2, pageSize: 2 }, { filePath });
  assert.equal(page.records.length, 2);
  assert.equal(page.pagination.total, 5);
  await assert.rejects(archiveMaterialRecord(imported.records[0].id, {}, { filePath }), /确认/);
  await archiveMaterialRecord(imported.records[0].id, { confirm: true }, { filePath });
  assert.equal((await listMaterialRecords({}, { filePath })).records.length, 4);
  assert.equal((await listMaterialRecords({ includeArchived: true }, { filePath })).records.length, 5);
  await archiveMaterialRecord(imported.records[0].id, { confirm: true, restore: true }, { filePath });
  assert.equal((await listMaterialRecords({}, { filePath })).records.length, 5);
  const csv = await exportMaterialRecordsCsv({ page: 1, pageSize: 1 }, { filePath });
  for (let i = 0; i < 5; i++) assert.match(csv, new RegExp(`SKU-${i}`));
  await assert.rejects(updateMaterialRecord(imported.records[1].id, { sku: 'SKU-0', materialId: 'M-0' }, { filePath }), /已存在/);
});

function createWorkbookBuffer({ withMacro = false } = {}) {
  const zip = new AdmZip();
  zip.addFile('xl/workbook.xml', Buffer.from(`<?xml version="1.0" encoding="UTF-8"?><workbook><sheets><sheet name="Temu上传模板" sheetId="1"/></sheets></workbook>`));
  zip.addFile('xl/sharedStrings.xml', Buffer.from(`<?xml version="1.0" encoding="UTF-8"?><sst><si><t>商家SKU</t></si><si><t>商品标题</t></si><si><t>价格</t></si><si><t>库存</t></si><si><t>主图素材ID</t></si><si><t>SKU-001</t></si><si><t>测试商品</t></si><si><t>material-001</t></si></sst>`));
  zip.addFile('xl/worksheets/sheet1.xml', Buffer.from(`<?xml version="1.0" encoding="UTF-8"?><worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>2</v></c><c r="D1" t="s"><v>3</v></c><c r="E1" t="s"><v>4</v></c></row><row r="2"><c r="A2" t="s"><v>5</v></c><c r="B2" t="s"><v>6</v></c><c r="C2"><v>29.99</v></c><c r="D2"><v>20</v></c><c r="E2" t="s"><v>7</v></c></row></sheetData></worksheet>`));
  if (withMacro) zip.addFile('xl/vbaProject.bin', Buffer.from('not-executed'));
  return zip.toBuffer();
}

test('XLSX inspector detects Temu headers without executing workbook content', async () => {
  const filePath = await tempPath('temu-template.xlsx');
  await fs.writeFile(filePath, createWorkbookBuffer());
  const result = await inspectXlsxTemplate(filePath, { originalName: 'temu-template.xlsx', platformId: 'temu' });
  assert.equal(result.sheetCount, 1);
  assert.equal(result.selectedSheet, 'Temu上传模板');
  assert.equal(result.sheets[0].headerRow, 1);
  assert.deepEqual(result.mapping.missingRequired, []);
  assert.equal(result.mapping.fields.find((field) => field.field === 'mainImageId').column, '主图素材ID');
  assert.deepEqual(result.safeMode, { macrosExecuted: false, externalLinksFetched: false, extractedToDisk: false });
});

test('XLSX inspector rejects macro-enabled workbook content', async () => {
  const filePath = await tempPath('macro-disguised.xlsx');
  await fs.writeFile(filePath, createWorkbookBuffer({ withMacro: true }));
  await assert.rejects(
    () => inspectXlsxTemplate(filePath, { originalName: 'macro-disguised.xlsx', platformId: 'temu' }),
    /VBA/
  );
});
