export function normalizeReviewMode(input) {
  if (input === 'real' || input === 'mock') return input;
  if (input && typeof input === 'object' && (input.mode === 'real' || input.mode === 'mock')) {
    return input.mode;
  }
  return 'mock';
}

export function normalizeReviewOptions(input = {}) {
  return {
    mode: normalizeReviewMode(input)
  };
}
