import express from 'express';
import { asyncHandler } from '../utils/asyncHandler.js';
import {
  getImportScanStatus,
  importScannedFolders,
  scanImportRoot
} from '../services/importScanService.js';
import { getUserSettings } from '../services/userSettingsService.js';

const router = express.Router();

router.get('/status', asyncHandler(async (_req, res) => {
  res.json(getImportScanStatus());
}));

router.post('/scan', asyncHandler(async (req, res) => {
  const result = await scanImportRoot({ rootDir: req.body?.rootDir });
  res.json(result);
}));

router.post('/import', asyncHandler(async (req, res) => {
  const settings = await getUserSettings();
  const defaultTargets = Array.isArray(req.body?.defaultTargets) && req.body.defaultTargets.length
    ? req.body.defaultTargets
    : settings.defaults?.platforms || [];
  const result = await importScannedFolders({
    folderPaths: Array.isArray(req.body?.folderPaths) ? req.body.folderPaths : [],
    batchName: req.body?.batchName,
    defaultTargets,
    templateId: req.body?.templateId || settings.defaults?.workflowTemplateId || null
  });
  res.status(result.batchTask ? 201 : 200).json(result);
}));

export default router;
