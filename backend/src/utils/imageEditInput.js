import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { paths } from '../services/db.js';

function numberEnv(name, fallback) {
  const parsed = Number.parseInt(process.env[name] || '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function imageEditConfig() {
  return {
    maxWidth: numberEnv('IMAGE_REFERENCE_MAX_WIDTH', 1536),
    quality: numberEnv('IMAGE_REFERENCE_QUALITY', 90)
  };
}

export async function prepareOpenAIEditReference(productReference = {}, config = imageEditConfig()) {
  if (!productReference.enabled || !productReference.filePath) {
    const error = new Error('Product reference image is not available for image edit');
    error.code = 'NO_PRODUCT_REFERENCE';
    throw error;
  }

  const absolutePath = path.isAbsolute(productReference.filePath)
    ? productReference.filePath
    : path.join(paths.rootDir, productReference.filePath);
  const inputBuffer = await fs.readFile(absolutePath);
  const before = await sharp(inputBuffer).metadata();
  const outputDir = path.join(paths.rootDir, '.vision-tmp', 'image-edit');
  await fs.mkdir(outputDir, { recursive: true });
  const outputPath = path.join(outputDir, `${productReference.sourceImageId || 'reference'}-${Date.now()}.png`);
  await sharp(inputBuffer)
    .rotate()
    .resize({
      width: config.maxWidth,
      height: config.maxWidth,
      fit: 'inside',
      withoutEnlargement: true
    })
    .png({
      quality: config.quality,
      compressionLevel: 9,
      adaptiveFiltering: true
    })
    .toFile(outputPath);

  const outputStats = await fs.stat(outputPath);
  const after = await sharp(outputPath).metadata();
  return {
    filePath: outputPath,
    buffer: await fs.readFile(outputPath),
    fileName: path.basename(outputPath),
    mimeType: 'image/png',
    referencePreprocess: {
      originalSize: inputBuffer.length,
      processedSize: outputStats.size,
      widthBefore: before.width || null,
      heightBefore: before.height || null,
      widthAfter: after.width || null,
      heightAfter: after.height || null,
      format: after.format || 'png'
    }
  };
}
