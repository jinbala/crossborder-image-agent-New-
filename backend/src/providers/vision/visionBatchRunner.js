import { preprocessImagesForVision } from '../../utils/visionImagePreprocess.js';
import { mergeVisionResults } from './mergeVisionResults.js';
import { getVisionRecognitionConfig, selectVisionImagesForMode } from './visionRecognitionConfig.js';

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function visionBatchConfig(env = process.env) {
  return {
    batchSize: Math.max(1, Number(env.VISION_BATCH_SIZE || 4)),
    retryCount: Math.max(0, Number(env.VISION_RETRY_COUNT || 1)),
    retryDelayMs: Math.max(0, Number(env.VISION_RETRY_DELAY_MS || 2000))
  };
}

function chunk(items, size) {
  const chunks = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

function isRetryable(error) {
  const message = `${error?.message || ''} ${error?.code || ''}`.toLowerCase();
  const status = error?.status || error?.response?.status;
  return message.includes('econnreset') ||
    message.includes('socket hang up') ||
    message.includes('timeout') ||
    message.includes('etimedout') ||
    status === 429 ||
    (status >= 500 && status < 600);
}

function providerError(error) {
  const status = error?.status || error?.response?.status;
  return {
    code: error?.code || (status ? 'HTTP_ERROR' : 'UNKNOWN_ERROR'),
    message: error?.message || 'Vision batch failed',
    details: {
      status,
      statusText: error?.response?.statusText
    }
  };
}

export async function recognizeInBatches({ task, images = [], callBatch }) {
  const startedAt = Date.now();
  const config = visionBatchConfig();
  const recognitionConfig = getVisionRecognitionConfig();
  const sourceImages = (images.length ? images : task?.sourceImages || []).slice(0, 15);
  const selection = selectVisionImagesForMode(sourceImages);
  const { images: processedImages, metadata: preprocessMetadata } = await preprocessImagesForVision(selection.selectedImages, {
    maxWidth: recognitionConfig.imageMaxWidth,
    quality: recognitionConfig.imageQuality
  });
  const batches = chunk(processedImages, config.batchSize);
  const successes = [];
  const failedBatches = [];
  const batchMetadata = [];
  const rawResponses = [];

  for (let index = 0; index < batches.length; index += 1) {
    const batchImages = batches[index];
    const batchStartedAt = Date.now();
    let lastError = null;
    let success = null;
    let attempts = 0;
    let retryTriggered = false;

    for (let attempt = 0; attempt <= config.retryCount; attempt += 1) {
      attempts += 1;
      try {
        success = await callBatch({ batchImages, batchIndex: index, attempt });
        break;
      } catch (error) {
        lastError = error;
        if (attempt < config.retryCount && isRetryable(error)) {
          retryTriggered = true;
          await wait(config.retryDelayMs);
          continue;
        }
        break;
      }
    }

    if (success?.data) {
      successes.push(success.data);
      if (success.rawResponse) rawResponses.push(success.rawResponse);
      batchMetadata.push({
        batchIndex: index,
        imageIndexes: batchImages.map((image) => image.imageIndex),
        status: 'success',
        durationMs: Date.now() - batchStartedAt,
        attempts,
        retryTriggered
      });
    } else {
      const error = providerError(lastError);
      failedBatches.push({ batchIndex: index, imageIndexes: batchImages.map((image) => image.imageIndex), attempts, retryTriggered, error });
      batchMetadata.push({
        batchIndex: index,
        imageIndexes: batchImages.map((image) => image.imageIndex),
        status: 'failed',
        durationMs: Date.now() - batchStartedAt,
        attempts,
        retryTriggered,
        error
      });
    }
  }

  if (!successes.length) {
    const error = new Error('All vision batches failed');
    error.code = 'ALL_BATCHES_FAILED';
    error.details = { failedBatches, batches: batchMetadata };
    throw error;
  }

  const data = mergeVisionResults(successes);
  const partialSuccess = failedBatches.length > 0;
  if (partialSuccess) {
    data.notes = [
      ...(data.notes || []),
      '部分图片识别失败，已返回可用结果，请人工复核。'
    ].slice(0, 15);
    data.risks = [
      ...(data.risks || []),
      {
        type: 'partial_vision_failure',
        level: 'medium',
        message: '部分图片识别失败，需要人工复核。',
        evidence: failedBatches.map((batch) => `batch ${batch.batchIndex + 1}`),
        imageIndex: null
      }
    ];
  }

  return {
    data,
    rawResponse: rawResponses.join('\n'),
    durationMs: Date.now() - startedAt,
    metadata: {
      batchCount: batches.length,
      batchSize: config.batchSize,
      retryCount: config.retryCount,
      recognitionMode: recognitionConfig.mode,
      imageMaxWidth: recognitionConfig.imageMaxWidth,
      imageQuality: recognitionConfig.imageQuality,
      requestTimeoutMs: recognitionConfig.requestTimeoutMs,
      imageCountOriginal: sourceImages.length,
      imageCountSent: selection.selectedImages.length,
      imageCountSkipped: selection.skippedImages.length,
      skippedImages: selection.skippedImages.map((image) => ({
        imageIndex: image.imageIndex,
        imageName: image.displayName || image.originalName || image.fileName || image.storedName
      })),
      partialSuccess,
      failedBatches,
      batches: batchMetadata,
      preprocess: preprocessMetadata
    }
  };
}
