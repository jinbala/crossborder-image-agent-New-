import express from 'express';
import { asyncHandler } from '../utils/asyncHandler.js';
import { getDesktopRuntime, pauseAllQueues } from '../services/desktopRuntimeService.js';
import { extensionPairing } from '../services/extensionPairingService.js';

const router = express.Router();
router.get('/runtime', asyncHandler(async (req, res) => res.json(await getDesktopRuntime(req.query))));
router.post('/pause-all', asyncHandler(async (_req, res) => res.json(await pauseAllQueues())));
router.post('/pairing-code', (_req, res) => res.json(extensionPairing.issueCode()));
router.post('/pair', asyncHandler(async (req, res) => res.json(extensionPairing.redeem(req.body?.code, req.headers.origin))));
export default router;
