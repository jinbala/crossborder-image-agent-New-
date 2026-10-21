import { assertResource, restrictedActor } from '../services/ownershipService.js';

// Applies before handlers and upload middleware, including cached-report routes.
export function resourceAccess(req, _res, next) {
  if (!restrictedActor()) return next();
  try {
    const path = req.path;
    const mappings = [
      [/^\/api\/tasks\/([^/]+)(?:\/|$)/, 'image', new Set(['upload', 'platform-rules', 'provider-config'])],
      [/^\/api\/batches\/([^/]+)(?:\/|$)/, 'batch', new Set(['import-folder', 'analytics'])],
      [/^\/api\/generate\/([^/]+)\/(?:report|three-sample-report)$/, 'image'],
      [/^\/api\/final-acceptance\/real-api\/([^/]+)\/report$/, 'image'],
      [/^\/api\/workbench\/(?:jobs|sku-packs|template-fills)\/([^/]+)(?:\/|$)/, 'job', new Set(['preview'])],
      [/^\/api\/workbench\/collection-jobs\/(collect-job-[A-Za-z0-9_-]+)(?:\/|$)/, 'job'],
      [/^\/api\/workbench\/materials\/([^/]+)(?:\/|$)/, 'material', new Set(['import', 'export.csv'])]
    ];
    for (const [pattern, kind, exceptions] of mappings) {
      const match = path.match(pattern);
      if (match && !exceptions?.has(match[1])) assertResource(kind, decodeURIComponent(match[1]));
    }
    if (path.startsWith('/api/')) {
      const body = req.body || {};
      if (body.taskId) assertResource('image', body.taskId);
      if (body.batchId) assertResource('batch', body.batchId);
      for (const id of Array.isArray(body.taskIds) ? body.taskIds : []) assertResource('image', id);
      for (const id of Array.isArray(body.batchIds) ? body.batchIds : []) assertResource('batch', id);
      for (const item of Array.isArray(body.samples) ? body.samples : []) if (item.taskId) assertResource('image', item.taskId);
    }
    next();
  } catch (error) { next(error); }
}
