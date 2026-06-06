import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { nanoid } from 'nanoid';
import { paths } from '../services/db.js';
import { getVisionRecognitionConfig } from '../providers/vision/visionRecognitionConfig.js';

const tempDir = path.join(paths.rootDir, '.vision-tmp');

function absolutePath(filePath) {
  return path.isAbsolute(filePath) ? filePath : path.join(paths.rootDir, filePath);
}

export function visionPreprocessConfig(env = process.env) {
  const recognition = getVisionRecognitionConfig(env);
  return {
    enabled: env.VISION_IMAGE_PREPROCESS !== 'false',
    maxWidth: recognition.imageMaxWidth,
    quality: recognition.imageQuality,
    maxBytes: Number(env.VISION_IMAGE_MAX_BYTES || 1024 * 1024)
  };
}

export async function preprocessImageForVision(image, options = {}) {
  const config = { ...visionPreprocessConfig(), ...options };
  const inputPath = absolutePath(image.filePath);
  const inputStats = await fs.stat(inputPath);
  const inputMetadata = await sharp(inputPath).metadata();

  await fs.mkdir(tempDir, { recursive: true });
  let quality = Math.max(45, Math.min(95, config.quality));
  let outputBuffer;

  for (let attempt = 0; attempt < 4; attempt += 1) {
    outputBuffer = await sharp(inputPath)
      .rotate()
      .resize({
        width: config.maxWidth,
        height: config.maxWidth,
        fit: 'inside',
        withoutEnlargement: true
      })
      .jpeg({ quality, mozjpeg: true })
      .toBuffer();

    if (outputBuffer.length <= config.maxBytes || quality <= 55) break;
    quality -= 10;
  }

  const outputPath = path.join(tempDir, `vision-${Date.now()}-${nanoid(8)}.jpg`);
  await fs.writeFile(outputPath, outputBuffer);
  const outputMetadata = await sharp(outputPath).metadata();

  return {
    ...image,
    originalFilePath: image.filePath,
    filePath: outputPath,
    mimeType: 'image/jpeg',
    format: 'jpeg',
    width: outputMetadata.width,
    height: outputMetadata.height,
    size: outputBuffer.length,
    preprocess: {
      enabled: true,
      originalSize: inputStats.size,
      processedSize: outputBuffer.length,
      originalWidth: inputMetadata.width,
      originalHeight: inputMetadata.height,
      processedWidth: outputMetadata.width,
      processedHeight: outputMetadata.height,
      widthBefore: inputMetadata.width,
      heightBefore: inputMetadata.height,
      widthAfter: outputMetadata.width,
      heightAfter: outputMetadata.height,
      quality,
      maxWidth: config.maxWidth
    }
  };
}

export async function preprocessImagesForVision(images, options = {}) {
  const config = { ...visionPreprocessConfig(), ...options };
  if (!config.enabled) {
    return {
      images,
      metadata: {
        enabled: false,
        totalOriginalBytes: images.reduce((sum, image) => sum + (image.size || 0), 0),
        totalProcessedBytes: images.reduce((sum, image) => sum + (image.size || 0), 0),
        images: []
      }
    };
  }

  const processed = [];
  for (const image of images) {
    processed.push(await preprocessImageForVision(image, config));
  }

  return {
    images: processed,
    metadata: {
      enabled: true,
      totalOriginalBytes: processed.reduce((sum, image) => sum + image.preprocess.originalSize, 0),
      totalProcessedBytes: processed.reduce((sum, image) => sum + image.preprocess.processedSize, 0),
      images: processed.map((image) => ({
        imageIndex: image.imageIndex,
        imageName: image.displayName || image.originalName || image.fileName,
        originalSize: image.preprocess.originalSize,
        processedSize: image.preprocess.processedSize,
        originalWidth: image.preprocess.originalWidth,
        originalHeight: image.preprocess.originalHeight,
        processedWidth: image.preprocess.processedWidth,
        processedHeight: image.preprocess.processedHeight,
        widthBefore: image.preprocess.widthBefore,
        heightBefore: image.preprocess.heightBefore,
        widthAfter: image.preprocess.widthAfter,
        heightAfter: image.preprocess.heightAfter,
        quality: image.preprocess.quality
      }))
    }
  };
}
