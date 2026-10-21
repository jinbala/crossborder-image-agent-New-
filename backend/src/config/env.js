import dotenv from 'dotenv';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { paidProviderSummary } from '../services/paidOperationPolicy.js';

const configPath = fileURLToPath(import.meta.url);
const defaultBackendRoot = path.resolve(path.dirname(configPath), '..', '..');
const defaultProjectRoot = path.resolve(defaultBackendRoot, '..');

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return false;
  dotenv.config({ path: filePath, override: false, quiet: true });
  return true;
}

export function loadEnvConfig({
  projectRoot = defaultProjectRoot,
  backendRoot = defaultBackendRoot
} = {}) {
  const loadedFiles = [];
  const rootEnvPath = path.join(projectRoot, '.env');
  const backendEnvPath = path.join(backendRoot, '.env');

  if (loadEnvFile(rootEnvPath)) loadedFiles.push(rootEnvPath);
  if (loadEnvFile(backendEnvPath)) loadedFiles.push(backendEnvPath);

  return loadedFiles;
}

export function getSelectedVisionProvider() {
  return (process.env.VISION_PROVIDER || process.env.AI_PROVIDER || 'mock').toLowerCase();
}

export function getSelectedVisionModel(provider = getSelectedVisionProvider()) {
  if (provider === 'qwen') return process.env.QWEN_MODEL || process.env.VISION_MODEL || 'qwen-vl-max-latest';
  if (provider === 'openai') return process.env.OPENAI_VISION_MODEL || process.env.VISION_MODEL || 'gpt-4.1-mini';
  if (provider === 'gemini') return process.env.GEMINI_VISION_MODEL || process.env.VISION_MODEL || 'gemini-2.5-flash';
  return 'mock-vision-v0';
}

export function getProviderConfigSummary() {
  const selectedVisionProvider = getSelectedVisionProvider();
  const selectedImageProvider = (process.env.IMAGE_PROVIDER || process.env.AI_PROVIDER || 'mock').toLowerCase();
  const selectedBackgroundProvider = (process.env.BACKGROUND_PROVIDER || 'mock').toLowerCase();
  const selectedReviewProvider = (process.env.REVIEW_PROVIDER || 'mock').toLowerCase();
  const backgroundModelEnv = {
    openai: 'OPENAI_IMAGE_MODEL',
    qwen: 'QWEN_IMAGE_MODEL',
    gemini: 'GEMINI_IMAGE_MODEL',
    custom: 'CUSTOM_BACKGROUND_MODEL'
  }[selectedBackgroundProvider];

  return {
    paidDestinations: paidProviderSummary(),
    AI_PROVIDER: process.env.AI_PROVIDER || null,
    VISION_PROVIDER: process.env.VISION_PROVIDER || null,
    IMAGE_PROVIDER: process.env.IMAGE_PROVIDER || null,
    BACKGROUND_PROVIDER: process.env.BACKGROUND_PROVIDER || null,
    REVIEW_PROVIDER: process.env.REVIEW_PROVIDER || null,
    selectedVisionProvider,
    selectedVisionModel: getSelectedVisionModel(selectedVisionProvider),
    selectedImageProvider,
    selectedBackgroundProvider,
    selectedReviewProvider,
    selectedReviewModel: process.env.REVIEW_MODEL || getSelectedVisionModel(selectedReviewProvider === 'vision' ? selectedVisionProvider : selectedReviewProvider),
    selectedBackgroundModel: (backgroundModelEnv && process.env[backgroundModelEnv]) || process.env.IMAGE_MODEL || (selectedBackgroundProvider === 'openai' ? 'gpt-image-2' : null),
    openAIImageEditEnabled: String(process.env.OPENAI_IMAGE_EDIT_ENABLED || 'false').toLowerCase() === 'true',
    openAIImageEditModel: process.env.OPENAI_IMAGE_EDIT_MODEL || process.env.OPENAI_IMAGE_MODEL || process.env.IMAGE_MODEL || (selectedBackgroundProvider === 'openai' ? 'gpt-image-2' : null),
    openAISubjectCompositeEnabled: String(process.env.OPENAI_SUBJECT_COMPOSITE_ENABLED || 'true').toLowerCase() !== 'false',
    selectedMattingProvider: (process.env.MATTING_PROVIDER || 'sharp').toLowerCase(),
    hasGeminiKey: Boolean(process.env.GEMINI_API_KEY),
    hasOpenAIKey: Boolean(process.env.OPENAI_API_KEY),
    hasQwenKey: Boolean(process.env.QWEN_API_KEY),
    hasBackgroundKey: Boolean(process.env.BACKGROUND_API_KEY)
  };
}

loadEnvConfig();
