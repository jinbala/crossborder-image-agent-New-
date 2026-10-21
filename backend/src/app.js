import './config/env.js';
import express from 'express';
import cors from 'cors';
import path from 'node:path';
import { localAccess } from './middleware/localAccess.js';
import { webAccess } from './middleware/webAccess.js';
import { assetAccess } from './middleware/assetAccess.js';
import { resourceAccess } from './middleware/resourceAccess.js';
import accountRouter from './routes/accountRoutes.js';
import platformRouter from './routes/platformRoutes.js';
import tasksRouter from './routes/tasks.js';
import batchesRouter from './routes/batches.js';
import importScanRouter from './routes/importScan.js';
import workflowTemplatesRouter from './routes/workflowTemplates.js';
import sopRouter from './routes/sop.js';
import settingsRouter from './routes/settings.js';
import snapshotsRouter from './routes/snapshots.js';
import healthRouter from './routes/health.js';
import storageRouter from './routes/storage.js';
import cleanupRouter from './routes/cleanupRoutes.js';
import stressTestRouter from './routes/stressTestRoutes.js';
import mattingRouter from './routes/mattingRoutes.js';
import rulesRouter from './routes/rulesRoutes.js';
import generateRouter from './routes/generateRoutes.js';
import uploadRouter from './routes/uploadRoutes.js';
import finalAcceptanceRouter from './routes/finalAcceptanceRoutes.js';
import workbenchRouter from './routes/workbenchRoutes.js';
import desktopRouter from './routes/desktopRoutes.js';
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
app.use('/api/platform', platformRouter);
app.use('/uploads', express.static(paths.uploadDir));
app.use('/outputs', express.static(paths.outputDir));

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, service: 'crossborder-image-agent-backend', capabilities: { collectionRequestIdempotency: 1, collectionCreationEpoch: collectionCreationEpoch() } });
});

app.get('/api/health/provider-config', (_req, res) => {
  res.json(getProviderConfigSummary());
});

app.use('/api/tasks', tasksRouter);
app.use('/api/batches', batchesRouter);
app.use('/api/import-scan', importScanRouter);
app.use('/api/workflow-templates', workflowTemplatesRouter);
app.use('/api/sop', sopRouter);
app.use('/api/settings', settingsRouter);
app.use('/api/snapshots', snapshotsRouter);
app.use('/api/health', healthRouter);
app.use('/api/storage', storageRouter);
app.use('/api/cleanup', cleanupRouter);
app.use('/api/stress-test', stressTestRouter);
app.use('/api/matting', mattingRouter);
app.use('/api/rules', rulesRouter);
app.use('/api/generate', generateRouter);
app.use('/api/upload', uploadRouter);
app.use('/api/final-acceptance', finalAcceptanceRouter);
app.use('/api/workbench', workbenchRouter);
app.use('/api/desktop', desktopRouter);

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
