import express from 'express';
import { asyncHandler } from '../utils/asyncHandler.js';
import {
  getStressTestConfig,
  getStressTestReport,
  runStressTest
} from '../services/stressTestService.js';

export function createStressTestRouter(serviceOptions = {}) {
  const router = express.Router();

  router.get('/config', asyncHandler(async (_req, res) => {
    res.json(getStressTestConfig());
  }));

  router.post('/run', asyncHandler(async (req, res) => {
    const report = await runStressTest(req.body || {}, serviceOptions);
    res.status(201).json(report);
  }));

  router.get('/:stressTestId', asyncHandler(async (req, res) => {
    res.json(await getStressTestReport(req.params.stressTestId, serviceOptions));
  }));

  router.get('/:stressTestId/report', asyncHandler(async (req, res) => {
    const report = await getStressTestReport(req.params.stressTestId, serviceOptions);
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${req.params.stressTestId}-report.json"`);
    res.send(JSON.stringify(report, null, 2));
  }));

  return router;
}

export default createStressTestRouter();
