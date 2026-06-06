#!/usr/bin/env node
import '../src/config/env.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getMattingConfig, runMatting } from '../src/services/mattingService.js';
import { buildMattingReport, writeMattingReport } from '../src/services/mattingReportService.js';
import { listTasks, paths } from '../src/services/db.js';

const scriptPath = fileURLToPath(import.meta.url);
const backendRoot = path.resolve(path.dirname(scriptPath), '..');
const testAssetsRoot = path.join(backendRoot, 'test-assets');
const SUPPORTED_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp']);

function readValue(argv, index) {
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) return '';
  return value;
}

function readOption(arg, name, argv, index) {
  if (arg === name) return readValue(argv, index);
  if (arg.startsWith(`${name}=`)) return arg.slice(name.length + 1);
  return null;
}

function normalizeImageInput(value) {
  if (!value) return '';
  const normalized = String(value).replaceAll('\\', '/');
  return normalized.startsWith('backend/test-assets/')
    ? normalized.slice('backend/'.length)
    : normalized;
}

export function parseImage2SmokeArgs(argv = []) {
  const options = {
    provider: 'image2',
    taskId: '',
    imageId: '',
    image: '',
    compare: true,
    writeReport: false,
    limit: 1,
    help: false
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const provider = readOption(arg, '--provider', argv, index);
    const taskId = readOption(arg, '--task-id', argv, index);
    const imageId = readOption(arg, '--image-id', argv, index);
    const image = readOption(arg, '--image', argv, index);
    const input = readOption(arg, '--input', argv, index);
    if (provider !== null) options.provider = provider || 'image2';
    else if (taskId !== null) options.taskId = taskId;
    else if (imageId !== null) options.imageId = imageId;
    else if (image !== null) options.image = normalizeImageInput(image);
    else if (input !== null) options.image = normalizeImageInput(input);
    else if (arg === '--no-compare') options.compare = false;
    else if (arg === '--compare') options.compare = true;
    else if (arg === '--write-report') options.writeReport = true;
    else if (arg === '--help') options.help = true;
  }
  return options;
}

function usage() {
  return [
    'Usage:',
    '  node scripts/runImage2MattingSmokeTest.js --task-id <taskId> --image-id <imageId>',
    '  node scripts/runImage2MattingSmokeTest.js --image test-assets/sku001-hard-drive/main.png',
    '  node scripts/runImage2MattingSmokeTest.js --provider=image2 --input=backend/test-assets/sku001-hard-drive/main.png',
    '  node scripts/runImage2MattingSmokeTest.js --provider=image2 --input=backend/test-assets/sku001-hard-drive/main.png --write-report',
    '  node scripts/runImage2MattingSmokeTest.js --task-id <taskId> --image-id <imageId> --no-compare',
    '',
    'This smoke test runs at most one image. It prints a sanitized JSON report and never prints provider secrets.'
  ].join('\n');
}

export function image2SmokeConfigSummary(env = process.env) {
  return {
    image2Available: Boolean(env.OPENAI_API_KEY),
    availabilityRule: 'Boolean(OPENAI_API_KEY)',
    requiredEnvNames: ['OPENAI_API_KEY'],
    recognizedEnvNames: [
      'OPENAI_API_KEY',
      'OPENAI_IMAGE_EDIT_MODEL',
      'OPENAI_IMAGE_MODEL',
      'IMAGE_MODEL',
      'OPENAI_BASE_URL'
    ],
    optionalEnvNames: [
      'OPENAI_IMAGE_EDIT_MODEL',
      'OPENAI_IMAGE_MODEL',
      'IMAGE_MODEL',
      'OPENAI_BASE_URL'
    ]
  };
}

function sanitizeString(value) {
  if (typeof value !== 'string') return value;
  return value
    .replace(/[A-Z]:\\[^"',\n\r\t]+/g, '[本地路径已隐藏]')
    .replace(/\bsk-[A-Za-z0-9_-]+/g, '[密钥已隐藏]');
}

export function sanitizeImage2SmokeReport(value) {
  if (Array.isArray(value)) return value.map(sanitizeImage2SmokeReport);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value)
      .filter(([key]) => !/apiKey|api_key|secret|token|password|filePath|path|localPath|subjectPngPath|maskPath/i.test(key))
      .map(([key, item]) => [key, sanitizeImage2SmokeReport(item)]));
  }
  return sanitizeString(value);
}

function compactResult(result = {}) {
  const qualityScore = result.qualityScore || {};
  return sanitizeImage2SmokeReport({
    status: result.status || 'unknown',
    requestedProvider: result.requestedProvider || '',
    providerUsed: result.providerUsed || '',
    outputType: result.outputType || '',
    fallbackUsed: Boolean(result.fallbackUsed),
    fallbackReason: result.fallbackReason || '',
    qualityScore,
    warnings: qualityScore.warnings || result.warnings || [],
    originalImage: result.originalImage || null,
    mattedImage: result.mattedImage || null,
    durationMs: result.durationMs || 0,
    errorMessage: result.errorMessage || ''
  });
}

function compactCompare(compareResult = null) {
  if (!compareResult) return null;
  return sanitizeImage2SmokeReport({
    sharp: compareResult.sharp ? compactResult(compareResult.sharp) : null,
    image2: compareResult.image2?.status === 'unavailable'
      ? {
        status: 'unavailable',
        message: compareResult.image2.message || 'Image2 未配置，当前仅可使用 sharp 本地抠图。'
      }
      : compactResult(compareResult.image2 || compareResult.image2Result || {}),
    recommendation: compareResult.recommendation || null
  });
}

function recommendationForSmokeCompare({ sharpResult, image2Result }) {
  if (!image2Result || image2Result.status !== 'success' || image2Result.fallbackUsed) {
    return { provider: 'sharp', reason: 'Image2 不可用、失败或发生 fallback，建议使用 sharp。' };
  }
  const image2Score = Number(image2Result.qualityScore?.score || 0);
  const sharpScore = Number(sharpResult?.qualityScore?.score || 0);
  if (image2Score > sharpScore + 10) {
    return { provider: 'image2', reason: 'Image2 评分明显高于 sharp，可人工复查后继续保留为实验 provider。' };
  }
  return { provider: 'sharp', reason: 'sharp 更稳定，默认建议使用 sharp。' };
}

export function buildImage2SmokeSummary({
  status,
  image2Available,
  input = {},
  runResult = null,
  compareResult = null,
  reason = '',
  configSummary = image2SmokeConfigSummary()
} = {}) {
  const available = Boolean(image2Available);
  const compare = compactCompare(compareResult);
  return sanitizeImage2SmokeReport({
    status: status || 'completed',
    createdAt: new Date().toISOString(),
    mode: 'image2-single-image-smoke',
    limit: 1,
    image2Available: available,
    availabilityRule: configSummary.availabilityRule,
    requiredEnvNames: configSummary.requiredEnvNames,
    recognizedEnvNames: configSummary.recognizedEnvNames,
    costNotice: available
      ? '即将调用 Image2 进行单图真实抠图测试，可能产生 API 成本。'
      : 'Image2 未配置，不会发起真实调用，也不会产生第三方 API 成本。',
    taskId: input.taskId || '',
    imageId: input.imageId || '',
    reason,
    image2: runResult ? compactResult(runResult) : {
      status: 'unavailable',
      message: 'Image2 未配置，当前仅可使用 sharp 本地抠图。'
    },
    compare,
    compareSucceeded: Boolean(compare?.sharp && compare?.image2),
    manualReviewPrompt: '请人工打开结果图，检查产品边缘、接口、孔位、纹理是否被改坏。'
  });
}

function sampleSummary(sample, options = {}) {
  if (options.image) {
    return {
      inputImageName: sample?.task?.sourceImages?.[0]?.displayName || path.basename(options.image),
      inputImageSafePath: `backend/${normalizeImageInput(options.image)}`,
      imageSource: 'test-assets'
    };
  }
  return {
    inputImageName: sample?.task?.sourceImages?.[0]?.displayName || '',
    inputImageSafePath: '',
    imageSource: 'task-image'
  };
}

async function attachReport(summary, sample, options, deps) {
  if (!options.writeReport) return summary;
  const report = buildMattingReport({
    summary,
    sample: sampleSummary(sample, options)
  });
  const saved = await (deps.writeMattingReport || writeMattingReport)({
    report,
    reportDir: deps.reportDir
  });
  return sanitizeImage2SmokeReport({
    ...summary,
    reportFile: saved.relativePath
  });
}

function sourceImages(task = {}) {
  return task.sourceImages?.length ? task.sourceImages : [task.originalImage].filter(Boolean);
}

async function sampleFromImagePath(image) {
  if (!image) return null;
  const absolutePath = path.resolve(backendRoot, image);
  const relativeToAssets = path.relative(testAssetsRoot, absolutePath);
  const outsideAssets = relativeToAssets.startsWith('..') || path.isAbsolute(relativeToAssets);
  if (outsideAssets) {
    throw new Error('--image 仅允许使用 backend/test-assets 下的小样本图片，避免误读业务文件。');
  }
  if (!SUPPORTED_EXTENSIONS.has(path.extname(absolutePath).toLowerCase())) {
    throw new Error('--image 仅支持 jpg、jpeg、png、webp 小样本图片。');
  }
  await fs.access(absolutePath);
  const taskId = `image2-smoke-${Date.now()}`;
  const imageId = path.parse(absolutePath).name
    .replace(/[^A-Za-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'sample';
  return {
    taskId,
    imageId,
    task: {
      id: taskId,
      sourceImages: [{
        id: imageId,
        displayName: path.basename(absolutePath),
        filePath: path.relative(paths.rootDir, absolutePath).replaceAll('\\', '/'),
        previewUrl: ''
      }]
    }
  };
}

async function selectSample({ taskId, imageId }, deps) {
  if (taskId && imageId) return { taskId, imageId };
  const tasks = await (deps.listTasks || listTasks)();
  const task = tasks.find((item) => {
    if (taskId && item.id !== taskId) return false;
    return sourceImages(item).length > 0;
  });
  if (!task) return null;
  const image = sourceImages(task).find((item) => !imageId || item.id === imageId) || sourceImages(task)[0];
  if (!image) return null;
  return { taskId: task.id, imageId: image.id };
}

export async function runImage2MattingSmoke(options = {}, deps = {}) {
  const config = await (deps.getConfig || getMattingConfig)();
  const configSummary = {
    ...image2SmokeConfigSummary(deps.env || process.env),
    image2Available: Boolean(config.image2Available)
  };
  if (String(options.provider || 'image2').toLowerCase() !== 'image2') {
    throw new Error('runImage2MattingSmokeTest 仅允许 provider=image2。');
  }
  if (!config.image2Available) {
    const summary = buildImage2SmokeSummary({
      status: 'skipped',
      image2Available: false,
      input: options,
      reason: 'Image2 未配置，已跳过真实调用。请只配置变量名 OPENAI_API_KEY，必要时再配置 OPENAI_IMAGE_EDIT_MODEL / OPENAI_IMAGE_MODEL / IMAGE_MODEL / OPENAI_BASE_URL。',
      configSummary
    });
    return attachReport(summary, null, options, deps);
  }
  const sample = await sampleFromImagePath(options.image) || await selectSample(options, deps);
  if (!sample) {
    const summary = buildImage2SmokeSummary({
      status: 'skipped',
      image2Available: config.image2Available,
      input: options,
      reason: '未找到可用于 Image2 小样本验收的单张商品图片。',
      configSummary
    });
    return attachReport(summary, null, options, deps);
  }

  const input = { taskId: sample.taskId, imageId: sample.imageId };
  const runDeps = sample.task ? { taskReader: async () => sample.task } : undefined;
  const runResult = await (deps.runMatting || runMatting)({ ...input, provider: 'image2' }, runDeps);
  const sharpResult = options.compare === false
    ? null
    : await (deps.runMatting || runMatting)({ ...input, provider: 'sharp' }, runDeps);
  const compareResult = options.compare === false
    ? null
    : {
      sharp: sharpResult,
      image2: runResult,
      recommendation: recommendationForSmokeCompare({ sharpResult, image2Result: runResult })
    };

  const summary = buildImage2SmokeSummary({
    status: 'completed',
    image2Available: config.image2Available,
    input,
    runResult,
    compareResult,
    configSummary
  });
  return attachReport(summary, sample, options, deps);
}

async function main() {
  const options = parseImage2SmokeArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }
  try {
    const report = await runImage2MattingSmoke(options);
    console.log(JSON.stringify(report, null, 2));
  } catch (error) {
    console.error(JSON.stringify(sanitizeImage2SmokeReport({
      status: 'failed',
      error: {
        code: error.code || 'IMAGE2_MATTING_SMOKE_ERROR',
        message: error.message
      }
    }), null, 2));
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  main();
}
