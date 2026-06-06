import { MockImageProvider } from '../mock/MockImageProvider.js';
import { RealBackgroundImageProvider } from './RealBackgroundImageProvider.js';

export function getImageProvider() {
  const imageProvider = String(process.env.IMAGE_PROVIDER || process.env.AI_PROVIDER || 'mock').toLowerCase();
  if (imageProvider === 'real') {
    return new RealBackgroundImageProvider({
      backgroundProviderName: process.env.BACKGROUND_PROVIDER || 'mock'
    });
  }
  return new MockImageProvider();
}
