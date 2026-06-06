import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { paths } from '../../services/db.js';

function absoluteFromRoot(filePath) {
  return path.isAbsolute(filePath) ? filePath : path.resolve(paths.rootDir, filePath);
}

function errorResult({ startedAt, model, error, sourceImage }) {
  return {
    provider: 'external',
    model,
    method: 'external_http_matting_api',
    status: 'failed',
    durationMs: Date.now() - startedAt,
    error,
    output: null,
    metadata: {
      confidence: 0,
      edgeQuality: 'poor',
      backgroundType: 'unknown',
      warnings: ['external_matting_failed'],
      boundingBox: null,
      originalImage: sourceImage ? {
        id: sourceImage.id,
        displayName: sourceImage.displayName || sourceImage.fileName || '',
        filePath: sourceImage.filePath
      } : null,
      providerResponsePreview: ''
    }
  };
}

function normalizeError(error) {
  return {
    code: error.code || (error.status ? 'HTTP_ERROR' : 'UNKNOWN_ERROR'),
    message: error.message || 'External matting failed',
    details: error.details || (error.status ? { status: error.status } : {})
  };
}

async function bufferFromUrl(fetchImpl, url) {
  const response = await fetchImpl(url);
  if (!response.ok) {
    const error = new Error(`Failed to download matting output: ${response.status}`);
    error.code = 'HTTP_ERROR';
    error.status = response.status;
    throw error;
  }
  return Buffer.from(await response.arrayBuffer());
}

function base64ToBuffer(value) {
  const clean = String(value || '').replace(/^data:image\/\w+;base64,/, '');
  return Buffer.from(clean, 'base64');
}

async function parseProviderResponse(response, fetchImpl) {
  const contentType = response.headers?.get?.('content-type') || '';
  if (!response.ok) {
    const preview = await response.text().catch(() => '');
    const error = new Error(`External matting HTTP error: ${response.status}`);
    error.code = 'HTTP_ERROR';
    error.status = response.status;
    error.details = { preview: preview.slice(0, 500) };
    throw error;
  }

  if (contentType.includes('image/png')) {
    return {
      subjectBuffer: Buffer.from(await response.arrayBuffer()),
      maskBuffer: null,
      parsed: {
        confidence: 0.5,
        warnings: ['binary_response_no_mask'],
        edgeQuality: 'medium',
        backgroundType: 'unknown'
      },
      preview: 'binary image/png response'
    };
  }

  const text = await response.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    const error = new Error('External matting response is not valid JSON or image/png');
    error.code = 'INVALID_MATTING_RESPONSE';
    error.details = { preview: text.slice(0, 500) };
    throw error;
  }

  let subjectBuffer = null;
  let maskBuffer = null;
  if (parsed.subjectPngBase64) subjectBuffer = base64ToBuffer(parsed.subjectPngBase64);
  if (parsed.maskBase64) maskBuffer = base64ToBuffer(parsed.maskBase64);
  if (!subjectBuffer && parsed.subjectPngUrl) subjectBuffer = await bufferFromUrl(fetchImpl, parsed.subjectPngUrl);
  if (!maskBuffer && parsed.maskUrl) maskBuffer = await bufferFromUrl(fetchImpl, parsed.maskUrl);
  if (!subjectBuffer) {
    const error = new Error('External matting response did not include subjectPngBase64 subjectPngUrl or image/png binary');
    error.code = 'INVALID_MATTING_RESPONSE';
    error.details = { preview: text.slice(0, 500) };
    throw error;
  }

  return {
    subjectBuffer,
    maskBuffer,
    parsed,
    preview: text.slice(0, 1000)
  };
}

async function saveOutputs({ task, sourceImage, subjectBuffer, maskBuffer }) {
  const outputDir = path.join(paths.rootDir, '.vision-tmp', 'matting', task?.id || 'external');
  await fs.mkdir(outputDir, { recursive: true });
  const baseName = `${sourceImage?.id || 'subject'}-${Date.now()}`;
  const subjectPngPath = path.join(outputDir, `${baseName}.png`);
  const maskPath = maskBuffer ? path.join(outputDir, `${baseName}-mask.png`) : null;
  await fs.writeFile(subjectPngPath, subjectBuffer);
  if (maskBuffer) await fs.writeFile(maskPath, maskBuffer);
  const metadata = await sharp(subjectPngPath).metadata();
  return {
    subjectPngPath,
    maskPath,
    width: metadata.width,
    height: metadata.height,
    format: metadata.format || 'png',
    hasAlpha: Boolean(metadata.hasAlpha)
  };
}

export class ExternalMattingProvider {
  constructor({
    apiKey = process.env.MATTING_API_KEY,
    baseURL = process.env.MATTING_BASE_URL,
    model = process.env.MATTING_MODEL || 'external-matting',
    fetchImpl = globalThis.fetch
  } = {}) {
    this.provider = 'external';
    this.model = model;
    this.method = 'external_http_matting_api';
    this.apiKey = apiKey;
    this.baseURL = baseURL;
    this.fetchImpl = fetchImpl;
  }

  async extractSubject({ task, sourceImage }) {
    const startedAt = Date.now();
    try {
      if (!this.apiKey || !this.baseURL) {
        const error = new Error('MATTING_API_KEY and MATTING_BASE_URL are required for MATTING_PROVIDER=external');
        error.code = 'MISSING_MATTING_CONFIG';
        throw error;
      }
      if (!sourceImage?.filePath) {
        const error = new Error('Source image is required for external matting');
        error.code = 'NO_SOURCE_IMAGE';
        throw error;
      }

      const filePath = absoluteFromRoot(sourceImage.filePath);
      const input = await fs.readFile(filePath);
      const form = new FormData();
      form.append('image', new Blob([input]), sourceImage.displayName || sourceImage.fileName || 'product.png');
      form.append('model', this.model);
      form.append('output', 'png');
      form.append('returnMask', 'true');

      const response = await this.fetchImpl(this.baseURL, {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.apiKey}` },
        body: form
      });
      const parsedResponse = await parseProviderResponse(response, this.fetchImpl);
      const output = await saveOutputs({
        task,
        sourceImage,
        subjectBuffer: parsedResponse.subjectBuffer,
        maskBuffer: parsedResponse.maskBuffer
      });

      return {
        provider: this.provider,
        model: this.model,
        method: this.method,
        status: 'success',
        durationMs: Date.now() - startedAt,
        error: null,
        output: {
          subjectPngPath: output.subjectPngPath,
          maskPath: output.maskPath,
          previewUrl: '',
          width: output.width,
          height: output.height,
          format: output.format,
          hasAlpha: output.hasAlpha,
          boundingBox: parsedResponse.parsed.boundingBox || null
        },
        metadata: {
          confidence: Number(parsedResponse.parsed.confidence ?? 0.5),
          edgeQuality: parsedResponse.parsed.edgeQuality || 'medium',
          backgroundType: parsedResponse.parsed.backgroundType || 'unknown',
          warnings: Array.isArray(parsedResponse.parsed.warnings) ? parsedResponse.parsed.warnings : [],
          boundingBox: parsedResponse.parsed.boundingBox || null,
          originalImage: {
            id: sourceImage.id,
            displayName: sourceImage.displayName || sourceImage.fileName || '',
            filePath: sourceImage.filePath
          },
          providerResponsePreview: parsedResponse.preview
        }
      };
    } catch (error) {
      return errorResult({
        startedAt,
        model: this.model,
        sourceImage,
        error: normalizeError(error)
      });
    }
  }
}
