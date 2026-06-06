import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  analyzeRecognitionQuality,
  analyzeRecognitionStability
} from '../src/services/recognitionQualityService.js';
import { generateImagePlans } from '../src/services/imagePlanService.js';

function makeTask(overrides = {}) {
  return {
    id: 'quality-task-1',
    productInfoConfirmed: { name: 'Confirmed value must not change' },
    productInfoRaw: {
      productName: 'Portable SSD',
      brand: 'Acme',
      model: 'X100',
      capacity: ['1TB'],
      dimensions: ['10 x 5 cm'],
      interfaceType: 'USB-C',
      certifications: ['CE'],
      warranty: '3 years',
      material: 'Aluminum',
      packageIncluded: ['SSD', 'USB-C cable'],
      compatibleDevices: ['Laptop']
    },
    productInfo: {
      name: 'Portable SSD',
      brand: 'Acme',
      model: 'X100',
      capacity: '1TB',
      dimensions: '10 x 5 cm',
      interfaceType: 'USB-C',
      certifications: ['CE'],
      warranty: '3 years',
      material: 'Aluminum',
      packageList: ['SSD', 'USB-C cable'],
      compatibleDevices: ['Laptop']
    },
    fieldEvidence: {
      brand: [{ source: 'visible_text', imageIndex: 0, text: 'Acme X100', value: 'Acme', confidence: 0.95 }],
      model: [{ source: 'visible_text', imageIndex: 0, text: 'Acme X100', value: 'X100', confidence: 0.95 }],
      capacity: [
        { source: 'visible_text', imageIndex: 1, text: '1TB capacity', value: '1TB', confidence: 0.95 },
        { source: 'visible_text', imageIndex: 2, text: '2TB capacity', value: '2TB', confidence: 0.92 }
      ],
      dimensions: [{ source: 'visual', imageIndex: 1, reason: '尺寸图估计', value: '10 x 5 cm', confidence: 0.55 }],
      interfaceType: [{ source: 'visible_text', imageIndex: 1, text: 'USB-C', value: 'USB-C', confidence: 0.9 }],
      material: [{ source: 'visual', imageIndex: 3, reason: '金属外观', value: 'Aluminum', confidence: 0.6 }],
      packageIncluded: [{ source: 'visible_text', imageIndex: 2, text: 'SSD + USB-C cable', value: 'SSD', confidence: 0.8 }]
    },
    inferredCandidates: [
      { field: 'certifications', value: 'CE', reason: '常见电子认证，但图片证据不足' },
      { field: 'warranty', value: '3 years', reason: '市场常见保修推测' },
      { field: 'compatibleDevices', value: 'Laptop', reason: '根据品类推测兼容笔记本' }
    ],
    visibleText: [
      { imageIndex: 0, text: 'Acme X100', confidence: 0.95 },
      { imageIndex: 1, text: '1TB USB-C', confidence: 0.95 }
    ],
    risks: [{ type: 'capacity_conflict', level: 'high', message: '容量存在冲突' }],
    confidence: { brand: 0.95, capacity: 0.7, dimensions: 0.55 },
    recognitionMeta: { provider: 'gemini', model: 'gemini-test', durationMs: 1234 },
    ...overrides
  };
}

test('recognition quality report generates field statistics without mutating task data', () => {
  const task = makeTask();
  const before = JSON.parse(JSON.stringify(task));

  const report = analyzeRecognitionQuality(task);

  assert.equal(report.summary.totalFields > 0, true);
  assert.equal(report.summary.highRiskFieldCount, 10);
  assert.equal(report.summary.conflicted, 1);
  assert.equal(report.summary.inferredOnly >= 2, true);
  assert.equal(report.recognition.durationMs, 1234);
  assert.deepEqual(task, before);
  assert.deepEqual(task.productInfoConfirmed, before.productInfoConfirmed);
});

test('recognition quality report detects high-risk missing evidence inferred-only and conflict fields', () => {
  const report = analyzeRecognitionQuality(makeTask());

  assert.equal(report.highRiskFields.some((item) => item.field === 'capacity'), true);
  assert.equal(report.conflictFields.some((item) => item.field === 'capacity' && item.conflictValues.includes('1tb') && item.conflictValues.includes('2tb')), true);
  assert.equal(report.missingEvidenceFields.some((item) => item.field === 'certifications'), true);
  assert.equal(report.missingEvidenceFields.some((item) => item.field === 'warranty'), true);
  assert.equal(report.inferredOnlyFields.some((item) => item.field === 'compatibleDevices'), true);
  assert.equal(report.fields.find((item) => item.field === 'dimensions').status, 'needsManualConfirm');
  assert.equal(report.fields.find((item) => item.field === 'material').status, 'needsManualConfirm');
});

test('recognition quality report summarizes evidence sources by source and image', () => {
  const report = analyzeRecognitionQuality(makeTask());

  assert.equal(report.evidenceSummary.totalEvidence >= 7, true);
  assert.equal(report.evidenceSummary.bySource.visible_text >= 5, true);
  assert.equal(report.evidenceSummary.bySource.visual, 2);
  assert.equal(report.evidenceSummary.byImage.some((item) => item.imageIndex === 1 && item.count >= 2), true);
});

test('repeat recognition stability summary uses stub recognition results only', () => {
  const stability = analyzeRecognitionStability([
    {
      productInfoRaw: { productName: 'Portable SSD', brand: 'Acme', capacity: ['1TB'] },
      fieldEvidence: { capacity: [{ source: 'visible_text', value: '1TB', text: '1TB', confidence: 0.9 }] }
    },
    {
      productInfoRaw: { productName: 'Portable SSD', brand: 'Acme', capacity: ['1TB'] },
      fieldEvidence: { capacity: [{ source: 'visible_text', value: '1TB', text: '1TB', confidence: 0.9 }] }
    },
    {
      productInfoRaw: { productName: 'Portable SSD', brand: 'Acme', capacity: ['2TB'] },
      fieldEvidence: { capacity: [{ source: 'visible_text', value: '2TB', text: '2TB', confidence: 0.9 }] }
    }
  ]);

  assert.equal(stability.runCount, 3);
  assert.equal(stability.fieldConsistency.capacity.distinctValues.length, 2);
  assert.equal(stability.conflictFields.includes('capacity'), true);
  assert.equal(stability.averageConsistency < 1, true);
});

test('image plans still do not use inferred candidates as confirmed copy', () => {
  const task = {
    id: 'quality-plan-task',
    productInfoConfirmed: {
      sku: 'Q-001',
      name: 'Portable SSD',
      productName: 'Portable SSD',
      category: 'External SSD',
      capacity: '',
      sellingPoints: [],
      packageList: []
    },
    productInfo: { name: 'Portable SSD', category: 'External SSD' },
    fieldEvidence: {},
    inferredCandidates: [{ field: 'capacity', value: '2TB', reason: 'No text evidence' }],
    targets: [{
      id: 'target-amazon',
      targetId: 'target-amazon',
      platformId: 'amazon',
      platformName: 'Amazon',
      site: 'US',
      language: 'English',
      categoryId: 'electronics_storage',
      category: 'electronics_storage'
    }],
    sourceImages: [{ id: 'source-1', imageIndex: 0 }]
  };

  const plans = generateImagePlans(task);
  const serialized = JSON.stringify(plans);

  assert.equal(serialized.includes('2TB'), false);
});
