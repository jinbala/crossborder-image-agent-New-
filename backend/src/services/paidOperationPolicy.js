// HTTP-boundary approval guard. Internal mock fixtures do not grant HTTP approval.
function originOf(value) {
  try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) ? url.origin : null; } catch { return null; }
}
export function providerOrigin(provider) {
  const selected = String(provider || 'mock').toLowerCase();
  const defaults = { openai: 'https://api.openai.com/v1', gemini: 'https://generativelanguage.googleapis.com/v1beta', qwen: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1' };
  if (!Object.hasOwn(defaults, selected)) return null;
  return originOf(process.env[`${selected.toUpperCase()}_BASE_URL`] || defaults[selected]);
}
export function paidProviderSummary() {
  const vision = String(process.env.VISION_PROVIDER || process.env.AI_PROVIDER || 'mock').toLowerCase();
  const configuredReview = String(process.env.REVIEW_PROVIDER || 'mock').toLowerCase();
  const review = configuredReview === 'vision' ? vision : configuredReview;
  const background = String(process.env.BACKGROUND_PROVIDER || 'mock').toLowerCase();
  const matting = String(process.env.MATTING_PROVIDER || 'sharp').toLowerCase();
  return {
    ...Object.fromEntries(Object.entries({ vision, review, background, image: 'openai' }).map(([kind, provider]) => [kind, { provider, origin: providerOrigin(provider), costVerified: false }])),
    matting: { provider: matting, local: ['sharp', 'rembg'].includes(matting), origin: matting === 'image2' ? providerOrigin('openai') : matting === 'external' ? originOf(process.env.MATTING_BASE_URL) : null, costVerified: false }
  };
}
export function requirePaidConfirmation(body, required) {
  if (required && body?.confirmPaidApi !== true) {
    const error = new Error('confirmPaidApi=true is required for this operation; images or product data may leave this device and failed calls may still be charged.');
    error.statusCode = 403;
    error.code = 'PAID_OPERATION_NOT_CONFIRMED';
    throw error;
  }
}
export function isRealQueueMode(mode) { return ['real', 'real-test', 'real_test'].includes(String(mode || '').toLowerCase()); }
