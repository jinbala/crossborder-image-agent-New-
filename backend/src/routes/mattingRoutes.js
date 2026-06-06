import express from 'express';
import { asyncHandler } from '../utils/asyncHandler.js';
import {
  compareMatting,
  getMattingConfig,
  runMatting
} from '../services/mattingService.js';

function stripSecrets(value) {
  if (Array.isArray(value)) return value.map(stripSecrets);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value)
      .filter(([key]) => !/apiKey|api_key|secret|token|password/i.test(key))
      .map(([key, item]) => [key, stripSecrets(item)]));
  }
  return value;
}

export function createMattingRouter(service = {}) {
  const router = express.Router();
  const mattingService = {
    getMattingConfig,
    runMatting,
    compareMatting,
    ...service
  };

  router.get('/config', asyncHandler(async (_req, res) => {
    res.json(stripSecrets(mattingService.getMattingConfig()));
  }));

  router.post('/run', asyncHandler(async (req, res) => {
    const result = await mattingService.runMatting({
      taskId: req.body?.taskId,
      imageId: req.body?.imageId,
      provider: req.body?.provider || 'sharp'
    });
    res.json(stripSecrets(result));
  }));

  router.post('/compare', asyncHandler(async (req, res) => {
    const result = await mattingService.compareMatting({
      taskId: req.body?.taskId,
      imageId: req.body?.imageId
    });
    res.json(stripSecrets(result));
  }));

  return router;
}

export default createMattingRouter();
