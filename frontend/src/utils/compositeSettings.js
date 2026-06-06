export const compositePresets = [
  { id: 'desk_center', label: '桌面居中', settings: { placement: 'center', scale: 0.62, offsetX: 0, offsetY: 40, shadowEnabled: true, shadowType: 'soft_contact' } },
  { id: 'desk_bottom_center', label: '桌面底部居中', settings: { placement: 'bottom_center', scale: 0.72, offsetX: 0, offsetY: 90, shadowEnabled: true, shadowType: 'soft_contact' } },
  { id: 'hero_right', label: '右侧展示', settings: { placement: 'right', scale: 0.62, offsetX: -60, offsetY: 20, shadowEnabled: true, shadowType: 'drop_shadow' } },
  { id: 'floating_product', label: '悬浮产品展示', settings: { placement: 'center', scale: 0.56, offsetX: 0, offsetY: -80, shadowEnabled: true, shadowType: 'drop_shadow', shadowOffsetY: 34 } }
];

export const defaultCompositeSettings = {
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

export function numberOrFallback(value, fallback) {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : fallback;
}

export function normalizeClientCompositeSettings(value = {}) {
  const safeValue = value && typeof value === 'object' ? value : {};

  return {
    ...defaultCompositeSettings,
    ...safeValue,
    scale: numberOrFallback(safeValue.scale, defaultCompositeSettings.scale),
    offsetX: numberOrFallback(safeValue.offsetX, defaultCompositeSettings.offsetX),
    offsetY: numberOrFallback(safeValue.offsetY, defaultCompositeSettings.offsetY),
    shadowEnabled: safeValue.shadowEnabled ?? defaultCompositeSettings.shadowEnabled,
    shadowOpacity: numberOrFallback(safeValue.shadowOpacity, defaultCompositeSettings.shadowOpacity),
    shadowBlur: numberOrFallback(safeValue.shadowBlur, defaultCompositeSettings.shadowBlur),
    shadowOffsetY: numberOrFallback(safeValue.shadowOffsetY, defaultCompositeSettings.shadowOffsetY),
    edgeFeather: numberOrFallback(safeValue.edgeFeather, defaultCompositeSettings.edgeFeather),
    backgroundBlur: numberOrFallback(safeValue.backgroundBlur, defaultCompositeSettings.backgroundBlur),
    colorMatch: safeValue.colorMatch || defaultCompositeSettings.colorMatch,
    placement: safeValue.placement || defaultCompositeSettings.placement,
    shadowType: safeValue.shadowType || defaultCompositeSettings.shadowType
  };
}
