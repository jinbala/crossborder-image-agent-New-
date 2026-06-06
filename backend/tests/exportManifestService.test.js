import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sourceTypeForImage } from '../src/services/exportManifestService.js';

test('sourceTypeForImage distinguishes mock real and fallback mock images', () => {
  assert.equal(sourceTypeForImage({ provider: 'mock', isMockPreview: true }), 'mock');
  assert.equal(sourceTypeForImage({ provider: 'openai', isRealGenerated: true }), 'real');
  assert.equal(sourceTypeForImage({ provider: 'mock', fallbackToMock: true }), 'fallbackMock');
});
