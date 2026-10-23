import './config/env.js';
import express from 'express';
import cors from 'cors';
import path from 'node:path';
import { localAccess } from './middleware/localAccess.js';
import { webAccess } from './middleware/webAccess.js';
import { assetAccess } from './middleware/assetAccess.js';
import { resourceAccess } from './middleware/resourceAccess.js';
import accountRouter from './routes/accountRoutes.js';
import { lazyRouter } from './utils/lazyRouter.js';
import { paths } from './services/db.js';
import { collectionCreationEpoch } from './services/platformStore.js';
import { getProviderConfigSummary } from './config/env.js';

const app = express();
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; connect-src 'self'; font-src 'self' data:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'");
  if (_req.path.startsWith('/api/')) res.setHeader('Cache-Control', 'no-store');
  next();
});

app.use(localAccess);
app.use(cors(process.env.LOCAL_API_TOKEN ? { origin: false } : {}));
app.use(express.json({ limit: '2mb' }));
app.use('/api/auth', accountRouter);
app.use(webAccess);
app.use(assetAccess);
app.use(resourceAccess);
app.use('/api/platform', lazyRouter(() => import('./routes/platformRoutes.js')));
app.use('/uploads', express.static(paths.uploadDir));
app.use('/outputs', express.static(paths.outputDir));

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, service: 'crossborder-image-agent-backend', capabilities: { collectionRequestIdempotency: 1, collectionCreationEpoch: collectionCreationEpoch() } });
});

app.get('/api/health/provider-config', (_req, res) => {
  res.json(getProviderConfigSummary());
});

app.use('/api/tasks', lazyRouter(() => import('./routes/tasks.js')));
app.use('/api/batches', lazyRouter(() => import('./routes/batches.js')));
app.use('/api/import-scan', lazyRouter(() => import('./routes/importScan.js')));
app.use('/api/workflow-templates', lazyRouter(() => import('./routes/workflowTemplates.js')));
app.use('/api/sop', lazyRouter(() => import('./routes/sop.js')));
app.use('/api/settings', lazyRouter(() => import('./routes/settings.js')));
app.use('/api/snapshots', lazyRouter(() => import('./routes/snapshots.js')));
app.use('/api/health', lazyRouter(() => import('./routes/health.js')));
app.use('/api/storage', lazyRouter(() => import('./routes/storage.js')));
app.use('/api/cleanup', lazyRouter(() => import('./routes/cleanupRoutes.js')));
app.use('/api/stress-test', lazyRouter(() => import('./routes/stressTestRoutes.js')));
app.use('/api/matting', lazyRouter(() => import('./routes/mattingRoutes.js')));
app.use('/api/rules', lazyRouter(() => import('./routes/rulesRoutes.js')));
app.use('/api/generate', lazyRouter(() => import('./routes/generateRoutes.js')));
app.use('/api/upload', lazyRouter(() => import('./routes/uploadRoutes.js')));
app.use('/api/final-acceptance', lazyRouter(() => import('./routes/finalAcceptanceRoutes.js')));
app.use('/api/workbench', lazyRouter(() => import('./routes/workbenchRoutes.js')));
app.use('/api/desktop', lazyRouter(() => import('./routes/desktopRoutes.js')));

if (process.env.FRONTEND_DIST_DIR) {
  const frontendDir = path.resolve(process.env.FRONTEND_DIST_DIR);
  app.use(express.static(frontendDir));
  app.get('*', (req, res, next) => {
    if (['/api', '/outputs', '/uploads'].some((prefix) => req.path === prefix || req.path.startsWith(`${prefix}/`))) return next();
    res.sendFile(path.join(frontendDir, 'index.html'));
  });
}

app.use((err, _req, res, _next) => {
  const status = err.statusCode || (String(err.code || '').startsWith('LIMIT_') ? 400 : 500);
  res.status(status).json({
    error: err.payload || err.message || 'Unexpected server error'
  });
});

export default app;
