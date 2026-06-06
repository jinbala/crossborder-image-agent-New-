import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  assessProductPreserveQuality,
  buildGenerationQualitySummary,
  recommendGenerationStrategy
} from '../src/services/productPreserveQualityService.js';

test('product preserve quality marks strong subject composite as good', () => {
  const result = assessProductPreserveQuality({
    realGenerationMode: 'subject_composite',
    subjectCompositeUsed: true,
    mattingConfidence: 0.9,
    edgeQuality: 'good',
    backgroundType: 'plain',
    mattingWarnings: []
  });

  assert.equal(result.strategy, 'subject_composite');
  assert.equal(result.qualityLevel, 'good');
  assert.equal(result.subjectPreserveRisk, 'low');
  assert.ok(result.qualityScore >= 80);
});

test('product preserve quality marks weak subject composite as poor', () => {
  const result = assessProductPreserveQuality({
    realGenerationMode: 'subject_composite',
    subjectCompositeUsed: true,
    mattingConfidence: 0.35,
    edgeQuality: 'poor',
    backgroundType: 'complex',
    mattingWarnings: ['complex_background_detected', 'low_edge_confidence', 'manual_review_recommended']
  });

  assert.equal(result.qualityLevel, 'poor');
  assert.equal(result.subjectPreserveRisk, 'high');
  assert.ok(result.reasons.some((reason) => /complex/i.test(reason)));
  assert.ok(result.suggestions.some((suggestion) => /white|clean|白底/i.test(suggestion)));
});

test('text-to-image has high subject preserve risk and mock is unknown', () => {
  const textToImage = assessProductPreserveQuality({
    realGenerationMode: 'text_to_image',
    isRealGenerated: true,
    productReferenceUsed: false
  });
  const mock = assessProductPreserveQuality({
    provider: 'mock',
    isMockPreview: true
  });

  assert.equal(textToImage.qualityLevel, 'poor');
  assert.equal(textToImage.subjectPreserveRisk, 'high');
  assert.equal(mock.strategy, 'mock');
  assert.equal(mock.qualityLevel, 'unknown');
});

test('recommend generation strategy uses safety reference and matting quality', () => {
  const safeRequest = {
    imageType: 'lifestyle_image',
    providerHints: { safeForRealGeneration: true, blockingIssues: [] },
    productReference: { enabled: true }
  };

  assert.equal(recommendGenerationStrategy({ generationRequest: safeRequest }).recommendedMode, 'subject_composite');
  assert.equal(
    recommendGenerationStrategy({
      generationRequest: safeRequest,
      mattingResult: {
        metadata: { edgeQuality: 'poor', backgroundType: 'complex', warnings: ['complex_background_detected'] }
      }
    }).recommendedMode,
    'image_edit'
  );
  assert.equal(
    recommendGenerationStrategy({
      generationRequest: { ...safeRequest, providerHints: { safeForRealGeneration: false, blockingIssues: ['contains Chinese text'] } }
    }).recommendedMode,
    'mock'
  );
});

test('generation quality summary counts quality levels and selected strategies', () => {
  const summary = buildGenerationQualitySummary([
    {
      preserveQuality: { qualityLevel: 'good' },
      generationStrategy: { selectedMode: 'subject_composite' }
    },
    {
      preserveQuality: { qualityLevel: 'poor' },
      generationStrategy: { selectedMode: 'text_to_image' }
    },
    {
      preserveQuality: { qualityLevel: 'unknown' },
      generationStrategy: { selectedMode: 'mock' }
    }
  ]);

  assert.equal(summary.goodCount, 1);
  assert.equal(summary.poorCount, 1);
  assert.equal(summary.unknownCount, 1);
  assert.equal(summary.subjectCompositeCount, 1);
  assert.equal(summary.textToImageCount, 1);
  assert.equal(summary.mockCount, 1);
});
