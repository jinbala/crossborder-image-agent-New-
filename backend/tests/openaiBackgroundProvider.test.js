import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import sharp from 'sharp';
import { OpenAIBackgroundProvider } from '../src/providers/image/openaiBackgroundProvider.js';
import { paths } from '../src/services/db.js';

const originalOutputDir = paths.outputDir;
const isolatedOutputDir = path.join(os.tmpdir(), `crossborder-openai-bg-${process.pid}`);
const referenceImagePath = path.join(isolatedOutputDir, 'openai-edit-reference.png');

function tinyPngBase64() {
  return sharp({
    create: {
      width: 64,
      height: 64,
      channels: 3,
      background: '#f8fafc'
    }
  }).png().toBuffer().then((buffer) => buffer.toString('base64'));
}

function generationRequest() {
  return {
    requestVersion: 'v1.8',
    taskId: 'task-openai-bg',
    planId: 'lifestyle_image-1',
    imageType: 'lifestyle_image',
    platform: 'Amazon',
    prompt: {
      positivePrompt: 'Create professional e-commerce lifestyle product photography on a modern office desk.',
      negativePrompt: 'No Chinese text. No price. No watermark.',
      promptVersion: 'v1.5'
    },
    providerHints: {
      preferredMode: 'background_replace',
      safeForRealGeneration: true,
      blockingIssues: []
    },
    sourceImages: [{ id: 'source-1' }],
    productReference: {
      enabled: true,
      sourceImageId: 'source-1',
      imageIndex: 0,
      displayName: '01-main.png',
      filePath: referenceImagePath,
      previewUrl: '/uploads/openai-edit-reference.png',
      role: 'main',
      reason: 'source image role is main'
    }
  };
}

function task() {
  return {
    id: 'task-openai-bg',
    platform: 'Amazon'
  };
}

function plan() {
  return {
    id: 'lifestyle_image-1',
    type: 'lifestyle_image',
    title: 'Lifestyle Image',
    compositeSettings: {
      placement: 'bottom_center',
      scale: 0.58,
      shadowEnabled: true,
      edgeFeather: 2,
      colorMatch: 'basic'
    }
  };
}

before(async () => {
  paths.outputDir = isolatedOutputDir;
  await fs.rm(isolatedOutputDir, { recursive: true, force: true });
  await fs.mkdir(isolatedOutputDir, { recursive: true });
  await sharp({
    create: {
      width: 256,
      height: 256,
      channels: 4,
      background: '#ffffff'
    }
  })
    .composite([
      {
        input: Buffer.from('<svg width="256" height="256" xmlns="http://www.w3.org/2000/svg"><rect x="72" y="56" width="112" height="144" rx="18" fill="#1f2937"/></svg>')
      }
    ])
    .png()
    .toFile(referenceImagePath);
});

after(async () => {
  paths.outputDir = originalOutputDir;
  await fs.rm(isolatedOutputDir, { recursive: true, force: true });
});

test('OpenAI background provider uses text-to-image when image edit is disabled', async () => {
  const b64 = await tinyPngBase64();
  const calls = { generate: 0, edit: 0 };
  const fakeClient = {
    images: {
      generate: async () => {
        calls.generate += 1;
        return { data: [{ b64_json: b64 }] };
      },
      edit: async () => {
        calls.edit += 1;
        return { data: [{ b64_json: b64 }] };
      }
    }
  };
  const provider = new OpenAIBackgroundProvider({
    apiKey: 'test-key',
    outputSize: '1024x1024',
    subjectCompositeEnabled: false,
    editEnabled: false,
    client: fakeClient
  });

  const result = await provider.generate({ task: task(), plan: plan(), generationRequest: generationRequest() });

  assert.equal(result.status, 'success');
  assert.equal(calls.generate, 1);
  assert.equal(calls.edit, 0);
  assert.equal(result.metadata.productReferenceUsed, false);
  assert.equal(result.metadata.realBackgroundOnly, true);
  assert.equal(result.metadata.editAttempted, false);
});

test('OpenAI background provider uses subject composite before image edit', async () => {
  const b64 = await tinyPngBase64();
  const calls = { generate: 0, edit: 0 };
  const fakeClient = {
    images: {
      generate: async (input) => {
        calls.generate += 1;
        assert.match(input.prompt, /no product/i);
        return { data: [{ b64_json: b64 }] };
      },
      edit: async () => {
        calls.edit += 1;
        throw new Error('edit should not be called when subject composite works');
      }
    }
  };
  const provider = new OpenAIBackgroundProvider({
    apiKey: 'test-key',
    outputSize: '1024x1024',
    subjectCompositeEnabled: true,
    editEnabled: true,
    client: fakeClient
  });

  const result = await provider.generate({ task: task(), plan: plan(), generationRequest: generationRequest(), version: 5 });

  assert.equal(result.status, 'success');
  assert.equal(calls.generate, 1);
  assert.equal(calls.edit, 0);
  assert.equal(result.metadata.realGenerationMode, 'subject_composite');
  assert.equal(result.metadata.productReferenceUsed, true);
  assert.equal(result.metadata.subjectCompositeUsed, true);
  assert.equal(result.metadata.subjectPreserved, true);
  assert.equal(result.metadata.productGeneratedByAI, false);
  assert.equal(result.metadata.compositeMode, 'subject_composite');
  assert.equal(result.metadata.compositeSettings.scale, 0.58);
  assert.equal(result.metadata.shadowApplied, true);
  assert.equal(result.metadata.edgeFeatherApplied, true);
  assert.equal(result.metadata.colorMatchApplied, true);
  assert.equal(result.metadata.compositeQuality.level, 'good');
  assert.equal(result.metadata.backgroundGenerated, true);
  assert.equal(result.metadata.mattingProvider, 'sharp');
  assert.equal(result.metadata.mattingMethod, 'sharp_light_background_alpha_mask');
  assert.ok(result.metadata.mattingConfidence > 0);
  assert.ok(Array.isArray(result.metadata.mattingWarnings));
  assert.equal(result.metadata.fallbackChain[0].mode, 'subject_composite');
  assert.equal(result.metadata.fallbackChain[0].status, 'success');
});

test('OpenAI background provider realMode=image_edit skips subject composite', async () => {
  const b64 = await tinyPngBase64();
  const calls = { generate: 0, edit: 0 };
  const fakeClient = {
    images: {
      generate: async () => {
        calls.generate += 1;
        throw new Error('generate should not be called before forced image edit');
      },
      edit: async () => {
        calls.edit += 1;
        return { data: [{ b64_json: b64 }] };
      }
    }
  };
  const provider = new OpenAIBackgroundProvider({
    apiKey: 'test-key',
    outputSize: '1024x1024',
    editOutputSize: '1024x1024',
    subjectCompositeEnabled: true,
    editEnabled: true,
    client: fakeClient
  });

  const result = await provider.generate({
    task: task(),
    plan: plan(),
    generationRequest: generationRequest(),
    realMode: 'image_edit'
  });

  assert.equal(result.status, 'success');
  assert.equal(calls.generate, 0);
  assert.equal(calls.edit, 1);
  assert.equal(result.metadata.realGenerationMode, 'image_edit');
  assert.equal(result.metadata.generationStrategy.selectedMode, 'image_edit');
});

test('OpenAI background provider realMode=text_to_image skips subject composite and edit', async () => {
  const b64 = await tinyPngBase64();
  const calls = { generate: 0, edit: 0 };
  const fakeClient = {
    images: {
      generate: async () => {
        calls.generate += 1;
        return { data: [{ b64_json: b64 }] };
      },
      edit: async () => {
        calls.edit += 1;
        throw new Error('edit should not be called for forced text-to-image');
      }
    }
  };
  const provider = new OpenAIBackgroundProvider({
    apiKey: 'test-key',
    outputSize: '1024x1024',
    editEnabled: true,
    subjectCompositeEnabled: true,
    client: fakeClient
  });

  const result = await provider.generate({
    task: task(),
    plan: plan(),
    generationRequest: generationRequest(),
    realMode: 'text_to_image'
  });

  assert.equal(result.status, 'success');
  assert.equal(calls.generate, 1);
  assert.equal(calls.edit, 0);
  assert.equal(result.metadata.realGenerationMode, 'text_to_image');
  assert.equal(result.metadata.preserveQuality.subjectPreserveRisk, 'high');
  assert.equal(result.metadata.generationStrategy.selectedMode, 'text_to_image');
});

test('OpenAI background provider falls back from subject composite to image edit', async () => {
  const b64 = await tinyPngBase64();
  const calls = { generate: 0, edit: 0 };
  const fakeClient = {
    images: {
      generate: async () => {
        calls.generate += 1;
        throw new Error('background should not be generated without a valid subject');
      },
      edit: async () => {
        calls.edit += 1;
        return { data: [{ b64_json: b64 }] };
      }
    }
  };
  const provider = new OpenAIBackgroundProvider({
    apiKey: 'test-key',
    outputSize: '1024x1024',
    editOutputSize: '1024x1024',
    subjectCompositeEnabled: true,
    editEnabled: true,
    client: fakeClient
  });
  const request = generationRequest();

  const previousMattingProvider = process.env.MATTING_PROVIDER;
  const previousFallbackProvider = process.env.MATTING_FALLBACK_PROVIDER;
  let result;
  try {
    process.env.MATTING_PROVIDER = 'external';
    process.env.MATTING_FALLBACK_PROVIDER = 'none';
    result = await provider.generate({ task: task(), plan: plan(), generationRequest: request });
  } finally {
    if (previousMattingProvider === undefined) {
      delete process.env.MATTING_PROVIDER;
    } else {
      process.env.MATTING_PROVIDER = previousMattingProvider;
    }
    if (previousFallbackProvider === undefined) {
      delete process.env.MATTING_FALLBACK_PROVIDER;
    } else {
      process.env.MATTING_FALLBACK_PROVIDER = previousFallbackProvider;
    }
  }

  assert.equal(result.status, 'success');
  assert.equal(calls.generate, 0);
  assert.equal(calls.edit, 1);
  assert.equal(result.metadata.realGenerationMode, 'image_edit');
  assert.equal(result.metadata.editSucceeded, true);
  assert.equal(result.metadata.fallbackChain[0].error.code, 'MATTING_FAILED');
  assert.equal(result.metadata.fallbackChain[0].mode, 'subject_composite');
  assert.equal(result.metadata.fallbackChain[0].status, 'failed');
  assert.equal(result.metadata.fallbackChain[1].mode, 'image_edit');
  assert.equal(result.metadata.fallbackChain[1].status, 'success');
});

test('OpenAI subject composite records external matting fallback to sharp', async () => {
  const b64 = await tinyPngBase64();
  const fakeClient = {
    images: {
      generate: async () => ({ data: [{ b64_json: b64 }] }),
      edit: async () => {
        throw new Error('edit should not be called after sharp fallback works');
      }
    }
  };
  const provider = new OpenAIBackgroundProvider({
    apiKey: 'test-key',
    outputSize: '1024x1024',
    subjectCompositeEnabled: true,
    editEnabled: true,
    client: fakeClient
  });
  const previous = {
    MATTING_PROVIDER: process.env.MATTING_PROVIDER,
    MATTING_API_KEY: process.env.MATTING_API_KEY,
    MATTING_BASE_URL: process.env.MATTING_BASE_URL
  };
  try {
    process.env.MATTING_PROVIDER = 'external';
    process.env.MATTING_API_KEY = 'test-key';
    process.env.MATTING_BASE_URL = 'https://unreachable.invalid/matting';
    const result = await provider.generate({
      task: task(),
      plan: plan(),
      generationRequest: generationRequest(),
      realMode: 'subject_composite'
    });

    assert.equal(result.status, 'success');
    assert.equal(result.metadata.realGenerationMode, 'subject_composite');
    assert.equal(result.metadata.mattingProvider, 'sharp');
    assert.equal(result.metadata.mattingFallbackToSharp, true);
    assert.ok(result.metadata.externalMattingError);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value == null) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('OpenAI background provider marks edit success with product reference metadata', async () => {
  const b64 = await tinyPngBase64();
  const calls = [];
  const fakeClient = {
    images: {
      edit: async (input) => {
        calls.push(input);
        return { data: [{ b64_json: b64 }] };
      },
      generate: async () => {
        throw new Error('generate should not be called');
      }
    }
  };
  const provider = new OpenAIBackgroundProvider({
    apiKey: 'test-key',
    outputSize: '1024x1024',
    editOutputSize: '1024x1024',
    subjectCompositeEnabled: false,
    editEnabled: true,
    client: fakeClient
  });

  const result = await provider.generate({ task: task(), plan: plan(), generationRequest: generationRequest(), version: 4 });

  assert.equal(result.status, 'success');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].model, 'gpt-image-2');
  assert.match(calls[0].prompt, /keep the product exactly as in the reference image/i);
  assert.ok(calls[0].image);
  assert.equal(result.metadata.productReferenceUsed, true);
  assert.equal(result.metadata.realBackgroundOnly, false);
  assert.equal(result.metadata.editAttempted, true);
  assert.equal(result.metadata.editSucceeded, true);
  assert.equal(result.metadata.editFailed, false);
  assert.equal(result.metadata.fallbackMode, null);
  assert.equal(result.metadata.productReference.sourceImageId, 'source-1');
  assert.ok(result.metadata.referencePreprocess.processedSize > 0);
});

test('OpenAI background provider falls back to text-to-image when edit fails', async () => {
  const b64 = await tinyPngBase64();
  const fakeClient = {
    images: {
      edit: async () => {
        const error = new Error('edit failed');
        error.code = 'PROVIDER_ERROR';
        throw error;
      },
      generate: async () => ({ data: [{ b64_json: b64 }] })
    }
  };
  const provider = new OpenAIBackgroundProvider({
    apiKey: 'test-key',
    outputSize: '1024x1024',
    editOutputSize: '1024x1024',
    subjectCompositeEnabled: false,
    editEnabled: true,
    client: fakeClient
  });

  const result = await provider.generate({ task: task(), plan: plan(), generationRequest: generationRequest() });

  assert.equal(result.status, 'success');
  assert.equal(result.metadata.productReferenceUsed, false);
  assert.equal(result.metadata.realBackgroundOnly, true);
  assert.equal(result.metadata.editAttempted, true);
  assert.equal(result.metadata.editSucceeded, false);
  assert.equal(result.metadata.editFailed, true);
  assert.equal(result.metadata.fallbackMode, 'text_to_image');
  assert.equal(result.metadata.editError.code, 'PROVIDER_ERROR');
  assert.equal(result.metadata.fallbackChain[0].mode, 'image_edit');
  assert.equal(result.metadata.fallbackChain[0].status, 'failed');
  assert.equal(result.metadata.fallbackChain[1].mode, 'text_to_image');
  assert.equal(result.metadata.fallbackChain[1].status, 'success');
});

test('OpenAI background provider falls back to text-to-image when edit is enabled without reference', async () => {
  const b64 = await tinyPngBase64();
  const calls = { generate: 0, edit: 0 };
  const fakeClient = {
    images: {
      edit: async () => {
        calls.edit += 1;
        throw new Error('edit should not be called without a reference');
      },
      generate: async () => {
        calls.generate += 1;
        return { data: [{ b64_json: b64 }] };
      }
    }
  };
  const provider = new OpenAIBackgroundProvider({
    apiKey: 'test-key',
    outputSize: '1024x1024',
    subjectCompositeEnabled: false,
    editEnabled: true,
    client: fakeClient
  });
  const request = {
    ...generationRequest(),
    productReference: { enabled: false, reason: 'no source images available' }
  };

  const result = await provider.generate({ task: task(), plan: plan(), generationRequest: request });

  assert.equal(result.status, 'success');
  assert.equal(calls.edit, 0);
  assert.equal(calls.generate, 1);
  assert.equal(result.metadata.productReferenceUsed, false);
  assert.equal(result.metadata.editAttempted, false);
  assert.equal(result.metadata.fallbackMode, 'text_to_image');
  assert.equal(result.metadata.editSkippedReason, 'NO_PRODUCT_REFERENCE');
});

test('OpenAI background provider reports missing API key', async () => {
  const provider = new OpenAIBackgroundProvider({ apiKey: '', client: {} });
  const result = await provider.generate({ task: task(), plan: plan(), generationRequest: generationRequest() });

  assert.equal(result.status, 'failed');
  assert.equal(result.error.code, 'MISSING_API_KEY');
  assert.match(result.error.message, /OPENAI_API_KEY/);
});

test('OpenAI background provider defaults to gpt-image-2 and saves base64 image output', async () => {
  const previousOpenAIImageModel = process.env.OPENAI_IMAGE_MODEL;
  const previousImageModel = process.env.IMAGE_MODEL;
  delete process.env.OPENAI_IMAGE_MODEL;
  delete process.env.IMAGE_MODEL;
  const b64 = await tinyPngBase64();
  const calls = [];
  const fakeClient = {
    images: {
      generate: async (input) => {
        calls.push(input);
        return { data: [{ b64_json: b64 }] };
      }
    }
  };
  const provider = new OpenAIBackgroundProvider({
    apiKey: 'test-key',
    outputSize: '1024x1024',
    subjectCompositeEnabled: false,
    client: fakeClient
  });

  try {
    const result = await provider.generate({ task: task(), plan: plan(), generationRequest: generationRequest(), version: 2 });

    assert.equal(result.status, 'success');
    assert.equal(result.provider, 'openai');
    assert.equal(result.model, 'gpt-image-2');
    assert.equal(result.output.isRealGenerated, true);
    assert.equal(result.output.isMockPreview, false);
    assert.ok(result.output.filePath.includes('task-openai-bg'));
    assert.ok(result.output.previewUrl.includes('/outputs/task-openai-bg/'));
    assert.equal(result.metadata.productReferenceUsed, false);
    assert.equal(result.metadata.realBackgroundOnly, true);
    assert.equal(calls[0].model, 'gpt-image-2');
    assert.match(calls[0].prompt, /professional e-commerce lifestyle product photography/i);

    const stats = await fs.stat(path.resolve(paths.rootDir, result.output.filePath));
    assert.ok(stats.size > 100);
  } finally {
    if (previousOpenAIImageModel == null) delete process.env.OPENAI_IMAGE_MODEL;
    else process.env.OPENAI_IMAGE_MODEL = previousOpenAIImageModel;
    if (previousImageModel == null) delete process.env.IMAGE_MODEL;
    else process.env.IMAGE_MODEL = previousImageModel;
  }
});

test('OpenAI background provider uses OPENAI_IMAGE_MODEL from environment', async () => {
  const previousOpenAIImageModel = process.env.OPENAI_IMAGE_MODEL;
  const b64 = await tinyPngBase64();
  const calls = [];
  const fakeClient = {
    images: {
      generate: async (input) => {
        calls.push(input);
        return { data: [{ b64_json: b64 }] };
      }
    }
  };
  process.env.OPENAI_IMAGE_MODEL = 'gpt-image-2-custom';
  const provider = new OpenAIBackgroundProvider({
    apiKey: 'test-key',
    outputSize: '1024x1024',
    subjectCompositeEnabled: false,
    client: fakeClient
  });

  try {
    const result = await provider.generate({ task: task(), plan: plan(), generationRequest: generationRequest(), version: 3 });
    assert.equal(result.model, 'gpt-image-2-custom');
    assert.equal(calls[0].model, 'gpt-image-2-custom');
  } finally {
    if (previousOpenAIImageModel == null) delete process.env.OPENAI_IMAGE_MODEL;
    else process.env.OPENAI_IMAGE_MODEL = previousOpenAIImageModel;
  }
});
