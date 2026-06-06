import {
  getSelectedVisionModel,
  getSelectedVisionProvider
} from '../config/env.js';

const PROVIDER_ENV = {
  mock: [],
  gemini: ['GEMINI_API_KEY'],
  openai: ['OPENAI_API_KEY'],
  qwen: ['QWEN_API_KEY'],
  nvidia: ['NVIDIA_API_KEY'],
  image2: ['IMAGE2_API_KEY'],
  custom: ['BACKGROUND_API_KEY']
};

function configured(requiredVariables = []) {
  return requiredVariables.every((name) => Boolean(process.env[name]));
}

function missing(requiredVariables = []) {
  return requiredVariables.filter((name) => !process.env[name]);
}

function imageProviderName() {
  const imageProvider = String(process.env.IMAGE_PROVIDER || process.env.AI_PROVIDER || 'mock').toLowerCase();
  if (imageProvider === 'real') return String(process.env.BACKGROUND_PROVIDER || 'mock').toLowerCase();
  return imageProvider;
}

function imageModel(provider) {
  if (provider === 'openai') return process.env.OPENAI_IMAGE_MODEL || process.env.IMAGE_MODEL || 'gpt-image-2';
  if (provider === 'gemini') return process.env.GEMINI_IMAGE_MODEL || process.env.IMAGE_MODEL || 'gemini-image-background';
  if (provider === 'nvidia') return process.env.NVIDIA_IMAGE_MODEL || process.env.IMAGE_MODEL || 'nvidia-image';
  if (provider === 'image2') return process.env.IMAGE2_MODEL || process.env.IMAGE_MODEL || 'image2';
  if (provider === 'qwen') return process.env.QWEN_IMAGE_MODEL || process.env.IMAGE_MODEL || 'qwen-image-background';
  if (provider === 'custom') return process.env.CUSTOM_BACKGROUND_MODEL || process.env.IMAGE_MODEL || 'custom-background';
  return 'mock-image-v0.3';
}

function reviewProviderName() {
  const provider = String(process.env.REVIEW_PROVIDER || 'mock').toLowerCase();
  if (provider === 'vision') return getSelectedVisionProvider();
  return provider;
}

function reviewModel(provider) {
  if (provider === 'openai') return process.env.OPENAI_REVIEW_MODEL || process.env.REVIEW_MODEL || process.env.OPENAI_VISION_MODEL || 'gpt-4.1-mini';
  if (provider === 'gemini') return process.env.GEMINI_REVIEW_MODEL || process.env.REVIEW_MODEL || process.env.GEMINI_VISION_MODEL || 'gemini-2.5-flash';
  if (provider === 'qwen') return process.env.QWEN_REVIEW_MODEL || process.env.REVIEW_MODEL || process.env.QWEN_MODEL || 'qwen-vl-max-latest';
  return 'mock-review-v3.1';
}

function statusItem({ kind, provider, model }) {
  const requiredVariables = PROVIDER_ENV[provider] || [];
  const missingVariables = missing(requiredVariables);
  return {
    kind,
    provider,
    model,
    requiredVariables,
    configured: configured(requiredVariables),
    missingVariables
  };
}

export function getProviderStatus() {
  const visionProvider = getSelectedVisionProvider();
  const imageProvider = imageProviderName();
  const reviewProvider = reviewProviderName();
  const vision = statusItem({
    kind: 'vision',
    provider: visionProvider,
    model: getSelectedVisionModel(visionProvider)
  });
  const image = statusItem({
    kind: 'image',
    provider: imageProvider,
    model: imageModel(imageProvider)
  });
  const review = statusItem({
    kind: 'review',
    provider: reviewProvider,
    model: reviewModel(reviewProvider)
  });
  return {
    modes: {
      mockAvailable: true,
      realTestAvailable: vision.configured && image.configured && review.configured,
      realTestDescription: '真实 API 仅用于识别、生图、审核；平台上传仍为 dry-run。'
    },
    vision,
    image,
    review,
    upload: {
      mode: 'dry-run',
      realUploadEnabled: false,
      readyForRealUpload: false
    }
  };
}
