import express from 'express';
import { asyncHandler } from '../utils/asyncHandler.js';
import {
  getStorageStatus,
  migrateToSqliteTrial,
  preflightSqlite,
  rebuildSqliteTrialIndexes,
  verifySqliteTrial
} from '../services/storageTrialService.js';
import {
  getSqliteTrialChecklist,
  runSqliteTrialChecklist
} from '../services/sqliteTrialChecklistService.js';

const router = express.Router();

router.get('/status', asyncHandler(async (_req, res) => {
  res.json(await getStorageStatus());
}));

router.post('/preflight-sqlite', asyncHandler(async (_req, res) => {
  res.json({ report: await preflightSqlite() });
}));

router.post('/migrate-to-sqlite', asyncHandler(async (req, res) => {
  try {
    const report = await migrateToSqliteTrial(req.body || {});
    res.json({ report });
  } catch (err) {
    if (err.code === 'SQLITE_ALREADY_EXISTS') {
      res.status(409).json({ error: { code: err.code, message: err.message } });
      return;
    }
    throw err;
  }
}));

router.post('/verify-sqlite', asyncHandler(async (_req, res) => {
  const report = await verifySqliteTrial();
  res.json({ report, sqliteTrial: report.sqliteTrial });
}));

router.post('/rebuild-sqlite-indexes', asyncHandler(async (_req, res) => {
  res.json({ report: await rebuildSqliteTrialIndexes() });
}));

router.get('/trial-checklist', asyncHandler(async (_req, res) => {
  res.json(getSqliteTrialChecklist());
}));

router.post('/run-trial-check', asyncHandler(async (_req, res) => {
  res.json({ report: await runSqliteTrialChecklist() });
}));

export default router;
