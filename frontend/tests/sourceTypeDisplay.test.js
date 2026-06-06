import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  getSourceTypeDisplay,
  normalizeSourceTypeForDisplay
} from '../src/utils/sourceTypeDisplay.js';

test('sourceType display normalizes legacy source labels without changing stored values', () => {
  assert.equal(normalizeSourceTypeForDisplay('mock'), 'mockPreview');
  assert.equal(normalizeSourceTypeForDisplay('mockPreview'), 'mockPreview');
  assert.equal(normalizeSourceTypeForDisplay('real'), 'realGenerated');
  assert.equal(normalizeSourceTypeForDisplay('realGenerated'), 'realGenerated');
  assert.equal(normalizeSourceTypeForDisplay('generated'), 'realGenerated');
  assert.equal(normalizeSourceTypeForDisplay('fallbackMock'), 'fallbackMock');
  assert.equal(normalizeSourceTypeForDisplay('fallback_mock'), 'fallbackMock');
  assert.equal(normalizeSourceTypeForDisplay('realSample'), 'realSample');
});

test('sourceType display exposes clear operator-facing labels', () => {
  assert.deepEqual(getSourceTypeDisplay('mock'), {
    raw: 'mock',
    key: 'mockPreview',
    label: 'mock preview',
    description: 'mock 预览图，仅用于流程预览'
  });
  assert.equal(getSourceTypeDisplay('real').label, 'real generated');
  assert.equal(getSourceTypeDisplay('fallback_mock').label, 'fallback mock');
  assert.equal(getSourceTypeDisplay('realSample').label, 'real sample');
});
