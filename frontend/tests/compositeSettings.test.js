import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  defaultCompositeSettings,
  normalizeClientCompositeSettings
} from '../src/utils/compositeSettings.js';

test('normalizeClientCompositeSettings handles null values', () => {
  const settings = normalizeClientCompositeSettings(null);

  assert.equal(settings.scale, defaultCompositeSettings.scale);
  assert.equal(settings.placement, defaultCompositeSettings.placement);
  assert.equal(settings.shadowEnabled, defaultCompositeSettings.shadowEnabled);
});

test('normalizeClientCompositeSettings keeps numeric string edits', () => {
  const settings = normalizeClientCompositeSettings({
    scale: '0.64',
    offsetX: '20',
    edgeFeather: '2',
    placement: 'right'
  });

  assert.equal(settings.scale, 0.64);
  assert.equal(settings.offsetX, 20);
  assert.equal(settings.edgeFeather, 2);
  assert.equal(settings.placement, 'right');
});
