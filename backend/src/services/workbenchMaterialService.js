import fs from 'node:fs/promises';
import path from 'node:path';
import { nanoid } from 'nanoid';
import { paths } from './db.js';
import { resourceVisible, assertResource, claimResource } from './ownershipService.js';

const DEFAULT_LEDGER_PATH = path.join(paths.dataDir, 'workbench-materials.json');
const MATERIAL_TYPES = new Set(['main', 'additional', 'square', 'swatch', 'detail', 'variant', 'general']);
let mutationQueue = Promise.resolve();

function clean(value, max = 1000) {
  return String(value ?? '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, max);
}

function csvCell(value) {
  let text = clean(value, 5000);
  if (/^[=+\-@]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}

async function readLedger(filePath) {
  try {
    const parsed = JSON.parse(await fs.readFile(filePath, 'utf8'));
    return { version: 1, updatedAt: parsed.updatedAt || null, records: Array.isArray(parsed.records) ? parsed.records : [] };
  } catch (error) {
    if (error.code === 'ENOENT') return { version: 1, updatedAt: null, records: [] };
    throw error;
  }
}

async function writeLedger(filePath, ledger) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${nanoid(6)}.tmp`;
  await fs.writeFile(tempPath, `${JSON.stringify(ledger, null, 2)}\n`, 'utf8');
  try {
    await fs.rename(tempPath, filePath);
  } catch (error) {
    await fs.rm(tempPath, { force: true });
    throw error;
  }
}

function normalizeRecord(input, existing = null) {
  const sku = clean(input.sku ?? existing?.sku, 120);
  const platformId = clean(input.platformId ?? existing?.platformId, 30).toLowerCase();
  const materialId = clean(input.materialId ?? existing?.materialId, 500);
  const materialTypeInput = clean(input.materialType ?? existing?.materialType, 30).toLowerCase();
  const materialType = MATERIAL_TYPES.has(materialTypeInput) ? materialTypeInput : 'general';
  if (!sku || !platformId || !materialId) {
    const error = new Error('素材记录必须包含 SKU、平台和素材 ID');
    error.statusCode = 400;
    throw error;
  }
  const now = new Date().toISOString();
  return {
    id: existing?.id || `material-${nanoid(10)}`,
    sku,
    platformId,
    materialId,
    materialType,
    sourceRef: clean(input.sourceRef ?? existing?.sourceRef, 2000),
    fileName: clean(input.fileName ?? existing?.fileName, 500),
    width: Number.isFinite(Number(input.width ?? existing?.width)) && Number(input.width ?? existing?.width) > 0 ? Math.round(Number(input.width ?? existing?.width)) : null,
    height: Number.isFinite(Number(input.height ?? existing?.height)) && Number(input.height ?? existing?.height) > 0 ? Math.round(Number(input.height ?? existing?.height)) : null,
    checksum: clean(input.checksum ?? existing?.checksum, 128),
    notes: clean(input.notes ?? existing?.notes, 1000),
    status: 'active',
    createdAt: existing?.createdAt || now,
    updatedAt: now
  };
}

function withMutation(mutator) {
  const run = mutationQueue.then(mutator, mutator);
  mutationQueue = run.catch(() => {});
  return run;
}

export async function listMaterialRecords(query = {}, { filePath = DEFAULT_LEDGER_PATH } = {}) {
  const ledger = await readLedger(filePath);
  const sku = clean(query.sku, 120).toLowerCase();
  const platformId = clean(query.platformId, 30).toLowerCase();
  const materialType = clean(query.materialType, 30).toLowerCase();
  const records = ledger.records.filter((record) => (
    resourceVisible('material', record.id) &&
    (query.includeArchived === true || query.includeArchived === 'true' || record.status !== 'archived') &&
    (!sku || (query.exactSku === true || query.exactSku === 'true' ? record.sku.toLowerCase() === sku : record.sku.toLowerCase().includes(sku))) &&
    (!platformId || record.platformId === platformId) &&
    (!materialType || record.materialType === materialType)
  )).sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
  const paginate = query.page !== undefined || query.pageSize !== undefined;
  const pageSize = Math.max(1, Math.min(200, Math.floor(Number(query.pageSize) || 50)));
  const page = Math.max(1, Math.min(Math.max(1, Math.ceil(records.length / pageSize)), Math.floor(Number(query.page) || 1)));
  return {
    version: ledger.version,
    updatedAt: ledger.updatedAt,
    summary: {
      totalCount: records.length,
      skuCount: new Set(records.map((record) => record.sku)).size,
      platformCount: new Set(records.map((record) => record.platformId)).size
    },
    records: paginate ? records.slice((page - 1) * pageSize, page * pageSize) : records,
    ...(paginate ? { pagination: { page, pageSize, total: records.length, totalPages: Math.max(1, Math.ceil(records.length / pageSize)) } } : {})
  };
}

export async function importMaterialRecords(inputs, { filePath = DEFAULT_LEDGER_PATH } = {}) {
  if (!Array.isArray(inputs) || inputs.length === 0 || inputs.length > 5000) {
    const error = new Error('每次需要导入 1–5000 条素材记录');
    error.statusCode = 400;
    throw error;
  }
  return withMutation(async () => {
    const ledger = await readLedger(filePath);
    const records = [...ledger.records];
    let createdCount = 0;
    let updatedCount = 0;
    const imported = [];
    for (const input of inputs) {
      const lookupSku = clean(input.sku, 120).toLowerCase();
      const lookupPlatform = clean(input.platformId, 30).toLowerCase();
      const lookupMaterial = clean(input.materialId, 500);
      const index = records.findIndex((record) => resourceVisible('material', record.id) && record.sku.toLowerCase() === lookupSku && record.platformId === lookupPlatform && record.materialId === lookupMaterial);
      if (index >= 0) {
        records[index] = normalizeRecord(input, records[index]);
        imported.push(records[index]);
        updatedCount += 1;
      } else {
        const record = normalizeRecord(input);
        claimResource('material', record.id);
        records.push(record);
        imported.push(record);
        createdCount += 1;
      }
    }
    const updatedAt = new Date().toISOString();
    await writeLedger(filePath, { version: 1, updatedAt, records });
    return { createdCount, updatedCount, totalCount: records.filter((record) => resourceVisible('material', record.id)).length, records: imported };
  });
}

export async function updateMaterialRecord(recordId, patch, { filePath = DEFAULT_LEDGER_PATH } = {}) {
  assertResource('material', recordId);
  return withMutation(async () => {
    const ledger = await readLedger(filePath);
    const index = ledger.records.findIndex((record) => record.id === recordId);
    if (index < 0) {
      const error = new Error('素材记录不存在');
      error.statusCode = 404;
      throw error;
    }
    const normalized = normalizeRecord(patch, ledger.records[index]);
    if (ledger.records.some((record, candidate) => candidate !== index && resourceVisible('material', record.id) && record.sku.toLowerCase() === normalized.sku.toLowerCase() && record.platformId === normalized.platformId && record.materialId === normalized.materialId)) throw Object.assign(new Error('同一 SKU 和平台已存在该素材 ID'), { statusCode: 409 });
    ledger.records[index] = { ...normalized, status: ledger.records[index].status || 'active', archivedAt: ledger.records[index].archivedAt || null };
    ledger.updatedAt = new Date().toISOString();
    await writeLedger(filePath, ledger);
    return ledger.records[index];
  });
}

export async function exportMaterialRecordsCsv(query = {}, options = {}) {
  const { page, pageSize, ...filters } = query;
  const result = await listMaterialRecords(filters, options);
  const headers = ['sku', 'platform', 'material_id', 'material_type', 'source_ref', 'file_name', 'width', 'height', 'checksum', 'notes', 'updated_at'];
  const rows = result.records.map((record) => [record.sku, record.platformId, record.materialId, record.materialType, record.sourceRef, record.fileName, record.width ?? '', record.height ?? '', record.checksum, record.notes, record.updatedAt]);
  return `\uFEFF${[headers, ...rows].map((row) => row.map(csvCell).join(',')).join('\r\n')}\r\n`;
}

export async function archiveMaterialRecord(recordId, { confirm = false, restore = false } = {}, { filePath = DEFAULT_LEDGER_PATH } = {}) {
  assertResource('material', recordId);
  if (confirm !== true) throw Object.assign(new Error('请确认素材归档或恢复'), { statusCode: 400 });
  return withMutation(async () => {
    const ledger = await readLedger(filePath);
    const record = ledger.records.find((item) => item.id === recordId);
    if (!record) throw Object.assign(new Error('素材记录不存在'), { statusCode: 404 });
    record.status = restore ? 'active' : 'archived';
    record.archivedAt = restore ? null : new Date().toISOString();
    record.updatedAt = new Date().toISOString();
    ledger.updatedAt = record.updatedAt;
    await writeLedger(filePath, ledger);
    return record;
  });
}

export { DEFAULT_LEDGER_PATH, MATERIAL_TYPES };
