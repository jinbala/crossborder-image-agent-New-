import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { normalizeCompositeSettings } from '../services/compositeSettingsService.js';

function placementCoordinates({ placement, backgroundWidth, backgroundHeight, subjectWidth, subjectHeight, offsetX, offsetY }) {
  const margin = Math.round(backgroundWidth * 0.08);
  let left = Math.round((backgroundWidth - subjectWidth) / 2);
  let top = Math.round((backgroundHeight - subjectHeight) / 2);
  if (placement === 'bottom_center') {
    top = Math.round(backgroundHeight - subjectHeight - (backgroundHeight * 0.12));
  } else if (placement === 'left') {
    left = margin;
  } else if (placement === 'right') {
    left = backgroundWidth - subjectWidth - margin;
  }
  return {
    left: Math.max(0, Math.min(backgroundWidth - subjectWidth, left + Math.round(offsetX))),
    top: Math.max(0, Math.min(backgroundHeight - subjectHeight, top + Math.round(offsetY)))
  };
}

async function prepareSubject(subjectPngPath, width, settings) {
  let pipeline = sharp(subjectPngPath).resize({ width, withoutEnlargement: true }).ensureAlpha();
  if (settings.edgeFeather > 0) {
    pipeline = pipeline.blur(Math.min(settings.edgeFeather, 2.5)).sharpen({ sigma: 0.4 });
  }
  if (settings.colorMatch === 'basic') {
    pipeline = pipeline.modulate({ brightness: 1.03, saturation: 0.98 });
  }
  return pipeline.png().toBuffer();
}

async function shadowBuffer(subjectBuffer, settings) {
  if (!settings.shadowEnabled || settings.shadowType === 'none') return null;
  const opacity = Math.max(0, Math.min(0.8, settings.shadowOpacity));
  const blur = Math.max(0, settings.shadowBlur);
  return sharp(subjectBuffer)
    .ensureAlpha()
    .tint('#000000')
    .modulate({ brightness: opacity })
    .blur(blur)
    .png()
    .toBuffer();
}

export async function compositeProductOnBackground({
  backgroundPath,
  subjectPngPath,
  outputPath,
  subjectSourceImageId,
  subjectSourceDisplayName,
  subjectScale = 0.4,
  placement = 'center',
  shadowApplied = true,
  compositeSettings
}) {
  try {
    const settings = normalizeCompositeSettings(compositeSettings || {
      scale: subjectScale,
      placement,
      shadowEnabled: shadowApplied
    });
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    const backgroundMeta = await sharp(backgroundPath).metadata();
    const backgroundWidth = backgroundMeta.width || 1536;
    const backgroundHeight = backgroundMeta.height || 1536;
    const targetWidth = Math.round(backgroundWidth * settings.scale);
    const subjectBuffer = await prepareSubject(subjectPngPath, targetWidth, settings);
    const subjectMeta = await sharp(subjectBuffer).metadata();
    const { left, top } = placementCoordinates({
      placement: settings.placement,
      backgroundWidth,
      backgroundHeight,
      subjectWidth: subjectMeta.width || targetWidth,
      subjectHeight: subjectMeta.height || targetWidth,
      offsetX: settings.offsetX,
      offsetY: settings.offsetY
    });
    const composites = [];

    const shadow = await shadowBuffer(subjectBuffer, settings);
    if (shadow) {
      composites.push({
        input: shadow,
        left: left + Math.round(settings.shadowType === 'soft_contact' ? targetWidth * 0.015 : targetWidth * 0.035),
        top: top + Math.round(settings.shadowOffsetY),
        blend: 'over'
      });
    }

    composites.push({ input: subjectBuffer, left, top, blend: 'over' });
    let background = sharp(backgroundPath);
    if (settings.backgroundBlur > 0) background = background.blur(settings.backgroundBlur);
    await background.composite(composites)
      .png()
      .toFile(outputPath);

    const finalMeta = await sharp(outputPath).metadata();
    return {
      status: 'success',
      filePath: outputPath,
      error: null,
      metadata: {
        compositeUsed: true,
        subjectSourceImageId,
        subjectSourceDisplayName,
        backgroundGenerated: true,
        subjectPreserved: true,
        productGeneratedByAI: false,
        compositeMode: 'subject_composite',
        compositeSettings: settings,
        subjectScale: settings.scale,
        subjectPlacement: settings.placement,
        shadowApplied: Boolean(shadow),
        edgeFeatherApplied: settings.edgeFeather > 0,
        colorMatchApplied: settings.colorMatch === 'basic',
        width: finalMeta.width,
        height: finalMeta.height,
        format: finalMeta.format || 'png'
      }
    };
  } catch (error) {
    return {
      status: 'failed',
      filePath: null,
      error: {
        code: error.code || 'PRODUCT_COMPOSITE_FAILED',
        message: error.message
      },
      metadata: {
        compositeUsed: false,
        subjectSourceImageId,
        subjectSourceDisplayName,
        backgroundGenerated: false,
        subjectPreserved: false,
        productGeneratedByAI: null,
        compositeMode: 'subject_composite',
        compositeSettings: normalizeCompositeSettings(compositeSettings || {}),
        subjectScale,
        subjectPlacement: placement,
        shadowApplied: false
      }
    };
  }
}
