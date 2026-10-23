import express from 'express';
import multer from 'multer';
import fs from 'node:fs/promises';
import path from 'node:path';
import { nanoid } from 'nanoid';
import { asyncHandler } from '../utils/asyncHandler.js';
import { paths } from '../services/db.js';
import {
  createCollectionPlan,
  createImagePack,
  createListingDryRun,
  createPricingPreview,
  getWorkbenchOverview,
  recentWorkbenchJobs,
  workbenchJobDetail
} from '../services/workbenchService.js';
import {
  exportMaterialRecordsCsv,
  importMaterialRecords,
  listMaterialRecords,
  updateMaterialRecord
} from '../services/workbenchMaterialService.js';
import { archiveMaterialRecord } from '../services/workbenchMaterialService.js';
import { inspectXlsxTemplate } from '../services/xlsxTemplateInspector.js';
import { previewTemplateFill, executeTemplateFill } from '../services/xlsxTemplateFillService.js';
import { createSkuPack, resumeSkuPack, previewSkuPackResume, previewSkuManifestRepair, repairSkuManifest } from '../services/skuPackService.js';
import { readSkuPackSnapshot } from '../services/skuPackStateService.js';
import { readWorkbenchSnapshot } from '../services/workbenchSnapshotService.js';
import { parseCollectionSpreadsheet, parseSkuMetadataSpreadsheet } from '../services/collectionSpreadsheetService.js';
import { createCollectionJob, getCollectionJob, importBrowserImage, runCollectionJob, previewCollectionManifestRepair, repairCollectionManifest } from '../services/collectionJobService.js';
import { getCollectionDraftContext, stageCollectionDraft, submitCollectionDraft, clearCollectionDraft } from '../services/collectionDraftService.js';
import { previewCollectionPack, createCollectionPack } from '../services/collectionPackService.js';

const router = express.Router();
const stagingDir = path.join(paths.uploadDir, 'workbench-staging');
const storage = multer.diskStorage({
  destination: (_req, _file, callback) => {
    fs.mkdir(stagingDir, { recursive: true }).then(() => callback(null, stagingDir)).catch(callback);
  },
  filename: (_req, file, callback) => callback(null, `${Date.now()}-${nanoid(8)}${path.extname(file.originalname)}`)
});
const imageUpload = multer({
  storage,
  limits: { files: 100, fileSize: 15 * 1024 * 1024 },
  fileFilter: (_req, file, callback) => {
    if (!/^image\/(jpeg|png|webp)$/i.test(file.mimetype)) {
      const error = new Error(`仅支持 JPG、PNG、WebP：${file.originalname}`);
      error.statusCode = 400;
      callback(error);
      return;
    }
    callback(null, true);
  }
});
const templateUpload = multer({
  storage,
  limits: { files: 1, fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, callback) => {
    if (path.extname(file.originalname).toLowerCase() !== '.xlsx') {
      const error = new Error('目前只支持无宏的 .xlsx 模板');
      error.statusCode = 400;
      callback(error);
      return;
    }
    callback(null, true);
  }
});
const skuPackUpload = multer({
  storage,
  limits: { files: 300, fileSize: 15 * 1024 * 1024 },
  fileFilter: (_req, file, callback) => {
    if (!/^image\/(jpeg|png|webp)$/i.test(file.mimetype)) {
      const error = new Error(`SKU 图包仅支持 JPG、PNG、WebP：${file.originalname}`);
      error.statusCode = 400;
      callback(error);
      return;
    }
    callback(null, true);
  }
});
const browserImageUpload = multer({
  storage,
  limits: { files: 1, fileSize: 25 * 1024 * 1024 },
  fileFilter: (_req, file, callback) => {
    if (!/^image\/(jpeg|png|webp|avif|gif|tiff)$/i.test(file.mimetype)) {
      const error = new Error('浏览器回传仅支持安全的栅格图片');
      error.statusCode = 400;
      callback(error);
      return;
    }
    callback(null, true);
  }
});
const collectionSheetUpload = multer({
  storage,
  limits: { files: 1, fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, callback) => {
    if (!['.csv', '.tsv', '.txt', '.xlsx'].includes(path.extname(file.originalname).toLowerCase())) {
      const error = new Error('采集表格仅支持 CSV、TSV、TXT 或 XLSX');
      error.statusCode = 400;
      callback(error);
      return;
    }
    callback(null, true);
  }
});

function parseJsonField(value, fallback, label) {
  if (value === undefined || value === null || value === '') return fallback;
  try {
    return JSON.parse(value);
  } catch {
    const error = new Error(`${label} JSON 格式无效`);
    error.statusCode = 400;
    throw error;
  }
}

router.get('/overview', (_req, res) => res.json(getWorkbenchOverview()));

router.get('/jobs', asyncHandler(async (req, res) => {
  res.json(await recentWorkbenchJobs(req.query.limit));
}));
router.get('/jobs/:id', asyncHandler(async (req, res) => res.set('Cache-Control', 'no-store').json(await workbenchJobDetail(req.params.id, req.query))));
router.get('/jobs/:id/manifest', asyncHandler(async (req, res) => {
  const snapshot = req.params.id.startsWith('sku-pack-') ? await readSkuPackSnapshot(req.params.id) : await readWorkbenchSnapshot(req.params.id);
  res.set('Cache-Control', 'no-store').attachment(`${req.params.id}-manifest.json`).type('application/json').send(snapshot.bytes);
}));
router.post('/sku-packs/:id/resume', asyncHandler(async (req, res) => res.json(await resumeSkuPack(req.params.id, req.body || {}))));
router.get('/sku-packs/:id/resume-preview', asyncHandler(async (req, res) => res.json(await previewSkuPackResume(req.params.id, { retryFailed: req.query.retryFailed === 'true' }))));
router.get('/sku-packs/:id/manifest', asyncHandler(async (req, res) => {
  const snapshot = await readSkuPackSnapshot(req.params.id);
  res.set('Cache-Control', 'no-store').attachment(`${req.params.id}-manifest.json`).type('application/json').send(snapshot.bytes);
}));
router.get('/sku-packs/:id/manifest-repair-preview', asyncHandler(async (req, res) => res.set('Cache-Control', 'no-store').json(await previewSkuManifestRepair(req.params.id))));
router.post('/sku-packs/:id/repair-manifest', asyncHandler(async (req, res) => res.json(await repairSkuManifest(req.params.id, req.body || {}))));

router.get('/materials', asyncHandler(async (req, res) => {
  res.json(await listMaterialRecords(req.query || {}));
}));

router.get('/materials/export.csv', asyncHandler(async (req, res) => {
  const csv = await exportMaterialRecordsCsv(req.query || {});
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="workbench-materials.csv"');
  res.send(csv);
}));

router.post('/materials/import', asyncHandler(async (req, res) => {
  const result = await importMaterialRecords(req.body?.records);
  res.status(201).json(result);
}));

router.patch('/materials/:recordId', asyncHandler(async (req, res) => {
  res.json(await updateMaterialRecord(req.params.recordId, req.body || {}));
}));
router.delete('/materials/:recordId', asyncHandler(async (req, res) => res.json(await archiveMaterialRecord(req.params.recordId, { confirm: req.body?.confirm === true }))));
router.post('/materials/:recordId/restore', asyncHandler(async (req, res) => res.json(await archiveMaterialRecord(req.params.recordId, { confirm: req.body?.confirm === true, restore: true }))));

router.post('/template-inspections', templateUpload.single('template'), asyncHandler(async (req, res) => {
  if (!req.file) {
    const error = new Error('请选择 XLSX 模板');
    error.statusCode = 400;
    throw error;
  }
  try {
    res.json(await inspectXlsxTemplate(req.file.path, {
      originalName: req.file.originalname,
      platformId: String(req.body?.platformId || 'temu').toLowerCase()
    }));
  } finally {
    await fs.rm(req.file.path, { force: true }).catch(() => {});
  }
}));

router.post('/collection-plans', asyncHandler(async (req, res) => {
  const result = await createCollectionPlan(req.body || {});
  res.status(201).json(result);
}));

router.post('/template-fills/preview', templateUpload.single('template'), asyncHandler(async (req, res) => {
  if (!req.file) throw Object.assign(new Error('请选择 XLSX 模板'), { statusCode: 400 });
  try {
    const options = parseJsonField(req.body?.options, {}, 'options');
    res.json(await previewTemplateFill(req.file.path, { ...options, originalName: req.file.originalname }));
  } finally { await fs.rm(req.file.path, { force: true }).catch(() => {}); }
}));

router.post('/template-fills/:fillId/execute', asyncHandler(async (req, res) => {
  res.json(await executeTemplateFill(req.params.fillId, req.body || {}));
}));

function spreadsheetSource(imported) {
  return { type: 'spreadsheet', fileName: imported.fileName, fileBytes: imported.fileBytes,
    headerRow: imported.headerRow, columns: imported.columns, safeMode: imported.safeMode };
}

router.get('/collection-drafts', asyncHandler(async (_req, res) => {
  res.set('Cache-Control', 'no-store').json(getCollectionDraftContext());
}));
router.post('/collection-drafts/rows', asyncHandler(async (req, res) => {
  const result = stageCollectionDraft({ rows: req.body?.rows, options: req.body?.options || {}, source: { type: 'web-manual' } }, req.body || {});
  res.status(result.reused ? 200 : 201).json(result);
}));
router.post('/collection-drafts/sheet', collectionSheetUpload.single('sheet'), asyncHandler(async (req, res) => {
  try {
    if (!req.file) throw Object.assign(new Error('请选择包含商品链接或图片链接的表格'), { statusCode: 400 });
    const imported = await parseCollectionSpreadsheet(req.file.path, req.file.originalname);
    const result = stageCollectionDraft({ rows: imported.records, options: parseJsonField(req.body?.options, {}, 'options'), source: spreadsheetSource(imported) }, req.body || {});
    res.status(result.reused ? 200 : 201).json(result);
  } finally { if (req.file) await fs.rm(req.file.path, { force: true }).catch(() => {}); }
}));
router.post('/collection-drafts/:draftId/submit', asyncHandler(async (req, res) => {
  const result = await submitCollectionDraft(req.params.draftId, req.body?.expectedActorId);
  res.status(result.creation?.replayed ? 200 : 201).json(result);
}));
router.post('/collection-drafts/:draftId/ack', asyncHandler(async (req, res) => {
  res.json(clearCollectionDraft(req.params.draftId, { expectedActorId: req.body?.expectedActorId, jobId: req.body?.jobId }));
}));
router.post('/collection-drafts/:draftId/discard', asyncHandler(async (req, res) => {
  res.json(clearCollectionDraft(req.params.draftId, { expectedActorId: req.body?.expectedActorId, confirm: req.body?.confirm, discard: true }));
}));

router.post('/collection-jobs', collectionSheetUpload.single('sheet'), asyncHandler(async (req, res) => {
  if (!req.file) {
    const error = new Error('请选择包含商品链接或图片链接的表格');
    error.statusCode = 400;
    throw error;
  }
  try {
    const imported = await parseCollectionSpreadsheet(req.file.path, req.file.originalname);
    const options = parseJsonField(req.body?.options, {}, 'options');
    const result = await createCollectionJob({
      rows: imported.records,
      options,
      clientRequestId: req.body?.clientRequestId, creationEpoch: req.body?.creationEpoch,
      source: spreadsheetSource(imported)
    });
    if (result.creation) res.set('X-Workbench-Creation', result.creation.replayed ? 'replayed' : 'created');
    res.status(result.creation?.replayed ? 200 : 201).json(result);
  } finally {
    await fs.rm(req.file.path, { force: true }).catch(() => {});
  }
}));

router.post('/sku-metadata-imports', collectionSheetUpload.single('sheet'), asyncHandler(async (req, res) => {
  if (!req.file) {
    const error = new Error('请选择包含 SKU 字段的 CSV 或 XLSX 表格');
    error.statusCode = 400;
    throw error;
  }
  try {
    res.json(await parseSkuMetadataSpreadsheet(req.file.path, req.file.originalname));
  } finally {
    await fs.rm(req.file.path, { force: true }).catch(() => {});
  }
}));

router.post('/collection-jobs/rows', asyncHandler(async (req, res) => {
  const result = await createCollectionJob({ rows: req.body?.rows, options: req.body?.options || {}, clientRequestId: req.body?.clientRequestId, creationEpoch: req.body?.creationEpoch, source: { type: 'browser-or-manual' } });
  if (result.creation) res.set('X-Workbench-Creation', result.creation.replayed ? 'replayed' : 'created');
  res.status(result.creation?.replayed ? 200 : 201).json(result);
}));

router.post('/collection-jobs/:jobId/browser-images', browserImageUpload.single('image'), asyncHandler(async (req, res) => {
  try {
    const result = await importBrowserImage(req.params.jobId, {
      itemId: req.body?.itemId,
      sourceUrl: req.body?.sourceUrl,
      finalUrl: req.body?.finalUrl,
      filePath: req.file?.path
    });
    res.status(result.imported ? 201 : 200).json(result);
  } finally {
    if (req.file?.path) await fs.rm(req.file.path, { force: true }).catch(() => {});
  }
}));

router.get('/collection-jobs/:jobId', asyncHandler(async (req, res) => {
  res.set('Cache-Control', 'no-store').json(await getCollectionJob(req.params.jobId));
}));
router.get('/collection-jobs/:jobId/manifest-repair-preview', asyncHandler(async (req, res) => res.set('Cache-Control', 'no-store').json(await previewCollectionManifestRepair(req.params.jobId))));
router.post('/collection-jobs/:jobId/repair-manifest', asyncHandler(async (req, res) => res.json(await repairCollectionManifest(req.params.jobId, req.body || {}))));

router.get('/collection-jobs/:jobId/sku-pack-preview', asyncHandler(async (req, res) => res.json(await previewCollectionPack(req.params.jobId))));
router.post('/collection-jobs/:jobId/sku-pack', asyncHandler(async (req, res) => res.json(await createCollectionPack(req.params.jobId, req.body || {}))));

router.post('/collection-jobs/:jobId/run', asyncHandler(async (req, res) => {
  res.json(await runCollectionJob(req.params.jobId, req.body || {}));
}));

router.post('/listing-dry-runs', asyncHandler(async (req, res) => {
  const result = await createListingDryRun(req.body || {});
  res.status(201).json(result);
}));

router.post('/pricing-previews', asyncHandler(async (req, res) => {
  const result = await createPricingPreview(req.body || {});
  res.status(201).json(result);
}));

router.post('/sku-packs', skuPackUpload.array('images', 300), asyncHandler(async (req, res) => {
  const files = req.files || [];
  try {
    const totalBytes = files.reduce((sum, file) => sum + (file.size || 0), 0);
    if (totalBytes > 500 * 1024 * 1024) {
      const error = new Error('SKU 图包单次上传总大小不能超过 500MB');
      error.statusCode = 400;
      throw error;
    }
    const relativePaths = parseJsonField(req.body?.relativePaths, [], 'relativePaths');
    const options = parseJsonField(req.body?.options, {}, 'options');
    if (!Array.isArray(relativePaths) || relativePaths.length !== files.length) {
      const error = new Error('文件相对路径数量与上传图片数量不一致');
      error.statusCode = 400;
      throw error;
    }
    res.status(201).json(await createSkuPack(files, relativePaths, options));
  } finally {
    await Promise.all(files.map((file) => fs.rm(file.path, { force: true }).catch(() => {})));
  }
}));

router.post('/image-packs', imageUpload.array('images', 100), asyncHandler(async (req, res) => {
  const files = req.files || [];
  try {
    const totalBytes = files.reduce((sum, file) => sum + (file.size || 0), 0);
    if (totalBytes > 300 * 1024 * 1024) {
      const error = new Error('单次上传总大小不能超过 300MB');
      error.statusCode = 400;
      throw error;
    }
    const result = await createImagePack(files, req.body || {});
    res.status(201).json(result);
  } finally {
    await Promise.all(files.map((file) => fs.rm(file.path, { force: true }).catch(() => {})));
  }
}));

export default router;
