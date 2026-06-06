import fs from 'node:fs/promises';
import path from 'node:path';
import { nanoid } from 'nanoid';
import { getTask, paths } from './db.js';
import { evaluateMattingQuality } from './mattingQualityService.js';
import { ExternalMattingProvider, Image2MattingProvider, SharpMattingProvider } from '../providers/matting/index.js';

const DEFAULT_TIMEOUT_MS = 60000;

function normalizeProvider(provider) {
  return ['sharp', 'external', 'image2', 'auto'].includes(String(provider || '').toLowerCase())
    ? String(provider).toLowerCase()
    : 'sharp';
}

function externalUrl(env) {
  return env.MATTING_EXTERNAL_API_URL || env.MATTING_BASE_URL || '';
}

function externalKey(env) {
  return env.MATTING_EXTERNAL_API_KEY || env.MATTING_API_KEY || '';
}

function externalConfigured(env) {
  return Boolean(externalUrl(env) && externalKey(env));
}

function image2Configured(env) {
  return Boolean(env.OPENAI_API_KEY);
}

function image2Model(env) {
  return env.OPENAI_IMAGE_EDIT_MODEL || env.OPENAI_IMAGE_MODEL || env.IMAGE_MODEL || 'gpt-image-2';
}

function timeoutMs(env) {
  const value = Number(env.MATTING_EXTERNAL_TIMEOUT_MS || env.MATTING_TIMEOUT_MS || DEFAULT_TIMEOUT_MS);
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_TIMEOUT_MS;
}

function sanitizeString(value) {
  if (typeof value !== 'string') return value;
  return value
    .replace(/[A-Z]:\\[^"',\n\r\t]+/g, (match) => match.split('\\').filter(Boolean).pop() || '[已隐藏本地路径]')
    .replace(/\bsk-[A-Za-z0-9_-]+/g, '[已隐藏敏感密钥]');
}

function sanitizeValue(value) {
  if (Array.isArray(value)) return value.map(sanitizeValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value)
      .filter(([key]) => !/apiKey|api_key|secret|token|password|filePath|path|subjectPngPath|maskPath/i.test(key))
      .map(([key, item]) => [key, sanitizeValue(item)]));
  }
  return sanitizeString(value);
}

function sourceImageSummary(sourceImage = {}) {
  return {
    id: sourceImage.id || '',
    displayName: sourceImage.displayName || sourceImage.originalName || sourceImage.fileName || sourceImage.id || '',
    previewUrl: sourceImage.previewUrl || sourceImage.url || ''
  };
}

function findSourceImage(task, imageId) {
  const images = task?.sourceImages?.length ? task.sourceImages : [task?.originalImage].filter(Boolean);
  return images.find((image) => image.id === imageId) || images[0] || null;
}

function createProviders(env, providers = {}) {
  return {
    sharp: providers.sharp || new SharpMattingProvider(),
    external: providers.external || new ExternalMattingProvider({
      apiKey: externalKey(env),
      baseURL: externalUrl(env),
      model: env.MATTING_EXTERNAL_MODEL || env.MATTING_MODEL || 'external-matting'
    }),
    image2: providers.image2 || new Image2MattingProvider({
      apiKey: env.OPENAI_API_KEY,
      baseURL: env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
      model: image2Model(env)
    })
  };
}

async function copyOutput({ outputRoot, taskId, provider, subjectPngPath }) {
  if (!subjectPngPath) return null;
  const safeTaskId = String(taskId || 'task').replace(/[^A-Za-z0-9_-]+/g, '-');
  const safeProvider = String(provider || 'matting').replace(/[^A-Za-z0-9_-]+/g, '-');
  const outputDir = path.join(outputRoot, safeTaskId, 'matting-test');
  await fs.mkdir(outputDir, { recursive: true });
  const fileName = `matting-${safeTaskId}-${safeProvider}-${Date.now()}-${nanoid(6)}.png`;
  const targetPath = path.join(outputDir, fileName);
  await fs.copyFile(subjectPngPath, targetPath);
  return {
    previewUrl: `/outputs/${safeTaskId}/matting-test/${fileName}`,
    relativePath: path.relative(paths.rootDir, targetPath).replaceAll('\\', '/')
  };
}

export function getMattingConfig(env = process.env) {
  const currentProvider = normalizeProvider(env.MATTING_PROVIDER || 'sharp');
  const configured = externalConfigured(env);
  const image2Available = image2Configured(env);
  return {
    currentProvider,
    externalConfigured: configured,
    image2Available,
    externalProviders: image2Available ? ['sharp', 'image2'] : ['sharp'],
    image2ModeLabel: '实验性抠图',
    costNotice: image2Available
      ? 'Image2 抠图测试可能产生 API 成本，仅在你点击对应按钮时才会调用。'
      : 'Image2 未配置，不会产生第三方 API 成本。',
    availableProviders: ['sharp', 'external', 'image2', 'auto'],
    defaultProvider: 'sharp',
    timeoutMs: timeoutMs(env),
    warning: image2Available
      ? 'Image2 已配置为实验性抠图 provider。不会自动调用，只有点击 Image2 按钮或明确 compare 时才会调用。'
      : configured
      ? '已检测到第三方抠图配置。只有点击第三方抠图按钮时才会调用，不会自动调用。第三方抠图 API 可能产生费用，请确认后再调用。'
      : 'Image2 未配置，当前仅可使用 sharp 本地抠图。第三方抠图 API 未配置。当前将使用 sharp 本地抠图，不会产生第三方 API 成本。'
  };
}

async function normalizeResult({ task, sourceImage, providerResult, requestedProvider, providerUsed, fallbackUsed = false, fallbackReason = '', outputRoot }) {
  const copied = await copyOutput({
    outputRoot,
    taskId: task.id,
    provider: providerUsed,
    subjectPngPath: providerResult.output?.subjectPngPath
  });
  const qualityScore = await evaluateMattingQuality({ providerResult, fallbackUsed });
  return sanitizeValue({
    requestedProvider: requestedProvider || providerUsed,
    providerUsed,
    outputType: providerResult.metadata?.outputType || (providerUsed === 'image2' ? 'edited-background-removed' : 'transparent'),
    fallbackUsed,
    fallbackReason,
    originalImage: sourceImageSummary(sourceImage),
    mattedImage: copied ? {
      previewUrl: copied.previewUrl,
      relativePath: copied.relativePath,
      width: providerResult.output?.width,
      height: providerResult.output?.height
    } : null,
    previewImage: copied ? { previewUrl: copied.previewUrl } : null,
    qualityScore,
    qualityDetails: qualityScore.details,
    durationMs: providerResult.durationMs || 0,
    status: providerResult.status,
    errorMessage: providerResult.error?.message || '',
    rawProviderMeta: providerResult.metadata?.rawProviderMeta || {}
  });
}

export async function runMatting(input = {}, deps = {}) {
  const env = deps.env || process.env;
  const task = await (deps.taskReader || getTask)(input.taskId);
  if (!task) {
    const error = new Error('Task not found');
    error.statusCode = 404;
    throw error;
  }
  const sourceImage = findSourceImage(task, input.imageId);
  if (!sourceImage) {
    const error = new Error('未找到可用于抠图的商品图片');
    error.statusCode = 400;
    throw error;
  }

  const config = getMattingConfig(env);
  const requested = normalizeProvider(input.provider || 'sharp');
  const providerName = requested === 'auto'
    ? (config.currentProvider === 'external' && config.externalConfigured ? 'external' : 'sharp')
    : requested;
  const outputRoot = deps.outputRoot || paths.outputDir;
  const providers = createProviders(env, deps.providers);

  if (providerName === 'external' && !config.externalConfigured) {
    const fallback = await providers.sharp.extractSubject({ task, sourceImage });
    return normalizeResult({
      task,
      sourceImage,
      providerResult: fallback,
      requestedProvider: requested,
      providerUsed: fallback.provider || 'sharp',
      fallbackUsed: true,
      fallbackReason: '第三方抠图 API 未配置，已 fallback 到 sharp 本地抠图。',
      outputRoot
    });
  }

  if (providerName === 'image2' && !config.image2Available) {
    const fallback = await providers.sharp.extractSubject({ task, sourceImage });
    return normalizeResult({
      task,
      sourceImage,
      providerResult: fallback,
      requestedProvider: 'image2',
      providerUsed: fallback.provider || 'sharp',
      fallbackUsed: true,
      fallbackReason: 'Image2 未配置，已 fallback 到 sharp 本地抠图。',
      outputRoot
    });
  }

  const primary = await providers[providerName].extractSubject({ task, sourceImage });
  if ((providerName === 'external' || providerName === 'image2') && primary.status !== 'success') {
    const fallback = await providers.sharp.extractSubject({ task, sourceImage });
    if (fallback.status === 'success') {
      return normalizeResult({
        task,
        sourceImage,
        providerResult: fallback,
        requestedProvider: providerName,
        providerUsed: fallback.provider || 'sharp',
        fallbackUsed: true,
        fallbackReason: `${providerName === 'image2' ? 'Image2 抠图失败' : '第三方抠图失败'}，已 fallback 到 sharp。${primary.error?.message || ''}`,
        outputRoot
      });
    }
  }

  return normalizeResult({
    task,
    sourceImage,
    providerResult: primary,
    requestedProvider: requested,
    providerUsed: primary.provider || providerName,
    fallbackUsed: false,
    fallbackReason: '',
    outputRoot
  });
}

export async function compareMatting(input = {}, deps = {}) {
  const env = deps.env || process.env;
  const task = await (deps.taskReader || getTask)(input.taskId);
  if (!task) {
    const error = new Error('Task not found');
    error.statusCode = 404;
    throw error;
  }
  const sourceImage = findSourceImage(task, input.imageId);
  if (!sourceImage) {
    const error = new Error('未找到可用于抠图的商品图片');
    error.statusCode = 400;
    throw error;
  }
  const config = getMattingConfig(env);
  const sharpResult = await runMatting({ ...input, provider: 'sharp' }, deps);
  const external = config.externalConfigured
    ? await runMatting({ ...input, provider: 'external' }, deps)
    : {
      status: 'skipped',
      message: '第三方抠图 API 未配置。当前仅返回 sharp 本地抠图结果，不会产生第三方 API 成本。'
    };
  const image2 = config.image2Available
    ? await runMatting({ ...input, provider: 'image2' }, deps)
    : {
      status: 'unavailable',
      message: 'Image2 未配置，当前仅可使用 sharp 本地抠图。'
    };
  const recommendation = image2.status !== 'success' || image2.fallbackUsed
    ? { provider: 'sharp', reason: 'Image2 不可用、失败或发生 fallback，建议使用 sharp。' }
    : Number(image2.qualityScore?.score || 0) > Number(sharpResult.qualityScore?.score || 0) + 10
      ? { provider: 'image2', reason: 'Image2 评分明显高于 sharp，可人工复查后使用实验结果。' }
      : { provider: 'sharp', reason: 'sharp 更稳定，默认建议使用 sharp。' };
  return sanitizeValue({
    originalImage: sourceImageSummary(sourceImage),
    sharp: sharpResult,
    external,
    image2,
    sharpResult,
    image2Result: image2,
    recommendation
  });
}
