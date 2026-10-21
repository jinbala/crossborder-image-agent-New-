import app from './app.js';
import { ensureStorage } from './services/db.js';

const port = Number(process.env.PORT ?? 4000);

await ensureStorage();

const server = app.listen(port, '127.0.0.1', () => {
  const address = server.address();
  console.log(`API server listening on http://127.0.0.1:${address.port}`);
  process.parentPort?.postMessage({ type: 'ready', port: address.port });
});

server.on('error', (error) => {
  console.error('API_START_FAILED', error.code || error.message);
  process.exitCode = 1;
  process.parentPort?.postMessage({ type: 'error', code: error.code || 'API_START_FAILED' });
});

let closing = false;
function shutdown() {
  if (closing) return;
  closing = true;
  server.close(() => process.exit(0));
  server.closeIdleConnections?.();
  setTimeout(() => process.exit(0), 5000).unref();
}
process.parentPort?.on('message', ({ data }) => { if (data?.type === 'shutdown') shutdown(); });
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
