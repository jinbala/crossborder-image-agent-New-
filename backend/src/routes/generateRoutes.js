import express from 'express';
import { asyncHandler } from '../utils/asyncHandler.js';
import {
  getThreeSampleGenerationReport,
  getSingleImageGenerationReport,
  runThreeSampleGeneration,
  runSingleImageGeneration
} from '../services/singleImageGenerationService.js';

export function createGenerateRouter(service = {}) {
  const router = express.Router();
  const generateService = {
    runSingleImageGeneration,
    getSingleImageGenerationReport,
    runThreeSampleGeneration,
    getThreeSampleGenerationReport,
    ...service
  };

  router.post('/single-image', asyncHandler(async (req, res) => {
    const report = await generateService.runSingleImageGeneration({
      taskId: req.body?.taskId,
      taskIds: req.body?.taskIds,
      batchId: req.body?.batchId,
      batchIds: req.body?.batchIds,
      planId: req.body?.planId,
      sourceImageId: req.body?.sourceImageId,
      imageType: req.body?.imageType,
      provider: req.body?.provider,
      realMode: req.body?.realMode,
      mattingProvider: req.body?.mattingProvider,
      confirmReal: req.body?.confirmReal === true
    });
    res.json({ report });
  }));

  router.post('/three-sample', asyncHandler(async (req, res) => {
    const result = await generateService.runThreeSampleGeneration({
      taskId: req.body?.taskId,
      taskIds: req.body?.taskIds,
      batchId: req.body?.batchId,
      batchIds: req.body?.batchIds,
      samples: req.body?.samples,
      mattingProvider: req.body?.mattingProvider,
      generationProvider: req.body?.generationProvider || req.body?.provider,
      provider: req.body?.provider,
      realMode: req.body?.realMode,
      confirmPaidApi: req.body?.confirmPaidApi === true
    });
    res.json(result);
  }));

  router.get('/:taskId/report', asyncHandler(async (req, res) => {
    const report = await generateService.getSingleImageGenerationReport(req.params.taskId);
    res.json({ report });
  }));

  router.get('/:taskId/three-sample-report', asyncHandler(async (req, res) => {
    const report = await generateService.getThreeSampleGenerationReport(req.params.taskId);
    res.json({ report });
  }));

  return router;
}

export default createGenerateRouter();
