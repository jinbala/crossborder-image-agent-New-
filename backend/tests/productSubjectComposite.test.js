import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import sharp from 'sharp';
import { extractProductSubject } from '../src/utils/productSubjectExtract.js';
import { compositeProductOnBackground } from '../src/utils/productComposite.js';
import { paths } from '../src/services/db.js';

const tempDir = path.join(os.tmpdir(), `crossborder-subject-composite-${process.pid}`);
let sourcePath;
let backgroundPath;

before(async () => {
  await fs.rm(tempDir, { recursive: true, force: true });
  await fs.mkdir(tempDir, { recursive: true });
  sourcePath = path.join(tempDir, 'product-main.png');
  backgroundPath = path.join(tempDir, 'background.png');
  await sharp({
    create: {
      width: 800,
      height: 800,
      channels: 4,
      background: '#ffffff'
    }
  })
    .composite([
      {
        input: Buffer.from('<svg width="800" height="800" xmlns="http://www.w3.org/2000/svg"><rect x="250" y="220" width="300" height="360" rx="40" fill="#1f2937"/><circle cx="500" cy="520" r="18" fill="#38bdf8"/></svg>')
      }
    ])
    .png()
    .toFile(sourcePath);
  await sharp({
    create: {
      width: 1200,
      height: 1200,
      channels: 3,
      background: '#e0f2fe'
    }
  }).png().toFile(backgroundPath);
});

after(async () => {
  await fs.rm(tempDir, { recursive: true, force: true });
});

test('extractProductSubject creates a transparent subject png from a light background product image', async () => {
  const result = await extractProductSubject({
    productReference: {
      enabled: true,
      sourceImageId: 'source-main',
      displayName: 'product-main.png',
      filePath: path.relative(paths.rootDir, sourcePath).replaceAll('\\', '/')
    },
    taskId: 'subject-test'
  });

  assert.equal(result.status, 'success');
  assert.ok(result.subjectPngPath);
  assert.equal(result.method, 'sharp_light_background_alpha_mask');
  assert.equal(result.metadata.hasAlpha, true);
  assert.ok(result.metadata.confidence > 0);
  assert.ok(result.boundingBox.width > 0);
  const outputMeta = await sharp(result.subjectPngPath).metadata();
  assert.equal(outputMeta.hasAlpha, true);
});

test('compositeProductOnBackground merges preserved subject onto generated background', async () => {
  const subject = await extractProductSubject({
    productReference: {
      enabled: true,
      sourceImageId: 'source-main',
      displayName: 'product-main.png',
      filePath: path.relative(paths.rootDir, sourcePath).replaceAll('\\', '/')
    },
    taskId: 'subject-test'
  });
  const outputPath = path.join(tempDir, 'final-composite.png');

  const composite = await compositeProductOnBackground({
    backgroundPath,
    subjectPngPath: subject.subjectPngPath,
    outputPath,
    subjectSourceImageId: 'source-main',
    subjectSourceDisplayName: 'product-main.png'
  });

  assert.equal(composite.status, 'success');
  assert.equal(composite.metadata.compositeUsed, true);
  assert.equal(composite.metadata.subjectPreserved, true);
  assert.equal(composite.metadata.backgroundGenerated, true);
  assert.equal(composite.metadata.productGeneratedByAI, false);
  assert.ok(composite.metadata.subjectScale > 0);
  const finalMeta = await sharp(outputPath).metadata();
  assert.equal(finalMeta.width, 1200);
  assert.equal(finalMeta.height, 1200);
});

test('compositeProductOnBackground applies placement scale shadow feather and color match settings', async () => {
  const subject = await extractProductSubject({
    productReference: {
      enabled: true,
      sourceImageId: 'source-main',
      displayName: 'product-main.png',
      filePath: path.relative(paths.rootDir, sourcePath).replaceAll('\\', '/')
    },
    taskId: 'subject-test'
  });
  const outputPath = path.join(tempDir, 'final-composite-settings.png');

  const composite = await compositeProductOnBackground({
    backgroundPath,
    subjectPngPath: subject.subjectPngPath,
    outputPath,
    subjectSourceImageId: 'source-main',
    subjectSourceDisplayName: 'product-main.png',
    compositeSettings: {
      placement: 'right',
      scale: 0.62,
      offsetX: 40,
      offsetY: -20,
      shadowEnabled: true,
      shadowType: 'drop_shadow',
      shadowOpacity: 0.4,
      shadowBlur: 20,
      shadowOffsetY: 24,
      edgeFeather: 2,
      colorMatch: 'basic'
    }
  });

  assert.equal(composite.status, 'success');
  assert.equal(composite.metadata.compositeMode, 'subject_composite');
  assert.equal(composite.metadata.subjectScale, 0.62);
  assert.equal(composite.metadata.subjectPlacement, 'right');
  assert.equal(composite.metadata.shadowApplied, true);
  assert.equal(composite.metadata.edgeFeatherApplied, true);
  assert.equal(composite.metadata.colorMatchApplied, true);
  assert.equal(composite.metadata.compositeSettings.placement, 'right');
});
