import express from 'express';
import { asyncHandler } from '../utils/asyncHandler.js';
import { generateGeneralSop, renderSopMarkdown, sopFileName } from '../services/sopService.js';

const router = express.Router();

router.get('/general', asyncHandler(async (req, res) => {
  const sop = generateGeneralSop();
  const markdown = renderSopMarkdown(sop);
  if (req.query.format === 'json') {
    res.json({ sop, markdown });
    return;
  }
  res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${sopFileName(sop)}"`);
  res.send(markdown);
}));

export default router;
