import { ReviewProvider } from '../ReviewProvider.js';
import { REVIEW_PROMPT_VERSION } from './reviewPrompt.js';
import { runRuleBasedReviewChecks } from './ruleBasedReview.js';

export class MockReviewProvider extends ReviewProvider {
  provider = 'mock';
  model = 'mock-review-v3.1';

  async review({ task, image, plan, generationRequest, fallbackToMockReview = false, realReviewError = null }) {
    const startedAt = Date.now();
    try {
      const data = runRuleBasedReviewChecks({ task, image, plan, generationRequest });
      const durationMs = Date.now() - startedAt;
      return {
        provider: this.provider,
        model: this.model,
        durationMs,
        status: 'success',
        error: null,
        data: {
          ...data,
          id: `${image.id}-review`,
          imageId: image.id,
          planId: image.planId,
          targetId: image.targetId || plan?.targetId,
          platformId: image.platformId || plan?.platformId,
          fileName: image.fileName,
          type: image.type,
          provider: this.provider,
          model: this.model,
          durationMs,
          reviewMode: 'mock',
          isRealReview: false,
          fallbackToMockReview,
          realReviewError,
          platformRuleSnapshot: data.platformChecks?.platformRuleSnapshot || null,
          categoryRuleSnapshot: data.platformChecks?.categoryRuleSnapshot || null,
          checks: {
            noChinese: { label: 'No Chinese text', status: data.textChecks.hasChinese ? 'failed' : 'passed' },
            noWatermark: { label: 'No watermark', status: data.platformChecks.watermarkDetected ? 'failed' : 'passed' },
            noPrice: { label: 'No price text', status: data.textChecks.hasPrice ? 'failed' : 'passed' },
            noFakeCertification: { label: 'No false certification', status: data.evidenceChecks.unconfirmedCertificationUsed ? 'failed' : 'passed' },
            mainImageRule: { label: 'Platform main image rule', status: data.platformChecks.mainImageTextAllowed === false ? 'failed' : 'passed' }
          },
          metadata: {
            promptVersion: REVIEW_PROMPT_VERSION,
            imageType: image.type,
            platform: plan?.platform || task.platform,
            isMockPreview: Boolean(image.isMockPreview),
            isRealGenerated: Boolean(image.isRealGenerated),
            generationStrategy: image.generationStrategy || null,
            preserveQuality: image.preserveQuality || null,
            textLayout: image.textLayout || null,
            generationRequestSummary: image.generationRequestSummary || plan?.generationRequestSummary || null,
            platformRuleSnapshot: data.platformChecks?.platformRuleSnapshot || null,
            categoryRuleSnapshot: data.platformChecks?.categoryRuleSnapshot || null
          }
        }
      };
    } catch (error) {
      return {
        provider: this.provider,
        model: this.model,
        durationMs: Date.now() - startedAt,
        status: 'failed',
        error: { code: error.code || 'MOCK_REVIEW_ERROR', message: error.message },
        data: null
      };
    }
  }
}
