import express from 'express';
import {
  buildFinalAcceptanceReport,
  buildFinalAcceptanceTemplate,
  exportFinalAcceptanceReport
} from '../services/finalAcceptanceService.js';
import {
  exportRealApiAcceptanceReport,
  getRealApiAcceptanceReport,
  runSingleSkuRealApiAcceptance
} from '../services/realApiAcceptanceService.js';

const router = express.Router();

function acceptanceOptions(req) {
  const targetSkuCount = Number(req.query?.targetSkuCount);
  return {
    version: req.query?.version,
    targetSkuCount: Number.isFinite(targetSkuCount) ? targetSkuCount : undefined,
    multiBatch: req.query?.multiBatch === 'true'
  };
}

router.get('/template', (req, res) => {
  res.json(buildFinalAcceptanceTemplate(acceptanceOptions(req)));
});

router.get('/report', async (req, res, next) => {
  try {
    res.json(await buildFinalAcceptanceReport(acceptanceOptions(req)));
  } catch (err) {
    next(err);
  }
});

router.post('/export', (req, res) => {
  res.json(exportFinalAcceptanceReport(req.body?.report || {}, {
    format: req.body?.format || 'json',
    timestamp: req.body?.timestamp
  }));
});

router.post('/real-api/run', async (req, res, next) => {
  try {
    const report = await runSingleSkuRealApiAcceptance({
      taskId: req.body?.taskId,
      taskIds: req.body?.taskIds,
      batchId: req.body?.batchId,
      batchIds: req.body?.batchIds,
      confirmRealApi: req.body?.confirmRealApi === true,
      confirmPaidApi: req.body?.confirmPaidApi === true,
      confirmNoPlatformUpload: req.body?.confirmNoPlatformUpload === true,
      maxRealApiCalls: req.body?.maxRealApiCalls,
      enableVision: req.body?.enableVision !== false,
      imageTypes: req.body?.imageTypes,
      enableReview: req.body?.enableReview === true,
      provider: req.body?.provider,
      visionProvider: req.body?.visionProvider,
      reviewProvider: req.body?.reviewProvider,
      mattingProvider: req.body?.mattingProvider
    });
    res.json({ report });
  } catch (err) {
    next(err);
  }
});

router.get('/real-api/:taskId/report', (req, res) => {
  res.json({ report: getRealApiAcceptanceReport(req.params.taskId) });
});

router.post('/real-api/export', (req, res) => {
  res.json(exportRealApiAcceptanceReport(req.body?.report || {}, {
    timestamp: req.body?.timestamp
  }));
});

export default router;
