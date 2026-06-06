import { ReviewProvider } from '../ReviewProvider.js';
import { reviewGeneratedImage } from '../../services/complianceService.js';

export class MockReviewProvider extends ReviewProvider {
  provider = 'mock';
  model = 'mock-review-v0.2';

  async review({ image }) {
    const startedAt = Date.now();
    try {
      const data = reviewGeneratedImage(image, {
        provider: this.provider,
        model: this.model,
        durationMs: Date.now() - startedAt
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
