import OpenAI from 'openai';
import { readImageAsBase64DataUrl } from '../../utils/imageInput.js';
import { BaseVisionProvider } from './baseVisionProvider.js';
import { buildVisionPrompt } from './visionPrompt.js';
import { parseJsonFromModelOutput } from './robustJsonParser.js';
import { normalizeVisionResult } from './normalizeVisionResult.js';
import { recognizeInBatches } from './visionBatchRunner.js';
import { getVisionRecognitionConfig } from './visionRecognitionConfig.js';

export class OpenAIVisionProvider extends BaseVisionProvider {
  constructor() {
    super({
      provider: 'openai',
      model: process.env.OPENAI_VISION_MODEL || process.env.VISION_MODEL || 'gpt-4.1-mini'
    });
    this.baseURL = process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1';
    this.apiKey = process.env.OPENAI_API_KEY;
    this.timeoutMs = getVisionRecognitionConfig().requestTimeoutMs;
  }

  extractText(response) {
    return response.output_text ||
      response.output?.flatMap((item) => item.content || [])
        ?.map((part) => part.text || part.output_text || '')
        ?.join('\n') ||
      '';
  }

  async recognize({ task, image, images = [] }) {
    const startedAt = Date.now();
    if (!this.apiKey) {
      return this.failure({
        startedAt,
        code: 'MISSING_API_KEY',
        message: 'OPENAI_API_KEY is required when VISION_PROVIDER=openai'
      });
    }

    try {
      const client = new OpenAI({ apiKey: this.apiKey, baseURL: this.baseURL, timeout: this.timeoutMs });
      const batchResult = await recognizeInBatches({
        task,
        images: images.length ? images : [image],
        callBatch: async ({ batchImages }) => {
          const prompt = buildVisionPrompt({ task: { ...task, sourceImages: batchImages }, image: batchImages[0] });
          const dataUrls = await Promise.all(batchImages.map((item) => readImageAsBase64DataUrl(item.filePath)));
          const response = await client.responses.create({
            model: this.model,
            input: [
              {
                role: 'user',
                content: [
                  { type: 'input_text', text: prompt },
                  ...dataUrls.map((dataUrl) => ({ type: 'input_image', image_url: dataUrl }))
                ]
              }
            ],
            temperature: 0
          });
          const text = this.extractText(response);
          const parsed = parseJsonFromModelOutput(text);
          return {
            data: normalizeVisionResult(parsed),
            rawResponse: text
          };
        }
      });
      return this.success({
        startedAt,
        data: batchResult.data,
        rawResponse: batchResult.rawResponse,
        metadata: batchResult.metadata
      });
    } catch (error) {
      return this.failure({
        startedAt,
        code: error.code || (error.status ? 'HTTP_ERROR' : 'UNKNOWN_ERROR'),
        message: error.message || 'OpenAI vision recognition failed',
        details: error.details || { status: error.status },
        metadata: error.details || {}
      });
    }
  }
}
