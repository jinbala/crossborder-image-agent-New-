import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { validateReleasePackage } from './validate-release-package.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, '..');

const ALLOWED_PATHS = [
  '.env.example',
  '.gitignore',
  'README.md',
  '启动小程序.bat',
  '关闭小程序.bat',
  '检查小程序状态.bat',
  'browser-extension',
  'desktop/package.json',
  'desktop/README.md',
  'desktop/package-lock.json',
  'desktop/scripts',
  'desktop/src',
  'desktop/tests',
  'docs',
  'scripts',
  'backend/package.json',
  'backend/package-lock.json',
  'backend/scripts',
  'backend/src',
  'backend/test-assets',
  'backend/tests',
  'frontend/index.html',
  'frontend/package.json',
  'frontend/package-lock.json',
  'frontend/postcss.config.js',
  'frontend/tailwind.config.js',
  'frontend/vite.config.js',
  'frontend/src',
  'frontend/tests'
];

function timestamp() {
  return new Date().toISOString().slice(0, 19).replace(/[:T]/g, '');
}

async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function copyAllowedFiles(stagingDir) {
  for (const relativePath of ALLOWED_PATHS) {
    const source = path.join(ROOT_DIR, relativePath);
    if (!(await exists(source))) continue;
    const target = path.join(stagingDir, relativePath);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.cp(source, target, {
      recursive: true,
      force: true,
      filter: (item) => {
        const normalized = path.relative(ROOT_DIR, item).replace(/\\/g, '/');
        return !/(^|\/)node_modules(\/|$)|(^|\/)\.env$|(^|\/)dev-server[^/]*\.log$|(^|\/)[^/]+\.log$/.test(normalized);
      }
    });
  }
}

function compressDirectory(stagingDir, zipPath) {
  const command = [
    '$ErrorActionPreference = "Stop";',
    'if (Test-Path -LiteralPath $env:ZIP_PATH) { Remove-Item -LiteralPath $env:ZIP_PATH -Force }',
    'Compress-Archive -Path (Join-Path $env:STAGING_DIR "*") -DestinationPath $env:ZIP_PATH -Force'
  ].join(' ');
  const result = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', command], {
    env: { ...process.env, STAGING_DIR: stagingDir, ZIP_PATH: zipPath },
    encoding: 'utf8'
  });
  if (result.status !== 0) {
    throw new Error(`Compress-Archive failed: ${result.stderr || result.stdout}`);
  }
}

export async function createReleasePackage(options = {}) {
  const outputPath = path.resolve(options.outputPath || path.join(ROOT_DIR, `crossborder-image-agent-release-${timestamp()}.zip`));
  const stagingDir = await fs.mkdtemp(path.join(os.tmpdir(), 'crossborder-image-agent-release-'));
  try {
    await copyAllowedFiles(stagingDir);
    compressDirectory(stagingDir, outputPath);
    const validation = validateReleasePackage(outputPath);
    if (validation.forbiddenCount > 0 || validation.containsRealEnv || validation.containsSqliteRuntime || validation.containsUploadsOutputsBackups) {
      throw new Error(`Release package validation failed: ${JSON.stringify(validation, null, 2)}`);
    }
    const stat = await fs.stat(outputPath);
    return {
      zipPath: outputPath,
      sizeBytes: stat.size,
      ...validation
    };
  } finally {
    await fs.rm(stagingDir, { recursive: true, force: true });
  }
}

function parseOutputArg(argv) {
  const index = argv.indexOf('--output');
  return index >= 0 ? argv[index + 1] : '';
}

async function runCli() {
  const outputPath = parseOutputArg(process.argv);
  const result = await createReleasePackage({ outputPath });
  console.log(JSON.stringify(result, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCli().catch((error) => {
    console.error(error.message || error);
    process.exit(1);
  });
}
