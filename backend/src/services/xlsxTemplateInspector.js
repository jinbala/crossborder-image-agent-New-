import fs from 'node:fs/promises';
import path from 'node:path';
import AdmZip from 'adm-zip';

const FIELD_ALIASES = {
  sku: ['sku', 'seller sku', '商家sku', '商家编码', '商品编码', '货号'],
  title: ['title', 'product title', '商品标题', '产品标题', '标题'],
  price: ['price', 'sale price', '售价', '价格', '商品价格'],
  stock: ['stock', 'quantity', '库存', '库存数量'],
  weightGrams: ['weight', 'weight(g)', 'weight grams', '重量', '商品重量', '重量克'],
  mainImageId: ['main image id', 'main material id', '主图素材id', '主图id', '主图素材'],
  mainImageUrl: ['main image', 'main image url', '主图', '主图链接', '主图url'],
  additionalImageIds: ['additional image ids', 'gallery material ids', '附图素材id', '附图id', '轮播图素材id'],
  additionalImageUrls: ['additional images', 'gallery images', '附图', '附图链接', '轮播图'],
  description: ['description', 'product description', '商品描述', '详情描述', '描述']
};

const REQUIRED_FIELDS = {
  temu: ['sku', 'title', 'price', 'stock', 'mainImageId'],
  amazon: ['sku', 'title', 'price', 'stock', 'mainImageUrl'],
  default: ['sku', 'title', 'price', 'stock', 'mainImageUrl']
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
      const type = cellMatch[2].match(/\bt="([^"]+)"/)?.[1] || '';
      const body = cellMatch[3];
      let value = '';
      if (type === 'inlineStr') value = textNodes(body);
      else {
        const raw = decodeXml(body.match(/<v>([\s\S]*?)<\/v>/)?.[1] || '');
        value = type === 's' ? (sharedStrings[Number(raw)] || '') : raw;
      }
      values[index] = value.trim();
    }
    rows.push({ rowNumber: Number(rowMatch[1]), values });
    if (rows.length >= 30) break;
  }
  return rows;
}

function normalizeHeader(value) {
  return String(value || '').toLowerCase().replace(/[\s_\-—–（）()【】\[\]:：/\\]+/g, '');
}

function detectHeaderRow(rows) {
  return [...rows].map((row) => {
    const values = row.values.filter(Boolean);
    const textCount = values.filter((value) => Number.isNaN(Number(value))).length;
    return { ...row, score: textCount * 3 + new Set(values).size };
  }).filter((row) => row.values.filter(Boolean).length >= 2).sort((a, b) => b.score - a.score || a.rowNumber - b.rowNumber)[0] || null;
}

function mapHeaders(headers, platformId) {
  const normalized = headers.map(normalizeHeader);
  const fields = Object.entries(FIELD_ALIASES).map(([field, aliases]) => {
    const candidates = [field, ...aliases].map(normalizeHeader);
    const columnIndexFound = normalized.findIndex((header) => candidates.includes(header));
    return {
      field,
      matched: columnIndexFound >= 0,
      columnIndex: columnIndexFound >= 0 ? columnIndexFound : null,
      column: columnIndexFound >= 0 ? headers[columnIndexFound] : null
    };
  });
  const required = REQUIRED_FIELDS[platformId] || REQUIRED_FIELDS.default;
  return {
    fields,
    required,
    missingRequired: required.filter((field) => !fields.find((item) => item.field === field)?.matched),
    coverage: Number((fields.filter((item) => item.matched).length / fields.length * 100).toFixed(1))
  };
}

export async function inspectXlsxTemplate(filePath, { originalName = '', platformId = 'temu' } = {}) {
  if (path.extname(originalName || filePath).toLowerCase() !== '.xlsx') {
    const error = new Error('目前只支持无宏的 .xlsx 模板');
    error.statusCode = 400;
    throw error;
  }
  const stats = await fs.stat(filePath);
  if (stats.size > 10 * 1024 * 1024) {
    const error = new Error('模板文件不能超过 10MB');
    error.statusCode = 400;
    throw error;
  }
  let zip;
  try {
    zip = new AdmZip(filePath);
  } catch {
    const error = new Error('文件不是有效的 XLSX 工作簿');
    error.statusCode = 400;
    throw error;
  }
  const entries = zip.getEntries();
  const uncompressedBytes = entries.reduce((sum, entry) => sum + Number(entry.header?.size || 0), 0);
  const hasMacro = entries.some((entry) => /vbaProject\.bin$/i.test(entry.entryName));
  if (entries.length > 2000 || uncompressedBytes > 50 * 1024 * 1024 || hasMacro) {
    const error = new Error(hasMacro ? '拒绝包含 VBA 宏的工作簿' : (entries.length > 2000 ? '工作簿内部文件数量过多' : '工作簿解压后体积不能超过 50MB'));
    error.statusCode = 400;
    throw error;
  }
  const sharedEntry = zip.getEntry('xl/sharedStrings.xml');
  const sharedStrings = sharedEntry ? parseSharedStrings(sharedEntry.getData().toString('utf8')) : [];
  const workbookEntry = zip.getEntry('xl/workbook.xml');
  const workbookXml = workbookEntry?.getData().toString('utf8') || '';
  const sheetNames = workbookEntry
    ? [...workbookXml.matchAll(/<sheet\b[^>]*\bname="([^"]+)"/g)].map((match) => decodeXml(match[1]))
    : [];
  const relationshipXml = zip.getEntry('xl/_rels/workbook.xml.rels')?.getData().toString('utf8') || '';
  const relationshipPaths = new Map([...relationshipXml.matchAll(/<Relationship\b([^>]*)\/?\s*>/g)].filter((match) => !/TargetMode="External"/i.test(match[1])).map((match) => {
    const id = match[1].match(/\bId="([^"]+)"/)?.[1];
    const target = decodeXml(match[1].match(/\bTarget="([^"]+)"/)?.[1] || '');
    const logicalPath = target.startsWith('/') ? target.slice(1) : path.posix.normalize(`xl/${target}`);
    return [id, logicalPath];
  }));
  const namesByPath = new Map([...workbookXml.matchAll(/<sheet\b([^>]*)\/?\s*>/g)].map((match) => {
    const id = match[1].match(/\br:id="([^"]+)"/)?.[1];
    return [relationshipPaths.get(id), decodeXml(match[1].match(/\bname="([^"]+)"/)?.[1] || '')];
  }));
  const worksheetEntries = entries.filter((entry) => /^xl\/worksheets\/[^/]+\.xml$/i.test(entry.entryName)).sort((a, b) => a.entryName.localeCompare(b.entryName, undefined, { numeric: true }));
  if (!worksheetEntries.length) {
    const error = new Error('工作簿中没有可读取的工作表');
    error.statusCode = 400;
    throw error;
  }
  const sheets = worksheetEntries.map((entry, index) => {
    const rows = parseWorksheet(entry.getData().toString('utf8'), sharedStrings);
    const header = detectHeaderRow(rows);
    const headers = header?.values.map((value) => value || '').slice(0, 200) || [];
    return {
      name: namesByPath.get(entry.entryName) || sheetNames[index] || `Sheet${index + 1}`,
      path: entry.entryName,
      headerRow: header?.rowNumber || null,
      headers,
      sampleRows: header ? rows.filter((row) => row.rowNumber > header.rowNumber).slice(0, 3).map((row) => row.values.slice(0, headers.length)) : []
    };
  });
  const selectedSheet = [...sheets].sort((a, b) => b.headers.filter(Boolean).length - a.headers.filter(Boolean).length)[0];
  const mapping = mapHeaders(selectedSheet.headers, platformId);
  return {
    fileName: path.basename(originalName || filePath),
    fileBytes: stats.size,
    platformId,
    sheetCount: sheets.length,
    sheets,
    selectedSheet: selectedSheet.name,
    mapping,
    safeMode: { macrosExecuted: false, externalLinksFetched: false, extractedToDisk: false },
    notice: '本结果只识别表头并建议字段映射；在样本导入验证前，不视为平台官方模板已兼容。'
  };
}

export { FIELD_ALIASES, REQUIRED_FIELDS };
