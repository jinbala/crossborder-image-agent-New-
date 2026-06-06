import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { evaluateMattingQuality } from '../src/services/mattingQualityService.js';

test('matting quality score returns score level warnings and heuristic details', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cia-matting-quality-'));
  const outputPath = path.join(dir, 'subject.png');
  await sharp({
    create: { width: 80, height: 80, channels: 4, background: '#00000000' }
  }).composite([
    { input: Buffer.from('<svg width="80" height="80" xmlns="http://www.w3.org/2000/svg"><rect x="20" y="15" width="40" height="50" fill="#111827"/></svg>') }
  ]).png().toFile(outputPath);

  const quality = await evaluateMattingQuality({
    providerResult: {
      status: 'success',
      provider: 'sharp',
      output: { subjectPngPath: outputPath },
      metadata: { warnings: [], confidence: 0.82 }
    },
    fallbackUsed: false
  });

  assert.equal(typeof quality.score, 'number');
  assert.match(quality.level, /good|medium|poor|unknown/);
  assert.equal(Array.isArray(quality.warnings), true);
  assert.equal(quality.details.hasOutput, true);
  assert.equal(quality.details.outputFileSize > 0, true);
  assert.equal(typeof quality.details.transparentRatio, 'number');
  assert.equal(typeof quality.details.subjectAreaRatio, 'number');

  await fs.rm(dir, { recursive: true, force: true });
});

test('matting quality score marks provider errors and fallback in Chinese warnings', async () => {
  const quality = await evaluateMattingQuality({
    providerResult: {
      status: 'failed',
      provider: 'external',
      error: { code: 'HTTP_ERROR', message: 'boom' },
      output: null,
      metadata: { warnings: ['external_failed'] }
    },
    fallbackUsed: true
  });

  assert.equal(quality.score < 60, true);
  assert.match(quality.level, /poor|unknown/);
  assert.equal(quality.details.providerError, true);
  assert.equal(quality.details.fallbackUsed, true);
  assert.equal(quality.warnings.some((item) => /第三方|fallback|降级|失败/.test(item)), true);
});
