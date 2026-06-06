import axios from 'axios';
import OpenAI from 'openai';
import { ReviewProvider } from '../ReviewProvider.js';
import { readImageAsBase64DataUrl, readImageAsGeminiInlineData } from '../../utils/imageInput.js';
import { parseJsonFromModelOutput } from '../vision/robustJsonParser.js';
import { normalizeReviewResult } from './normalizeReviewResult.js';
import { REVIEW_PROMPT_VERSION, buildReviewPrompt } from './reviewPrompt.js';
import { runRuleBasedReviewChecks, mergeReviewData } from './ruleBasedReview.js';

function providerConfig(provider) {
  if (provider === 'gemini') {
    return {
      apiKey: process.env.GEMINI_API_KEY,
      baseURL: process.env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com/v1beta',
      model: process.env.REVIEW_MODEL || process.env.GEMINI_VISION_MODEL || 'gemini-2.5-flash'
    };
  }
  if (provider === 'openai') {
    return {
      apiKey: process.env.OPENAI_API_KEY,
      baseURL: process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
      model: process.env.REVIEW_MODEL || process.env.OPENAI_VISION_MODEL || 'gpt-4.1-mini'
    };
  }
  if (provider === 'qwen') {
    return {
      apiKey: process.env.QWEN_API_KEY,
      baseURL: process.env.QWEN_BASE_URL || 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
      model: process.env.REVIEW_MODEL || process.env.QWEN_MODEL || 'qwen-vl-max-latest'
    };
  }
  return { apiKey: '', baseURL: '', model: '' };
}

function missingKeyError(provider) {
  return {
    code: 'MISSING_API_KEY',
    message: `${provider.toUpperCase()} API key is required for real review provider`
  };
}

export class RealVisionReviewProvider extends ReviewProvider {
  constructor(provider = process.env.REVIEW_PROVIDER || 'gemini') {
    super();
    this.provider = provider;
    this.config = providerConfig(provider);
    this.model = this.config.model;
  }

  async review({ task, image, plan, generationRequest }) {
    const startedAt = Date.now();
    if (!this.config.apiKey) {
      return {
        provider: this.provider,
        model: this.model,
        status: 'failed',
        durationMs: Date.now() - startedAt,
        error: missingKeyError(this.provider),
        data: null
      };
    }
    try {
      const prompt = buildReviewPrompt({ task, image, plan, generationRequest });
      const text = await this.callModel({ prompt, image });
      const parsed = parseJsonFromModelOutput(text);
      const visionData = normalizeReviewResult(parsed);
      const ruleData = runRuleBasedReviewChecks({ task, image, plan, generationRequest });
      const data = mergeReviewData(ruleData, visionData);
      const durationMs = Date.now() - startedAt;
      return {
        provider: this.provider,
        model: this.model,
        status: 'success',
        durationMs,
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
          reviewMode: 'real',
          isRealReview: true,
          fallbackToMockReview: false,
          platformRuleSnapshot: data.platformChecks?.platformRuleSnapshot || null,
          categoryRuleSnapshot: data.platformChecks?.categoryRuleSnapshot || null,
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
        },
        rawResponsePreview: String(text || '').slice(0, 1000)
      };
    } catch (error) {
      return {
        provider: this.provider,
        model: this.model,
        status: 'failed',
        durationMs: Date.now() - startedAt,
        error: {
          code: error.code || 'REVIEW_PROVIDER_ERROR',
          message: error.message,
          details: error.details || {}
        },
        data: null
      };
    }
  }

  async callModel({ prompt, image }) {
    if (this.provider === 'gemini') return this.callGemini({ prompt, image });
    if (this.provider === 'openai') return this.callOpenAI({ prompt, image });
    if (this.provider === 'qwen') return this.callQwen({ prompt, image });
    const error = new Error(`Unsupported REVIEW_PROVIDER: ${this.provider}`);
    error.code = 'UNSUPPORTED_REVIEW_PROVIDER';
    throw error;
  }

  async callGemini({ prompt, image }) {
    const img = await readImageAsGeminiInlineData(image.filePath);
    const url = `${this.config.baseURL}/models/${this.model}:generateContent?key=${this.config.apiKey}`;
    const response = await axios.post(url, {
      contents: [{
        role: 'user',
        parts: [
          { text: prompt },
          { inline_data: { mime_type: img.mimeType, data: img.base64 } }
        ]
      }],
      generationConfig: {
        temperature: 0,
        responseMimeType: 'application/json'
      }
    }, { timeout: Number(process.env.REVIEW_TIMEOUT_MS || 180000) });
    return response.data?.candidates?.[0]?.content?.parts?.map((part) => part.text || '').join('\n') || '';
  }

  async callOpenAI({ prompt, image }) {
    const dataUrl = await readImageAsBase64DataUrl(image.filePath);
    const client = new OpenAI({ apiKey: this.config.apiKey, baseURL: this.config.baseURL });
    const response = await client.responses.create({
      model: this.model,
      input: [{
        role: 'user',
        content: [
          { type: 'input_text', text: prompt },
          { type: 'input_image', image_url: dataUrl }
        ]
      }],
      temperature: 0
    });
    return response.output_text || response.output?.flatMap((item) => item.content || []).map((part) => part.text || part.output_text || '').join('\n') || '';
  }

  async callQwen({ prompt, image }) {
    const dataUrl = await readImageAsBase64DataUrl(image.filePath);
    const client = new OpenAI({ apiKey: this.config.apiKey, baseURL: this.config.baseURL });
    const completion = await client.chat.completions.create({
      model: this.model,
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: prompt },
          { type: 'image_url', image_url: { url: dataUrl } }
        ]
      }],
      temperature: 0
    });
    return completion.choices?.[0]?.message?.content || '';
  }
}
