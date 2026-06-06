import { MockReviewProvider } from './MockReviewProvider.js';
import { RealVisionReviewProvider } from './RealVisionReviewProvider.js';

export function getSelectedReviewProvider() {
  return (process.env.REVIEW_PROVIDER || 'mock').toLowerCase();
}

export function getReviewProvider(mode = 'mock') {
  if (mode === 'mock') return new MockReviewProvider();
  const provider = getSelectedReviewProvider();
  if (provider === 'mock') return new MockReviewProvider();
  if (['vision', 'gemini', 'openai', 'qwen'].includes(provider)) {
    return new RealVisionReviewProvider(provider === 'vision' ? (process.env.VISION_PROVIDER || 'gemini').toLowerCase() : provider);
  }
  const error = new Error(`Unsupported REVIEW_PROVIDER: ${provider}`);
  error.statusCode = 500;
  throw error;
}
