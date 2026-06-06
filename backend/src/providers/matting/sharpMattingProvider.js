import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { paths } from '../../services/db.js';

function absoluteFromRoot(filePath) {
  return path.isAbsolute(filePath) ? filePath : path.resolve(paths.rootDir, filePath);
}

function colorDistance(pixel, bg) {
  return Math.sqrt(((pixel.r - bg.r) ** 2) + ((pixel.g - bg.g) ** 2) + ((pixel.b - bg.b) ** 2));
}

function averageColor(samples) {
  return {
    r: Math.round(samples.reduce((sum, item) => sum + item.r, 0) / samples.length),
    g: Math.round(samples.reduce((sum, item) => sum + item.g, 0) / samples.length),
    b: Math.round(samples.reduce((sum, item) => sum + item.b, 0) / samples.length)
  };
}

function cornerSamples(data, width, height, sampleSize = 16) {
  const points = [];
  const ranges = [
    [0, 0],
    [Math.max(0, width - sampleSize), 0],
    [0, Math.max(0, height - sampleSize)],
    [Math.max(0, width - sampleSize), Math.max(0, height - sampleSize)]
  ];
  for (const [startX, startY] of ranges) {
    for (let y = startY; y < Math.min(height, startY + sampleSize); y += 1) {
      for (let x = startX; x < Math.min(width, startX + sampleSize); x += 1) {
        const offset = (y * width + x) * 4;
        points.push({ r: data[offset], g: data[offset + 1], b: data[offset + 2] });
      }
    }
  }
  return points;
}

function colorVariance(samples, average) {
  if (!samples.length) return 0;
  const variance = samples.reduce((sum, item) => sum + (colorDistance(item, average) ** 2), 0) / samples.length;
  return Math.sqrt(variance);
}

function classifyBackground(background, variance) {
  const brightness = (background.r + background.g + background.b) / 3;
  if (variance > 28) return 'complex';
  if (brightness > 235 && variance < 12) return 'plain';
  if (brightness > 200) return 'light';
  return 'complex';
}

function boundingBoxFromAlpha(data, width, height) {
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  let alphaPixels = 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const alpha = data[(y * width + x) * 4 + 3];
      if (alpha > 24) {
        alphaPixels += 1;
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
      }
    }
  }
  if (maxX < minX || maxY < minY) return null;
  return { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1, alphaPixels };
}

function quality({ backgroundType, confidence, foregroundRatio }) {
  if (backgroundType === 'complex' || confidence < 0.35 || foregroundRatio < 0.03) return 'poor';
  if (backgroundType === 'light' || confidence < 0.62) return 'medium';
  return 'good';
}

function warningsFor({ backgroundType, edgeQuality }) {
  const warnings = [];
  if (backgroundType === 'complex') warnings.push('complex_background_detected');
  if (edgeQuality === 'poor') warnings.push('low_edge_confidence');
  if (warnings.length) warnings.push('manual_review_recommended');
  return warnings;
}

function failed(error, startedAt, provider = 'sharp', model = 'sharp-alpha-mask-v1') {
  return {
    provider,
    model,
    method: 'sharp_light_background_alpha_mask',
    status: 'failed',
    durationMs: Date.now() - startedAt,
    error: {
      code: error.code || 'MATTING_FAILED',
      message: error.message
    },
    output: null,
    metadata: {
      confidence: 0,
      edgeQuality: 'poor',
      backgroundType: 'unknown',
      warnings: ['matting_failed'],
      sourceImageId: null,
      sourceDisplayName: ''
    }
  };
}

export class SharpMattingProvider {
  provider = 'sharp';
  model = 'sharp-alpha-mask-v1';
  method = 'sharp_light_background_alpha_mask';

  async extractSubject({ task, sourceImage }) {
    const startedAt = Date.now();
    try {
      if (!sourceImage?.filePath) {
        const error = new Error('Source image is required for matting');
        error.code = 'NO_SOURCE_IMAGE';
        throw error;
      }

      const inputPath = absoluteFromRoot(sourceImage.filePath);
      const input = await fs.readFile(inputPath);
      const image = sharp(input).rotate().ensureAlpha();
      const { data, info } = await image.raw().toBuffer({ resolveWithObject: true });
      const samples = cornerSamples(data, info.width, info.height);
      const background = averageColor(samples);
      const variance = colorVariance(samples, background);
      const backgroundType = classifyBackground(background, variance);

      for (let i = 0; i < data.length; i += 4) {
        const originalAlpha = data[i + 3];
        const distance = colorDistance({ r: data[i], g: data[i + 1], b: data[i + 2] }, background);
        const threshold = backgroundType === 'plain' ? 34 : 24;
        const likelyBackground = distance < threshold && (background.r + background.g + background.b) / 3 > 190;
        data[i + 3] = likelyBackground ? 0 : originalAlpha;
      }

      const bbox = boundingBoxFromAlpha(data, info.width, info.height);
      if (!bbox) {
        const error = new Error('No foreground subject could be extracted');
        error.code = 'EMPTY_SUBJECT_MASK';
        throw error;
      }

      const outputDir = path.join(paths.rootDir, '.vision-tmp', 'subjects', task?.id || 'subject');
      await fs.mkdir(outputDir, { recursive: true });
      const baseName = `${sourceImage.id || 'subject'}-${Date.now()}`;
      const subjectPngPath = path.join(outputDir, `${baseName}.png`);
      const maskPath = path.join(outputDir, `${baseName}-mask.png`);
      const subjectBuffer = await sharp(data, { raw: { width: info.width, height: info.height, channels: 4 } })
        .extract({ left: bbox.x, top: bbox.y, width: bbox.width, height: bbox.height })
        .png()
        .toBuffer();
      await fs.writeFile(subjectPngPath, subjectBuffer);

      const alphaMask = Buffer.alloc(info.width * info.height);
      for (let i = 0, j = 0; i < data.length; i += 4, j += 1) alphaMask[j] = data[i + 3];
      await sharp(alphaMask, { raw: { width: info.width, height: info.height, channels: 1 } })
        .extract({ left: bbox.x, top: bbox.y, width: bbox.width, height: bbox.height })
        .png()
        .toFile(maskPath);

      const outputStats = await fs.stat(subjectPngPath);
      const subjectMeta = await sharp(subjectPngPath).metadata();
      const foregroundRatio = bbox.alphaPixels / (info.width * info.height);
      const confidence = Math.max(0.1, Math.min(0.92, (foregroundRatio * 2.4) + (backgroundType === 'plain' ? 0.42 : backgroundType === 'light' ? 0.25 : 0.05)));
      const edgeQuality = quality({ backgroundType, confidence, foregroundRatio });
      return {
        provider: this.provider,
        model: this.model,
        method: this.method,
        status: 'success',
        durationMs: Date.now() - startedAt,
        error: null,
        output: {
          subjectPngPath,
          maskPath,
          previewUrl: '',
          width: subjectMeta.width,
          height: subjectMeta.height,
          hasAlpha: Boolean(subjectMeta.hasAlpha),
          boundingBox: { x: bbox.x, y: bbox.y, width: bbox.width, height: bbox.height }
        },
        metadata: {
          confidence,
          edgeQuality,
          backgroundType,
          warnings: warningsFor({ backgroundType, edgeQuality }),
          sourceImageId: sourceImage.id,
          sourceDisplayName: sourceImage.displayName || sourceImage.fileName || '',
          originalSize: input.length,
          outputSize: outputStats.size,
          hasAlpha: Boolean(subjectMeta.hasAlpha)
        }
      };
    } catch (error) {
      return failed(error, startedAt, this.provider, this.model);
    }
  }
}
