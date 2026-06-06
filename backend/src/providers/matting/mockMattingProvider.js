import { SharpMattingProvider } from './sharpMattingProvider.js';

export class MockMattingProvider extends SharpMattingProvider {
  provider = 'mock';
  model = 'mock-matting-sharp-v1';
}
