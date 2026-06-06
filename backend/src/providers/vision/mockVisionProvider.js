import { recognizeProduct } from '../../services/mockVisionService.js';
import { BaseVisionProvider } from './baseVisionProvider.js';

export class MockVisionProvider extends BaseVisionProvider {
  constructor() {
    super({ provider: 'mock', model: 'mock-vision-v0.2' });
  }

  async recognize({ images = [] } = {}) {
    const startedAt = Date.now();
    try {
      return this.success({
        startedAt,
        data: recognizeProduct({ images }),
        rawResponse: 'mock'
      });
    } catch (error) {
      return this.failure({
        startedAt,
        code: 'UNKNOWN_ERROR',
        message: error.message
      });
    }
  }
}
