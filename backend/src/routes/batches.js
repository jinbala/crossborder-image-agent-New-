import express from 'express';
import path from 'node:path';
import { asyncHandler } from '../utils/asyncHandler.js';
import {
  applyTargetsToBatch,
  createBatchExportZip,
  getBatch,
  generateBatch,
  importBatchFolder,
  listBatches,
  planBatch,
  recognizeBatch,
  reviewBatch
} from '../services/batchTaskService.js';
import {
  cancelBatchQueue,
  getBatchQueueLogs,
  pauseBatchQueue,
  resumeBatchQueue,
  retryFailedJobs,
  runBatchQueue
} from '../services/batchQueueService.js';
import {
  getAllBatchAnalyticsSummary,
  getBatchAnalytics,
  refreshBatchAnalytics
} from '../services/batchAnalyticsService.js';
import { applyTemplateToBatch } from '../services/workflowTemplateService.js';
import { generateBatchSopWithAnalytics, renderSopMarkdown, sopFileName } from '../services/sopService.js';
import { getUserSettings } from '../services/userSettingsService.js';
import { getTask } from '../services/db.js';
import { buildBatchReviewReport } from '../services/batchReviewReportService.js';
import { analyzeBatchStability } from '../services/batchStabilityService.js';
import { executeSkuRetry, planSkuRetry } from '../services/skuRetryService.js';
import { buildBatchResumePlan } from '../services/batchResumePlanService.js';
import { cancelBatch, deleteBatch, resetBatchImportState } from '../services/batchControlService.js';
import {
  buildExportPackagePreview,
  createStructuredExportPackage
} from '../services/exportPackageService.js';
import {
  buildListingCsvPreview,
  createListingCsvExport
} from '../services/listingExportService.js';
import { buildUploadReadinessReport } from '../services/uploadReadinessService.js';
import { buildUploadPayloadPreview } from '../services/uploadPayloadService.js';
import { simulateSandboxSubmit } from '../services/uploadSandboxService.js';

const router = express.Router();

async function requireBatch(batchId) {
  const batchTask = await getBatch(batchId);
  if (!batchTask) {
    const error = new Error('Batch task not found');
    error.statusCode = 404;
    throw error;
  }
  return batchTask;
}

function requireConfirmed(body = {}) {
  if (body?.confirm !== true) {
    const error = new Error('confirm=true is required for this batch control operation');
    error.statusCode = 400;
    throw error;
  }
}

router.get('/', asyncHandler(async (_req, res) => {
  const batchTasks = await listBatches();
  res.json({ batchTasks });
}));

router.post('/import-folder', asyncHandler(async (req, res) => {
  const { folderPath, name, defaultTargets } = req.body || {};
  const settings = await getUserSettings();
  const targetsFromSettings = settings.defaults?.platforms || [];
  const targets = Array.isArray(defaultTargets) && defaultTargets.length ? defaultTargets : targetsFromSettings;
  const templateId = req.body?.templateId || settings.defaults?.workflowTemplateId;
  let result = await importBatchFolder({
    folderPath: folderPath ? path.resolve(folderPath) : '',
    name,
    defaultTargets: targets
  });
  if (templateId && result.batchTask?.id) {
    const templateResult = await applyTemplateToBatch({ batchId: result.batchTask.id, templateId });
    result = {
      ...result,
      batchTask: templateResult.batchTask,
      templateSnapshot: templateResult.templateSnapshot,
      templateWarnings: templateResult.warnings
    };
  }
  res.status(201).json(result);
}));

router.get('/analytics/summary', asyncHandler(async (_req, res) => {
  res.json(await getAllBatchAnalyticsSummary());
}));

router.post('/:batchId/cancel', asyncHandler(async (req, res) => {
  requireConfirmed(req.body);
  const result = await cancelBatch(req.params.batchId);
  res.json({ result, batchTask: result.batchTask });
}));

router.delete('/:batchId', asyncHandler(async (req, res) => {
  requireConfirmed(req.body);
  const result = await deleteBatch(req.params.batchId);
  res.json({ result });
}));

router.post('/:batchId/reset-import', asyncHandler(async (req, res) => {
  requireConfirmed(req.body);
  const result = await resetBatchImportState(req.params.batchId);
  res.json({ result, batchTask: result.batchTask });
}));

router.get('/:batchId/analytics', asyncHandler(async (req, res) => {
  res.json({ batchId: req.params.batchId, analytics: await getBatchAnalytics(req.params.batchId) });
}));

router.post('/:batchId/analytics/refresh', asyncHandler(async (req, res) => {
  res.json({ batchId: req.params.batchId, analytics: await refreshBatchAnalytics(req.params.batchId) });
}));

router.get('/:batchId/analytics/export', asyncHandler(async (req, res) => {
  const analytics = await getBatchAnalytics(req.params.batchId);
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Disposition', `attachment; filename="${req.params.batchId}-analytics.json"`);
  res.send(JSON.stringify({ batchId: req.params.batchId, analytics }, null, 2));
}));

router.get('/:batchId/review-report', asyncHandler(async (req, res) => {
  const batchTask = await requireBatch(req.params.batchId);
  const tasks = [];
  for (const sku of batchTask.skuTasks || []) {
    if (!sku.taskId) continue;
    const task = await getTask(sku.taskId);
    if (task) tasks.push(task);
  }
  res.json({
    batchId: req.params.batchId,
    reviewReport: buildBatchReviewReport(batchTask, tasks)
  });
}));

router.get('/:batchId/stability', asyncHandler(async (req, res) => {
  res.json({
    batchId: req.params.batchId,
    batchStabilityReport: await analyzeBatchStability(req.params.batchId)
  });
}));

router.get('/:batchId/resume-plan', asyncHandler(async (req, res) => {
  res.json({
    batchId: req.params.batchId,
    batchResumePlan: await buildBatchResumePlan(req.params.batchId)
  });
}));

function exportPackageOptionsFromQuery(query = {}) {
  return {
    platforms: query.platforms,
    includeReports: query.includeReports !== 'false',
    includeMockImages: query.includeMockImages !== 'false',
    includeRealSamples: query.includeRealSamples === 'true',
    format: 'zip'
  };
}

router.get('/:batchId/export-package/preview', asyncHandler(async (req, res) => {
  res.json({
    batchId: req.params.batchId,
    preview: await buildExportPackagePreview(req.params.batchId, exportPackageOptionsFromQuery(req.query))
  });
}));

router.post('/:batchId/export-package', asyncHandler(async (req, res) => {
  const result = await createStructuredExportPackage(req.params.batchId, {
    platforms: req.body?.platforms,
    includeReports: req.body?.includeReports !== false,
    includeMockImages: req.body?.includeMockImages !== false,
    includeRealSamples: req.body?.includeRealSamples === true,
    format: 'zip',
    confirmExport: req.body?.confirmExport === true
  });
  res.status(201).json(result);
}));

router.get('/:batchId/listing-csv/preview', asyncHandler(async (req, res) => {
  res.json({
    batchId: req.params.batchId,
    preview: await buildListingCsvPreview(req.params.batchId, {
      platforms: req.query.platforms,
      includeMockImages: req.query.includeMockImages !== 'false',
      sourcePackageId: req.query.sourcePackageId || ''
    })
  });
}));

router.post('/:batchId/listing-csv', asyncHandler(async (req, res) => {
  const result = await createListingCsvExport(req.params.batchId, {
    platforms: req.body?.platforms,
    includeMockImages: req.body?.includeMockImages !== false,
    sourcePackageId: req.body?.sourcePackageId || '',
    confirmExport: req.body?.confirmExport === true
  });
  res.status(201).json(result);
}));

router.get('/:batchId/upload-readiness/preview', asyncHandler(async (req, res) => {
  res.json({
    batchId: req.params.batchId,
    uploadReadinessReport: await buildUploadReadinessReport(req.params.batchId, {
      platforms: req.query.platforms,
      packageId: req.query.packageId || ''
    })
  });
}));

router.post('/:batchId/upload-readiness/preview', asyncHandler(async (req, res) => {
  if (req.body?.confirmDryRun !== true) {
    const error = new Error('confirmDryRun=true is required for sandbox dry-run preview');
    error.statusCode = 400;
    throw error;
  }
  res.json({
    batchId: req.params.batchId,
    uploadReadinessReport: await buildUploadReadinessReport(req.params.batchId, {
      platforms: req.body?.platforms,
      packageId: req.body?.packageId || '',
      listingCsvId: req.body?.listingCsvId || '',
      sandboxConfig: req.body?.platformAccounts || req.body?.sandboxConfig || {}
    })
  });
}));

router.post('/:batchId/upload-payload/preview', asyncHandler(async (req, res) => {
  res.json({
    batchId: req.params.batchId,
    uploadPayloadPreview: await buildUploadPayloadPreview(req.params.batchId, {
      platforms: req.body?.platforms,
      packageId: req.body?.packageId || '',
      confirmDryRun: req.body?.confirmDryRun === true
    })
  });
}));

router.post('/:batchId/upload-sandbox/simulate', asyncHandler(async (req, res) => {
  res.json({
    batchId: req.params.batchId,
    uploadSandboxReport: await simulateSandboxSubmit(req.params.batchId, {
      platforms: req.body?.platforms,
      packageId: req.body?.packageId || '',
      confirmSandboxSubmit: req.body?.confirmSandboxSubmit === true
    })
  });
}));

router.get('/:batchId/tasks/:taskId/retry-plan', asyncHandler(async (req, res) => {
  res.json({
    batchId: req.params.batchId,
    taskId: req.params.taskId,
    retryPlan: await planSkuRetry(req.params.batchId, req.params.taskId)
  });
}));

router.post('/:batchId/tasks/:taskId/retry', asyncHandler(async (req, res) => {
  res.json({
    batchId: req.params.batchId,
    taskId: req.params.taskId,
    retryResult: await executeSkuRetry(req.params.batchId, req.params.taskId, {
      retryStep: req.body?.retryStep,
      confirmRetry: req.body?.confirmRetry === true,
      mode: req.body?.mode || 'mockOnly',
      confirmPaidApi: req.body?.confirmPaidApi === true
    })
  });
}));

router.get('/:batchId/sop', asyncHandler(async (req, res) => {
  const batchTask = await requireBatch(req.params.batchId);
  const sop = await generateBatchSopWithAnalytics(batchTask);
  res.json({ sop, markdown: renderSopMarkdown(sop) });
}));

router.get('/:batchId/sop/download', asyncHandler(async (req, res) => {
  const batchTask = await requireBatch(req.params.batchId);
  const sop = await generateBatchSopWithAnalytics(batchTask);
  res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${sopFileName(sop)}"`);
  res.send(renderSopMarkdown(sop));
}));

router.get('/:batchId', asyncHandler(async (req, res) => {
  const batchTask = await requireBatch(req.params.batchId);
  res.json({ batchTask });
}));

router.post('/:batchId/recognize', asyncHandler(async (req, res) => {
  const result = await recognizeBatch(req.params.batchId);
  res.json(result);
}));

router.post('/:batchId/apply-targets', asyncHandler(async (req, res) => {
  const result = await applyTargetsToBatch(req.params.batchId, Array.isArray(req.body?.defaultTargets) ? req.body.defaultTargets : []);
  res.json(result);
}));

router.post('/:batchId/apply-template', asyncHandler(async (req, res) => {
  const result = await applyTemplateToBatch({
    batchId: req.params.batchId,
    templateId: req.body?.templateId
  });
  res.json(result);
}));

router.post('/:batchId/plan', asyncHandler(async (req, res) => {
  const result = await planBatch(req.params.batchId);
  res.json(result);
}));

router.post('/:batchId/generate', asyncHandler(async (req, res) => {
  const result = await generateBatch(req.params.batchId, { mode: req.body?.mode || 'mock' });
  res.json(result);
}));

router.post('/:batchId/review', asyncHandler(async (req, res) => {
  const result = await reviewBatch(req.params.batchId, { mode: req.body?.mode || 'mock' });
  res.json(result);
}));

router.post('/:batchId/queue/start', asyncHandler(async (req, res) => {
  const batchTask = await runBatchQueue({
    batchId: req.params.batchId,
    action: req.body?.action,
    concurrency: req.body?.concurrency,
    mode: req.body?.mode || 'mock',
    waitForCompletion: false
  });
  res.status(202).json({ batchTask });
}));

router.post('/:batchId/queue/pause', asyncHandler(async (req, res) => {
  const batchTask = await pauseBatchQueue(req.params.batchId);
  res.json({ batchTask });
}));

router.post('/:batchId/queue/resume', asyncHandler(async (req, res) => {
  const batchTask = await resumeBatchQueue(req.params.batchId);
  res.json({ batchTask });
}));

router.post('/:batchId/queue/cancel', asyncHandler(async (req, res) => {
  const batchTask = await cancelBatchQueue(req.params.batchId);
  res.json({ batchTask });
}));

router.post('/:batchId/queue/retry-failed', asyncHandler(async (req, res) => {
  const batchTask = await retryFailedJobs({
    batchId: req.params.batchId,
    action: req.body?.action,
    concurrency: req.body?.concurrency,
    mode: req.body?.mode || 'mock',
    filter: req.body?.filter || 'retryable',
    waitForCompletion: false
  });
  res.status(202).json({ batchTask });
}));

router.get('/:batchId/logs', asyncHandler(async (req, res) => {
  res.json(await getBatchQueueLogs(req.params.batchId));
}));

router.get('/:batchId/export', asyncHandler(async (req, res) => {
  const { exportFile, zipPath } = await createBatchExportZip(req.params.batchId);
  res.download(zipPath, exportFile.fileName);
}));

export default router;
