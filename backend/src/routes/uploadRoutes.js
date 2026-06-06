import express from 'express';
import { getUploadCredentialStatus } from '../services/uploadCredentialService.js';
import { buildUploadSafetyReport } from '../services/uploadSafetyCheckService.js';

const router = express.Router();

router.get('/credentials/status', (_req, res) => {
  res.json(getUploadCredentialStatus());
});

router.get('/safety-report', (_req, res) => {
  res.json(buildUploadSafetyReport());
});

export default router;
