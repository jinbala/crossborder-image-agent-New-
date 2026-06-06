const presets = {
  fast: {
    mode: 'fast',
    imageMaxWidth: 960,
    imageQuality: 70,
    visibleTextLimitPerImage: 5,
    visibleTextTotalLimit: 40,
    maxImages: 8,
    requestTimeoutMs: 90000
  },
  balanced: {
    mode: 'balanced',
    imageMaxWidth: 1280,
    imageQuality: 75,
    visibleTextLimitPerImage: 10,
    visibleTextTotalLimit: 80,
    maxImages: 12,
    requestTimeoutMs: 300000
  },
  full: {
    mode: 'full',
    imageMaxWidth: 1600,
    imageQuality: 85,
    visibleTextLimitPerImage: 15,
    visibleTextTotalLimit: 120,
    maxImages: 15,
    requestTimeoutMs: 300000
  }
};

const priorityKeywords = [
  { pattern: /(^|[-_\s])main|主图/i, score: 100 },
  { pattern: /size|尺寸/i, score: 90 },
  { pattern: /spec|参数/i, score: 88 },
  { pattern: /capacity|容量/i, score: 86 },
  { pattern: /interface|接口/i, score: 84 },
  { pattern: /package|包装/i, score: 82 },
  { pattern: /feature|卖点/i, score: 78 },
  { pattern: /detail|细节/i, score: 74 },
  { pattern: /compatible|兼容/i, score: 72 }
];

function numberOrDefault(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

export function normalizeRecognitionMode(mode) {
  const normalized = String(mode || 'balanced').trim().toLowerCase();
  return presets[normalized] ? normalized : 'balanced';
}

export function getVisionRecognitionConfig(env = process.env) {
  const mode = normalizeRecognitionMode(env.VISION_RECOGNITION_MODE);
  const preset = presets[mode];
  const modeTimeoutKey = `VISION_${mode.toUpperCase()}_TIMEOUT_MS`;
  return {
    mode,
    imageMaxWidth: numberOrDefault(env.VISION_IMAGE_MAX_WIDTH, preset.imageMaxWidth),
    imageQuality: numberOrDefault(env.VISION_IMAGE_QUALITY, preset.imageQuality),
    visibleTextLimitPerImage: numberOrDefault(env.VISION_VISIBLE_TEXT_LIMIT_PER_IMAGE, preset.visibleTextLimitPerImage),
    visibleTextTotalLimit: numberOrDefault(env.VISION_VISIBLE_TEXT_TOTAL_LIMIT, preset.visibleTextTotalLimit),
    maxImages: Math.min(15, numberOrDefault(env.VISION_MAX_IMAGES_SENT, preset.maxImages)),
    requestTimeoutMs: numberOrDefault(env[modeTimeoutKey] ?? (mode === 'fast' ? undefined : env.VISION_TIMEOUT_MS), preset.requestTimeoutMs)
  };
}

export function applyRecognitionModeToEnv(mode, env = process.env) {
  const normalized = normalizeRecognitionMode(mode);
  const preset = presets[normalized];
  env.VISION_RECOGNITION_MODE = normalized;
  env.VISION_IMAGE_MAX_WIDTH = String(preset.imageMaxWidth);
  env.VISION_IMAGE_QUALITY = String(preset.imageQuality);
  env.VISION_VISIBLE_TEXT_LIMIT_PER_IMAGE = String(preset.visibleTextLimitPerImage);
  env.VISION_VISIBLE_TEXT_TOTAL_LIMIT = String(preset.visibleTextTotalLimit);
  env.VISION_MAX_IMAGES_SENT = String(preset.maxImages);
  env[`VISION_${normalized.toUpperCase()}_TIMEOUT_MS`] = String(preset.requestTimeoutMs);
  return getVisionRecognitionConfig(env);
}

function imageName(image = {}) {
  return image.displayName || image.originalName || image.fileName || image.storedName || '';
}

export function visionImagePriority(image = {}) {
  const name = imageName(image);
  const matched = priorityKeywords.find((item) => item.pattern.test(name));
  return matched ? matched.score : 0;
}

export function selectVisionImagesForMode(images = [], env = process.env) {
  const config = getVisionRecognitionConfig(env);
  const ranked = images
    .slice(0, 15)
    .map((image, index) => ({ image, index, priority: visionImagePriority(image), name: imageName(image) }))
    .sort((a, b) => b.priority - a.priority || a.name.localeCompare(b.name) || a.index - b.index);
  const selected = ranked.slice(0, config.maxImages).map((entry) => entry.image);
  const skipped = ranked.slice(config.maxImages).map((entry) => entry.image);

  return {
    selectedImages: selected,
    skippedImages: skipped,
    config
  };
}
