import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import {
  compareMatting,
  getMattingConfig,
  runMatting
} from '../src/services/mattingService.js';
import { Image2MattingProvider } from '../src/providers/matting/image2MattingProvider.js';

test('generation approval destination contains only an HTTP origin, not URL credentials, paths or query keys', () => {
  const config = getMattingConfig({ OPENAI_BASE_URL: 'https://user:password@images.example/private?token=secret', OPENAI_API_KEY: 'sk-private-secret' });
  assert.equal(config.generationDestination.origin, 'https://images.example');
  assert.doesNotMatch(JSON.stringify(config), /password|private\?|token=secret|sk-private-secret/);
  assert.equal(getMattingConfig({ OPENAI_BASE_URL: 'javascript:alert(1)' }).generationDestination.origin, null);
});

async function makeImage() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cia-matting-service-'));
  const imagePath = path.join(dir, 'source.png');
  await sharp({
    create: { width: 100, height: 100, channels: 4, background: '#ffffff' }
  }).composite([
    { input: Buffer.from('<svg width="100" height="100" xmlns="http://www.w3.org/2000/svg"><rect x="30" y="20" width="40" height="60" fill="#111827"/></svg>') }
  ]).png().toFile(imagePath);
  return { dir, imagePath };
}

function taskFor(imagePath) {
  return {
    id: 'task-matting-1',
    sourceImages: [{
      id: 'image-1',
      displayName: 'source.png',
      filePath: imagePath,
      previewUrl: '/uploads/source.png'
    }]
  };
}

function providerResult(provider, outputPath, status = 'success') {
  return {
    provider,
    model: `${provider}-model`,
    method: `${provider}-method`,
    status,
    durationMs: 12,
    error: status === 'success' ? null : { code: 'BROKEN', message: 'external failed' },
    output: status === 'success' ? {
      subjectPngPath: outputPath,
      width: 100,
      height: 100,
      hasAlpha: true
    } : null,
    metadata: {
      confidence: status === 'success' ? 0.8 : 0,
      warnings: status === 'success' ? [] : ['external_failed']
    }
  };
}

test('matting config defaults to sharp and never exposes external API key', () => {
  const config = getMattingConfig({
    MATTING_PROVIDER: '',
    MATTING_EXTERNAL_API_URL: '',
    MATTING_EXTERNAL_API_KEY: 'secret-key'
  });

  assert.equal(config.currentProvider, 'sharp');
  assert.equal(config.defaultProvider, 'sharp');
  assert.equal(config.externalConfigured, false);
  assert.deepEqual(config.availableProviders, ['sharp', 'rembg', 'external', 'image2', 'auto']);
  assert.equal(JSON.stringify(config).includes('secret-key'), false);
  assert.match(config.warning, /第三方抠图 API 未配置/);
});

test('matting config exposes Image2 availability without returning API key', () => {
  const unavailable = getMattingConfig({
    OPENAI_API_KEY: '',
    OPENAI_IMAGE_MODEL: 'gpt-image-2'
  });
  const available = getMattingConfig({
    OPENAI_API_KEY: 'sk-secret',
    OPENAI_IMAGE_MODEL: 'gpt-image-2'
  });

  assert.equal(unavailable.image2Available, false);
  assert.match(unavailable.warning, /Image2 未配置/);
  assert.equal(available.image2Available, true);
  assert.equal(available.externalProviders.includes('image2'), true);
  assert.equal(available.image2ModeLabel, '实验性抠图');
  assert.match(available.costNotice, /Image2 抠图测试可能产生 API 成本/);
  assert.equal(JSON.stringify(available).includes('sk-secret'), false);
});

test('Image2 matting provider parses edited output and marks experimental outputType', async () => {
  const { dir, imagePath } = await makeImage();
  const outputBuffer = await fs.readFile(imagePath);
  const provider = new Image2MattingProvider({
    apiKey: 'sk-secret',
    client: {
      images: {
        edit: async () => ({
          data: [{
            b64_json: outputBuffer.toString('base64'),
            output_type: 'edited-background-removed'
          }]
        })
      }
    }
  });

  const result = await provider.extractSubject({
    task: { id: 'task-image2-provider' },
    sourceImage: taskFor(imagePath).sourceImages[0]
  });

  assert.equal(result.status, 'success');
  assert.equal(result.provider, 'image2');
  assert.match(result.output.subjectPngPath, /\.png$/);
  assert.match(result.metadata.outputType, /transparent|edited-background-removed|simulated/);
  assert.equal(JSON.stringify(result).includes('sk-secret'), false);
  await fs.rm(dir, { recursive: true, force: true });
});

test('Image2 matting provider sends the source image with a supported MIME type', async () => {
  const { dir, imagePath } = await makeImage();
  const outputBuffer = await fs.readFile(imagePath);
  let capturedImage = null;
  const provider = new Image2MattingProvider({
    apiKey: 'sk-secret',
    client: {
      images: {
        edit: async ({ image }) => {
          capturedImage = image;
          return {
            data: [{
              b64_json: outputBuffer.toString('base64'),
              output_type: 'edited-background-removed'
            }]
          };
        }
      }
    }
  });

  const result = await provider.extractSubject({
    task: { id: 'task-image2-provider' },
    sourceImage: taskFor(imagePath).sourceImages[0]
  });

  assert.equal(result.status, 'success');
  assert.equal(capturedImage.type, 'image/png');
  assert.equal(capturedImage.name, 'source.png');
  await fs.rm(dir, { recursive: true, force: true });
});

test('runMatting does not call external when external is not configured and falls back to sharp', async () => {
  const { dir, imagePath } = await makeImage();
  let externalCalls = 0;
  const result = await runMatting({
    taskId: 'task-matting-1',
    imageId: 'image-1',
    provider: 'external'
  }, {
    env: { MATTING_PROVIDER: 'external', MATTING_EXTERNAL_API_URL: '', MATTING_EXTERNAL_API_KEY: '' },
    taskReader: async () => taskFor(imagePath),
    outputRoot: dir,
    providers: {
      sharp: { extractSubject: async () => providerResult('sharp', imagePath) },
      external: { extractSubject: async () => { externalCalls += 1; return providerResult('external', imagePath); } }
    }
  });

  assert.equal(externalCalls, 0);
  assert.equal(result.providerUsed, 'sharp');
  assert.equal(result.fallbackUsed, true);
  assert.match(result.fallbackReason, /第三方抠图 API 未配置/);
  assert.equal(result.status, 'success');
  assert.equal(JSON.stringify(result).includes(imagePath), false);
  await fs.rm(dir, { recursive: true, force: true });
});

test('runMatting does not call Image2 when unavailable and falls back to sharp', async () => {
  const { dir, imagePath } = await makeImage();
  let image2Calls = 0;
  const result = await runMatting({
    taskId: 'task-matting-1',
    imageId: 'image-1',
    provider: 'image2'
  }, {
    env: { OPENAI_API_KEY: '', OPENAI_IMAGE_MODEL: 'gpt-image-2' },
    taskReader: async () => taskFor(imagePath),
    outputRoot: dir,
    providers: {
      sharp: { extractSubject: async () => providerResult('sharp', imagePath) },
      image2: { extractSubject: async () => { image2Calls += 1; return providerResult('image2', imagePath); } }
    }
  });

  assert.equal(image2Calls, 0);
  assert.equal(result.requestedProvider, 'image2');
  assert.equal(result.providerUsed, 'sharp');
  assert.equal(result.outputType, 'transparent');
  assert.equal(result.fallbackUsed, true);
  assert.match(result.fallbackReason, /Image2 未配置/);
  assert.equal(result.qualityScore.details.hasOutput, true);
  await fs.rm(dir, { recursive: true, force: true });
});

test('runMatting falls back to sharp when Image2 fails and records requested provider', async () => {
  const { dir, imagePath } = await makeImage();
  const result = await runMatting({
    taskId: 'task-matting-1',
    imageId: 'image-1',
    provider: 'image2'
  }, {
    env: { OPENAI_API_KEY: 'sk-secret', OPENAI_IMAGE_MODEL: 'gpt-image-2' },
    taskReader: async () => taskFor(imagePath),
    outputRoot: dir,
    providers: {
      sharp: { extractSubject: async () => providerResult('sharp', imagePath) },
      image2: { extractSubject: async () => providerResult('image2', imagePath, 'failed') }
    }
  });

  assert.equal(result.requestedProvider, 'image2');
  assert.equal(result.providerUsed, 'sharp');
  assert.equal(result.fallbackUsed, true);
  assert.match(result.fallbackReason, /Image2 抠图失败|external failed/);
  assert.equal(JSON.stringify(result).includes('sk-secret'), false);
  await fs.rm(dir, { recursive: true, force: true });
});

test('runMatting falls back to sharp and records fallbackReason when external fails', async () => {
  const { dir, imagePath } = await makeImage();
  const result = await runMatting({
    taskId: 'task-matting-1',
    imageId: 'image-1',
    provider: 'external'
  }, {
    env: {
      MATTING_PROVIDER: 'external',
      MATTING_EXTERNAL_API_URL: 'https://matting.example/api',
      MATTING_EXTERNAL_API_KEY: 'secret-key'
    },
    taskReader: async () => taskFor(imagePath),
    outputRoot: dir,
    providers: {
      sharp: { extractSubject: async () => providerResult('sharp', imagePath) },
      external: { extractSubject: async () => providerResult('external', imagePath, 'failed') }
    }
  });

  assert.equal(result.providerUsed, 'sharp');
  assert.equal(result.fallbackUsed, true);
  assert.match(result.fallbackReason, /external failed|第三方抠图失败/);
  assert.equal(result.qualityScore.details.fallbackUsed, true);
  assert.equal(JSON.stringify(result).includes('secret-key'), false);
  await fs.rm(dir, { recursive: true, force: true });
});

test('compareMatting returns sharp result and skips external when unavailable', async () => {
  const { dir, imagePath } = await makeImage();
  const result = await compareMatting({
    taskId: 'task-matting-1',
    imageId: 'image-1'
  }, {
    env: { MATTING_PROVIDER: 'sharp', MATTING_EXTERNAL_API_URL: '', MATTING_EXTERNAL_API_KEY: '' },
    taskReader: async () => taskFor(imagePath),
    outputRoot: dir,
    providers: {
      sharp: { extractSubject: async () => providerResult('sharp', imagePath) }
    }
  });

  assert.equal(result.sharp.status, 'success');
  assert.equal(result.external.status, 'skipped');
  assert.match(result.external.message, /第三方抠图 API 未配置/);
  assert.equal(result.sharp.qualityScore.details.hasOutput, true);
  await fs.rm(dir, { recursive: true, force: true });
});

test('compareMatting always returns sharp and attempts Image2 only when available', async () => {
  const { dir, imagePath } = await makeImage();
  let image2Calls = 0;
  const unavailable = await compareMatting({
    taskId: 'task-matting-1',
    imageId: 'image-1'
  }, {
    env: { OPENAI_API_KEY: '', OPENAI_IMAGE_MODEL: 'gpt-image-2' },
    taskReader: async () => taskFor(imagePath),
    outputRoot: dir,
    providers: {
      sharp: { extractSubject: async () => providerResult('sharp', imagePath) },
      image2: { extractSubject: async () => { image2Calls += 1; return providerResult('image2', imagePath); } }
    }
  });

  assert.equal(unavailable.sharp.status, 'success');
  assert.equal(unavailable.image2.status, 'unavailable');
  assert.equal(image2Calls, 0);

  const available = await compareMatting({
    taskId: 'task-matting-1',
    imageId: 'image-1'
  }, {
    env: { OPENAI_API_KEY: 'sk-secret', OPENAI_IMAGE_MODEL: 'gpt-image-2' },
    taskReader: async () => taskFor(imagePath),
    outputRoot: dir,
    providers: {
      sharp: { extractSubject: async () => providerResult('sharp', imagePath) },
      image2: { extractSubject: async () => { image2Calls += 1; return providerResult('image2', imagePath); } }
    }
  });

  assert.equal(available.sharp.status, 'success');
  assert.equal(available.image2.status, 'success');
  assert.equal(available.image2.requestedProvider, 'image2');
  assert.equal(available.image2.providerUsed, 'image2');
  assert.equal(available.recommendation.provider, 'sharp');
  assert.equal(image2Calls, 1);
  assert.equal(JSON.stringify(available).includes('sk-secret'), false);
  await fs.rm(dir, { recursive: true, force: true });
});
