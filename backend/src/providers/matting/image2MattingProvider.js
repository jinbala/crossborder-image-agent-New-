import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import OpenAI, { toFile } from 'openai';
import { paths } from '../../services/db.js';

function absoluteFromRoot(filePath) {
  return path.isAbsolute(filePath) ? filePath : path.resolve(paths.rootDir, filePath);
}

function mimeTypeFromPath(filePath) {
  const ext = path.extname(filePath || '').toLowerCase();
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.png') return 'image/png';
  if (ext === '.webp') return 'image/webp';
  return 'image/png';
}

function outputTypeFromResponse(first = {}, metadata = {}) {
  const value = first.output_type || first.outputType || metadata.outputType;
  if (['transparent', 'edited-background-removed', 'simulated'].includes(value)) return value;
  return first.b64_json || first.url ? 'edited-background-removed' : 'simulated';
}

async function downloadUrl(url) {
  const response = await fetch(url);
  if (!response.ok) {
    const error = new Error(`Failed to download Image2 matting output: ${response.status}`);
    error.code = 'HTTP_ERROR';
    error.status = response.status;
    throw error;
  }
  return Buffer.from(await response.arrayBuffer());
}

async function imageBufferFromResponse(response) {
  const first = response.data?.[0] || {};
  if (!first.b64_json && !first.url) {
    const error = new Error('Image2 response did not include b64_json or url');
    error.code = 'IMAGE2_EMPTY_OUTPUT';
    throw error;
  }
  return {
    buffer: first.b64_json ? Buffer.from(first.b64_json, 'base64') : await downloadUrl(first.url),
    first
  };
}

function normalizeError(error) {
  return {
    code: error.code || (error.status ? 'HTTP_ERROR' : 'IMAGE2_MATTING_FAILED'),
    message: error.message || 'Image2 matting failed',
    details: error.status ? { status: error.status } : {}
  };
}

function failed({ startedAt, model, error }) {
  return {
    provider: 'image2',
    model,
    method: 'openai_image2_experimental_matting',
    status: 'failed',
    durationMs: Date.now() - startedAt,
    error: normalizeError(error),
    output: null,
    metadata: {
      outputType: 'simulated',
      warnings: ['image2_matting_failed'],
      confidence: 0,
      rawProviderMeta: {}
    }
  };
}

export class Image2MattingProvider {
  constructor({
    apiKey = process.env.OPENAI_API_KEY,
    baseURL = process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
    model = process.env.OPENAI_IMAGE_EDIT_MODEL || process.env.OPENAI_IMAGE_MODEL || process.env.IMAGE_MODEL || 'gpt-image-2',
    client
  } = {}) {
    this.provider = 'image2';
    this.model = model;
    this.method = 'openai_image2_experimental_matting';
    this.apiKey = apiKey;
    this.baseURL = baseURL;
    this.client = client || (apiKey ? new OpenAI({ apiKey, baseURL }) : null);
  }

  async extractSubject({ task, sourceImage }) {
    const startedAt = Date.now();
    try {
      if (!this.apiKey || !this.client) {
        const error = new Error('OPENAI_API_KEY is required for Image2 experimental matting');
        error.code = 'MISSING_IMAGE2_CONFIG';
        throw error;
      }
      if (!sourceImage?.filePath) {
        const error = new Error('Source image is required for Image2 matting');
        error.code = 'NO_SOURCE_IMAGE';
        throw error;
      }

      const filePath = absoluteFromRoot(sourceImage.filePath);
      const input = await fs.readFile(filePath);
      const fileName = sourceImage.displayName || sourceImage.fileName || path.basename(filePath) || 'product.png';
      const response = await this.client.images.edit({
        model: this.model,
        image: await toFile(input, fileName, { type: mimeTypeFromPath(fileName || filePath) }),
        prompt: [
          'Remove the background from the product image for a small experimental matting test.',
          'Prefer transparent background PNG when possible.',
          'Preserve the product shape, color, details, logo, ports, and proportions.',
          'Do not add text, watermark, price, certification, or new accessories.'
        ].join(' '),
        n: 1,
        output_format: 'png'
      });
      const { buffer, first } = await imageBufferFromResponse(response);
      const outputDir = path.join(paths.rootDir, '.vision-tmp', 'matting', task?.id || 'image2');
      await fs.mkdir(outputDir, { recursive: true });
      const outputPath = path.join(outputDir, `${sourceImage.id || 'image2'}-${Date.now()}.png`);
      await fs.writeFile(outputPath, buffer);
      const metadata = await sharp(outputPath).metadata();
      const outputType = outputTypeFromResponse(first, response.metadata || {});

      return {
        provider: 'image2',
        model: this.model,
        method: this.method,
        status: 'success',
        durationMs: Date.now() - startedAt,
        error: null,
        output: {
          subjectPngPath: outputPath,
          maskPath: null,
          width: metadata.width,
          height: metadata.height,
          format: metadata.format || 'png',
          hasAlpha: Boolean(metadata.hasAlpha)
        },
        metadata: {
          outputType,
          confidence: outputType === 'transparent' ? 0.75 : 0.55,
          warnings: outputType === 'transparent'
            ? ['image2_experimental_matting']
            : ['image2_experimental_matting', 'edited_background_removed_not_standard_transparent_png'],
          rawProviderMeta: {
            responseType: first.b64_json ? 'b64_json' : 'url',
            outputType
          }
        }
      };
    } catch (error) {
      return failed({ startedAt, model: this.model, error });
    }
  }
}
