import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import OpenAI, { toFile } from 'openai';
import { paths } from '../../services/db.js';
import { generationRequestSummary } from '../../services/generationRequestService.js';
import { normalizeCompositeSettings } from '../../services/compositeSettingsService.js';
import { sanitizeFilePart } from '../../utils/fileNaming.js';
import { prepareOpenAIEditReference } from '../../utils/imageEditInput.js';
import { compositeProductOnBackground } from '../../utils/productComposite.js';
import { extractSubjectWithFallback } from '../matting/index.js';
import {
  assessProductPreserveQuality,
  buildGenerationStrategy,
  recommendGenerationStrategy
} from '../../services/productPreserveQualityService.js';

function providerError(code, message, details = {}) {
  return { code, message, details };
}

function outputSize() {
  return process.env.IMAGE_OUTPUT_SIZE || '1536x1536';
}

function editOutputSize() {
  return process.env.IMAGE_EDIT_OUTPUT_SIZE || process.env.IMAGE_OUTPUT_SIZE || '1536x1536';
}

function editEnabledFromEnv() {
  return String(process.env.OPENAI_IMAGE_EDIT_ENABLED || 'false').toLowerCase() === 'true';
}

function subjectCompositeEnabledFromEnv() {
  return String(process.env.OPENAI_SUBJECT_COMPOSITE_ENABLED || 'true').toLowerCase() !== 'false';
}

function normalizeProviderError(error) {
  const code = error.code || (error.status ? 'HTTP_ERROR' : 'UNKNOWN_ERROR');
  return providerError(code, error.message || 'OpenAI image generation failed', { status: error.status });
}

function buildOpenAIBackgroundPrompt(generationRequest) {
  return [
    generationRequest.prompt?.positivePrompt || '',
    'Professional e-commerce lifestyle product photography.',
    'Use a realistic modern desk, office, or travel workspace background.',
    'Keep the product appearance accurate and product-led.',
    'Use clean commercial lighting and natural shadows.',
    'No text, no Chinese, no price, no fake certification, no watermark.',
    'Do not add extra ports, extra accessories, or unsupported logos.',
    `Negative constraints: ${generationRequest.prompt?.negativePrompt || ''}`
  ].filter(Boolean).join(' ');
}

function buildOpenAIEditPrompt(generationRequest) {
  return [
    generationRequest.prompt?.positivePrompt || '',
    'Use the provided reference image as the product source.',
    'Keep the product exactly as in the reference image.',
    'Preserve shape, color, texture, ports, logo, proportions, and all visible product details.',
    'Only change or generate the background/environment around the product.',
    'Create professional e-commerce lifestyle photography with clean commercial lighting.',
    'No text, no Chinese, no price, no certifications, no watermark.',
    'Do not add extra accessories, extra ports, unsupported logos, or new product features.',
    `Negative constraints: ${generationRequest.prompt?.negativePrompt || ''}`
  ].filter(Boolean).join(' ');
}

function buildOpenAIBackgroundOnlyPrompt(generationRequest) {
  return [
    `Create only an empty clean modern lifestyle background for ${generationRequest.product?.category || 'a product'} ecommerce photography.`,
    'Modern office desk, workspace, or travel desk setup.',
    'Leave the central area clear for product placement.',
    'No product, no device, no object as the main subject.',
    'No text, no logo, no watermark, no price, no certification.',
    'Clean commercial lighting, realistic shadows, premium marketplace style.'
  ].join(' ');
}

async function saveBuffer({ taskId, planId, imageType, provider, version = 1, buffer, extension = 'png' }) {
  const outputDir = path.join(paths.outputDir, taskId);
  await fs.mkdir(outputDir, { recursive: true });
  const stamp = Date.now();
  const fileName = `${sanitizeFilePart(taskId)}_${sanitizeFilePart(imageType || 'image')}_${sanitizeFilePart(planId)}_${provider}_v${version}_${stamp}.${extension}`;
  const absolutePath = path.join(outputDir, fileName);
  await fs.writeFile(absolutePath, buffer);
  const metadata = await sharp(absolutePath).metadata();
  return {
    fileName,
    filePath: path.relative(paths.rootDir, absolutePath).replaceAll('\\', '/'),
    previewUrl: `/outputs/${taskId}/${fileName}`,
    url: `/outputs/${taskId}/${fileName}`,
    width: metadata.width,
    height: metadata.height,
    format: metadata.format || extension
  };
}

async function downloadUrl(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw Object.assign(new Error(`Failed to download OpenAI image URL: ${response.status}`), {
      code: 'HTTP_ERROR',
      details: { status: response.status }
    });
  }
  return Buffer.from(await response.arrayBuffer());
}

async function bufferFromImageResponse(response) {
  const first = response.data?.[0];
  if (!first?.b64_json && !first?.url) {
    throw Object.assign(new Error('OpenAI image response did not include b64_json or url'), {
      code: 'PROVIDER_ERROR'
    });
  }
  return {
    buffer: first.b64_json ? Buffer.from(first.b64_json, 'base64') : await downloadUrl(first.url),
    responseType: first.b64_json ? 'b64_json' : 'url'
  };
}

function referenceSummary(productReference) {
  if (!productReference) return null;
  return {
    sourceImageId: productReference.sourceImageId,
    imageIndex: productReference.imageIndex,
    displayName: productReference.displayName,
    role: productReference.role,
    previewUrl: productReference.previewUrl,
    reason: productReference.reason
  };
}

function normalizeRealMode(realMode) {
  return ['auto', 'subject_composite', 'image_edit', 'text_to_image'].includes(realMode) ? realMode : 'auto';
}

function decorateWithQuality(result, { plan, generationRequest, selectedMode, mattingResult }) {
  const imageLike = {
    provider: result.provider,
    model: result.model,
    isRealGenerated: true,
    isMockPreview: false,
    ...(result.output || {}),
    ...(result.metadata || {})
  };
  const actualMode = imageLike.realGenerationMode || selectedMode || 'text_to_image';
  return {
    ...result,
    metadata: {
      ...result.metadata,
      preserveQuality: assessProductPreserveQuality(imageLike),
      compositeQuality: assessProductPreserveQuality(imageLike).compositeQuality,
      generationStrategy: buildGenerationStrategy({
        selectedMode: actualMode,
        generationRequest,
        plan,
        mattingResult
      })
    }
  };
}

export class OpenAIBackgroundProvider {
  constructor({
    apiKey = process.env.OPENAI_API_KEY,
    baseURL = process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
    model = process.env.OPENAI_IMAGE_MODEL || process.env.IMAGE_MODEL || 'gpt-image-2',
    editModel = process.env.OPENAI_IMAGE_EDIT_MODEL || process.env.OPENAI_IMAGE_MODEL || process.env.IMAGE_MODEL || 'gpt-image-2',
    outputSize: configuredOutputSize = outputSize(),
    editOutputSize: configuredEditOutputSize = editOutputSize(),
    editEnabled = editEnabledFromEnv(),
    subjectCompositeEnabled = subjectCompositeEnabledFromEnv(),
    client
  } = {}) {
    this.provider = 'openai';
    this.apiKey = apiKey;
    this.baseURL = baseURL;
    this.model = model;
    this.editModel = editModel;
    this.outputSize = configuredOutputSize;
    this.editOutputSize = configuredEditOutputSize;
    this.editEnabled = editEnabled;
    this.subjectCompositeEnabled = subjectCompositeEnabled;
    this.client = client || (apiKey ? new OpenAI({ apiKey, baseURL }) : null);
  }

  baseMetadata(generationRequest) {
    return {
      generationRequestSummary: generationRequestSummary(generationRequest),
      sourceImageIds: (generationRequest.sourceImages || []).map((image) => image.id),
      promptVersion: generationRequest.prompt?.promptVersion,
      fallbackToMock: false,
      realGenerationError: null
    };
  }

  failedResult({ startedAt, generationRequest, error, model = this.model, metadataPatch = {} }) {
    return {
      provider: this.provider,
      model,
      mode: 'background_replace',
      status: 'failed',
      durationMs: Date.now() - startedAt,
      error,
      output: null,
      metadata: {
        ...this.baseMetadata(generationRequest),
        realGenerationError: error,
        ...metadataPatch
      }
    };
  }

  async resultFromResponse({ task, plan, generationRequest, response, version, metadataPatch = {}, extensionForUrl = 'png', modelOverride = this.model }) {
    const { buffer, responseType } = await bufferFromImageResponse(response);
    const output = await saveBuffer({
      taskId: task.id,
      planId: plan.id,
      imageType: plan.type,
      provider: this.provider,
      version,
      buffer,
      extension: responseType === 'b64_json' ? 'png' : extensionForUrl
    });
    return {
      provider: this.provider,
      model: modelOverride,
      mode: 'background_replace',
      status: 'success',
      output: {
        ...output,
        isMockPreview: false,
        isRealGenerated: true
      },
      metadata: {
        ...this.baseMetadata(generationRequest),
        openaiResponseType: responseType,
        ...metadataPatch
      }
    };
  }

  async requestSubjectComposite({ task, plan, generationRequest, version }) {
    const sourceImage = {
      id: generationRequest.productReference?.sourceImageId,
      imageIndex: generationRequest.productReference?.imageIndex,
      displayName: generationRequest.productReference?.displayName,
      filePath: generationRequest.productReference?.filePath,
      previewUrl: generationRequest.productReference?.previewUrl,
      role: generationRequest.productReference?.role
    };
    const subject = await extractSubjectWithFallback({
      providerName: process.env.MATTING_PROVIDER || 'sharp',
      task,
      sourceImage,
      generationRequest
    });
    if (subject.status !== 'success') {
      throw Object.assign(new Error(subject.error?.message || 'Subject extraction failed'), {
        code: 'MATTING_FAILED',
        details: subject.error
      });
    }

    const backgroundResponse = await this.client.images.generate({
      model: this.model,
      prompt: buildOpenAIBackgroundOnlyPrompt(generationRequest),
      size: this.outputSize,
      n: 1
    });
    const { buffer, responseType } = await bufferFromImageResponse(backgroundResponse);
    const backgroundOutput = await saveBuffer({
      taskId: task.id,
      planId: `${plan.id}-background`,
      imageType: `${plan.type}_background`,
      provider: this.provider,
      version,
      buffer,
      extension: 'png'
    });
    const backgroundPath = path.join(paths.rootDir, backgroundOutput.filePath);
    const finalOutputPath = backgroundPath.replace(/\.png$/i, '-subject-composite.png');
    const composite = await compositeProductOnBackground({
      backgroundPath,
      subjectPngPath: subject.output?.subjectPngPath,
      outputPath: finalOutputPath,
      subjectSourceImageId: generationRequest.productReference?.sourceImageId,
      subjectSourceDisplayName: generationRequest.productReference?.displayName,
      compositeSettings: normalizeCompositeSettings(generationRequest.compositeSettings || plan.compositeSettings)
    });
    if (composite.status !== 'success') {
      throw Object.assign(new Error(composite.error?.message || 'Product composite failed'), {
        code: composite.error?.code || 'PRODUCT_COMPOSITE_FAILED'
      });
    }

    const finalMeta = await sharp(finalOutputPath).metadata();
    const fileName = path.basename(finalOutputPath);
    return {
      provider: this.provider,
      model: this.model,
      mode: 'background_replace',
      status: 'success',
      output: {
        fileName,
        filePath: path.relative(paths.rootDir, finalOutputPath).replaceAll('\\', '/'),
        previewUrl: `/outputs/${task.id}/${fileName}`,
        url: `/outputs/${task.id}/${fileName}`,
        width: finalMeta.width,
        height: finalMeta.height,
        format: finalMeta.format || 'png',
        isMockPreview: false,
        isRealGenerated: true
      },
      metadata: {
        ...this.baseMetadata(generationRequest),
        openaiResponseType: responseType,
        productReferenceUsed: true,
        productReferenceSelectedBy: generationRequest.productReference?.selectedBy || 'auto',
        productReferenceOverride: generationRequest.productReferenceOverride || generationRequest.productReference?.override || null,
        realBackgroundOnly: false,
        realGenerationMode: 'subject_composite',
        subjectCompositeUsed: true,
        subjectExtractionMethod: subject.method,
        subjectSourceImageId: generationRequest.productReference?.sourceImageId,
        subjectSourceDisplayName: generationRequest.productReference?.displayName,
        subjectPreserved: true,
        backgroundGenerated: true,
        backgroundOnly: true,
        productGeneratedByAI: false,
        compositeMetadata: composite.metadata,
        compositeMode: composite.metadata?.compositeMode || 'subject_composite',
        compositeSettings: composite.metadata?.compositeSettings || normalizeCompositeSettings(generationRequest.compositeSettings || plan.compositeSettings),
        subjectScale: composite.metadata?.subjectScale,
        subjectPlacement: composite.metadata?.subjectPlacement,
        shadowApplied: Boolean(composite.metadata?.shadowApplied),
        edgeFeatherApplied: Boolean(composite.metadata?.edgeFeatherApplied),
        colorMatchApplied: Boolean(composite.metadata?.colorMatchApplied),
        mattingProvider: subject.provider,
        mattingModel: subject.model,
        mattingMethod: subject.method,
        mattingConfidence: subject.metadata?.confidence ?? 0,
        edgeQuality: subject.metadata?.edgeQuality || 'unknown',
        backgroundType: subject.metadata?.backgroundType || 'unknown',
        mattingWarnings: subject.metadata?.warnings || [],
        mattingFallbackToSharp: Boolean(subject.metadata?.mattingFallbackToSharp),
        externalMattingError: subject.metadata?.externalMattingError || null,
        subjectPngPath: subject.output?.subjectPngPath || null,
        maskPath: subject.output?.maskPath || null,
        productReference: referenceSummary(generationRequest.productReference),
        referencePreprocess: subject.metadata,
        editAttempted: false,
        editSucceeded: false,
        editFailed: false,
        fallbackMode: null,
        fallbackChain: [{ mode: 'subject_composite', status: 'success' }]
      }
    };
  }

  async requestTextToImage({ task, plan, generationRequest, version, metadataPatch = {} }) {
    const response = await this.client.images.generate({
      model: this.model,
      prompt: buildOpenAIBackgroundPrompt(generationRequest),
      size: this.outputSize,
      n: 1
    });
    return this.resultFromResponse({
      task,
      plan,
      generationRequest,
      response,
      version,
      extensionForUrl: 'jpg',
      metadataPatch: {
        productReferenceUsed: false,
        productReferenceSelectedBy: generationRequest.productReference?.selectedBy || 'auto',
        productReferenceOverride: generationRequest.productReferenceOverride || generationRequest.productReference?.override || null,
        realBackgroundOnly: true,
        realGenerationMode: 'text_to_image',
        subjectCompositeUsed: false,
        subjectPreserved: false,
        backgroundGenerated: true,
        productGeneratedByAI: true,
        fallbackChain: [{ mode: 'text_to_image', status: 'success' }],
        editAttempted: false,
        editSucceeded: false,
        editFailed: false,
        fallbackMode: null,
        productReference: generationRequest.productReference || null,
        referencePreprocess: null,
        ...metadataPatch
      }
    });
  }

  async requestImageEdit({ task, plan, generationRequest, version }) {
    const referenceInput = await prepareOpenAIEditReference(generationRequest.productReference);
    const response = await this.client.images.edit({
      model: this.editModel,
      image: await toFile(referenceInput.buffer, referenceInput.fileName, { type: referenceInput.mimeType }),
      prompt: buildOpenAIEditPrompt(generationRequest),
      size: this.editOutputSize,
      n: 1,
      output_format: 'png'
    });
    return this.resultFromResponse({
      task,
      plan,
      generationRequest,
      response,
      version,
      modelOverride: this.editModel,
      metadataPatch: {
        productReferenceUsed: true,
        productReferenceSelectedBy: generationRequest.productReference?.selectedBy || 'auto',
        productReferenceOverride: generationRequest.productReferenceOverride || generationRequest.productReference?.override || null,
        realBackgroundOnly: false,
        realGenerationMode: 'image_edit',
        subjectCompositeUsed: false,
        subjectPreserved: false,
        backgroundGenerated: true,
        productGeneratedByAI: true,
        editAttempted: true,
        editSucceeded: true,
        editFailed: false,
        editError: null,
        fallbackMode: null,
        fallbackChain: [{ mode: 'image_edit', status: 'success' }],
        productReference: referenceSummary(generationRequest.productReference),
        referencePreprocess: referenceInput.referencePreprocess
      }
    });
  }

  async generate({ task, plan, generationRequest, version = 1, realMode = 'auto' }) {
    const startedAt = Date.now();
    if (!this.apiKey) {
      const error = providerError('MISSING_API_KEY', 'OPENAI_API_KEY is required for BACKGROUND_PROVIDER=openai');
      return this.failedResult({ startedAt, generationRequest, error });
    }

    const chain = [];
    const requestedMode = normalizeRealMode(realMode);
    const recommendation = recommendGenerationStrategy({ plan, generationRequest });
    const effectiveMode = requestedMode === 'auto' ? recommendation.recommendedMode : requestedMode;
    const allowSubjectComposite = effectiveMode === 'subject_composite';
    const allowImageEdit = effectiveMode === 'subject_composite' || effectiveMode === 'image_edit';
    const allowTextToImage = ['subject_composite', 'image_edit', 'text_to_image'].includes(effectiveMode);

    if (allowSubjectComposite && this.subjectCompositeEnabled && generationRequest.productReference?.enabled) {
      try {
        const result = await this.requestSubjectComposite({ task, plan, generationRequest, version });
        return {
          ...decorateWithQuality(result, { plan, generationRequest, selectedMode: 'subject_composite' }),
          durationMs: Date.now() - startedAt,
          error: null
        };
      } catch (error) {
        chain.push({ mode: 'subject_composite', status: 'failed', error: normalizeProviderError(error) });
      }
    }

    if (allowImageEdit && this.editEnabled && generationRequest.productReference?.enabled) {
      try {
        const result = await this.requestImageEdit({ task, plan, generationRequest, version });
        result.metadata.fallbackMode = chain.length ? 'image_edit' : null;
        result.metadata.fallbackChain = [...chain, { mode: 'image_edit', status: 'success' }];
        return {
          ...decorateWithQuality(result, { plan, generationRequest, selectedMode: 'image_edit' }),
          durationMs: Date.now() - startedAt,
          error: null
        };
      } catch (error) {
        chain.push({ mode: 'image_edit', status: 'failed', error: normalizeProviderError(error) });
      }
    }

    try {
      if (!allowTextToImage) {
        throw Object.assign(new Error(`Requested realMode ${effectiveMode} is not available`), {
          code: 'UNSUPPORTED_REAL_MODE'
        });
      }
      const textResult = await this.requestTextToImage({
        task,
        plan,
        generationRequest,
        version,
        metadataPatch: {
          editAttempted: chain.some((item) => item.mode === 'image_edit'),
          editSucceeded: false,
          editFailed: chain.some((item) => item.mode === 'image_edit' && item.status === 'failed'),
          editError: chain.find((item) => item.mode === 'image_edit' && item.status === 'failed')?.error || null,
          fallbackMode: chain.length || (this.editEnabled && !generationRequest.productReference?.enabled) ? 'text_to_image' : null,
          fallbackChain: [...chain, { mode: 'text_to_image', status: 'success' }],
          editSkippedReason: this.editEnabled && !generationRequest.productReference?.enabled ? 'NO_PRODUCT_REFERENCE' : undefined
        }
      });
      return {
        ...decorateWithQuality(textResult, { plan, generationRequest, selectedMode: 'text_to_image' }),
        durationMs: Date.now() - startedAt,
        error: null
      };
    } catch (error) {
      chain.push({ mode: 'text_to_image', status: 'failed', error: normalizeProviderError(error) });
      return this.failedResult({
        startedAt,
        generationRequest,
        error: normalizeProviderError(error),
        metadataPatch: {
          productReferenceUsed: false,
          realBackgroundOnly: false,
          realGenerationMode: 'mock',
          subjectCompositeUsed: false,
          subjectPreserved: false,
          backgroundGenerated: false,
          productGeneratedByAI: null,
          editAttempted: chain.some((item) => item.mode === 'image_edit'),
          editSucceeded: false,
          editFailed: chain.some((item) => item.mode === 'image_edit' && item.status === 'failed'),
          editError: chain.find((item) => item.mode === 'image_edit' && item.status === 'failed')?.error || null,
          fallbackMode: 'mock',
          fallbackChain: [...chain, { mode: 'mock', status: 'success' }]
        }
      });
    }
  }
}
