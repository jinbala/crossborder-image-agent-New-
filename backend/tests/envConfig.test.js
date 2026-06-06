import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadEnvConfig, getProviderConfigSummary } from '../src/config/env.js';

const originalEnv = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnv };
});

test('loads project root env even when backend is the working directory', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'crossborder-env-'));
  const backendDir = path.join(tempRoot, 'backend');
  await fs.mkdir(backendDir);
  await fs.writeFile(path.join(tempRoot, '.env'), [
    'AI_PROVIDER=mock',
    'VISION_PROVIDER=gemini',
    'GEMINI_API_KEY=local-test-key'
  ].join('\n'));

  delete process.env.AI_PROVIDER;
  delete process.env.VISION_PROVIDER;
  delete process.env.GEMINI_API_KEY;

  loadEnvConfig({ projectRoot: tempRoot, backendRoot: backendDir });

  assert.equal(process.env.AI_PROVIDER, 'mock');
  assert.equal(process.env.VISION_PROVIDER, 'gemini');
  assert.equal(process.env.GEMINI_API_KEY, 'local-test-key');
});

test('provider config summary exposes provider choice and key presence only', () => {
  process.env.AI_PROVIDER = 'mock';
  process.env.VISION_PROVIDER = 'gemini';
  process.env.GEMINI_API_KEY = 'secret-value';
  process.env.OPENAI_API_KEY = '';
  delete process.env.QWEN_API_KEY;

  const summary = getProviderConfigSummary();

  assert.equal(summary.AI_PROVIDER, 'mock');
  assert.equal(summary.VISION_PROVIDER, 'gemini');
  assert.equal(summary.selectedVisionProvider, 'gemini');
  assert.equal(summary.hasGeminiKey, true);
  assert.equal(summary.hasOpenAIKey, false);
  assert.equal(summary.hasQwenKey, false);
  assert.equal(JSON.stringify(summary).includes('secret-value'), false);
});

test('provider config summary reads OpenAI image model from environment', () => {
  process.env.IMAGE_PROVIDER = 'real';
  process.env.BACKGROUND_PROVIDER = 'openai';
  process.env.OPENAI_IMAGE_MODEL = 'gpt-image-2';
  process.env.IMAGE_MODEL = 'fallback-image-model';

  const summary = getProviderConfigSummary();

  assert.equal(summary.selectedImageProvider, 'real');
  assert.equal(summary.selectedBackgroundProvider, 'openai');
  assert.equal(summary.selectedBackgroundModel, 'gpt-image-2');
});
