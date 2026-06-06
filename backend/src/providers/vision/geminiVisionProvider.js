import axios from 'axios';
import { readImageAsGeminiInlineData } from '../../utils/imageInput.js';
import { BaseVisionProvider } from './baseVisionProvider.js';
import { buildVisionPrompt } from './visionPrompt.js';
import { parseJsonFromModelOutput } from './robustJsonParser.js';
import { normalizeVisionResult } from './normalizeVisionResult.js';
import { recognizeInBatches } from './visionBatchRunner.js';
import { getVisionRecognitionConfig } from './visionRecognitionConfig.js';

export class GeminiVisionProvider extends BaseVisionProvider {
  constructor() {
    super({
      provider: 'gemini',
      model: process.env.GEMINI_VISION_MODEL || process.env.VISION_MODEL || 'gemini-2.5-flash'
    });
    this.baseURL = process.env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com/v1beta';
    this.apiKey = process.env.GEMINI_API_KEY;
    this.timeoutMs = getVisionRecognitionConfig().requestTimeoutMs;
  }

  async recognize({ task, image, images = [] }) {
    const startedAt = Date.now();
    if (!this.apiKey) {
      return this.failure({
        startedAt,
        code: 'MISSING_API_KEY',
        message: 'GEMINI_API_KEY is required when VISION_PROVIDER=gemini'
      });
    }

    try {
      const url = `${this.baseURL}/models/${this.model}:generateContent?key=${this.apiKey}`;
      const batchResult = await recognizeInBatches({
        task,
        images: images.length ? images : [image],
        callBatch: async ({ batchImages }) => {
          const prompt = buildVisionPrompt({ task: { ...task, sourceImages: batchImages }, image: batchImages[0] });
          const inlineImages = await Promise.all(batchImages.map((item) => readImageAsGeminiInlineData(item.filePath)));
          const response = await axios.post(
            url,
            {
              contents: [
                {
                  role: 'user',
                  parts: [
                    { text: prompt },
                    ...inlineImages.map((inline) => ({
                      inline_data: {
                        mime_type: inline.mimeType,
                        data: inline.base64
                      }
                    }))
                  ]
                }
              ],
              generationConfig: {
                temperature: 0,
                responseMimeType: 'application/json'
              }
            },
            { timeout: this.timeoutMs }
          );
          const text = response.data?.candidates?.[0]?.content?.parts
            ?.map((part) => part.text || '')
            ?.join('\n') || '';
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
        code: error.code === 'ECONNABORTED' ? 'HTTP_ERROR' : error.code || (error.response ? 'HTTP_ERROR' : 'UNKNOWN_ERROR'),
        message: error.message || 'Gemini vision recognition failed',
        details: {
          ...error.details,
          status: error.response?.status,
          statusText: error.response?.statusText
        },
        metadata: error.details || {}
      });
    }
  }
}
