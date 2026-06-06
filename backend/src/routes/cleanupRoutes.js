import express from 'express';
import { asyncHandler } from '../utils/asyncHandler.js';
import {
  getCleanupSummary,
  previewCleanup,
  runCleanup
} from '../services/cleanupService.js';

export function createCleanupRouter(serviceOptions = {}) {
  const router = express.Router();

  router.get('/summary', asyncHandler(async (_req, res) => {
    res.json(await getCleanupSummary(serviceOptions));
  }));

  router.post('/preview', asyncHandler(async (req, res) => {
    res.json(await previewCleanup(req.body || {}, serviceOptions));
  }));

  router.post('/run', asyncHandler(async (req, res) => {
    res.json(await runCleanup(req.body || {}, serviceOptions));
  }));

  return router;
}

export default createCleanupRouter();
