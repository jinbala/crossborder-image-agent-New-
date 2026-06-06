import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { paths } from '../src/services/db.js';
import { preprocessImageForVision } from '../src/utils/visionImagePreprocess.js';
import { mergeVisionResults } from '../src/providers/vision/mergeVisionResults.js';
import { recognizeInBatches } from '../src/providers/vision/visionBatchRunner.js';
import { getVisionRecognitionConfig, selectVisionImagesForMode } from '../src/providers/vision/visionRecognitionConfig.js';

let samplePath;

before(async () => {
  await fs.mkdir(paths.uploadDir, { recursive: true });
  samplePath = path.join(paths.uploadDir, 'large-vision-test.png');
  await sharp({
    create: {
      width: 2200,
      height: 1400,
      channels: 3,
      background: '#38bdf8'
    }
  })
    .png()
    .toFile(samplePath);
});

test('preprocessImageForVision creates compressed temporary model input without changing original', async () => {
  const beforeStats = await fs.stat(samplePath);
  const result = await preprocessImageForVision({
    filePath: samplePath,
    imageIndex: 0,
    displayName: '主图.png'
  }, { maxWidth: 1280, quality: 80 });
  const afterStats = await fs.stat(samplePath);
  const outputStats = await fs.stat(result.filePath);
  const metadata = await sharp(result.filePath).metadata();

  assert.equal(afterStats.size, beforeStats.size);
  assert.equal(metadata.format, 'jpeg');
  assert.ok(metadata.width <= 1280);
  assert.ok(outputStats.size < beforeStats.size);
  assert.equal(result.preprocess.originalSize, beforeStats.size);
  assert.equal(result.preprocess.processedSize, outputStats.size);
});

test('fast balanced and full recognition modes read the expected defaults', () => {
  const fast = getVisionRecognitionConfig({ VISION_RECOGNITION_MODE: 'fast' });
  const balanced = getVisionRecognitionConfig({ VISION_RECOGNITION_MODE: 'balanced' });
  const full = getVisionRecognitionConfig({ VISION_RECOGNITION_MODE: 'full' });

  assert.equal(fast.mode, 'fast');
  assert.equal(fast.imageMaxWidth, 960);
  assert.equal(fast.imageQuality, 70);
  assert.equal(fast.visibleTextLimitPerImage, 5);
  assert.equal(fast.visibleTextTotalLimit, 40);
  assert.equal(fast.maxImages, 8);
  assert.equal(fast.requestTimeoutMs, 90000);
  assert.equal(balanced.imageMaxWidth, 1280);
  assert.equal(balanced.imageQuality, 75);
  assert.equal(balanced.maxImages, 12);
  assert.equal(balanced.requestTimeoutMs, 300000);
  assert.equal(full.imageMaxWidth, 1600);
  assert.equal(full.imageQuality, 85);
  assert.equal(full.maxImages, 15);
});

test('selectVisionImagesForMode prioritizes important filenames and limits fast mode count', () => {
  const images = [
    '09-random.jpg',
    '08-footer.jpg',
    '07-compatible.jpg',
    '06-interface.jpg',
    '05-capacity.jpg',
    '04-feature.jpg',
    '03-detail.jpg',
    '02-package.jpg',
    '01-size.jpg',
    '00-main.jpg'
  ].map((fileName, index) => ({ fileName, displayName: fileName, imageIndex: index }));

  const result = selectVisionImagesForMode(images, { VISION_RECOGNITION_MODE: 'fast' });

  assert.equal(result.selectedImages.length, 8);
  assert.equal(result.skippedImages.length, 2);
  assert.equal(result.selectedImages[0].fileName, '00-main.jpg');
  assert.equal(result.selectedImages[1].fileName, '01-size.jpg');
  assert.equal(result.selectedImages.some((image) => image.fileName === '09-random.jpg'), false);
});

test('mergeVisionResults combines arrays, visible text, risks and notes', () => {
  const merged = mergeVisionResults([
    {
      productInfoRaw: {
        productName: 'Portable SSD',
        capacity: ['1TB'],
        interfaceType: 'USB-C',
        compatibleDevices: ['PC'],
        visibleSpecs: ['1TB']
      },
      visibleText: [{ imageIndex: 0, imageName: '01-main.png', text: '1TB', confidence: 0.9 }],
      fieldEvidence: {
        capacity: [{ source: 'visible_text', imageIndex: 0, imageName: '01-main.png', text: '1TB', value: '1TB', confidence: 0.9 }]
      },
      risks: [{ type: 'certification_mark', level: 'medium', message: 'CE visible', evidence: ['CE'], imageIndex: 0 }],
      confidence: { productName: 0.7, visibleText: 0.8 },
      notes: ['first note']
    },
    {
      productInfoRaw: {
        productName: 'Portable SSD',
        capacity: ['1TB', '2TB'],
        compatibleDevices: ['PC', 'Mac'],
        packageIncluded: ['USB cable'],
        visibleSpecs: ['USB 3.2']
      },
      visibleText: [
        { imageIndex: 1, imageName: '02-size.png', text: 'USB 3.2', confidence: 0.8 },
        { imageIndex: 1, imageName: '02-size.png', text: '2TB', confidence: 0.8 }
      ],
      fieldEvidence: {
        capacity: [
          { source: 'visible_text', imageIndex: 1, imageName: '02-size.png', text: '1TB', value: '1TB', confidence: 0.8 },
          { source: 'visible_text', imageIndex: 1, imageName: '02-size.png', text: '2TB', value: '2TB', confidence: 0.8 }
        ]
      },
      risks: [{ type: 'certification_mark', level: 'medium', message: 'CE visible', evidence: ['CE'], imageIndex: 0 }],
      confidence: { productName: 0.9, capacity: 0.8 },
      notes: ['second note']
    }
  ]);

  assert.deepEqual(merged.productInfoRaw.capacity, ['1TB', '2TB']);
  assert.deepEqual(merged.productInfoRaw.compatibleDevices, ['PC', 'Mac']);
  assert.deepEqual(merged.productInfoRaw.visibleSpecs, ['1TB', 'USB 3.2']);
  assert.equal(merged.visibleText.length, 3);
  assert.equal(merged.risks.length, 1);
  assert.equal(merged.confidence.productName, 0.9);
  assert.equal(merged.notes.includes('first note'), true);
  assert.equal(merged.notes.includes('second note'), true);
});

test('recognizeInBatches returns partialSuccess when one batch succeeds and one batch fails', async () => {
  const previousBatchSize = process.env.VISION_BATCH_SIZE;
  const previousRetry = process.env.VISION_RETRY_COUNT;
  process.env.VISION_BATCH_SIZE = '1';
  process.env.VISION_RETRY_COUNT = '0';

  const images = [
    { filePath: samplePath, imageIndex: 0, displayName: '01-main.png' },
    { filePath: samplePath, imageIndex: 1, displayName: '02-size.png' }
  ];
  let callCount = 0;
  const result = await recognizeInBatches({
    task: { id: 'test-batch', sourceImages: images },
    images,
    callBatch: async ({ batchImages }) => {
      callCount += 1;
      if (callCount === 2) {
        const error = new Error('socket hang up');
        error.code = 'ECONNRESET';
        throw error;
      }
      return {
        data: {
          productInfoRaw: { productName: 'Portable SSD', capacity: ['1TB'] },
          visibleText: [{ imageIndex: batchImages[0].imageIndex, text: '1TB' }],
          risks: [],
          confidence: { productName: 0.8 },
          notes: []
        },
        rawResponse: '{"ok":true}'
      };
    }
  });

  assert.equal(result.metadata.partialSuccess, true);
  assert.equal(result.metadata.batchCount, 2);
  assert.equal(result.metadata.failedBatches.length, 1);
  assert.equal(result.data.productInfoRaw.productName, 'Portable SSD');
  assert.match(result.data.notes.join(' '), /部分图片识别失败/);

  if (previousBatchSize == null) delete process.env.VISION_BATCH_SIZE;
  else process.env.VISION_BATCH_SIZE = previousBatchSize;
  if (previousRetry == null) delete process.env.VISION_RETRY_COUNT;
  else process.env.VISION_RETRY_COUNT = previousRetry;
});
