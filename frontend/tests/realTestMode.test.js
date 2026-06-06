import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { getImageSourceStatus, summarizeImageSources } from '../src/utils/imageSourceStatus.js';

test('BatchPage and API expose real-test provider status without real upload actions', () => {
  const pageSource = fs.readFileSync(path.resolve('src/pages/BatchPage.jsx'), 'utf8');
  const apiSource = fs.readFileSync(path.resolve('src/services/api.js'), 'utf8');

  assert.match(apiSource, /getProviderStatus/);
  assert.match(apiSource, /real-test/);
  assert.match(pageSource, /recognition mode/i);
  assert.match(pageSource, /image generation mode/i);
  assert.match(pageSource, /review mode/i);
  assert.match(pageSource, /upload mode/i);
  assert.match(pageSource, /configured/);
  assert.match(pageSource, /real-test/);
  assert.match(pageSource, /dry-run/);
  assert.doesNotMatch(pageSource, /真实上传平台|开始真实上传|uploadPlatform/);
});

test('image source helpers distinguish mock real generated and fallback mock', () => {
  assert.equal(getImageSourceStatus({ isMockPreview: true }).label, 'MOCK PREVIEW');
  assert.equal(getImageSourceStatus({ isRealGenerated: true }).label, 'REAL GENERATED');
  assert.equal(getImageSourceStatus({ fallbackToMock: true }).label, 'FALLBACK MOCK');

  const summary = summarizeImageSources([
    { isMockPreview: true, provider: 'mock' },
    { isRealGenerated: true, provider: 'openai' },
    { fallbackToMock: true, provider: 'mock' }
  ]);

  assert.equal(summary.mockPreviewCount, 1);
  assert.equal(summary.realGeneratedCount, 1);
  assert.equal(summary.fallbackMockCount, 1);
});
