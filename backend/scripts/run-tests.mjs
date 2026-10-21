import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const backend = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const project = path.dirname(backend);
const testRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'crossborder-isolated-tests-'));
try {
  // Snapshot/health fixtures need documentation, never real user uploads or DBs.
  for (const name of ['README.md', '.env.example', '.gitignore', 'docs']) {
    await fs.cp(path.join(project, name), path.join(testRoot, name), { recursive: true });
  }
  const args = process.argv.slice(2);
  const child = spawn(process.execPath, ['--test', '--test-concurrency=1', ...args], {
    cwd: backend, stdio: 'inherit', env: { ...process.env,
      CROSSBORDER_DATA_ROOT: testRoot, LOCAL_API_TOKEN: '', STORAGE_DRIVER: 'json', WEB_AUTH_ENABLED: 'false',
      AI_PROVIDER: 'mock', VISION_PROVIDER: 'mock', IMAGE_PROVIDER: 'mock', BACKGROUND_PROVIDER: 'mock', REVIEW_PROVIDER: 'mock', MATTING_PROVIDER: 'sharp', MATTING_FALLBACK_PROVIDER: 'sharp',
      OPENAI_API_KEY: '', GEMINI_API_KEY: '', QWEN_API_KEY: '', DASHSCOPE_API_KEY: '', MATTING_EXTERNAL_API_KEY: '', MATTING_API_KEY: ''
    }
  });
  process.exitCode = await new Promise((resolve, reject) => { child.on('exit', (code) => resolve(code ?? 1)); child.on('error', reject); });
} finally {
  const parent = path.resolve(os.tmpdir());
  if (path.dirname(testRoot) === parent && path.basename(testRoot).startsWith('crossborder-isolated-tests-')) await fs.rm(testRoot, { recursive: true, force: true });
}
