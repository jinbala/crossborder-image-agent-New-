import fs from 'node:fs/promises';
import path from 'node:path';
import { paths } from '../services/db.js';

const mimeByExtension = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp'
};

export function guessMimeType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const mimeType = mimeByExtension[ext];
  if (!mimeType) {
    const error = new Error(`Unsupported image format: ${ext || 'unknown'}`);
    error.code = 'UNSUPPORTED_IMAGE_FORMAT';
    throw error;
  }
  return mimeType;
}

export function resolveImagePath(filePath) {
  const absolute = path.isAbsolute(filePath) ? filePath : path.join(paths.rootDir, filePath);
  const normalized = path.resolve(absolute);
  if (!normalized.startsWith(paths.rootDir)) {
    const error = new Error('Image path is outside the project workspace');
    error.code = 'INVALID_IMAGE_PATH';
    throw error;
  }
  return normalized;
}

export async function readImageAsBase64DataUrl(filePath) {
  const absolutePath = resolveImagePath(filePath);
  const mimeType = guessMimeType(absolutePath);
  const buffer = await fs.readFile(absolutePath);
  return `data:${mimeType};base64,${buffer.toString('base64')}`;
}

export async function readImageAsGeminiInlineData(filePath) {
  const absolutePath = resolveImagePath(filePath);
  const mimeType = guessMimeType(absolutePath);
  const buffer = await fs.readFile(absolutePath);
  return {
    mimeType,
    base64: buffer.toString('base64')
  };
}
