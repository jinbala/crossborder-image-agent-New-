// Isolated native-ABI diagnostic; run only with Electron's own Node mode.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = await fs.mkdtemp(path.join(desktop, '.smoke-data', 'zip-lock-native-'));
const workspace = path.join(root, 'workspace'); await fs.mkdir(workspace);
if (!root.split(path.sep).includes('.smoke-data') || (!process.versions.electron && !process.parentPort)) throw new Error('Requires Electron ABI and an owned test profile');
Object.assign(process.env, { CROSSBORDER_DATA_ROOT: workspace, STORAGE_DRIVER: 'sqlite', WEB_AUTH_ENABLED: 'false', LOCAL_API_TOKEN: '', AI_PROVIDER: 'mock', VISION_PROVIDER: 'mock', IMAGE_PROVIDER: 'mock', BACKGROUND_PROVIDER: 'mock', REVIEW_PROVIDER: 'mock', MATTING_PROVIDER: 'sharp', MATTING_FALLBACK_PROVIDER: 'sharp', OPENAI_API_KEY: '', GEMINI_API_KEY: '', QWEN_API_KEY: '', MATTING_API_KEY: '', MATTING_EXTERNAL_API_KEY: '' });
const require = createRequire(import.meta.url), sharp = require('sharp');
const { createSkuPack, resumeSkuPack, previewSkuPackResume } = await import(pathToFileURL(path.join(desktop, 'runtime/backend/src/services/skuPackService.js')));
const good = path.join(workspace, 'good.png'), bad = path.join(workspace, 'bad.png');
await sharp({ create: { width: 64, height: 32, channels: 3, background: '#49727f' } }).png().toFile(good); await fs.writeFile(bad, 'corrupt fixture only');
const files = Array.from({ length: 35 }, (_, i) => ({ path: i < 30 ? good : bad, originalname: 'main.png' })), paths = files.map((_, i) => `fixture/SKU-${i + 1}/main.png`);
const result = await createSkuPack(files, paths, { generateSquare: false, matteImages: false, preserveOriginals: true, format: 'webp' });
try {
  const preview = await previewSkuPackResume(result.id, { retryFailed: true });
  const resumed = await resumeSkuPack(result.id, { confirm: true, retryFailed: true, previewHash: preview.previewHash });
  const report = { ok: true, profile: path.basename(root), native: process.versions.electron, utility: Boolean(process.parentPort), status: resumed.status, summary: resumed.summary };
  await fs.writeFile(path.join(root, 'probe-report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report));
} catch (error) {
  const diagnostic = await require('../src/zip-lock-diagnostic.cjs').inspectSmokeZipLock(path.join(workspace, 'outputs/workbench', result.id, `${result.id}.zip`)).catch(error => ({ error: error.message }));
  const report = { ok: false, profile: path.basename(root), native: process.versions.electron, error: error.message, diagnostic };
  await fs.writeFile(path.join(root, 'probe-report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report)); process.exitCode = 1;
}
if (process.parentPort) { await new Promise(resolve => process.stdout.write('', resolve)); process.exit(process.exitCode || 0); }
