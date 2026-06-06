#!/usr/bin/env node
import path from 'node:path';
import fs from 'node:fs/promises';
import { getReviewProvider } from '../src/providers/review/index.js';

function parseArgs(argv) {
  const args = { provider: process.env.REVIEW_PROVIDER || 'mock', image: '' };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--provider') args.provider = argv[++i];
    else if (arg === '--image') args.image = argv[++i];
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.image) {
    console.log(JSON.stringify({
      status: 'failed',
      error: { code: 'MISSING_IMAGE_PATH', message: '请使用 --image 指定本地图片路径。' }
    }, null, 2));
    process.exitCode = 1;
    return;
  }
  const absolute = path.resolve(args.image);
  try {
    await fs.access(absolute);
    process.env.REVIEW_PROVIDER = args.provider;
    const provider = getReviewProvider(args.provider === 'mock' ? 'mock' : 'real');
    const image = {
      id: 'manual-review-image',
      planId: 'manual-review-plan',
      type: 'feature_image',
      fileName: path.basename(absolute),
      filePath: absolute,
      provider: 'manual',
      model: 'manual',
      isMockPreview: false,
      isRealGenerated: true
    };
    const task = {
      id: 'manual-review-task',
      platform: 'Amazon',
      productInfoConfirmed: { productName: 'Manual Review Product', category: 'General' },
      fieldEvidence: {},
      inferredCandidates: []
    };
    const plan = {
      id: image.planId,
      type: image.type,
      platform: 'Amazon',
      textBlocks: [],
      generationRequestSummary: { imageType: image.type, platform: 'Amazon' }
    };
    const result = await provider.review({ task, image, plan, generationRequest: plan.generationRequestSummary });
    console.log(JSON.stringify({
      provider: result.provider,
      model: result.model,
      status: result.status,
      durationMs: result.durationMs,
      error: result.error,
      data: result.data,
      rawResponsePreview: result.rawResponsePreview
    }, null, 2));
  } catch (error) {
    console.log(JSON.stringify({
      status: 'failed',
      error: {
        code: error.code || 'REVIEW_TEST_ERROR',
        message: error.message
      }
    }, null, 2));
    process.exitCode = 1;
  }
}

main();
