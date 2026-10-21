import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import sharp from 'sharp';
import { paths } from '../../services/db.js';

function absoluteFromRoot(filePath) {
  return path.isAbsolute(filePath) ? filePath : path.resolve(paths.rootDir, filePath);
}

export function defaultRembgCommand(env = process.env) {
  if (env.REMBG_COMMAND) return env.REMBG_COMMAND;
  const local = process.platform === 'win32'
    ? path.join(paths.rootDir, '.venv-rembg', 'Scripts', 'rembg.exe')
    : path.join(paths.rootDir, '.venv-rembg', 'bin', 'rembg');
  return fsSync.existsSync(local) ? local : 'rembg';
}

export function isRembgAvailable(env = process.env) {
  const command = defaultRembgCommand(env);
  if (path.isAbsolute(command)) return fsSync.existsSync(command);
  const probe = spawnSync(command, ['--version'], { windowsHide: true, timeout: 3000, stdio: 'ignore' });
  return !probe.error && probe.status === 0;
}

export function rembgEnvironment(env = process.env) {
  const model = env.REMBG_MODEL || 'u2net';
  const directory = path.resolve(env.REMBG_HOME || env.U2NET_HOME || path.join(paths.rootDir, 'models', 'rembg'));
  let accepted = env.REMBG_MODEL_LICENSE_ACCEPTED === 'true';
  try { accepted ||= JSON.parse(fsSync.readFileSync(path.join(directory, 'license-acceptance.json'), 'utf8').replace(/^\uFEFF/, '')).models?.[model]?.accepted === true; } catch { /* Missing consent never implies agreement. */ }
  const modelPresent = /^[a-z0-9_-]+$/i.test(model) && [path.join(directory, 'models', model, `${model}.onnx`), path.join(directory, `${model}.onnx`)].some((file) => fsSync.existsSync(file));
  const installed = isRembgAvailable(env);
  return { installed, model, directory, modelPresent, licenseAccepted: accepted, ready: installed && modelPresent && accepted,
    reason: !installed ? '尚未安装 rembg 依赖' : !accepted ? '模型权重许可尚未确认；未下载权重，不会自动下载' : !modelPresent ? '模型文件尚未安装；不会在推理时自动下载' : '依赖和模型已就绪，本地推理不上传图片' };
}

function runCommand(command, args, { timeoutMs = 240_000, env = process.env } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true, shell: false, env, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      const error = new Error(`本地 AI 抠图超过 ${Math.round(timeoutMs / 1000)} 秒`);
      error.code = 'REMBG_TIMEOUT';
      reject(error);
    }, timeoutMs);
    child.stderr.on('data', (chunk) => { stderr = `${stderr}${chunk}`.slice(-4000); });
    child.on('error', (error) => { clearTimeout(timer); reject(error); });
    child.on('exit', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve({ code, stderr });
      else {
        const error = new Error(stderr.trim() || `rembg 退出码 ${code}`);
        error.code = 'REMBG_PROCESS_FAILED';
        reject(error);
      }
    });
  });
}

function alphaBoundingBox(data, width, height) {
  let minX = width; let minY = height; let maxX = -1; let maxY = -1; let alphaPixels = 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (data[(y * width + x) * 4 + 3] <= 8) continue;
      alphaPixels += 1;
      minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
    }
  }
  return maxX < minX ? null : { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1, alphaPixels };
}

function failed(error, startedAt, model) {
  const missing = error.code === 'ENOENT';
  return {
    provider: 'rembg',
    model,
    method: 'local_rembg_onnx',
    status: 'failed',
    durationMs: Date.now() - startedAt,
    error: {
      code: missing ? 'REMBG_NOT_INSTALLED' : (error.code || 'REMBG_FAILED'),
      message: missing ? '未找到 rembg。本地 AI Provider 已接入，但需先运行 scripts/setup-rembg.ps1 安装 Python 3.11-3.13 环境和模型。' : error.message
    },
    output: null,
    metadata: { confidence: 0, edgeQuality: 'poor', backgroundType: 'unknown', warnings: ['local_ai_matting_failed'] }
  };
}

export class RembgMattingProvider {
  constructor({
    command = defaultRembgCommand(),
    model = process.env.REMBG_MODEL || 'u2net',
    timeoutMs = Number(process.env.REMBG_TIMEOUT_MS || 240_000),
    alphaMatting = String(process.env.REMBG_ALPHA_MATTING || 'true').toLowerCase() !== 'false',
    colorDecontamination = String(process.env.REMBG_COLOR_DECONTAMINATION || 'true').toLowerCase() !== 'false',
    commandRunner = runCommand
  } = {}) {
    this.provider = 'rembg';
    this.model = model;
    this.method = 'local_rembg_onnx';
    this.command = command;
    this.timeoutMs = timeoutMs;
    this.alphaMatting = alphaMatting;
    this.colorDecontamination = colorDecontamination;
    this.commandRunner = commandRunner;
  }

  async extractSubject({ task, sourceImage }) {
    const startedAt = Date.now();
    const temporaryFiles = [];
    try {
      if (!sourceImage?.filePath) throw Object.assign(new Error('本地 AI 抠图缺少输入图片'), { code: 'NO_SOURCE_IMAGE' });
      let modelEnvironment;
      if (this.commandRunner === runCommand) {
        modelEnvironment = rembgEnvironment({ ...process.env, REMBG_MODEL: this.model, REMBG_COMMAND: this.command });
        if (!modelEnvironment.ready) throw Object.assign(new Error(modelEnvironment.reason), { code: !modelEnvironment.installed ? 'REMBG_NOT_INSTALLED' : !modelEnvironment.licenseAccepted ? 'REMBG_MODEL_LICENSE_REQUIRED' : 'REMBG_MODEL_MISSING' });
      }
      const inputPath = absoluteFromRoot(sourceImage.filePath);
      await fs.access(inputPath);
      const outputDir = path.join(paths.rootDir, '.vision-tmp', 'matting', task?.id || 'rembg');
      await fs.mkdir(outputDir, { recursive: true });
      const baseName = `${String(sourceImage.id || 'subject').replace(/[^A-Za-z0-9_-]+/g, '-')}-${Date.now()}`;
      const rawOutputPath = path.join(outputDir, `${baseName}-raw.png`);
      const subjectPngPath = path.join(outputDir, `${baseName}.png`);
      const maskPath = path.join(outputDir, `${baseName}-mask.png`);
      temporaryFiles.push(rawOutputPath);
      const args = ['i', '-m', this.model];
      if (this.alphaMatting) args.push('-a');
      if (this.colorDecontamination) args.push('-dc');
      args.push(inputPath, rawOutputPath);
      await this.commandRunner(this.command, args, { timeoutMs: this.timeoutMs, env: modelEnvironment ? { ...process.env, U2NET_HOME: modelEnvironment.directory, REMBG_HOME: modelEnvironment.directory } : process.env });

      const { data, info } = await sharp(rawOutputPath).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      const bbox = alphaBoundingBox(data, info.width, info.height);
      if (!bbox) throw Object.assign(new Error('本地 AI 模型没有识别到前景主体'), { code: 'EMPTY_SUBJECT_MASK' });
      const extract = { left: bbox.x, top: bbox.y, width: bbox.width, height: bbox.height };
      await sharp(data, { raw: { width: info.width, height: info.height, channels: 4 } }).extract(extract).png().toFile(subjectPngPath);
      const alpha = Buffer.alloc(info.width * info.height);
      for (let source = 3, target = 0; source < data.length; source += 4, target += 1) alpha[target] = data[source];
      await sharp(alpha, { raw: { width: info.width, height: info.height, channels: 1 } }).extract(extract).png().toFile(maskPath);
      const outputStats = await fs.stat(subjectPngPath);
      const foregroundRatio = bbox.alphaPixels / (info.width * info.height);
      return {
        provider: this.provider,
        model: this.model,
        method: this.method,
        status: 'success',
        durationMs: Date.now() - startedAt,
        error: null,
        output: {
          subjectPngPath,
          maskPath,
          previewUrl: '',
          width: bbox.width,
          height: bbox.height,
          hasAlpha: true,
          boundingBox: { x: bbox.x, y: bbox.y, width: bbox.width, height: bbox.height }
        },
        metadata: {
          confidence: Math.max(0.45, Math.min(0.96, 0.58 + foregroundRatio)),
          edgeQuality: this.alphaMatting ? 'good' : 'medium',
          backgroundType: 'ai-segmented',
          warnings: ['model_output_requires_visual_review'],
          offline: true,
          networkUsedForInference: false,
          outputSize: outputStats.size
        }
      };
    } catch (error) {
      return failed(error, startedAt, this.model);
    } finally {
      await Promise.all(temporaryFiles.map((filePath) => fs.rm(filePath, { force: true }).catch(() => {})));
    }
  }
}
