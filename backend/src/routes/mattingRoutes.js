import express from 'express';
import { asyncHandler } from '../utils/asyncHandler.js';
import {
  compareMatting,
  adoptMatting,
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
    adoptMatting,
    ...service
  };
  function requireRemoteApproval(input, compare = false) {
    const config = mattingService.getMattingConfig();
    const remote = compare ? config.externalConfigured || config.image2Available : (input?.provider === 'image2' && config.image2Available) || (['external', 'auto'].includes(input?.provider) && config.externalConfigured);
    if (remote && (input?.confirmExternal !== true || input?.confirmDataTransfer !== true)) throw Object.assign(new Error('调用将上传所选原图到外部 Provider 并可能产生费用。请逐任务确认费用与数据传输后再执行。'), { statusCode: 400 });
  }

  router.get('/config', asyncHandler(async (_req, res) => {
    res.json(stripSecrets(mattingService.getMattingConfig()));
  }));
  router.post('/adopt', asyncHandler(async (req, res) => res.json(await mattingService.adoptMatting(req.body || {}))));

  router.post('/run', asyncHandler(async (req, res) => {
    requireRemoteApproval(req.body);
    const result = await mattingService.runMatting({
      taskId: req.body?.taskId,
      imageId: req.body?.imageId,
      provider: req.body?.provider || 'sharp'
    });
    res.json(stripSecrets(result));
  }));

  router.post('/compare', asyncHandler(async (req, res) => {
    requireRemoteApproval(req.body, true);
    const result = await mattingService.compareMatting({
      taskId: req.body?.taskId,
      imageId: req.body?.imageId
    });
    res.json(stripSecrets(result));
  }));

  return router;
}

export default createMattingRouter();
