function missingKeyError(keyName, provider) {
  return {
    code: 'MISSING_API_KEY',
    message: `${keyName} is required for BACKGROUND_PROVIDER=${provider}`
  };
}

function unsupportedError(provider) {
  return {
    code: 'UNSUPPORTED_BACKGROUND_PROVIDER',
    message: `${provider} background generation is scaffolded but not implemented yet.`
  };
}

function failedResult({ provider, model, startedAt, error }) {
  return {
    provider,
    model,
    mode: 'background_replace',
    status: 'failed',
    durationMs: Date.now() - startedAt,
    error,
    output: null,
    metadata: {
      fallbackToMock: false,
      realGenerationError: error
    }
  };
}

class ScaffoldedBackgroundProvider {
  constructor({ provider, keyName, model }) {
    this.provider = provider;
    this.keyName = keyName;
    this.model = model;
  }

  async generate() {
    const startedAt = Date.now();
    if (!process.env[this.keyName]) {
      return failedResult({
        provider: this.provider,
        model: this.model,
        startedAt,
        error: missingKeyError(this.keyName, this.provider)
      });
    }
    return failedResult({
      provider: this.provider,
      model: this.model,
      startedAt,
      error: unsupportedError(this.provider)
    });
  }
}

export function getBackgroundProvider(providerName = process.env.BACKGROUND_PROVIDER || 'mock') {
  const provider = String(providerName || 'mock').toLowerCase();
  if (provider === 'qwen') {
    return new ScaffoldedBackgroundProvider({
      provider: 'qwen',
      keyName: 'QWEN_API_KEY',
      model: process.env.QWEN_IMAGE_MODEL || process.env.IMAGE_MODEL || 'qwen-image-background'
    });
  }
  if (provider === 'openai') {
    return new OpenAIBackgroundProvider();
  }
  if (provider === 'gemini') {
    return new ScaffoldedBackgroundProvider({
      provider: 'gemini',
      keyName: 'GEMINI_API_KEY',
      model: process.env.GEMINI_IMAGE_MODEL || process.env.IMAGE_MODEL || 'gemini-image-background'
    });
  }
  if (provider === 'custom') {
    return new ScaffoldedBackgroundProvider({
      provider: 'custom',
      keyName: 'BACKGROUND_API_KEY',
      model: process.env.CUSTOM_BACKGROUND_MODEL || process.env.IMAGE_MODEL || 'custom-background'
    });
  }
  return null;
}
import { OpenAIBackgroundProvider } from './openaiBackgroundProvider.js';
