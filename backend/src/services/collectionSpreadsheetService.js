import fs from 'node:fs/promises';
import path from 'node:path';
import AdmZip from 'adm-zip';
import { decodeOriginalFileName } from '../utils/fileNameUtils.js';

const MAX_ROWS = 5000;
const MAX_COLUMNS = 200;
const MAX_UNCOMPRESSED_BYTES = 60 * 1024 * 1024;

const ALIASES = {
  sku: ['sku', '商品sku', '商家sku', '货号', '商品编码', 'productsku'],
  title: ['title', '商品标题', '产品标题', '标题', 'producttitle'],
  sales: ['sales', 'sold', '销量', '已售', '销售量', '月销量', 'soldcount'],
  productUrl: ['producturl', 'productlink', '商品链接', '商品地址', '产品链接', '详情页', '链接', 'url'],
  imageUrls: ['imageurl', 'imageurls', 'images', '图片链接', '图片地址', '图片url', '主图', '主图链接', '附图', '附图链接']
};

const SKU_METADATA_ALIASES = {
  sku: ['sku', '商品sku', '商家sku', '商品编码'],
  spu: ['spu', '货号', '款号', '商品货号'],
  spec: ['spec', '规格', '商品规格', '销售属性'],
  variantSku: ['variantsku', 'variant sku', '变种sku', '变体sku', '子sku'],
  title: ['title', '商品标题', '产品标题', '标题']
};

function decodeXml(value) {
  return String(value || '')
    .replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'").replaceAll('&amp;', '&')
    .replace(/&#(\d+);/g, (_match, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_match, code) => String.fromCodePoint(Number.parseInt(code, 16)));
}

function textNodes(xml) {
  return [...String(xml || '').matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((match) => decodeXml(match[1])).join('');
}

function parseSharedStrings(xml) {
  return [...String(xml || '').matchAll(/<si(?:\s[^>]*)?>([\s\S]*?)<\/si>/g)].map((match) => textNodes(match[1]));
}

function columnIndex(cellRef) {
  const letters = String(cellRef || '').match(/^[A-Z]+/i)?.[0]?.toUpperCase() || '';
  let index = 0;
  for (const letter of letters) index = index * 26 + letter.charCodeAt(0) - 64;
  return Math.max(0, index - 1);
}

function parseWorksheet(xml, sharedStrings) {
  const rows = [];
  for (const rowMatch of String(xml || '').matchAll(/<row(?:\s[^>]*)?r="(\d+)"[^>]*>([\s\S]*?)<\/row>/g)) {
    const values = [];
    for (const cellMatch of rowMatch[2].matchAll(/<c(?:\s[^>]*)?r="([A-Z]+\d+)"([^>]*)>([\s\S]*?)<\/c>/gi)) {
      const index = columnIndex(cellMatch[1]);
      if (index >= MAX_COLUMNS) continue;
      const type = cellMatch[2].match(/\bt="([^"]+)"/)?.[1] || '';
      const body = cellMatch[3];
      let value = '';
      if (type === 'inlineStr') value = textNodes(body);
      else {
        const raw = decodeXml(body.match(/<v>([\s\S]*?)<\/v>/)?.[1] || '');
        value = type === 's' ? (sharedStrings[Number(raw)] || '') : raw;
      }
      values[index] = String(value).trim();
    }
    rows.push({ rowNumber: Number(rowMatch[1]), values });
    if (rows.length >= MAX_ROWS + 25) break;
  }
  return rows;
}

function parseDelimited(text, delimiter) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  const source = String(text || '').replace(/^\uFEFF/, '');
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (quoted) {
      if (char === '"' && source[index + 1] === '"') { cell += '"'; index += 1; }
      else if (char === '"') quoted = false;
      else cell += char;
    } else if (char === '"') quoted = true;
    else if (char === delimiter) { row.push(cell.trim()); cell = ''; }
    else if (char === '\n') {
      row.push(cell.replace(/\r$/, '').trim());
      rows.push(row.slice(0, MAX_COLUMNS));
      row = [];
      cell = '';
      if (rows.length >= MAX_ROWS + 25) break;
    } else cell += char;
  }
  if (cell || row.length) { row.push(cell.replace(/\r$/, '').trim()); rows.push(row.slice(0, MAX_COLUMNS)); }
  return rows.map((values, index) => ({ rowNumber: index + 1, values }));
}

function delimiterFor(text) {
  const firstLine = String(text || '').replace(/^\uFEFF/, '').split(/\r?\n/, 1)[0] || '';
  const choices = [',', '\t', ';'];
  return choices.sort((a, b) => firstLine.split(b).length - firstLine.split(a).length)[0];
}

function normalizeHeader(value) {
  return String(value || '').toLowerCase().replace(/[\s_\-—–（()）【】\[\]:：\/\\.]+/g, '');
}

function canonicalField(header) {
  const normalized = normalizeHeader(header);
  for (const [field, aliases] of Object.entries(ALIASES)) {
    if ([field, ...aliases].map(normalizeHeader).includes(normalized)) return field;
  }
  if (/(image|img|图片|主图|附图)/i.test(normalized)) return 'imageUrls';
  return '';
}

function headerScore(values) {
  return values.reduce((score, value) => score + (canonicalField(value) ? 3 : 0), 0);
}

function normalizeUrlList(value) {
  return String(value || '').split(/[\r\n;,|]+/).map((item) => item.trim()).filter((item) => /^https?:\/\//i.test(item));
}

function rowsToRecords(rows) {
  const header = rows.slice(0, 25)
    .map((row) => ({ ...row, score: headerScore(row.values) }))
    .sort((a, b) => b.score - a.score || a.rowNumber - b.rowNumber)[0];
  if (!header || header.score === 0) {
    const error = new Error('未识别到商品链接、图片链接、SKU、标题或销量表头');
    error.statusCode = 400;
    throw error;
  }
  const columns = header.values.map((value, index) => ({ index, name: value, field: canonicalField(value) })).filter((column) => column.field);
  const records = [];
  for (const row of rows.filter((item) => item.rowNumber > header.rowNumber).slice(0, MAX_ROWS)) {
    const record = { sourceRow: row.rowNumber, sku: '', title: '', sales: null, productUrl: '', imageUrls: [] };
    for (const column of columns) {
      const value = row.values[column.index] || '';
      if (column.field === 'imageUrls') record.imageUrls.push(...normalizeUrlList(value));
      else if (column.field === 'sales') {
        const numeric = Number(String(value).replace(/[^\d.-]/g, ''));
        record.sales = Number.isFinite(numeric) ? numeric : null;
      } else if (!record[column.field]) record[column.field] = String(value).trim();
    }
    record.imageUrls = [...new Set(record.imageUrls)];
    if (record.productUrl || record.imageUrls.length) records.push(record);
  }
  if (!records.length) {
    const error = new Error('表格中没有可处理的商品链接或图片链接');
    error.statusCode = 400;
    throw error;
  }
  return { headerRow: header.rowNumber, columns, records };
}

async function parseXlsx(filePath) {
  let zip;
  try { zip = new AdmZip(filePath); } catch {
    const error = new Error('文件不是有效的 XLSX 工作簿');
    error.statusCode = 400;
    throw error;
  }
  const entries = zip.getEntries();
  const total = entries.reduce((sum, entry) => sum + Number(entry.header?.size || 0), 0);
  if (entries.length > 2500 || total > MAX_UNCOMPRESSED_BYTES || entries.some((entry) => /vbaProject\.bin$/i.test(entry.entryName))) {
    const error = new Error('拒绝包含宏、文件数量过多或解压体积过大的工作簿');
    error.statusCode = 400;
    throw error;
  }
  const sharedEntry = zip.getEntry('xl/sharedStrings.xml');
  const sharedStrings = sharedEntry ? parseSharedStrings(sharedEntry.getData().toString('utf8')) : [];
  const sheet = entries.filter((entry) => /^xl\/worksheets\/sheet\d+\.xml$/i.test(entry.entryName)).sort((a, b) => a.entryName.localeCompare(b.entryName, undefined, { numeric: true }))[0];
  if (!sheet) {
    const error = new Error('工作簿中没有可读取的工作表');
    error.statusCode = 400;
    throw error;
  }
  return parseWorksheet(sheet.getData().toString('utf8'), sharedStrings);
}

async function readSpreadsheetRows(filePath, originalName) {
  const extension = path.extname(originalName || filePath).toLowerCase();
  if (extension === '.xlsx') return parseXlsx(filePath);
  if (extension === '.csv' || extension === '.tsv' || extension === '.txt') {
    const text = await fs.readFile(filePath, 'utf8');
    return parseDelimited(text, extension === '.tsv' ? '\t' : delimiterFor(text));
  }
  const error = new Error('仅支持 CSV、TSV、TXT 或无宏 XLSX 表格');
  error.statusCode = 400;
  throw error;
}

export async function parseCollectionSpreadsheet(filePath, originalName = '') {
  const stats = await fs.stat(filePath);
  if (stats.size > 10 * 1024 * 1024) {
    const error = new Error('导入表格不能超过 10MB');
    error.statusCode = 400;
    throw error;
  }
  const rows = await readSpreadsheetRows(filePath, originalName);
  const parsed = rowsToRecords(rows);
  return {
    fileName: decodeOriginalFileName(originalName || filePath),
    fileBytes: stats.size,
    ...parsed,
    safeMode: { macrosExecuted: false, formulasExecuted: false, externalLinksFetched: false }
  };
}

export async function parseSkuMetadataSpreadsheet(filePath, originalName = '') {
  const stats = await fs.stat(filePath);
  if (stats.size > 10 * 1024 * 1024) throw Object.assign(new Error('SKU 数据表不能超过 10MB'), { statusCode: 400 });
  const rows = await readSpreadsheetRows(filePath, originalName);
  const aliases = Object.fromEntries(Object.entries(SKU_METADATA_ALIASES).map(([field, values]) => [field, [field, ...values].map(normalizeHeader)]));
  const matchField = (value) => Object.entries(aliases).find(([, values]) => values.includes(normalizeHeader(value)))?.[0] || '';
  const header = rows.slice(0, 25).map((row) => ({ ...row, score: row.values.filter((value) => matchField(value)).length })).sort((a, b) => b.score - a.score || a.rowNumber - b.rowNumber)[0];
  if (!header || !header.values.some((value) => matchField(value) === 'sku')) throw Object.assign(new Error('SKU 数据表必须包含 SKU 列'), { statusCode: 400 });
  const columns = header.values.map((value, index) => ({ index, name: value, field: matchField(value) })).filter((item) => item.field);
  const records = rows.filter((row) => row.rowNumber > header.rowNumber).slice(0, MAX_ROWS).map((row) => {
    const record = { sku: '', spu: '', spec: '', variantSku: '', title: '' };
    columns.forEach((column) => { if (!record[column.field]) record[column.field] = cleanCell(row.values[column.index]); });
    return record;
  }).filter((record) => record.sku);
  if (!records.length) throw Object.assign(new Error('SKU 数据表中没有有效记录'), { statusCode: 400 });
  return { fileName: decodeOriginalFileName(originalName || filePath), fileBytes: stats.size, headerRow: header.rowNumber, columns, records, safeMode: { macrosExecuted: false, formulasExecuted: false, externalLinksFetched: false } };
}

function cleanCell(value) {
  return String(value ?? '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 1000);
}

export { ALIASES, SKU_METADATA_ALIASES, parseDelimited, rowsToRecords };
