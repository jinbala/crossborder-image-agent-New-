import express from 'express';
import { asyncHandler } from '../utils/asyncHandler.js';
import {
  getEffectiveSettings,
  getUserSettings,
  resetUserSettings,
  updateUserSettings
} from '../services/userSettingsService.js';
import { getProviderStatus } from '../services/providerStatusService.js';
import { privateSafe } from '../services/platformStore.js';

const router = express.Router();

router.get('/', asyncHandler(async (_req, res) => {
  res.json({ userSettings: await getUserSettings() });
}));

router.put('/', asyncHandler(async (req, res) => {
  res.json({ userSettings: await updateUserSettings(req.body || {}) });
}));

router.post('/reset', asyncHandler(async (_req, res) => {
  res.json({ userSettings: await resetUserSettings() });
}));

router.get('/effective', asyncHandler(async (req, res) => {
  const result = await getEffectiveSettings();
  res.json(req.actor?.role === 'admin' ? result : privateSafe(result));
}));

router.get('/providers/status', asyncHandler(async (_req, res) => {
  res.json(getProviderStatus());
}));

export default router;
