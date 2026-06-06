function numberEnv(name, fallback = 0) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

export function getProviderCostConfig() {
  return {
    vision: {
      gemini: { perCall: numberEnv('COST_VISION_GEMINI_PER_CALL'), note: 'Configure manually' },
      openai: { perCall: numberEnv('COST_VISION_OPENAI_PER_CALL'), note: 'Configure manually' },
      qwen: { perCall: numberEnv('COST_VISION_QWEN_PER_CALL'), note: 'Configure manually' },
      mock: { perCall: numberEnv('COST_VISION_MOCK_PER_CALL') }
    },
    image: {
      openai: { perCall: numberEnv('COST_IMAGE_OPENAI_PER_CALL'), note: 'Configure manually' },
      qwen: { perCall: numberEnv('COST_IMAGE_QWEN_PER_CALL'), note: 'Configure manually' },
      gemini: { perCall: numberEnv('COST_IMAGE_GEMINI_PER_CALL'), note: 'Configure manually' },
      mock: { perCall: numberEnv('COST_IMAGE_MOCK_PER_CALL') }
    },
    review: {
      gemini: { perCall: numberEnv('COST_REVIEW_GEMINI_PER_CALL') },
      openai: { perCall: numberEnv('COST_REVIEW_OPENAI_PER_CALL') },
      qwen: { perCall: numberEnv('COST_REVIEW_QWEN_PER_CALL') },
      mock: { perCall: numberEnv('COST_REVIEW_MOCK_PER_CALL') }
    },
    matting: {
      external: { perCall: numberEnv('COST_MATTING_EXTERNAL_PER_CALL') },
      sharp: { perCall: numberEnv('COST_MATTING_SHARP_PER_CALL') },
      mock: { perCall: numberEnv('COST_MATTING_MOCK_PER_CALL') }
    }
  };
}

export function getProviderCallCost(action, provider) {
  const config = getProviderCostConfig();
  return config[action]?.[provider]?.perCall ?? 0;
}
