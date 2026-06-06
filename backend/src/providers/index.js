import { getVisionProvider } from './vision/index.js';
import { getImageProvider } from './image/index.js';
import { getReviewProvider } from './review/index.js';
import { MockVisionProvider } from './vision/mockVisionProvider.js';
import { MockImageProvider } from './mock/MockImageProvider.js';
import { MockReviewProvider } from './review/MockReviewProvider.js';

export function getProviders(providerName) {
  const mode = typeof providerName === 'string'
    ? providerName
    : providerName?.mode;
  const normalizedMode = String(mode || 'mock').toLowerCase();

  if (providerName !== undefined && ['mock', 'mockonly', 'preview'].includes(normalizedMode)) {
    return {
      vision: new MockVisionProvider(),
      image: new MockImageProvider(),
      review: new MockReviewProvider()
    };
  }

  return {
    vision: getVisionProvider(),
    image: getImageProvider(),
    review: getReviewProvider('real')
  };
}

export { getReviewProvider };
