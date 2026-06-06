import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  COMPOSITE_PRESETS,
  defaultCompositeSettings,
  normalizeCompositeSettings
} from '../src/services/compositeSettingsService.js';
import { assessCompositeQuality } from '../src/services/productPreserveQualityService.js';

test('default composite settings are suitable for lifestyle subject composite', () => {
  const settings = defaultCompositeSettings();

  assert.equal(settings.placement, 'bottom_center');
  assert.equal(settings.shadowEnabled, true);
  assert.equal(settings.shadowType, 'soft_contact');
  assert.ok(settings.scale > 0.4 && settings.scale <= 1);
});

test('normalize composite settings clamps unsafe values and keeps known options', () => {
  const settings = normalizeCompositeSettings({
    placement: 'right',
    scale: 1.8,
    offsetX: 999,
    offsetY: -999,
    shadowType: 'drop_shadow',
    shadowOpacity: 2,
    edgeFeather: 20,
    colorMatch: 'basic'
  });

  assert.equal(settings.placement, 'right');
  assert.equal(settings.scale, 1);
  assert.equal(settings.offsetX, 300);
  assert.equal(settings.offsetY, -300);
  assert.equal(settings.shadowOpacity, 0.8);
  assert.equal(settings.edgeFeather, 8);
  assert.equal(settings.colorMatch, 'basic');
});

test('normalize composite settings treats null as defaults', () => {
  const defaults = defaultCompositeSettings();
  const settings = normalizeCompositeSettings(null);

  assert.deepEqual(settings, defaults);
});

test('composite presets include desk and floating layouts', () => {
  assert.ok(COMPOSITE_PRESETS.some((preset) => preset.id === 'desk_center'));
  assert.ok(COMPOSITE_PRESETS.some((preset) => preset.id === 'floating_product'));
});

test('composite quality evaluates placement edge and shadow risks', () => {
  const good = assessCompositeQuality({
    realGenerationMode: 'subject_composite',
    edgeQuality: 'good',
    compositeSettings: { ...defaultCompositeSettings(), shadowEnabled: true }
  });
  const poor = assessCompositeQuality({
    realGenerationMode: 'subject_composite',
    edgeQuality: 'poor',
    compositeSettings: { ...defaultCompositeSettings(), scale: 0.2, offsetX: 280, shadowEnabled: false }
  });

  assert.equal(good.level, 'good');
  assert.equal(good.edgeBlendRisk, 'low');
  assert.equal(poor.level, 'poor');
  assert.equal(poor.edgeBlendRisk, 'high');
  assert.equal(poor.subjectPlacementRisk, 'high');
  assert.equal(poor.shadowRisk, 'medium');
});
