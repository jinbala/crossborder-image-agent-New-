import OpenAI from 'openai';
import { readImageAsBase64DataUrl } from '../../utils/imageInput.js';
import { BaseVisionProvider } from './baseVisionProvider.js';
import { buildVisionPrompt } from './visionPrompt.js';
import { parseJsonFromModelOutput } from './robustJsonParser.js';
import { normalizeVisionResult } from './normalizeVisionResult.js';
import { recognizeInBatches } from './visionBatchRunner.js';
import { getVisionRecognitionConfig } from './visionRecognitionConfig.js';

export class QwenVisionProvider extends BaseVisionProvider {
  constructor() {
    super({
      provider: 'qwen',
      model: process.env.QWEN_MODEL || process.env.VISION_MODEL || 'qwen-vl-max-latest'
    });
    this.baseURL = process.env.QWEN_BASE_URL || 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1';
    this.apiKey = process.env.QWEN_API_KEY;
    this.timeoutMs = getVisionRecognitionConfig().requestTimeoutMs;
  }

  async recognize({ task, image, images = [] }) {
    const startedAt = Date.now();
    if (!this.apiKey) {
      return this.failure({
        startedAt,
        code: 'MISSING_API_KEY',
        message: 'QWEN_API_KEY is required when VISION_PROVIDER=qwen'
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
          const completion = await client.chat.completions.create({
            model: this.model,
            messages: [
              {
                role: 'user',
                content: [
                  { type: 'text', text: prompt },
                  ...dataUrls.map((dataUrl) => ({ type: 'image_url', image_url: { url: dataUrl } }))
                ]
              }
            ],
            temperature: 0
          });
          const text = completion.choices?.[0]?.message?.content || '';
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
        message: error.message || 'Qwen vision recognition failed',
        details: error.details || { status: error.status },
        metadata: error.details || {}
      });
    }
  }
}
