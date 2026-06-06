import './config/env.js';
import express from 'express';
import cors from 'cors';
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
import { paths } from './services/db.js';
import { getProviderConfigSummary } from './config/env.js';

const app = express();

app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use('/uploads', express.static(paths.uploadDir));
app.use('/outputs', express.static(paths.outputDir));

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, service: 'crossborder-image-agent-backend' });
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

app.use((err, _req, res, _next) => {
  const status = err.statusCode || (String(err.code || '').startsWith('LIMIT_') ? 400 : 500);
  res.status(status).json({
    error: err.payload || err.message || 'Unexpected server error'
  });
});

export default app;
