import { SharpMattingProvider } from './sharpMattingProvider.js';
import { ExternalMattingProvider } from './externalMattingProvider.js';
import { Image2MattingProvider } from './image2MattingProvider.js';
import { MockMattingProvider } from './mockMattingProvider.js';

export function getMattingProvider(providerName = process.env.MATTING_PROVIDER || 'sharp', options = {}) {
  const provider = String(providerName || 'sharp').toLowerCase();
  if (provider === 'sharp') return new SharpMattingProvider(options.sharp);
  if (provider === 'mock') return new MockMattingProvider();
  if (provider === 'external') return new ExternalMattingProvider(options.external);
  if (provider === 'image2') return new Image2MattingProvider(options.image2);
  return new SharpMattingProvider();
}

export async function extractSubjectWithFallback({
  providerName = process.env.MATTING_PROVIDER || 'sharp',
  task,
  sourceImage,
  generationRequest,
  providerOptions = {}
}) {
  const selectedProvider = String(providerName || 'sharp').toLowerCase();
  const primary = getMattingProvider(selectedProvider, providerOptions);
  const primaryResult = await primary.extractSubject({ task, sourceImage, generationRequest });
  const fallbackProvider = String(process.env.MATTING_FALLBACK_PROVIDER || 'sharp').toLowerCase();
  if (primaryResult.status === 'success' || selectedProvider !== 'external' || fallbackProvider !== 'sharp') {
    return primaryResult;
  }

  const fallback = new SharpMattingProvider(providerOptions.sharp);
  const fallbackResult = await fallback.extractSubject({ task, sourceImage, generationRequest });
  if (fallbackResult.status !== 'success') return primaryResult;
  return {
    ...fallbackResult,
    metadata: {
      ...fallbackResult.metadata,
      mattingFallbackToSharp: true,
      externalMattingError: primaryResult.error
    }
  };
}

export { SharpMattingProvider, ExternalMattingProvider, Image2MattingProvider, MockMattingProvider };
