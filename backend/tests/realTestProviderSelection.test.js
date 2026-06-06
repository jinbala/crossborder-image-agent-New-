import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { getProviders } from '../src/providers/index.js';

const originalEnv = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnv };
});

test('mock mode keeps mock providers even when real env providers are selected', () => {
  process.env.VISION_PROVIDER = 'gemini';
  process.env.IMAGE_PROVIDER = 'real';
  process.env.BACKGROUND_PROVIDER = 'openai';
  process.env.REVIEW_PROVIDER = 'openai';

  const providers = getProviders('mock');

  assert.equal(providers.vision.provider, 'mock');
  assert.equal(providers.image.provider, 'mock');
  assert.equal(providers.review.provider, 'mock');
});

test('real-test mode selects configured real providers', () => {
  process.env.VISION_PROVIDER = 'gemini';
  process.env.IMAGE_PROVIDER = 'real';
  process.env.BACKGROUND_PROVIDER = 'openai';
  process.env.REVIEW_PROVIDER = 'openai';

  const providers = getProviders('real-test');

  assert.equal(providers.vision.provider, 'gemini');
  assert.notEqual(providers.image.provider, 'mock');
  assert.notEqual(providers.review.provider, 'mock');
});
