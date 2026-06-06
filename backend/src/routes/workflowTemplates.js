import express from 'express';
import { asyncHandler } from '../utils/asyncHandler.js';
import {
  cloneTemplate,
  createUserTemplate,
  deleteUserTemplate,
  getTemplate,
  listTemplates,
  updateUserTemplate
} from '../services/workflowTemplateService.js';

const router = express.Router();

router.get('/', asyncHandler(async (_req, res) => {
  res.json({ templates: await listTemplates() });
}));

router.get('/:templateId', asyncHandler(async (req, res) => {
  const template = await getTemplate(req.params.templateId);
  if (!template) {
    res.status(404).json({ error: 'Workflow template not found' });
    return;
  }
  res.json({ template });
}));

router.post('/', asyncHandler(async (req, res) => {
  const template = await createUserTemplate(req.body || {});
  res.status(201).json({ template });
}));

router.put('/:templateId', asyncHandler(async (req, res) => {
  const template = await updateUserTemplate(req.params.templateId, req.body || {});
  res.json({ template });
}));

router.delete('/:templateId', asyncHandler(async (req, res) => {
  await deleteUserTemplate(req.params.templateId);
  res.json({ ok: true });
}));

router.post('/:templateId/clone', asyncHandler(async (req, res) => {
  const template = await cloneTemplate(req.params.templateId);
  res.status(201).json({ template });
}));

export default router;
