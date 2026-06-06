const placements = new Set(['center', 'bottom_center', 'left', 'right', 'custom']);
const shadowTypes = new Set(['soft_contact', 'drop_shadow', 'none']);
const colorMatches = new Set(['none', 'basic']);

export const COMPOSITE_PRESETS = [
  {
    id: 'desk_center',
    label: '桌面居中',
    settings: { placement: 'center', scale: 0.62, offsetX: 0, offsetY: 40, shadowEnabled: true, shadowType: 'soft_contact' }
  },
  {
    id: 'desk_bottom_center',
    label: '桌面底部居中',
    settings: { placement: 'bottom_center', scale: 0.72, offsetX: 0, offsetY: 90, shadowEnabled: true, shadowType: 'soft_contact' }
  },
  {
    id: 'hero_right',
    label: '右侧展示',
    settings: { placement: 'right', scale: 0.62, offsetX: -60, offsetY: 20, shadowEnabled: true, shadowType: 'drop_shadow' }
  },
  {
    id: 'floating_product',
    label: '悬浮产品展示',
    settings: { placement: 'center', scale: 0.56, offsetX: 0, offsetY: -80, shadowEnabled: true, shadowType: 'drop_shadow', shadowOffsetY: 34 }
  }
];

function numberInRange(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, number));
}

export function defaultCompositeSettings() {
  return {
    placement: 'bottom_center',
    scale: 0.72,
    offsetX: 0,
    offsetY: 70,
    shadowEnabled: true,
    shadowType: 'soft_contact',
    shadowOpacity: 0.28,
    shadowBlur: 28,
    shadowOffsetY: 18,
    edgeFeather: 1.5,
    backgroundBlur: 0,
    colorMatch: 'none'
  };
}

export function normalizeCompositeSettings(value = {}) {
  const defaults = defaultCompositeSettings();
  const safeValue = value && typeof value === 'object' ? value : {};
  const placement = placements.has(safeValue.placement) ? safeValue.placement : defaults.placement;
  const shadowType = shadowTypes.has(safeValue.shadowType) ? safeValue.shadowType : defaults.shadowType;
  const colorMatch = colorMatches.has(safeValue.colorMatch) ? safeValue.colorMatch : defaults.colorMatch;
  return {
    placement,
    scale: numberInRange(safeValue.scale, defaults.scale, 0.4, 1),
    offsetX: numberInRange(safeValue.offsetX, defaults.offsetX, -300, 300),
    offsetY: numberInRange(safeValue.offsetY, defaults.offsetY, -300, 300),
    shadowEnabled: safeValue.shadowEnabled === undefined ? defaults.shadowEnabled : Boolean(safeValue.shadowEnabled),
    shadowType,
    shadowOpacity: numberInRange(safeValue.shadowOpacity, defaults.shadowOpacity, 0, 0.8),
    shadowBlur: numberInRange(safeValue.shadowBlur, defaults.shadowBlur, 0, 80),
    shadowOffsetY: numberInRange(safeValue.shadowOffsetY, defaults.shadowOffsetY, -80, 120),
    edgeFeather: numberInRange(safeValue.edgeFeather, defaults.edgeFeather, 0, 8),
    backgroundBlur: numberInRange(safeValue.backgroundBlur, defaults.backgroundBlur, 0, 12),
    colorMatch
  };
}
