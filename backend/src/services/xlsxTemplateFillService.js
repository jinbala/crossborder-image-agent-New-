import fs from 'node:fs/promises';
import { writeWorkbenchManifest } from './workbenchSnapshotService.js';
import path from 'node:path';
import { createHash } from 'node:crypto';
import AdmZip from 'adm-zip';
import { nanoid } from 'nanoid';
import { paths } from './db.js';
import { inspectXlsxTemplate } from './xlsxTemplateInspector.js';
import { indexTask } from './taskCenterService.js';
import { assertResource, claimResource } from './ownershipService.js';

const ROOT = path.join(paths.outputDir, 'workbench');
const executions = new Map();
const digest = (value) => createHash('sha256').update(value).digest('hex');
const fail = (message, statusCode = 400) => Object.assign(new Error(message), { statusCode });
const xml = (value) => String(value ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');
const unxml = (value) => String(value || '').replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&quot;', '"').replaceAll('&apos;', "'").replaceAll('&amp;', '&');
const publicPath = (file) => `/${path.relative(paths.rootDir, file).split(path.sep).join('/')}`;

function columnName(index) {
  let value = index + 1;
  let name = '';
  while (value > 0) { value -= 1; name = String.fromCharCode(65 + value % 26) + name; value = Math.floor(value / 26); }
  return name;
}

function rowsFromXml(sheet) {
  return [...sheet.matchAll(/<row\b[^>]*\br="(\d+)"[^>]*?(?:\/>|>[\s\S]*?<\/row>)/g)].map((match) => ({ number: Number(match[1]), raw: match[0] }));
}

function cellsFromRow(row = '') {
  return [...row.matchAll(/<c\b[^>]*\br="([A-Z]+\d+)"[^>]*?(?:\/>|>[\s\S]*?<\/c>)/g)].map((match) => ({ ref: match[1], raw: match[0] }));
}

function cellValue(raw, shared) {
  if (!raw) return '';
  if (/\bt="s"/.test(raw)) return shared[Number(raw.match(/<v[^>]*>([\s\S]*?)<\/v>/)?.[1])] || '';
  return unxml([...raw.matchAll(/<(?:t|v)\b[^>]*>([\s\S]*?)<\/(?:t|v)>/g)].map((match) => match[1]).join(''));
}

function replaceCell(row, ref, content, styleSource) {
  const cells = cellsFromRow(row);
  const found = cells.find((cell) => cell.ref === ref);
  const style = (found?.raw || styleSource || '').match(/\bs="(\d+)"/)?.[1];
  const numeric = typeof content === 'number' && Number.isFinite(content);
  const next = `<c r="${ref}"${style ? ` s="${style}"` : ''} t="${numeric ? 'n' : 'inlineStr'}">${numeric ? `<v>${content}</v>` : `<is><t xml:space="preserve">${xml(content)}</t></is>`}</c>`;
  if (found) return row.replace(found.raw, next);
  const letter = ref.match(/^[A-Z]+/)[0];
  const index = (text) => [...text].reduce((sum, char) => sum * 26 + char.charCodeAt(0) - 64, 0);
  const following = cells.find((cell) => index(cell.ref.match(/^[A-Z]+/)[0]) > index(letter));
  if (following) return row.replace(following.raw, `${next}${following.raw}`);
  if (/\/>$/.test(row)) return row.replace(/\/>$/, `>${next}</row>`);
  return row.replace('</row>', `${next}</row>`);
}

export function planWorkbookFill(sheet, records, mapping, { startRow, overwriteCells = false, sharedStrings = [] }) {
  if (!Array.isArray(records) || !records.length || records.length > 1000) throw fail('回填数据必须为 1—1000 行');
  if (!Number.isInteger(startRow) || startRow < 2 || startRow + records.length > 1_048_576) throw fail('回填起始行无效');
  const fields = Object.entries(mapping || {}).filter(([, column]) => column !== '' && column !== null && column !== undefined);
  if (!fields.length || fields.some(([field, column]) => !/^[A-Za-z][A-Za-z0-9_]{0,60}$/.test(field) || !Number.isInteger(column) || column < 0 || column >= 200)) throw fail('字段映射无效，请使用 0—199 的列索引');
  if (new Set(fields.map(([, column]) => column)).size !== fields.length) throw fail('不能将多个字段写入同一列');
  if (!/<sheetData\b[^>]*>/.test(sheet) || !/<\/sheetData>/.test(sheet)) throw fail('暂不支持此工作表结构');
  if (/<sheetProtection\b/.test(sheet)) throw fail('工作表受保护，请提供可编辑的模板副本');
  const rows = rowsFromXml(sheet);
  const sourceStyles = cellsFromRow(rows.find((row) => row.number === startRow)?.raw || '');
  const changes = [];
  const blocked = [];
  const updated = new Map(rows.map((row) => [row.number, row.raw]));
  for (const [offset, record] of records.entries()) {
    if (!record || typeof record !== 'object' || Array.isArray(record)) throw fail(`第 ${offset + 1} 行不是有效记录`);
    const rowNumber = startRow + offset;
    let row = updated.get(rowNumber) || `<row r="${rowNumber}"></row>`;
    for (const [field, column] of fields) {
      const input = record[field];
      if (input === undefined || input === null || input === '') continue;
      if (typeof input === 'number' && !Number.isFinite(input)) throw fail(`第 ${offset + 1} 行 ${field} 不是有效数值`);
      if (!['string', 'number', 'boolean'].includes(typeof input) && !Array.isArray(input)) throw fail(`第 ${offset + 1} 行 ${field} 不是可填写的文本`);
      const after = String(Array.isArray(input) ? input.join(';') : input);
      if (after.length > 32767) throw fail(`第 ${offset + 1} 行 ${field} 超过单元格长度限制`);
      const ref = `${columnName(column)}${rowNumber}`;
      const existing = cellsFromRow(row).find((cell) => cell.ref === ref);
      const before = cellValue(existing?.raw, sharedStrings);
      if (/<f(?:\s|>|\/)/.test(existing?.raw || '')) { blocked.push({ ref, field, reason: 'FORMULA_PRESERVED' }); continue; }
      if (before === after) continue;
      if (before && !overwriteCells) { blocked.push({ ref, field, reason: 'CELL_NOT_EMPTY', before }); continue; }
      // Inline strings keep =,+,-,@ prefixes as text and never create formulas.
      row = replaceCell(row, ref, typeof input === 'number' ? input : after, sourceStyles.find((cell) => cell.ref === `${columnName(column)}${startRow}`)?.raw);
      changes.push({ ref, field, before, after });
    }
    updated.set(rowNumber, row);
  }
  let nextSheet = sheet;
  for (const row of rows) if (updated.has(row.number)) nextSheet = nextSheet.replace(row.raw, updated.get(row.number));
  const existingNumbers = new Set(rows.map((row) => row.number));
  const added = [...updated.entries()].filter(([number]) => !existingNumbers.has(number)).sort((a, b) => a[0] - b[0]);
  for (const [number, raw] of added) {
    const following = rows.find((row) => row.number > number);
    nextSheet = following ? nextSheet.replace(updated.get(following.number), `${raw}${updated.get(following.number)}`) : nextSheet.replace('</sheetData>', `${raw}</sheetData>`);
  }
  // Preserve the original range's last column and extend it only when necessary.
  nextSheet = nextSheet.replace(/<dimension\b[^>]*ref="([A-Z]+)(\d+)(?::([A-Z]+)(\d+))?"[^>]*\/>/, (tag, firstCol, firstRow, lastCol, lastRow) => {
    const lastNumber = Math.max(Number(lastRow || firstRow), startRow + records.length - 1);
    const index = (name) => [...name].reduce((sum, letter) => sum * 26 + letter.charCodeAt(0) - 64, 0) - 1;
    const lastColumn = columnName(Math.max(index(lastCol || firstCol), ...fields.map(([, column]) => column)));
    return tag.replace(/ref="[^"]+"/, `ref="${firstCol}${firstRow}:${lastColumn}${lastNumber}"`);
  });
  return { sheet: nextSheet, changes, blocked, summary: { recordCount: records.length, changedCells: changes.length, blockedCells: blocked.length, formulasPreserved: blocked.filter((item) => item.reason === 'FORMULA_PRESERVED').length } };
}

export async function previewTemplateFill(filePath, raw = {}) {
  const inspection = await inspectXlsxTemplate(filePath, { originalName: raw.originalName, platformId: raw.platformId || 'temu' });
  const selected = inspection.sheets.find((sheet) => sheet.path === raw.sheetPath || sheet.name === raw.sheetName) || inspection.sheets.find((sheet) => sheet.name === inspection.selectedSheet);
  if (!selected?.headerRow) throw fail('未识别到有效表头，请先选择模板');
  const zip = new AdmZip(filePath);
  if (zip.getEntries().some((entry) => /^_xmlsignatures\//i.test(entry.entryName))) throw fail('不能修改带数字签名的工作簿，请使用未签名模板副本');
  const mapping = raw.mapping || Object.fromEntries(inspection.mapping.fields.filter((field) => field.matched).map((field) => [field.field, field.columnIndex]));
  const missingRequired = inspection.mapping.required.filter((field) => mapping[field] === undefined || mapping[field] === null || mapping[field] === '');
  if (missingRequired.length) throw fail(`缺少必填字段映射：${missingRequired.join('、')}`);
  const records = raw.records;
  if (!Array.isArray(records)) throw fail('缺少待回填商品数据');
  const missingValues = records.flatMap((record, index) => inspection.mapping.required.filter((field) => record?.[field] === undefined || record?.[field] === null || record?.[field] === '').map((field) => ({ row: index + 1, field })));
  if (missingValues.length) throw fail(`必填数据不完整：${missingValues.slice(0, 10).map((item) => `第${item.row}行 ${item.field}`).join('；')}`);
  const options = { startRow: Number(raw.startRow || selected.headerRow + 1), overwriteCells: raw.overwriteCells === true };
  if (options.startRow <= selected.headerRow) throw fail('不能覆盖模板表头');
  const shared = zip.getEntry('xl/sharedStrings.xml')?.getData().toString('utf8') || '';
  options.sharedStrings = [...shared.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)].map((item) => [...item[1].matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((part) => unxml(part[1])).join(''));
  const planned = planWorkbookFill(zip.getEntry(selected.path).getData().toString('utf8'), records, mapping, options);
  const id = `template-fill-${Date.now()}-${nanoid(8)}`;
  claimResource('job', id);
  const directory = path.join(ROOT, id);
  await fs.mkdir(directory, { recursive: true });
  const source = await fs.readFile(filePath);
  await fs.writeFile(path.join(directory, 'source.xlsx'), source);
  const plan = { id, type: 'template-fill', status: 'preview', createdAt: new Date().toISOString(), originalName: path.basename(raw.originalName || 'template.xlsx'),
    sourceHash: digest(source), sheetPath: selected.path, sheetName: selected.name, records, mapping, options,
    summary: planned.summary, changes: planned.changes, blocked: planned.blocked };
  const serialized = JSON.stringify(plan);
  const previewHash = digest(serialized);
  await fs.writeFile(path.join(directory, 'plan.json'), serialized);
  const preview = { ...plan, name: `模板回填：${plan.originalName}`, status: 'waiting_user', updatedAt: plan.createdAt, previewHash,
    canExecute: planned.changes.length > 0 && planned.blocked.length === 0, manifestUrl: publicPath(path.join(directory, 'manifest.json')) };
  await writeWorkbenchManifest(preview);
  indexTask(preview);
  return { id, previewHash, sheetName: selected.name, summary: planned.summary, changes: planned.changes, blocked: planned.blocked, canExecute: preview.canExecute };
}

async function performTemplateFill(id, { previewHash, confirm = false } = {}) {
  if (confirm !== true) throw fail('请确认模板回填差异后再执行');
  if (!/^template-fill-[A-Za-z0-9_-]+$/.test(String(id || ''))) throw fail('模板任务 ID 无效');
  const directory = path.join(ROOT, id);
  const serialized = await fs.readFile(path.join(directory, 'plan.json'), 'utf8').catch(() => { throw fail('模板预览不存在', 404); });
  if (!previewHash || previewHash !== digest(serialized)) throw fail('模板预览已变化，请重新预览', 409);
  const plan = JSON.parse(serialized);
  if (plan.blocked.length || !plan.changes.length) throw fail('请先解决预览中的占用或公式冲突', 409);
  const source = await fs.readFile(path.join(directory, 'source.xlsx'));
  if (digest(source) !== plan.sourceHash) throw fail('模板源副本已变化，请重新预览', 409);
  const zip = new AdmZip(source);
  const planned = planWorkbookFill(zip.getEntry(plan.sheetPath).getData().toString('utf8'), plan.records, plan.mapping, plan.options);
  zip.updateFile(plan.sheetPath, Buffer.from(planned.sheet));
  const output = path.join(directory, 'filled-template.xlsx');
  // Same approved preview produces the same output even after a retry.
  await fs.writeFile(`${output}.tmp`, zip.toBuffer());
  await fs.rename(`${output}.tmp`, output);
  const report = { id, type: 'template-fill', status: 'completed', createdAt: plan.createdAt, updatedAt: new Date().toISOString(),
    sheetName: plan.sheetName, sourceHash: plan.sourceHash, outputHash: digest(await fs.readFile(output)),
    summary: planned.summary, changes: planned.changes, blocked: planned.blocked,
    downloadUrl: publicPath(output), diffUrl: publicPath(path.join(directory, 'diff.json')) };
  await fs.writeFile(path.join(directory, 'diff.json'), JSON.stringify(report, null, 2));
  await writeWorkbenchManifest(report);
  indexTask(report);
  return report;
}

export function executeTemplateFill(id, options = {}) {
  assertResource('job', id);
  if (options.confirm !== true) return Promise.reject(fail('请确认模板回填差异后再执行'));
  const key = `${id}:${options.previewHash}`;
  if (executions.has(key)) return executions.get(key);
  const operation = performTemplateFill(id, options).finally(() => executions.delete(key));
  executions.set(key, operation);
  return operation;
}
