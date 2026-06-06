import express from 'express';
import { asyncHandler } from '../utils/asyncHandler.js';
import {
  getScopedHealth,
  renderHealthReportMarkdown,
  runSystemHealthCheck
} from '../services/systemHealthService.js';

const router = express.Router();

router.get('/full', asyncHandler(async (_req, res) => {
  const health = await runSystemHealthCheck();
  res.json({ health, markdown: renderHealthReportMarkdown(health) });
}));

router.get('/providers', asyncHandler(async (_req, res) => {
  const health = await getScopedHealth('providers');
  res.json({ health });
}));

router.get('/storage', asyncHandler(async (_req, res) => {
  const health = await getScopedHealth('storage');
  res.json({ health });
}));

router.get('/database', asyncHandler(async (_req, res) => {
  const health = await getScopedHealth('database');
  res.json({ health });
}));

export default router;
