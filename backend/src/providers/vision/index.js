import { MockVisionProvider } from './mockVisionProvider.js';
import { QwenVisionProvider } from './qwenVisionProvider.js';
import { OpenAIVisionProvider } from './openaiVisionProvider.js';
import { GeminiVisionProvider } from './geminiVisionProvider.js';

export function getVisionProvider() {
  const provider = (process.env.VISION_PROVIDER || process.env.AI_PROVIDER || 'mock').toLowerCase();

  if (provider === 'mock') return new MockVisionProvider();
  if (provider === 'qwen') return new QwenVisionProvider();
  if (provider === 'openai') return new OpenAIVisionProvider();
  if (provider === 'gemini') return new GeminiVisionProvider();

  const error = new Error(`Unsupported VISION_PROVIDER: ${provider}`);
  error.statusCode = 500;
  throw error;
}
