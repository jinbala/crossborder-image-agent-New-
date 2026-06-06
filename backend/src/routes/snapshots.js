import express from 'express';
import { asyncHandler } from '../utils/asyncHandler.js';
import {
  createSnapshot,
  deleteSnapshot,
  getSnapshot,
  listSnapshots,
  restoreSnapshot
} from '../services/snapshotService.js';

const router = express.Router();

router.get('/', asyncHandler(async (_req, res) => {
  res.json({ snapshots: await listSnapshots() });
}));

router.post('/', asyncHandler(async (req, res) => {
  const snapshot = await createSnapshot(req.body || {});
  res.status(201).json({ snapshot });
}));

router.get('/:snapshotId', asyncHandler(async (req, res) => {
  res.json({ snapshot: await getSnapshot(req.params.snapshotId) });
}));

router.get('/:snapshotId/download', asyncHandler(async (req, res) => {
  const snapshot = await getSnapshot(req.params.snapshotId);
  res.download(snapshot.filePath, snapshot.fileName);
}));

router.delete('/:snapshotId', asyncHandler(async (req, res) => {
  res.json(await deleteSnapshot(req.params.snapshotId, { confirm: req.body?.confirm === true }));
}));

router.post('/:snapshotId/restore', asyncHandler(async (req, res) => {
  res.json({
    report: await restoreSnapshot(req.params.snapshotId, {
      ...(req.body || {}),
      confirm: req.body?.confirm === true
    })
  });
}));

export default router;
