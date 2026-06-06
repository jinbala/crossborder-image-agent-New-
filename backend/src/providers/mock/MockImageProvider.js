import { ImageProvider } from '../ImageProvider.js';
import { generateMockImageForPlan } from '../../services/mockImageService.js';

export class MockImageProvider extends ImageProvider {
  provider = 'mock';
  model = 'mock-image-v0.3';

  async generate({ task, plan, outputIndex, version, regenerate }) {
    const startedAt = Date.now();
    try {
      const data = await generateMockImageForPlan({
        task,
        plan,
        outputIndex,
        version,
        regenerate,
        provider: this.provider,
        model: this.model
      });
      return {
        provider: this.provider,
        model: this.model,
        durationMs: Date.now() - startedAt,
        status: 'succeeded',
        error: null,
        data
      };
    } catch (error) {
      return {
        provider: this.provider,
        model: this.model,
        durationMs: Date.now() - startedAt,
        status: 'failed',
        error: error.message,
        data: null
      };
    }
  }
}
