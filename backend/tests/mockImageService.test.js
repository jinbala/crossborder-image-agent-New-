import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { generateMockImageForPlan } from '../src/services/mockImageService.js';
import { buildExportMetadata, buildExportPrompts } from '../src/services/exportService.js';
import { paths } from '../src/services/db.js';

const planTypes = [
  'main_image',
  'feature_image',
  'size_image',
  'compatibility_image',
  'package_image',
  'lifestyle_image',
  'detail_image',
  'variant_image'
];

const originalOutputDir = paths.outputDir;
const isolatedOutputDir = path.join(os.tmpdir(), `crossborder-image-agent-mock-preview-${process.pid}`);

function baseTask(overrides = {}) {
  return {
    id: 'mock-preview-test',
    platform: 'Amazon',
    productInfoConfirmed: {
      sku: 'MOCK-001',
      name: 'Portable External Drive',
      category: 'External Storage',
      dimensions: '',
      material: 'Aluminum',
      interfaceType: 'USB-C',
      compatibleDevices: ['Laptop', 'Phone'],
      packageList: [],
      sellingPoints: ['Fast backup', 'Portable design'],
      visibleSpecs: ['USB-C port']
    },
    productInfo: {
      sku: 'MOCK-001',
      name: 'Portable External Drive'
    },
    inferredCandidates: [{ field: 'capacity', value: '5TB', reason: 'No visible evidence' }],
    ...overrides
  };
}

function plan(type, overrides = {}) {
  return {
    id: `${type}-1`,
    type,
    title: `${type} title`,
    goal: `${type} goal`,
    platform: 'Amazon',
    prompt: `Prompt for ${type}`,
    textBlocks: [
      { id: 'text-1', label: 'Point', text: 'Fast backup', sourceFields: ['sellingPoints'] },
      { id: 'text-2', label: 'Capacity', text: '5TB', sourceFields: ['capacity'] }
    ],
    riskWarnings: [],
    excludedUnconfirmedFields: [{ field: 'capacity', value: '5TB', reason: 'No evidence' }],
    ...overrides
  };
}

before(async () => {
  paths.outputDir = isolatedOutputDir;
  await fs.rm(isolatedOutputDir, { recursive: true, force: true });
});

after(async () => {
  paths.outputDir = originalOutputDir;
  await fs.rm(isolatedOutputDir, { recursive: true, force: true });
});

test('generates mock preview images for all eight plan types', async () => {
  for (const [index, type] of planTypes.entries()) {
    const result = await generateMockImageForPlan({
      task: baseTask(),
      plan: plan(type),
      outputIndex: index + 1
    });

    const absolutePath = path.join(paths.rootDir, result.filePath);
    const stats = await fs.stat(absolutePath);
    assert.ok(stats.size > 1000);
    assert.equal(result.status, 'succeeded');
    assert.equal(result.provider, 'mock');
    assert.equal(result.previewUrl, `/outputs/mock-preview-test/${result.fileName}`);
    assert.equal(result.isMockPreview, true);
    assert.equal(result.mockPreview.type, type);
    assert.ok(result.mockPreview.sections.length >= 1);
    assert.equal(result.mockPreview.template.templateType, type);
    assert.ok(result.mockPreview.template.templateName);
    assert.ok(result.mockPreview.template.layoutStyle);
    assert.ok(result.mockPreview.template.variantId);
    assert.ok(result.mockPreview.layoutStyle);
    assert.equal(result.mockPreview.layoutStyle, result.mockPreview.template.layoutStyle);
  }
});

test('mock preview template copy is English and marketplace safe', async () => {
  for (const [index, type] of planTypes.entries()) {
    const result = await generateMockImageForPlan({
      task: baseTask({
        productInfoConfirmed: {
          sku: 'MOCK-002',
          name: 'Portable External Drive',
          category: 'External Storage',
          sellingPoints: ['中文卖点', '50% OFF', 'Compact Design'],
          compatibleDevices: [],
          packageList: [],
          dimensions: '',
          capacity: ['5TB']
        },
        fieldEvidence: {},
        recognitionQuality: {
          missingEvidenceFields: [{ field: 'capacity' }],
          conflictFields: [{ field: 'compatibleDevices' }],
          inferredOnlyFields: [{ field: 'dimensions' }]
        },
        inferredCandidates: [{ field: 'capacity', value: '5TB' }]
      }),
      plan: plan(type, {
        textBlocks: [
          { id: 'safe', text: 'Compact Design', sourceFields: ['sellingPoints'] },
          { id: 'cn', text: '中文卖点', sourceFields: ['sellingPoints'] },
          { id: 'promo', text: '50% OFF', sourceFields: ['sellingPoints'] },
          { id: 'capacity', text: '5TB', sourceFields: ['capacity'] }
        ]
      }),
      outputIndex: index + 1
    });
    const visibleCopy = JSON.stringify({
      template: result.mockPreview.template,
      title: result.mockPreview.title,
      sections: result.mockPreview.sections,
      missingInfo: result.mockPreview.missingInfo
    });

    assert.doesNotMatch(visibleCopy, /[\u3400-\u9fff]/);
    assert.doesNotMatch(visibleCopy, /\b(price|sale|discount|off|coupon|deal|best|no\.?\s*1|guaranteed)\b|[$€£¥]|\d+\s?%/i);
    assert.doesNotMatch(visibleCopy, /5TB/);
  }
});

test('main image mock preview does not use promotional textBlocks', async () => {
  const result = await generateMockImageForPlan({
    task: baseTask(),
    plan: plan('main_image'),
    outputIndex: 1
  });

  assert.deepEqual(result.mockPreview.usedTextBlocks, []);
  assert.match(result.mockPreview.note, /Main Image Preview/);
  assert.equal(result.mockPreview.template.backgroundStyle, 'pure_white');
  assert.equal(result.mockPreview.template.allowedTextBlocks.length, 0);
});

test('mock preview varies layout seed across regenerated versions without unsafe copy', async () => {
  const outputs = [];
  for (const version of [1, 2, 3]) {
    outputs.push(await generateMockImageForPlan({
      task: baseTask({
        productInfoConfirmed: {
          sku: 'MOCK-003',
          name: 'Portable External Drive',
          category: 'External Storage',
          sellingPoints: ['Compact Design', '涓枃鍗栫偣', '50% OFF'],
          compatibleDevices: ['All devices'],
          capacity: ['5TB']
        },
        recognitionQuality: {
          missingEvidenceFields: [{ field: 'capacity' }],
          conflictFields: [{ field: 'compatibleDevices' }],
          inferredOnlyFields: []
        }
      }),
      plan: plan('feature_image', {
        textBlocks: [
          { id: 'safe', text: 'Compact Design', sourceFields: ['sellingPoints'] },
          { id: 'cn', text: '涓枃鍗栫偣', sourceFields: ['sellingPoints'] },
          { id: 'promo', text: '50% OFF', sourceFields: ['sellingPoints'] },
          { id: 'capacity', text: '5TB', sourceFields: ['capacity'] }
        ]
      }),
      outputIndex: 2,
      version
    }));
  }

  assert.ok(new Set(outputs.map((item) => item.mockPreview.template.variantId)).size >= 2);
  for (const result of outputs) {
    const visibleCopy = JSON.stringify({
      template: result.mockPreview.template,
      layoutStyle: result.mockPreview.layoutStyle,
      sections: result.mockPreview.sections
    });
    assert.equal(result.mockPreview.layoutStyle, result.mockPreview.template.layoutStyle);
    assert.doesNotMatch(visibleCopy, /[\u3400-\u9fff]/);
    assert.doesNotMatch(visibleCopy, /\b(price|sale|discount|off|coupon|deal|best|no\.?\s*1|guaranteed)\b|\d+\s?%/i);
    assert.doesNotMatch(visibleCopy, /5TB|All devices/);
  }
});

test('feature image mock preview includes textBlocks summary', async () => {
  const result = await generateMockImageForPlan({
    task: baseTask(),
    plan: plan('feature_image'),
    outputIndex: 2
  });

  assert.ok(result.mockPreview.usedTextBlocks.some((block) => block.text === 'Fast backup'));
  assert.equal(result.generationRequest.imageType, 'feature_image');
  assert.ok(result.generationRequest.textBlocks.some((block) => block.text === 'Fast backup'));
  assert.equal(result.mockPreview.usedTextBlocks[0].text, result.generationRequest.textBlocks[0].text);
});

test('mock preview uses programmatic text layout metadata for text-heavy images', async () => {
  const result = await generateMockImageForPlan({
    task: baseTask({
      productInfoConfirmed: {
        sku: 'MOCK-001',
        productName: 'Portable External Drive',
        category: 'External Storage',
        sellingPoints: ['Fast backup', 'Portable design'],
        visibleSpecs: ['USB-C port'],
        dimensions: ['4.5 x 2.8 in'],
        packageIncluded: ['Drive', 'USB cable'],
        compatibleDevices: ['Laptop', 'Phone'],
        capacity: ['1TB']
      },
      fieldEvidence: {
        capacity: [{ source: 'visible_text', text: '1TB', value: '1TB' }]
      }
    }),
    plan: plan('feature_image', {
      textBlocks: [
        { id: 'safe', text: 'Fast backup', sourceField: 'sellingPoints', evidenceStatus: 'confirmed' },
        { id: 'unsafe', text: '限时优惠', sourceField: 'promotion', evidenceStatus: 'confirmed' }
      ]
    }),
    outputIndex: 2
  });

  assert.equal(result.renderedBy, 'programmatic_text_layout');
  assert.equal(result.textLayout.layoutVersion, 'v2.9');
  assert.ok(result.textLayout.textElements.some((item) => item.text === 'Fast backup'));
  assert.ok(result.textLayout.warnings.some((item) => item.code === 'TEXT_FILTERED_CHINESE'));
});

test('mock preview prefers user textLayoutOverride and records layout source', async () => {
  const result = await generateMockImageForPlan({
    task: baseTask(),
    plan: plan('feature_image', {
      textLayoutOverride: {
        layoutVersion: 'v2.9',
        textElements: [
          { id: 'custom-headline', text: 'Custom Layout Copy', x: 180, y: 160, width: 900, height: 80, fontSize: 52 }
        ],
        iconElements: [],
        lineElements: [],
        editedByUser: true
      }
    }),
    outputIndex: 2
  });

  assert.equal(result.renderedBy, 'programmatic_text_layout');
  assert.equal(result.layoutSource, 'user_override');
  assert.equal(result.layoutEditedByUser, true);
  assert.equal(result.textLayout.textElements[0].text, 'Custom Layout Copy');
});

test('lifestyle mock preview does not use programmatic text layout', async () => {
  const result = await generateMockImageForPlan({
    task: baseTask(),
    plan: plan('lifestyle_image'),
    outputIndex: 6
  });

  assert.equal(result.textLayout, null);
  assert.equal(result.renderedBy, 'mock_template');
});

test('lifestyle mock preview normalizes null composite settings from storage', async () => {
  const result = await generateMockImageForPlan({
    task: baseTask(),
    plan: plan('lifestyle_image', { compositeSettings: null }),
    outputIndex: 6
  });

  assert.equal(result.status, 'succeeded');
  assert.equal(result.compositeSettings.scale, 0.72);
  assert.equal(result.subjectScale, 0.72);
  assert.equal(result.shadowApplied, true);
});

test('size and package mock previews show missing information when confirmed fields are empty', async () => {
  const sizeResult = await generateMockImageForPlan({
    task: baseTask(),
    plan: plan('size_image', { textBlocks: [] }),
    outputIndex: 3
  });
  const packageResult = await generateMockImageForPlan({
    task: baseTask(),
    plan: plan('package_image', { textBlocks: [] }),
    outputIndex: 5
  });

  assert.ok(sizeResult.mockPreview.missingInfo.some((item) => /尺寸|size/i.test(item)));
  assert.ok(packageResult.mockPreview.missingInfo.some((item) => /包装|package/i.test(item)));
});

test('variant mock preview does not render inferred capacity values', async () => {
  const result = await generateMockImageForPlan({
    task: baseTask(),
    plan: plan('variant_image'),
    outputIndex: 8
  });

  const renderedText = JSON.stringify(result.mockPreview);
  assert.doesNotMatch(renderedText, /5TB/);
  assert.ok(result.mockPreview.missingInfo.some((item) => /变体|variant/i.test(item)));
});

test('export metadata marks generated mock previews', () => {
  const imagePlan = plan('feature_image');
  const generatedImage = {
    id: 'image-1',
    planId: 'feature_image-1',
    provider: 'mock',
    model: 'mock-image-v0.3',
    isMockPreview: true,
      generationRequestSummary: {
        requestVersion: 'v1.8',
        imageType: 'feature_image',
      preferredMode: 'text_layout',
      safeForRealGeneration: true,
      blockingIssues: [],
      positivePrompt: 'positive',
      negativePrompt: 'negative',
      textBlocks: [{ text: 'Fast backup' }],
      forbiddenElements: ['Chinese text']
    },
    renderedBy: 'programmatic_text_layout',
    textLayout: {
      layoutVersion: 'v2.9',
      textElements: [{ id: 'text-1', text: 'Fast backup' }],
      iconElements: [],
      lineElements: [],
      warnings: [],
      blockingIssues: []
    }
  };
  const metadata = buildExportMetadata({
    ...baseTask(),
    sourceImages: [],
    targets: [],
    generatedImages: [generatedImage],
    imagePlans: [imagePlan],
    exports: []
  });
  const prompts = buildExportPrompts({
    ...baseTask(),
    sourceImages: [],
    targets: [],
    generatedImages: [generatedImage],
    imagePlans: [imagePlan],
    exports: []
  });

  assert.equal(metadata.isMockPreview, true);
  assert.equal(metadata.generatedImages[0].isMockPreview, true);
  assert.equal(metadata.generatedImages[0].generationRequestSummary.requestVersion, 'v1.8');
  assert.equal(prompts.generationRequests[0].imageType, 'feature_image');
  assert.equal(prompts.generationRequests[0].preferredMode, 'text_layout');
  assert.equal(prompts.imageSourceSummary.mockPreviewCount, 1);
  assert.equal(prompts.generatedImages[0].isMockPreview, true);
  assert.equal(metadata.generatedImages[0].renderedBy, 'programmatic_text_layout');
  assert.equal(metadata.generatedImages[0].textLayout.layoutVersion, 'v2.9');
});

test('export metadata summarizes mixed mock real and fallback image sources', () => {
  const generatedImages = [
    {
      id: 'mock-image',
      planId: 'main_image-1',
      type: 'main_image',
      fileName: 'Amazon_MOCK_main_image_1.jpg',
      provider: 'mock',
      model: 'mock-image-v0.3',
      isMockPreview: true,
      isRealGenerated: false,
      fallbackToMock: false,
      productReferenceUsed: false,
      realBackgroundOnly: false
    },
    {
      id: 'real-image',
      planId: 'lifestyle_image-1',
      type: 'lifestyle_image',
      fileName: 'task_lifestyle_image_openai_v1.png',
      provider: 'openai',
      model: 'gpt-image-2',
      mode: 'background_replace',
      isMockPreview: false,
      isRealGenerated: true,
      fallbackToMock: false,
      productReferenceUsed: false,
      realBackgroundOnly: true,
      realGenerationMode: 'subject_composite',
      subjectCompositeUsed: true,
      subjectExtractionMethod: 'sharp_light_background_alpha_mask',
      subjectSourceImageId: 'source-1',
      subjectSourceDisplayName: '01-main.png',
      subjectPreserved: true,
      backgroundGenerated: true,
      productGeneratedByAI: false,
      mattingProvider: 'sharp',
      mattingModel: 'sharp-alpha-mask-v1',
      mattingMethod: 'sharp_light_background_alpha_mask',
      mattingConfidence: 0.82,
      edgeQuality: 'good',
      backgroundType: 'plain',
      mattingWarnings: [],
      preserveQuality: {
        qualityScore: 86,
        qualityLevel: 'good',
        subjectPreserveRisk: 'low',
        backgroundRisk: 'low',
        textRisk: 'low',
        reasons: ['Clean subject composite'],
        suggestions: ['Manual review still recommended']
      },
      generationStrategy: {
        selectedMode: 'subject_composite',
        recommendedMode: 'subject_composite',
        reason: 'Clean reference image',
        alternatives: ['image_edit'],
        blockingIssues: []
      },
      compositeMetadata: { compositeUsed: true, subjectScale: 0.4 },
      fallbackChain: [{ mode: 'subject_composite', status: 'success' }],
      editAttempted: true,
      editSucceeded: true,
      editFailed: false,
      fallbackMode: null,
      productReference: { sourceImageId: 'source-1', imageIndex: 0, displayName: '01-main.png', role: 'main' },
      referencePreprocess: { originalSize: 1000, processedSize: 700, widthBefore: 1200, heightBefore: 1200, widthAfter: 1024, heightAfter: 1024, format: 'png' },
      compositeSettings: { placement: 'bottom_center', scale: 0.58, shadowEnabled: true },
      compositeQuality: { level: 'good', subjectPlacementRisk: 'low', edgeBlendRisk: 'low', shadowRisk: 'low', reasons: [], suggestions: [] },
      compositeMode: 'subject_composite',
      subjectScale: 0.58,
      subjectPlacement: 'bottom_center',
      shadowApplied: true,
      edgeFeatherApplied: true,
      colorMatchApplied: true,
      generationRequestSummary: {
        requestVersion: 'v1.8',
        imageType: 'lifestyle_image',
        preferredMode: 'background_replace',
        safeForRealGeneration: true,
        positivePrompt: 'real prompt',
        negativePrompt: 'negative',
        textBlocks: [],
        forbiddenElements: ['Chinese text']
      }
    },
    {
      id: 'fallback-image',
      planId: 'detail_image-1',
      type: 'detail_image',
      fileName: 'Amazon_MOCK_detail_image_3.jpg',
      provider: 'mock',
      model: 'mock-image-v0.3',
      mode: 'background_replace',
      isMockPreview: true,
      isRealGenerated: false,
      fallbackToMock: true,
      realGenerationError: { code: 'MISSING_API_KEY', message: 'OPENAI_API_KEY is required' },
      productReferenceUsed: false,
      realBackgroundOnly: false
    }
  ];

  const metadata = buildExportMetadata({
    ...baseTask(),
    sourceImages: [],
    targets: [],
    generatedImages,
    imagePlans: [plan('main_image'), plan('lifestyle_image'), plan('detail_image')],
    exports: []
  });

  assert.deepEqual(metadata.imageSourceSummary, {
    totalImages: 3,
    mockPreviewCount: 1,
    realGeneratedCount: 1,
    fallbackMockCount: 1,
    providers: ['mock', 'openai']
  });
  assert.equal(metadata.generatedImages[1].isRealGenerated, true);
  assert.equal(metadata.generatedImages[1].imageType, 'lifestyle_image');
  assert.equal(metadata.generatedImages[1].mode, 'background_replace');
  assert.equal(metadata.generatedImages[1].productReferenceUsed, false);
  assert.equal(metadata.generatedImages[1].realBackgroundOnly, true);
  assert.equal(metadata.generatedImages[1].realGenerationMode, 'subject_composite');
  assert.equal(metadata.generatedImages[1].subjectCompositeUsed, true);
  assert.equal(metadata.generatedImages[1].subjectPreserved, true);
  assert.equal(metadata.generatedImages[1].productGeneratedByAI, false);
  assert.equal(metadata.generatedImages[1].mattingProvider, 'sharp');
  assert.equal(metadata.generatedImages[1].edgeQuality, 'good');
  assert.deepEqual(metadata.generatedImages[1].mattingWarnings, []);
  assert.equal(metadata.generatedImages[1].preserveQuality.qualityLevel, 'good');
  assert.equal(metadata.generatedImages[1].generationStrategy.selectedMode, 'subject_composite');
  assert.equal(metadata.generationQualitySummary.goodCount, 1);
  assert.equal(metadata.generationQualitySummary.subjectCompositeCount, 1);
  assert.equal(metadata.generationQualitySummary.mockCount, 2);
  assert.equal(metadata.generatedImages[1].compositeSettings.scale, 0.58);
  assert.equal(metadata.generatedImages[1].compositeQuality.level, 'good');
  assert.equal(metadata.generatedImages[1].shadowApplied, true);
  assert.equal(metadata.generatedImages[1].fallbackChain[0].mode, 'subject_composite');
  assert.equal(metadata.generatedImages[1].editAttempted, true);
  assert.equal(metadata.generatedImages[1].editSucceeded, true);
  assert.equal(metadata.generatedImages[1].productReference.sourceImageId, 'source-1');
  assert.equal(metadata.generatedImages[1].referencePreprocess.widthAfter, 1024);
  assert.equal(metadata.generatedImages[2].fallbackToMock, true);
  assert.equal(metadata.generatedImages[2].realGenerationError.code, 'MISSING_API_KEY');
});
