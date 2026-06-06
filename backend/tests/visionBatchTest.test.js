import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildSkuSet,
  computeFieldCompleteness,
  getProviderAvailability,
  parseVisionBatchArgs,
  reportMarkdown,
  summarizeBatchResults
} from '../scripts/runVisionBatchTest.js';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

test('runVisionBatchTest parses multi-provider recursive directory arguments', () => {
  const options = parseVisionBatchArgs([
    '--providers', 'gemini,qwen,openai',
    '--dir', 'test-assets',
    '--recursive'
  ]);

  assert.deepEqual(options.providers, ['gemini', 'qwen', 'openai']);
  assert.equal(options.dir, 'test-assets');
  assert.equal(options.recursive, true);
  assert.equal(options.fromResult, null);
});

test('runVisionBatchTest parses recognition mode', () => {
  const options = parseVisionBatchArgs([
    '--provider', 'gemini',
    '--dir', 'test-assets/sku001-hard-drive',
    '--mode', 'fast'
  ]);

  assert.equal(options.mode, 'fast');
});

test('runVisionBatchTest parses from-result mode without provider requirement', () => {
  const options = parseVisionBatchArgs(['--from-result', 'test-results/vision-batch-demo.json']);

  assert.deepEqual(options.providers, []);
  assert.equal(options.fromResult, 'test-results/vision-batch-demo.json');
});

test('field completeness scores hard-drive recognition fields', () => {
  const result = computeFieldCompleteness({
    productInfoRaw: {
      productName: 'Portable External SSD',
      category: 'External SSD',
      capacity: ['1TB'],
      interfaceType: 'USB-C',
      compatibleDevices: ['PC', 'Mac'],
      dimensions: ['102 x 32 x 9 mm'],
      material: 'Aluminum',
      packageIncluded: ['SSD', 'USB cable'],
      sellingPoints: ['Fast transfer'],
      visibleSpecs: ['USB 3.2']
    },
    visibleText: [{ text: '1TB' }],
    risks: [],
    notes: ['Capacity should be manually verified']
  });

  assert.equal(result.fields.productName, true);
  assert.equal(result.fields.interfaceType, true);
  assert.equal(result.fields.visibleText, true);
  assert.equal(result.fields.notes, true);
  assert.equal(result.score, 92);
  assert.equal(result.maxScore, 100);
});

test('provider availability marks missing keys as skipped without exposing keys', () => {
  const availability = getProviderAvailability('gemini', {
    GEMINI_API_KEY: '',
    OPENAI_API_KEY: 'secret-openai',
    QWEN_API_KEY: ''
  });

  assert.equal(availability.available, false);
  assert.equal(availability.status, 'skipped');
  assert.equal(availability.error.code, 'MISSING_API_KEY');
  assert.equal(JSON.stringify(availability).includes('secret-openai'), false);
});

test('field completeness returns all false for null data', () => {
  const result = computeFieldCompleteness(null);

  assert.equal(result.score, 0);
  assert.equal(Object.values(result.fields).every((value) => value === false), true);
});

test('failed and skipped provider results render in markdown report', () => {
  const markdown = reportMarkdown({
    createdAt: '2026-05-29T00:00:00.000Z',
    providers: ['gemini'],
    totalSkuCount: 1,
    totalImageCount: 1,
    results: [
      {
        skuId: 'sku001',
        imageCount: 1,
        providerResults: [
          {
            provider: 'gemini',
            status: 'failed',
            durationMs: 0,
            error: { code: 'PARSE_ERROR', message: 'Bad JSON' },
            data: null,
            fieldCompleteness: computeFieldCompleteness(null)
          },
          {
            provider: 'gemini',
            status: 'skipped',
            durationMs: 0,
            error: { code: 'MISSING_API_KEY', message: 'Missing key' },
            data: null,
            fieldCompleteness: computeFieldCompleteness(null)
          }
        ]
      }
    ],
    summary: null
  }, 'backend/test-results/demo.json');

  assert.match(markdown, /failed/);
  assert.match(markdown, /PARSE_ERROR/);
  assert.match(markdown, /skipped/);
  assert.match(markdown, /MISSING_API_KEY/);
});

test('reportMarkdown summarizes visibleText samples without dumping long OCR', () => {
  const visibleText = Array.from({ length: 30 }, (_, index) => ({
    text: `OCR sample ${index}`,
    imageIndex: 0
  }));
  const markdown = reportMarkdown({
    createdAt: '2026-05-29T00:00:00.000Z',
    providers: ['gemini'],
    totalSkuCount: 1,
    totalImageCount: 1,
    results: [
      {
        skuId: 'sku001',
        imageCount: 1,
        providerResults: [
          {
            provider: 'gemini',
            status: 'success',
            durationMs: 1000,
            error: null,
            data: {
              productInfoRaw: { productName: 'Portable SSD' },
              visibleText,
              risks: [],
              notes: ['visibleText truncated: original 120, kept 30'],
              ocrSummary: {
                visibleTextOriginalCount: 120,
                visibleTextKeptCount: 30,
                visibleTextTruncated: true
              }
            },
            fieldCompleteness: computeFieldCompleteness({ productInfoRaw: { productName: 'Portable SSD' }, visibleText })
          }
        ]
      }
    ],
    summary: null
  }, 'backend/test-results/demo.json');

  assert.match(markdown, /visibleText count: 30/);
  assert.match(markdown, /visibleText original count: 120/);
  assert.match(markdown, /visibleText truncated: yes/);
  assert.match(markdown, /OCR sample 9/);
  assert.doesNotMatch(markdown, /OCR sample 10/);
});

test('empty SKU folder is represented as warning without throwing', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'empty-sku-'));
  await fs.writeFile(path.join(tempDir, 'README.md'), 'not an image');

  const sku = await buildSkuSet(tempDir);

  assert.equal(sku.imageCount, 0);
  assert.equal(sku.warnings.some((warning) => warning.reason === 'UNSUPPORTED_FORMAT'), true);
});

test('batch summary aggregates success, failed, skipped and average score', () => {
  const summary = summarizeBatchResults({
    providers: ['gemini'],
    results: [
      {
        providerResults: [
          { provider: 'gemini', status: 'success', durationMs: 1000, fieldCompleteness: { score: 80 } },
          { provider: 'gemini', status: 'skipped', durationMs: 0, fieldCompleteness: { score: 0 } },
          { provider: 'gemini', status: 'failed', durationMs: 2000, error: { code: 'PARSE_ERROR' }, fieldCompleteness: { score: 0 } }
        ]
      }
    ]
  });

  assert.equal(summary.byProvider.gemini.success, 1);
  assert.equal(summary.byProvider.gemini.skipped, 1);
  assert.equal(summary.byProvider.gemini.failed, 1);
  assert.equal(summary.byProvider.gemini.averageDurationMs, 1500);
  assert.equal(summary.byProvider.gemini.averageFieldCompleteness, 80);
  assert.equal(summary.commonIssues.parseFailures, 1);
});

test('reportMarkdown includes speed optimization fields', () => {
  const markdown = reportMarkdown({
    createdAt: '2026-05-29T00:00:00.000Z',
    providers: ['gemini'],
    totalSkuCount: 1,
    totalImageCount: 10,
    config: {
      recognitionMode: 'fast',
      imageMaxWidth: 960,
      imageQuality: 70,
      batchSize: 4,
      retryCount: 1
    },
    results: [
      {
        skuId: 'sku001',
        imageCount: 10,
        providerResults: [
          {
            provider: 'gemini',
            status: 'success',
            durationMs: 120000,
            error: null,
            data: { productInfoRaw: { productName: 'Portable SSD' }, visibleText: [], risks: [], notes: [] },
            fieldCompleteness: { score: 92 },
            metadata: {
              recognitionMode: 'fast',
              imageMaxWidth: 960,
              imageQuality: 70,
              requestTimeoutMs: 90000,
              imageCountOriginal: 10,
              imageCountSent: 8,
              imageCountSkipped: 2,
              preprocess: {
                totalOriginalBytes: 10 * 1024 * 1024,
                totalProcessedBytes: 3 * 1024 * 1024
              }
            }
          }
        ]
      }
    ],
    summary: null
  }, 'backend/test-results/demo.json');

  assert.match(markdown, /速度优化对比/);
  assert.match(markdown, /fast/);
  assert.match(markdown, /10\.00 MB/);
  assert.match(markdown, /3\.00 MB/);
  assert.match(markdown, /8\/10/);
  assert.match(markdown, /modeDebug\.requestTimeoutMs: 90000/);
  assert.match(markdown, /modeDebug\.latencyOutlier: no/);
});

test('reportMarkdown shows field evidence risks for unsupported high-risk fields', () => {
  const markdown = reportMarkdown({
    createdAt: '2026-05-29T00:00:00.000Z',
    providers: ['gemini'],
    totalSkuCount: 1,
    totalImageCount: 1,
    results: [
      {
        skuId: 'sku001',
        imageCount: 1,
        providerResults: [
          {
            provider: 'gemini',
            status: 'success',
            durationMs: 1000,
            error: null,
            data: {
              productInfoRaw: {
                productName: 'Portable SSD',
                capacity: ['1TB'],
                material: 'Aluminum'
              },
              visibleText: [],
              risks: [],
              notes: [],
              fieldEvidence: {
                capacity: [],
                material: [{ source: 'visual', imageIndex: 0, reason: 'metal-like shell', value: 'Aluminum', confidence: 0.5 }]
              },
              inferredCandidates: [{ field: 'capacity', value: '1TB', reason: 'No visible text evidence' }]
            },
            fieldCompleteness: { score: 50 },
            metadata: {}
          }
        ]
      }
    ],
    summary: null
  }, 'backend/test-results/demo.json');

  assert.match(markdown, /字段证据检查/);
  assert.match(markdown, /capacity/);
  assert.match(markdown, /high/);
  assert.match(markdown, /material/);
  assert.match(markdown, /medium/);
});
