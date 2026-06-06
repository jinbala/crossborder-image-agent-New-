import { MockImageProvider } from '../mock/MockImageProvider.js';
import { buildGenerationRequest, generationRequestSummary } from '../../services/generationRequestService.js';
import { getBackgroundProvider } from './backgroundProviders.js';
import {
  assessProductPreserveQuality,
  buildGenerationStrategy
} from '../../services/productPreserveQualityService.js';

function canUseRealBackground(plan, generationRequest, mode = 'mock') {
  const realTestSupportedTypes = new Set(['main_image', 'feature_image', 'detail_image', 'lifestyle_image']);
  if (mode === 'real-test') {
    return realTestSupportedTypes.has(plan.type) &&
      generationRequest.providerHints?.safeForRealGeneration === true;
  }
  return (
    plan.type === 'lifestyle_image' &&
    generationRequest.providerHints?.preferredMode === 'background_replace' &&
    generationRequest.providerHints?.safeForRealGeneration === true
  );
}

function skipReason(plan, generationRequest) {
  const issues = [];
  if (plan.type !== 'lifestyle_image') issues.push('Only lifestyle_image supports real background generation.');
  if (generationRequest.providerHints?.preferredMode !== 'background_replace') issues.push('preferredMode must be background_replace.');
  if (generationRequest.providerHints?.safeForRealGeneration !== true) {
    issues.push(`safeForRealGeneration is false: ${(generationRequest.providerHints?.blockingIssues || []).join('; ')}`);
  }
  return issues.join(' ');
}

function decorateMock(result, patch, { plan, generationRequest } = {}) {
  const decoratedData = {
    ...result.data,
    targetId: plan?.targetId,
    platformId: plan?.platformId,
    platformName: plan?.platformName,
    site: plan?.site,
    language: plan?.language,
    categoryId: plan?.categoryId,
    isMockPreview: true,
    isRealGenerated: false,
    productReferenceUsed: false,
    realBackgroundOnly: false,
    editAttempted: false,
    editSucceeded: false,
    editFailed: false,
    fallbackMode: null,
    ...patch,
    generationRequestSummary: patch.generationRequestSummary || result.data?.generationRequestSummary
  };
  return {
    ...result,
    data: {
      ...decoratedData,
      preserveQuality: patch.preserveQuality || assessProductPreserveQuality(decoratedData),
      generationStrategy: patch.generationStrategy || buildGenerationStrategy({
        selectedMode: decoratedData.fallbackToMock || decoratedData.isMockPreview ? 'mock' : decoratedData.realGenerationMode,
        generationRequest,
        plan
      })
    }
  };
}

export class RealBackgroundImageProvider {
  provider = 'real-background-wrapper';
  model = 'background-router-v1.9';

  constructor({ backgroundProviderName = process.env.BACKGROUND_PROVIDER || 'mock' } = {}) {
    this.backgroundProviderName = backgroundProviderName;
    this.mockProvider = new MockImageProvider();
  }

  async generate({ task, plan, outputIndex, version, regenerate, mode = 'mock', realMode = 'auto' }) {
    const generationRequest = buildGenerationRequest({ task, plan });
    const summary = generationRequestSummary(generationRequest);

    if (mode !== 'real_background') {
      return this.mockProvider.generate({ task, plan, outputIndex, version, regenerate });
    }

      if (!canUseRealBackground(plan, generationRequest, mode)) {
      const mock = await this.mockProvider.generate({ task, plan, outputIndex, version, regenerate });
      return decorateMock(mock, {
        mode: 'mock',
        realGenerationSkipped: true,
        skipReason: skipReason(plan, generationRequest),
        generationRequest,
        generationRequestSummary: summary
      }, { plan, generationRequest });
    }

    const backgroundProvider = getBackgroundProvider(this.backgroundProviderName);
    if (!backgroundProvider) {
      const mock = await this.mockProvider.generate({ task, plan, outputIndex, version, regenerate });
      return decorateMock(mock, {
        mode: 'background_replace',
        fallbackToMock: true,
        realGenerationError: {
          code: 'UNSUPPORTED_BACKGROUND_PROVIDER',
          message: `Unsupported BACKGROUND_PROVIDER: ${this.backgroundProviderName}`
        },
        generationRequest,
        generationRequestSummary: summary
      }, { plan, generationRequest });
    }

    const realResult = await backgroundProvider.generate({ task, plan, generationRequest, realMode });
    if (realResult.status !== 'success') {
      const mock = await this.mockProvider.generate({ task, plan, outputIndex, version, regenerate });
      const recommended = buildGenerationStrategy({
        selectedMode: 'mock',
        generationRequest,
        plan
      });
      recommended.recommendedMode = realMode && realMode !== 'auto' ? realMode : recommended.recommendedMode;
      return decorateMock(mock, {
        mode: 'background_replace',
        fallbackToMock: true,
        realGenerationError: realResult.error,
        productReferenceUsed: Boolean(realResult.metadata?.productReferenceUsed),
        productReferenceSelectedBy: realResult.metadata?.productReferenceSelectedBy || null,
        productReferenceOverride: realResult.metadata?.productReferenceOverride || null,
        realBackgroundOnly: Boolean(realResult.metadata?.realBackgroundOnly),
        editAttempted: Boolean(realResult.metadata?.editAttempted),
        editSucceeded: Boolean(realResult.metadata?.editSucceeded),
        editFailed: Boolean(realResult.metadata?.editFailed),
        fallbackMode: realResult.metadata?.fallbackMode || 'mock',
      editError: realResult.metadata?.editError || null,
      productReference: realResult.metadata?.productReference || generationRequest.productReference || null,
      referencePreprocess: realResult.metadata?.referencePreprocess || null,
      realGenerationMode: realResult.metadata?.realGenerationMode || null,
      subjectCompositeUsed: Boolean(realResult.metadata?.subjectCompositeUsed),
      subjectExtractionMethod: realResult.metadata?.subjectExtractionMethod || null,
      subjectSourceImageId: realResult.metadata?.subjectSourceImageId || null,
      subjectSourceDisplayName: realResult.metadata?.subjectSourceDisplayName || null,
      subjectPreserved: Boolean(realResult.metadata?.subjectPreserved),
      backgroundGenerated: Boolean(realResult.metadata?.backgroundGenerated),
      productGeneratedByAI: realResult.metadata?.productGeneratedByAI ?? null,
      compositeMetadata: realResult.metadata?.compositeMetadata || null,
      fallbackChain: realResult.metadata?.fallbackChain || [],
      mattingProvider: realResult.metadata?.mattingProvider || null,
      mattingModel: realResult.metadata?.mattingModel || null,
      mattingMethod: realResult.metadata?.mattingMethod || null,
      mattingConfidence: realResult.metadata?.mattingConfidence ?? null,
      edgeQuality: realResult.metadata?.edgeQuality || null,
      backgroundType: realResult.metadata?.backgroundType || null,
      mattingWarnings: realResult.metadata?.mattingWarnings || [],
      mattingFallbackToSharp: Boolean(realResult.metadata?.mattingFallbackToSharp),
      externalMattingError: realResult.metadata?.externalMattingError || null,
      subjectPngPath: realResult.metadata?.subjectPngPath || null,
      maskPath: realResult.metadata?.maskPath || null,
      mattingPreviewUsed: Boolean(plan.mattingPreviewUsed),
      compositeMode: realResult.metadata?.compositeMode || null,
      compositeSettings: realResult.metadata?.compositeSettings || plan.compositeSettings || null,
      compositeQuality: realResult.metadata?.compositeQuality || null,
      subjectScale: realResult.metadata?.subjectScale ?? null,
      subjectPlacement: realResult.metadata?.subjectPlacement || null,
      shadowApplied: Boolean(realResult.metadata?.shadowApplied),
      edgeFeatherApplied: Boolean(realResult.metadata?.edgeFeatherApplied),
      colorMatchApplied: Boolean(realResult.metadata?.colorMatchApplied),
      preserveQuality: assessProductPreserveQuality({ ...mock.data, fallbackToMock: true }),
      generationStrategy: recommended,
      generationRequest,
        generationRequestSummary: summary
      }, { plan, generationRequest });
    }

    return {
      provider: realResult.provider,
      model: realResult.model,
      durationMs: realResult.durationMs,
      status: 'succeeded',
      error: null,
      data: {
        id: `${plan.id}-image`,
        planId: plan.id,
        targetId: plan.targetId,
        platformId: plan.platformId,
        platformName: plan.platformName,
        site: plan.site,
        language: plan.language,
        categoryId: plan.categoryId,
        type: plan.type,
        imageType: plan.type,
        title: plan.title,
        prompt: generationRequest.prompt.positivePrompt,
        promptPreview: generationRequest.prompt.positivePrompt.slice(0, 500),
        ...realResult.output,
        mode: 'background_replace',
        version: version || 1,
        generatedAt: new Date().toISOString(),
        regeneratedAt: regenerate || (version || 1) > 1 ? new Date().toISOString() : null,
        isMockPreview: false,
        isRealGenerated: true,
        fallbackToMock: false,
        realGenerationError: null,
        productReferenceUsed: Boolean(realResult.metadata?.productReferenceUsed),
        productReferenceSelectedBy: realResult.metadata?.productReferenceSelectedBy || null,
        productReferenceOverride: realResult.metadata?.productReferenceOverride || null,
        realBackgroundOnly: Boolean(realResult.metadata?.realBackgroundOnly),
        editAttempted: Boolean(realResult.metadata?.editAttempted),
        editSucceeded: Boolean(realResult.metadata?.editSucceeded),
        editFailed: Boolean(realResult.metadata?.editFailed),
        fallbackMode: realResult.metadata?.fallbackMode || null,
        editError: realResult.metadata?.editError || null,
        productReference: realResult.metadata?.productReference || null,
        referencePreprocess: realResult.metadata?.referencePreprocess || null,
        realGenerationMode: realResult.metadata?.realGenerationMode || null,
        subjectCompositeUsed: Boolean(realResult.metadata?.subjectCompositeUsed),
        subjectExtractionMethod: realResult.metadata?.subjectExtractionMethod || null,
        subjectSourceImageId: realResult.metadata?.subjectSourceImageId || null,
        subjectSourceDisplayName: realResult.metadata?.subjectSourceDisplayName || null,
        subjectPreserved: Boolean(realResult.metadata?.subjectPreserved),
        backgroundGenerated: Boolean(realResult.metadata?.backgroundGenerated),
        productGeneratedByAI: realResult.metadata?.productGeneratedByAI ?? null,
        compositeMetadata: realResult.metadata?.compositeMetadata || null,
        fallbackChain: realResult.metadata?.fallbackChain || [],
        mattingProvider: realResult.metadata?.mattingProvider || null,
        mattingModel: realResult.metadata?.mattingModel || null,
        mattingMethod: realResult.metadata?.mattingMethod || null,
        mattingConfidence: realResult.metadata?.mattingConfidence ?? null,
        edgeQuality: realResult.metadata?.edgeQuality || null,
        backgroundType: realResult.metadata?.backgroundType || null,
        mattingWarnings: realResult.metadata?.mattingWarnings || [],
        mattingFallbackToSharp: Boolean(realResult.metadata?.mattingFallbackToSharp),
        externalMattingError: realResult.metadata?.externalMattingError || null,
        subjectPngPath: realResult.metadata?.subjectPngPath || null,
        maskPath: realResult.metadata?.maskPath || null,
        mattingPreviewUsed: Boolean(plan.mattingPreviewUsed),
        compositeMode: realResult.metadata?.compositeMode || null,
        compositeSettings: realResult.metadata?.compositeSettings || plan.compositeSettings || null,
        compositeQuality: realResult.metadata?.compositeQuality || realResult.metadata?.preserveQuality?.compositeQuality || null,
        subjectScale: realResult.metadata?.subjectScale ?? null,
        subjectPlacement: realResult.metadata?.subjectPlacement || null,
        shadowApplied: Boolean(realResult.metadata?.shadowApplied),
        edgeFeatherApplied: Boolean(realResult.metadata?.edgeFeatherApplied),
        colorMatchApplied: Boolean(realResult.metadata?.colorMatchApplied),
        preserveQuality: realResult.metadata?.preserveQuality || assessProductPreserveQuality(realResult.metadata),
        generationStrategy: realResult.metadata?.generationStrategy || buildGenerationStrategy({
          selectedMode: realResult.metadata?.realGenerationMode,
          generationRequest,
          plan
        }),
        generationRequest,
        generationRequestSummary: summary,
        provider: realResult.provider,
        model: realResult.model,
        status: 'succeeded',
        metadata: realResult.metadata || {}
      }
    };
  }
}
