import express from 'express';
import { rateLimit } from '../middleware/rateLimit.js';
import multer from 'multer';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { asyncHandler } from '../utils/asyncHandler.js';
import { listMembers, createMember, updateMember, fail } from '../services/accountService.js';
import { platformDb, meta, listAudit, privateSafe } from '../services/platformStore.js';
import { getProviderConfigSummary } from '../config/env.js';
import { paths } from '../services/dbPaths.js';
import { getStorageDriver } from '../storage/index.js';
import { requireRole } from '../middleware/webAccess.js';
import { listRecords, saveRecord, archiveRecord, getRecord } from '../services/platformRecordService.js';
import { creativeBrief, renderStudio } from '../services/studioService.js';
import { authorizationStatus, beginShopAuthorization, finishShopAuthorization, listShopConnections, revokeShop, createErpGrant, listErpGrants, revokeErpGrant, authorizeErp, erpProducts } from '../services/authorizationService.js';
import { listTaskCenter, taskMetadata, rebuildLegacyIndex } from '../services/taskCenterService.js';
import { issueDeviceCode, redeemDeviceCode, listDevices, revokeDevice, synchronizeDevice } from '../services/deviceSyncService.js';
import { listTasks, getBatchTask, getTask } from '../services/db.js';
import { assertResource } from '../services/ownershipService.js';
import { assignmentPreview, assignResource } from '../services/resourceAssignmentService.js';
import { supportStatus } from '../services/supportService.js';
import { listMaterialRecords } from '../services/workbenchMaterialService.js';
import { getCollectionJob, pauseCollectionJob } from '../services/collectionJobService.js';
import { pauseBatchQueue, cancelBatchQueue } from '../services/batchQueueService.js';
import { createCommerceSandbox, getCommerceSandbox, runCommerceSandbox, stopCommerceSandbox } from '../services/commerceSandboxService.js';
import { controlSkuPack } from '../services/skuPackService.js';
import { controlImagePack } from '../services/imagePackRecoveryService.js';

const router = express.Router();
router.post('/task-index/rebuild', requireRole('admin'), asyncHandler(async (req, res) => {
  if (req.body?.confirm !== true) throw fail('请确认后台重新扫描历史任务清单，原文件不会修改');
  res.json(await rebuildLegacyIndex());
}));
router.get('/support/status', requireRole('admin', 'support'), asyncHandler(async (req, res) => res.json(await supportStatus(req.actor))));
router.post('/resources/:kind/:id/owner-preview', requireRole('admin'), asyncHandler(async (req, res) => res.json(await assignmentPreview(req.params.kind, req.params.id, req.body || {}, req.actor))));
router.post('/resources/:kind/:id/owner', requireRole('admin'), asyncHandler(async (req, res) => res.json(await assignResource(req.params.kind, req.params.id, req.body || {}, req.actor))));
router.post('/commerce-sandbox', requireRole('admin', 'operator'), asyncHandler(async (req, res) => res.status(201).json(await createCommerceSandbox(req.body || {}, req.actor))));
router.get('/commerce-sandbox/:id', requireRole('admin', 'operator'), (req, res, next) => { try { res.json(getCommerceSandbox(req.params.id, req.actor)); } catch (error) { next(error); } });
router.post('/commerce-sandbox/:id/run', requireRole('admin', 'operator'), asyncHandler(async (req, res) => res.json(await runCommerceSandbox(req.params.id, req.body || {}, req.actor))));
router.post('/commerce-sandbox/:id/stop', requireRole('admin', 'operator'), (req, res, next) => { try { res.json(stopCommerceSandbox(req.params.id, req.body || {}, req.actor)); } catch (error) { next(error); } });
router.get('/help', asyncHandler(async (_req, res) => {
  res.set('X-Workbench-Version', process.env.APP_DESKTOP_VERSION || 'web-source').type('text/plain; charset=utf-8')
    .send(await fs.readFile(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../docs/user-manual.md'), 'utf8'));
}));
router.get('/authorizations/status', requireRole('admin'), (_req, res, next) => { try { res.json(authorizationStatus()); } catch (error) { next(error); } });
router.get('/shops', requireRole('admin'), (req, res, next) => { try { res.json({ records: listShopConnections(req.actor) }); } catch (error) { next(error); } });
router.post('/shops/authorize', requireRole('admin'), (req, res, next) => { try { res.json(beginShopAuthorization(req.body || {}, req.actor)); } catch (error) { next(error); } });
router.get('/shops/callback', requireRole('admin'), asyncHandler(async (req, res) => { await finishShopAuthorization(req.query, req.actor); res.redirect('/connections?bound=1'); }));
router.post('/shops/:id/revoke', requireRole('admin'), asyncHandler(async (req, res) => { if (req.body?.confirm !== true) throw fail('请确认撤销授权'); res.json(await revokeShop(req.params.id, req.actor)); }));
router.get('/erp-grants', requireRole('admin'), (req, res, next) => { try { res.json({ records: listErpGrants(req.actor) }); } catch (error) { next(error); } });
router.post('/erp-grants', requireRole('admin'), (req, res, next) => { try { res.status(201).json(createErpGrant(req.body || {}, req.actor)); } catch (error) { next(error); } });
router.post('/erp-grants/:id/revoke', requireRole('admin'), (req, res, next) => { try { if (req.body?.confirm !== true) throw fail('请确认撤销授权'); res.json(revokeErpGrant(req.params.id, req.actor)); } catch (error) { next(error); } });
router.get('/erp/v1/:resource', asyncHandler(async (req, res) => {
  const resource = req.params.resource;
  if (!['tasks', 'products'].includes(resource)) throw fail('ERP 只支持商品和任务摘要', 404);
  authorizeErp(String(req.headers.authorization || '').replace(/^Bearer\s+/i, ''), `${resource}:read`);
  res.json(resource === 'products' ? erpProducts(req.query) : await listTaskCenter(req.query).then((result) => ({ ...result, records: result.records.map(({ id, kind, state, sku, title, created_at, updated_at }) => privateSafe({ id, kind, state, sku, title, created_at, updated_at })) })));
}));
const studioUpload = multer({ dest: os.tmpdir(), limits: { files: 101, fileSize: 15 * 1024 * 1024 }, fileFilter: (_req, file, callback) => callback(/^image\/(png|jpeg|webp)$/.test(file.mimetype) ? null : fail('仅支持 PNG、JPG、WebP 图片'), true) });
router.post('/studio/plan', requireRole('admin', 'operator', 'designer'), (req, res, next) => { try { res.json(creativeBrief(req.body)); } catch (error) { next(error); } });
router.post('/studio/render', requireRole('admin', 'operator', 'designer'), studioUpload.fields([{ name: 'images', maxCount: 100 }, { name: 'background', maxCount: 1 }]), asyncHandler(async (req, res) => {
  try {
    let options; try { options = JSON.parse(req.body.options || '{}'); } catch { throw fail('图片参数 JSON 无效'); }
    res.status(201).json(await renderStudio(req.files?.images, req.files?.background?.[0], options));
  } finally { await Promise.all(Object.values(req.files || {}).flat().map((file) => fs.rm(file.path, { force: true }))); }
}));
router.get('/record-history/:id', (req, res, next) => {
  try {
    const record = getRecord(req.params.id);
    if (!record || !['preset', 'pricing-rule', 'conversation', 'product', 'notice'].includes(record.kind) || (['preset', 'conversation'].includes(record.kind) && req.actor.role !== 'admin' && record.ownerId !== req.actor.id)) throw fail('记录不存在', 404);
    res.json({ records: platformDb().prepare('SELECT version,data,created_at FROM record_revisions WHERE record_id=? ORDER BY version DESC LIMIT 100').all(record.id).map((row) => ({ ...row, data: JSON.parse(row.data) })) });
  } catch (error) { next(error); }
});
router.get('/workspace', asyncHandler(async (_req, res) => {
  const disk = await fs.statfs(paths.rootDir).catch(() => null);
  res.json({ workspace: meta('workspace', { name: '本地运营工作空间' }), tasks: await listTaskCenter({ pageSize: 8 }), providers: getProviderConfigSummary(),
    storage: { driver: getStorageDriver(), availableBytes: disk ? disk.bavail * disk.bsize : null }, version: process.env.APP_DESKTOP_VERSION || 'web-source' });
}));
router.get('/devices', (req, res) => res.json({ records: listDevices(req.actor) }));
router.post('/devices/code', (req, res, next) => { try { res.json(issueDeviceCode(req.actor)); } catch (error) { next(error); } });
router.post('/devices/redeem', rateLimit({ limit: 30, windowMs: 60000, name: '设备配对' }), (req, res, next) => { try { res.json(redeemDeviceCode(req.body || {})); } catch (error) { next(error); } });
router.post('/devices/:id/revoke', (req, res, next) => { try { res.json(revokeDevice(req.params.id, req.actor)); } catch (error) { next(error); } });
router.get('/sync-export', requireRole('admin', 'operator', 'designer'), asyncHandler(async (_req, res) => res.json({ records: await taskMetadata(), metadataOnly: true })));
router.post('/sync', rateLimit({ limit: 200, windowMs: 60000, name: '设备同步' }), (req, res, next) => {
  try { const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, ''); res.json(synchronizeDevice(token, req.body || {})); } catch (error) { next(error); }
});
router.get('/members', requireRole('admin'), (_req, res) => res.json({ records: listMembers() }));
router.post('/members', requireRole('admin'), asyncHandler(async (req, res) => res.status(201).json(await createMember(req.body || {}, req.actor))));
router.patch('/members/:id', asyncHandler(async (req, res) => res.json(updateMember(req.params.id, req.body || {}, req.actor))));
router.get('/audit', (req, res) => res.json(listAudit({ ...req.query, actorId: req.actor.role === 'admin' ? '' : req.actor.id })));
router.get('/task-center', asyncHandler(async (req, res) => res.json(await listTaskCenter(req.query))));
router.get('/task-center/export.csv', asyncHandler(async (req, res) => {
  const rows = [['id', 'kind', 'state', 'sku', 'title', 'created_at', 'updated_at']];
  let page = 1, result;
  do { result = await listTaskCenter({ ...req.query, page, pageSize: 100 }); rows.push(...result.records.map((item) => rows[0].map((key) => item[key]))); page++; } while (page <= result.pagination.totalPages && page <= 1000);
  const cell = (value) => { const text = String(value ?? ''); return `"${(/^[=+@\-\t\r]/.test(text) ? `'${text}` : text).replaceAll('"', '""')}"`; };
  res.type('text/csv').attachment('task-center.csv').send(`\uFEFF${rows.map((row) => row.map(cell).join(',')).join('\r\n')}`);
}));
router.post('/task-center/:id/actions', requireRole('admin', 'operator'), asyncHandler(async (req, res) => {
  if (!['pause', 'cancel'].includes(req.body?.action)) throw fail('仅支持暂停或取消；请在任务详情中确认继续执行');
  if (req.body.action === 'cancel' && req.body.confirm !== true) throw fail('请确认取消任务');
  const record = platformDb().prepare('SELECT * FROM task_index WHERE id=?').get(req.params.id);
  if (!record) throw fail('任务不存在', 404);
  assertResource(['image', 'batch'].includes(record.kind) ? record.kind : 'job', record.id);
  if (record.kind === 'batch') {
    if (!await getBatchTask(record.id)) throw fail('批量任务不存在', 404);
    const result = req.body.action === 'pause' ? await pauseBatchQueue(record.id) : await cancelBatchQueue(record.id);
    return res.json(result);
  }
  if (record.kind === 'collection-job') return res.json(await pauseCollectionJob(record.id, req.body.action === 'cancel'));
  if (record.kind === 'sku-pack') return res.json(await controlSkuPack(record.id, req.body.action));
  if (record.kind === 'image-pack') return res.json(await controlImagePack(record.id, { ...req.body, confirm: req.body.action === 'pause' || req.body.confirm === true }));
  throw fail('此任务不支持队列操作', 409);
}));
router.get('/records/:kind', (req, res, next) => { try { res.json(listRecords(req.params.kind, req.query, req.actor)); } catch (error) { next(error); } });
router.post('/records/:kind', (req, res, next) => { try { res.status(201).json(saveRecord(req.params.kind, req.body || {}, req.actor)); } catch (error) { next(error); } });
router.patch('/records/:kind/:id', (req, res, next) => { try { res.json(saveRecord(req.params.kind, req.body || {}, req.actor, req.params.id)); } catch (error) { next(error); } });
router.post('/record-actions/:id/archive', (req, res, next) => { try { res.json(archiveRecord(req.params.id, req.body || {}, req.actor)); } catch (error) { next(error); } });
router.get('/records/:kind/export', (req, res, next) => {
  try {
    const records = [];
    let page = 1;
    let result;
    do { result = listRecords(req.params.kind, { ...req.query, page, pageSize: 100 }, req.actor); records.push(...result.records); page += 1; } while (page <= result.pagination.totalPages && page <= 1000);
    res.attachment(`${req.params.kind}-export.json`).json({ formatVersion: 1, kind: req.params.kind, exportedAt: new Date().toISOString(), records: records.map((item) => ({ data: item.data })) });
  } catch (error) { next(error); }
});
router.post('/records/:kind/import', requireRole('admin', 'operator', 'designer'), (req, res, next) => {
  try {
    if (req.body?.formatVersion !== 1 || !Array.isArray(req.body?.records) || req.body.records.length > 500) throw fail('请导入版本 1 的记录文件，每次不超过 500 条');
    const results = req.body.records.map((record, index) => {
      try { return { index, status: 'success', record: saveRecord(req.params.kind, { data: record.data }, req.actor) }; }
      catch (error) { return { index, status: 'failed', reason: error.message }; }
    });
    res.json({ results, successCount: results.filter((item) => item.status === 'success').length, failedCount: results.filter((item) => item.status === 'failed').length });
  } catch (error) { next(error); }
});
router.post('/products/import-tasks', requireRole('admin', 'operator'), asyncHandler(async (req, res) => {
  const rows = req.body?.collectionJobId ? (await getCollectionJob(req.body.collectionJobId)).items.map((item) => ({ sku: item.sku, title: item.title || item.sku, sourceUrl: item.productUrl, sales: item.sales }))
    : (await listTasks()).map((task) => { const info = task.productInfoConfirmed || task.productInfo || {}; return { ...info, sku: info.sku || task.id, title: info.name || info.productName || task.id, taskId: task.id }; });
  const existing = new Set(platformDb().prepare("SELECT data FROM platform_records WHERE kind='product' AND deleted=0 AND (?=1 OR owner_id=?)").all(Number(req.actor.role === 'admin'), req.actor.id).map((row) => JSON.parse(row.data).sku));
  const results = rows.slice(0, 5000).map((data) => {
    if (existing.has(data.sku)) return { sku: data.sku, status: 'skipped', reason: 'SKU 已存在，保留人工编辑结果' };
    try { const record = saveRecord('product', { data }, req.actor); existing.add(data.sku); return { sku: data.sku, status: 'success', id: record.id }; }
    catch (error) { return { sku: data.sku, status: 'failed', reason: error.message }; }
  });
  res.json({ results });
}));
router.get('/products/:id/links', asyncHandler(async (req, res) => {
  const product = getRecord(req.params.id);
  if (!product || product.kind !== 'product') throw fail('商品不存在', 404);
  const [materials, jobs, task] = await Promise.all([listMaterialRecords({ sku: product.data.sku, exactSku: true, page: req.query.page || 1, pageSize: 50 }), listTaskCenter({ sku: product.data.sku, pageSize: 50 }), product.data.taskId ? getTask(product.data.taskId) : null]);
  res.json({ productId: product.id, sku: product.data.sku, source: { platform: product.data.sourcePlatform || '', url: product.data.sourceUrl || '' }, materials,
    tasks: jobs, recognition: task ? { taskId: task.id, productInfo: task.productInfoConfirmed || task.productInfoRaw || task.productInfo, quality: task.recognitionQuality || null } : null,
    exports: jobs.records.filter((item) => item.summary.downloadUrl).map((item) => ({ taskId: item.id, url: item.summary.downloadUrl, createdAt: item.updated_at })) });
}));
router.get('/space', asyncHandler(async (req, res) => {
  const jobs = await listTaskCenter({ ...req.query, hideArchived: req.query.includeArchived !== 'true', pageSize: req.query.pageSize || 30 });
  const hidden = new Set(platformDb().prepare('SELECT task_id FROM space_archives').all().map((row) => row.task_id));
  res.json({ ...jobs, records: jobs.records.map((item) => ({ ...item, archived: hidden.has(item.id), downloadUrl: item.summary.downloadUrl, imageCount: item.summary.imageCount || item.summary.outputCount || item.summary.downloadedCount || 0 })) });
}));
router.post('/space/:id/archive', requireRole('admin', 'operator'), (req, res, next) => {
  try {
    if (req.body?.confirm !== true) throw fail('请确认归档或恢复');
    const record = platformDb().prepare('SELECT id,kind FROM task_index WHERE id=?').get(req.params.id);
    if (!record) throw fail('任务不存在', 404);
    assertResource(['image', 'batch'].includes(record.kind) ? record.kind : 'job', record.id);
    if (req.body.restore === true) platformDb().prepare('DELETE FROM space_archives WHERE task_id=?').run(req.params.id);
    else platformDb().prepare('INSERT OR REPLACE INTO space_archives VALUES (?,?,?)').run(req.params.id, req.actor.id, new Date().toISOString());
    res.json({ ok: true, filesDeleted: false });
  } catch (error) { next(error); }
});
export default router;
