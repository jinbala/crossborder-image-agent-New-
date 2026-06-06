import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { buildImageFileName } from '../utils/fileNaming.js';
import { paths } from './db.js';
import { buildGenerationRequest, generationRequestSummary } from './generationRequestService.js';
import { assessProductPreserveQuality, buildGenerationStrategy } from './productPreserveQualityService.js';
import { normalizeCompositeSettings } from './compositeSettingsService.js';
import { buildTextLayout, isProgrammaticTextLayoutType } from './textLayoutService.js';
import { targetForPlan } from './targetService.js';
import {
  applyImageTemplateStyle,
  getImageTemplateStyle,
  isMarketplaceSafeEnglishCopy,
  recognitionQualityBlockedFields,
  sanitizeMarketplaceTextBlocks
} from './imageTemplateStyleService.js';

const typeStyles = {
  main_image: { bg: '#ffffff', accent: '#0f172a', title: 'Main Image Preview' },
  feature_image: { bg: '#eff6ff', accent: '#2563eb', title: 'Feature Image Preview' },
  size_image: { bg: '#f0fdf4', accent: '#16a34a', title: 'Size / Specs Preview' },
  compatibility_image: { bg: '#ecfeff', accent: '#0891b2', title: 'Compatibility Preview' },
  package_image: { bg: '#fdf2f8', accent: '#db2777', title: 'Package Preview' },
  lifestyle_image: { bg: '#fffbeb', accent: '#d97706', title: 'Lifestyle Preview' },
  detail_image: { bg: '#f5f3ff', accent: '#7c3aed', title: 'Detail Preview' },
  variant_image: { bg: '#fff7ed', accent: '#ea580c', title: 'Variant Preview' }
};

const deviceIcons = {
  laptop: 'Laptop',
  phone: 'Phone',
  tablet: 'Tablet',
  tv: 'TV',
  mac: 'Mac',
  pc: 'PC',
  desktop: 'Desktop'
};

function escapeXml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function asArray(value) {
  if (Array.isArray(value)) return value.filter((item) => item !== null && item !== undefined && String(item).trim() !== '');
  if (value === null || value === undefined || value === '') return [];
  return [value];
}

function unique(values) {
  return [...new Set(asArray(values).map((item) => String(item).trim()).filter(Boolean))];
}

function productInfo(task) {
  return task.productInfoConfirmed || task.productInfo || {};
}

function excludedFields(plan = {}, task = {}) {
  return new Set([
    ...(plan.excludedUnconfirmedFields || []).map((item) => item.field).filter(Boolean),
    ...recognitionQualityBlockedFields(task.recognitionQuality || {})
  ]);
}

function safeRequestTextBlocks(generationRequest = {}, task = {}, plan = {}) {
  if (generationRequest.imageType === 'main_image') return [];
  const template = getImageTemplateStyle(generationRequest.imageType || plan.type);
  const blockedFields = new Set([
    ...recognitionQualityBlockedFields(task.recognitionQuality || {}),
    ...(plan.excludedUnconfirmedFields || []).map((item) => item.field).filter(Boolean)
  ]);
  return sanitizeMarketplaceTextBlocks(generationRequest.textBlocks || [], {
    blockedFields,
    allowedFields: template.allowedTextBlocks
  })
    .filter((block) => block.text)
    .filter((block) => block.evidenceStatus !== 'blocked_without_visible_text')
    .slice(0, generationRequest.imageType === 'feature_image' ? 5 : 4);
}

function templateForPlan(plan = {}) {
  return plan.templateSeed || getImageTemplateStyle(plan.type);
}

function styleForPreview(plan, preview) {
  const base = typeStyles[plan.type] || typeStyles.feature_image;
  const template = preview?.template || {};
  return {
    ...base,
    bg: template.backgroundColor || base.bg,
    accent: template.accentColor || base.accent
  };
}

function valueFromProduct(info, keys) {
  for (const key of keys) {
    const value = info[key];
    if (Array.isArray(value) && value.length) return value;
    if (Array.isArray(value)) continue;
    if (value) return [value];
  }
  return [];
}

function section(label, items) {
  return { label, items: unique(items).filter(isMarketplaceSafeEnglishCopy).slice(0, 6) };
}

function previewForPlan({ task, plan, generationRequest }) {
  const info = productInfo(task);
  const template = templateForPlan(plan);
  const textBlocks = safeRequestTextBlocks(generationRequest, task, plan);
  const missingInfo = [];
  const warnings = (generationRequest.compliance?.riskWarnings || []).map((warning) => warning.message || String(warning)).slice(0, 4);
  const sections = [];

  if (plan.type === 'main_image') {
    sections.push(section('Product only', ['Centered product silhouette', 'White background', 'No sales copy']));
  }

  if (plan.type === 'feature_image') {
    sections.push(section('Selling points', textBlocks.map((block) => block.text)));
    if (!textBlocks.length) missingInfo.push('Missing selling points');
  }

  if (plan.type === 'size_image') {
    const dimensions = valueFromProduct(info, ['dimensions', 'size', 'sizes']);
    const sizeItems = [
      ...textBlocks.map((block) => block.text),
      ...dimensions,
      ...valueFromProduct(info, ['visibleSpecs'])
    ];
    sections.push(section('Dimensions / specs', sizeItems));
    if (!dimensions.length) missingInfo.push('Size / dimensions need manual confirmation');
  }

  if (plan.type === 'compatibility_image') {
    const devices = [
      ...textBlocks.map((block) => block.text),
      ...valueFromProduct(info, ['compatibleDevices'])
    ];
    sections.push(section('Compatible devices', devices));
    sections.push(section('Device icons', devices.map((item) => deviceIcons[String(item).toLowerCase()] || item)));
    if (!devices.length || warnings.some((item) => /兼容|compat/i.test(item))) {
      missingInfo.push('Compatible devices require confirmation');
    }
  }

  if (plan.type === 'package_image') {
    const packageItems = [
      ...textBlocks.map((block) => block.text),
      ...valueFromProduct(info, ['packageIncluded', 'packageList'])
    ];
    sections.push(section('Package included', packageItems));
    if (!packageItems.length) missingInfo.push('Package list requires confirmation');
  }

  if (plan.type === 'lifestyle_image') {
    sections.push(section('Scene placeholders', ['Desk setup', 'Office work', 'Travel storage']));
    if (textBlocks.length) sections.push(section('Scene keywords', textBlocks.map((block) => block.text)));
  }

  if (plan.type === 'detail_image') {
    const detailItems = [
      ...textBlocks.map((block) => block.text),
      ...valueFromProduct(info, ['material']),
      ...valueFromProduct(info, ['interfaceType']),
      ...valueFromProduct(info, ['visibleSpecs'])
    ];
    sections.push(section('Detail callouts', detailItems));
    if (!detailItems.length) missingInfo.push('Missing detail information');
  }

  if (plan.type === 'variant_image') {
    const excluded = excludedFields(plan, task);
    const variantItems = [
      ...textBlocks.map((block) => block.text),
      ...valueFromProduct(info, ['color', 'colors']),
      ...(excluded.has('capacity') ? [] : valueFromProduct(info, ['capacity'])),
      ...(excluded.has('model') ? [] : valueFromProduct(info, ['model']))
    ].filter((item) => !/5TB/i.test(String(item)));
    sections.push(section('Confirmed variants', variantItems));
    if (!variantItems.length || excluded.has('capacity')) missingInfo.push('Confirmed variants require confirmation');
  }

  if (!sections.some((item) => item.items.length)) {
    sections.push(section(template.title || 'Template Guidance', ['Confirmed product preview']));
  }

  return {
    type: plan.type,
    title: template.title || typeStyles[plan.type]?.title || plan.title,
    layoutStyle: template.layoutStyle,
    template: {
      templateType: template.templateType,
      templateName: template.templateName,
      layoutStyle: template.layoutStyle,
      backgroundStyle: template.backgroundStyle,
      backgroundColor: template.backgroundColor,
      accentColor: template.accentColor,
      productPlacement: template.productPlacement,
      safetyNotes: template.safetyNotes,
      iconHints: template.iconHints,
      allowedTextBlocks: template.allowedTextBlocks,
      variantId: template.variantId,
      layoutSeed: template.layoutSeed,
      seedIndex: template.seedIndex
    },
    note: `MOCK PREVIEW - ${typeStyles[plan.type]?.title || plan.title}`,
    usedTextBlocks: textBlocks,
    sections: sections.filter((item) => item.items.length),
    warnings,
    missingInfo,
    isMockPreview: true
  };
}

function wrapText(value, maxChars = 28, maxLines = 3) {
  const words = String(value || '').split(/\s+/).filter(Boolean);
  const lines = [];
  let current = '';
  for (const word of words) {
    const next = current ? `${current} ${word}` : word;
    if (next.length > maxChars && current) {
      lines.push(current);
      current = word;
    } else {
      current = next;
    }
    if (lines.length >= maxLines) break;
  }
  if (current && lines.length < maxLines) lines.push(current);
  return lines.length ? lines : ['-'];
}

function textLines(lines, { x, y, size = 34, color = '#334155', weight = 500, lineHeight = 44 }) {
  return lines.map((line, index) => (
    `<text x="${x}" y="${y + index * lineHeight}" font-family="Arial, sans-serif" font-size="${size}" font-weight="${weight}" fill="${color}">${escapeXml(line)}</text>`
  )).join('');
}

function productShape(plan, style) {
  const textAllowed = plan.type !== 'main_image';
  return `
    <g transform="translate(520 360)">
      <rect x="0" y="0" width="560" height="520" rx="72" fill="#111827" opacity="0.08"/>
      <rect x="60" y="40" width="440" height="440" rx="56" fill="#1f2937"/>
      <rect x="110" y="100" width="340" height="260" rx="36" fill="${style.accent}" opacity="0.18"/>
      <circle cx="430" cy="390" r="18" fill="${style.accent}"/>
      ${textAllowed ? '<text x="280" y="235" text-anchor="middle" font-family="Arial, sans-serif" font-size="34" font-weight="700" fill="#f8fafc">PRODUCT</text>' : ''}
    </g>
  `;
}

function iconGrid(preview, style) {
  const iconLabels = preview.sections.find((item) => item.label === 'Device icons')?.items || [];
  return iconLabels.slice(0, 4).map((label, index) => {
    const x = 270 + index * 270;
    return `
      <g>
        <rect x="${x}" y="1030" width="180" height="130" rx="24" fill="#ffffff" stroke="${style.accent}" stroke-width="4"/>
        <rect x="${x + 42}" y="1060" width="96" height="56" rx="10" fill="${style.accent}" opacity="0.22"/>
        <text x="${x + 90}" y="1218" text-anchor="middle" font-family="Arial, sans-serif" font-size="30" font-weight="700" fill="#334155">${escapeXml(label)}</text>
      </g>
    `;
  }).join('');
}

function measurementOverlay(style) {
  return `
    <line x1="450" y1="310" x2="1150" y2="310" stroke="${style.accent}" stroke-width="6"/>
    <line x1="450" y1="300" x2="450" y2="330" stroke="${style.accent}" stroke-width="6"/>
    <line x1="1150" y1="300" x2="1150" y2="330" stroke="${style.accent}" stroke-width="6"/>
    <line x1="1180" y1="360" x2="1180" y2="920" stroke="${style.accent}" stroke-width="6"/>
    <line x1="1165" y1="360" x2="1195" y2="360" stroke="${style.accent}" stroke-width="6"/>
    <line x1="1165" y1="920" x2="1195" y2="920" stroke="${style.accent}" stroke-width="6"/>
  `;
}

function packageLayout(preview, style) {
  const items = preview.sections.find((item) => item.label === 'Package included')?.items || [];
  return items.slice(0, 4).map((item, index) => {
    const x = 220 + (index % 2) * 580;
    const y = 920 + Math.floor(index / 2) * 170;
    return `
      <g>
        <rect x="${x}" y="${y}" width="500" height="120" rx="24" fill="#fff" stroke="${style.accent}" stroke-width="3"/>
        <circle cx="${x + 60}" cy="${y + 60}" r="26" fill="${style.accent}" opacity="0.2"/>
        ${textLines(wrapText(item, 22, 2), { x: x + 110, y: y + 54, size: 30, color: '#334155', lineHeight: 36 })}
      </g>
    `;
  }).join('');
}

function sectionCards(preview, style) {
  const items = preview.sections
    .filter((item) => !['Device icons', 'Package included'].includes(item.label))
    .flatMap((item) => item.items.map((value) => ({ label: item.label, value })))
    .slice(0, 5);
  return items.map((item, index) => {
    const x = 135 + (index % 2) * 680;
    const y = 940 + Math.floor(index / 2) * 155;
    return `
      <g>
        <rect x="${x}" y="${y}" width="610" height="120" rx="26" fill="#ffffff" stroke="#e2e8f0" stroke-width="3"/>
        <circle cx="${x + 58}" cy="${y + 60}" r="28" fill="${style.accent}" opacity="0.18"/>
        <text x="${x + 105}" y="${y + 38}" font-family="Arial, sans-serif" font-size="22" font-weight="700" fill="${style.accent}">${escapeXml(item.label)}</text>
        ${textLines(wrapText(item.value, 29, 2), { x: x + 105, y: y + 78, size: 28, color: '#334155', lineHeight: 34 })}
      </g>
    `;
  }).join('');
}

function missingInfoBanner(preview) {
  if (!preview.missingInfo.length) return '';
  return `
    <rect x="150" y="1380" width="1300" height="82" rx="22" fill="#fef3c7" stroke="#f59e0b" stroke-width="3"/>
    <text x="800" y="1432" text-anchor="middle" font-family="Arial, sans-serif" font-size="30" font-weight="700" fill="#92400e">${escapeXml(preview.missingInfo.slice(0, 2).join(' / '))}</text>
  `;
}

function renderLayoutText(textElement) {
  const anchor = textElement.align === 'center' ? 'middle' : textElement.align === 'right' ? 'end' : 'start';
  const x = textElement.align === 'center' ? textElement.x + textElement.width / 2 : textElement.align === 'right' ? textElement.x + textElement.width : textElement.x;
  return textLines(wrapText(textElement.text, Math.max(12, Math.floor(textElement.width / (textElement.fontSize * 0.54))), 2), {
    x,
    y: textElement.y,
    size: textElement.fontSize,
    color: textElement.riskLevel === 'medium' ? '#92400e' : '#0f172a',
    weight: textElement.fontWeight,
    lineHeight: Math.round(textElement.fontSize * 1.2)
  }).replaceAll('<text ', `<text text-anchor="${anchor}" `);
}

function renderLayoutIcon(icon, style) {
  const label = String(icon.label || icon.type || '').slice(0, 18);
  return `
    <g>
      <rect x="${icon.x}" y="${icon.y}" width="${icon.size}" height="${icon.size}" rx="22" fill="${style.accent}" opacity="0.15" stroke="${style.accent}" stroke-width="3"/>
      <circle cx="${icon.x + icon.size / 2}" cy="${icon.y + icon.size / 2}" r="${Math.max(16, icon.size * 0.22)}" fill="${style.accent}" opacity="0.55"/>
      <text x="${icon.x + icon.size / 2}" y="${icon.y + icon.size + 34}" text-anchor="middle" font-family="Arial, sans-serif" font-size="22" font-weight="700" fill="#475569">${escapeXml(label)}</text>
    </g>
  `;
}

function renderLayoutLine(line, style) {
  return `
    <g>
      <line x1="${line.x1}" y1="${line.y1}" x2="${line.x2}" y2="${line.y2}" stroke="${style.accent}" stroke-width="5" stroke-linecap="round"/>
      ${line.label ? `<text x="${line.x2 + 12}" y="${line.y2 - 8}" font-family="Arial, sans-serif" font-size="22" font-weight="700" fill="${style.accent}">${escapeXml(line.label)}</text>` : ''}
    </g>
  `;
}

function textLayoutWarnings(textLayout) {
  const issues = [...(textLayout?.blockingIssues || []), ...(textLayout?.warnings || [])].slice(0, 3);
  if (!issues.length) return '';
  return `
    <rect x="150" y="1375" width="1300" height="92" rx="22" fill="${textLayout.blockingIssues?.length ? '#fee2e2' : '#fef3c7'}" stroke="${textLayout.blockingIssues?.length ? '#ef4444' : '#f59e0b'}" stroke-width="3"/>
    <text x="800" y="1432" text-anchor="middle" font-family="Arial, sans-serif" font-size="26" font-weight="800" fill="${textLayout.blockingIssues?.length ? '#991b1b' : '#92400e'}">${escapeXml(issues.map((item) => item.message || item.code).join(' / ')).slice(0, 120)}</text>
  `;
}

function svgForTextLayout(plan, task, preview, textLayout) {
  const info = productInfo(task);
  const style = styleForPreview(plan, preview);
  const productName = info.name || info.productName || 'Confirmed product';
  const productArea = textLayout.productArea || { x: 500, y: 420, width: 600, height: 560 };
  const productTransform = `translate(${productArea.x - 20} ${productArea.y - 40}) scale(${Math.min(productArea.width / 560, productArea.height / 520)})`;
  return `
    <svg width="${textLayout.canvas.width}" height="${textLayout.canvas.height}" xmlns="http://www.w3.org/2000/svg">
      <rect width="1600" height="1600" fill="${textLayout.canvas.background || style.bg}"/>
      <rect x="70" y="70" width="1460" height="1460" rx="48" fill="none" stroke="#e2e8f0" stroke-width="4"/>
      <text x="110" y="145" font-family="Arial, sans-serif" font-size="34" font-weight="800" fill="${style.accent}">MOCK PREVIEW</text>
      <text x="1490" y="145" text-anchor="end" font-family="Arial, sans-serif" font-size="28" font-weight="700" fill="#64748b">PROGRAMMATIC TEXT LAYOUT</text>
      <text x="800" y="292" text-anchor="middle" font-family="Arial, sans-serif" font-size="30" font-weight="600" fill="#475569">${escapeXml(productName)}</text>
      <g transform="${productTransform}">
        <rect x="0" y="0" width="560" height="520" rx="72" fill="#111827" opacity="0.07"/>
        <rect x="60" y="40" width="440" height="440" rx="56" fill="#1f2937"/>
        <rect x="110" y="100" width="340" height="260" rx="36" fill="${style.accent}" opacity="0.18"/>
        <circle cx="430" cy="390" r="18" fill="${style.accent}"/>
      </g>
      ${textLayout.lineElements.filter((line) => line.visible !== false).sort((a, b) => (a.zIndex || 0) - (b.zIndex || 0)).map((line) => renderLayoutLine(line, style)).join('')}
      ${textLayout.iconElements.filter((icon) => icon.visible !== false).sort((a, b) => (a.zIndex || 0) - (b.zIndex || 0)).map((icon) => renderLayoutIcon(icon, style)).join('')}
      ${textLayout.textElements.filter((text) => text.visible !== false).sort((a, b) => (a.zIndex || 0) - (b.zIndex || 0)).map(renderLayoutText).join('')}
      ${textLayoutWarnings(textLayout)}
      <text x="800" y="1510" text-anchor="middle" font-family="Arial, sans-serif" font-size="24" font-weight="700" fill="#94a3b8">Mock preview only - text rendered by programmatic layout</text>
    </svg>
  `;
}

function svgForPlan(plan, task, preview, textLayout = null) {
  if (textLayout) return svgForTextLayout(plan, task, preview, textLayout);
  const info = productInfo(task);
  const style = styleForPreview(plan, preview);
  const productName = info.name || info.productName || 'Confirmed product';
  const titleText = plan.type === 'main_image' ? 'MOCK PREVIEW' : preview.title;
  const subtitleText = plan.type === 'main_image' ? 'Main Image Preview' : productName;
  return `
    <svg width="1600" height="1600" xmlns="http://www.w3.org/2000/svg">
      <rect width="1600" height="1600" fill="${style.bg}"/>
      <rect x="70" y="70" width="1460" height="1460" rx="48" fill="none" stroke="#e2e8f0" stroke-width="4"/>
      <text x="110" y="145" font-family="Arial, sans-serif" font-size="34" font-weight="800" fill="${style.accent}">MOCK PREVIEW</text>
      <text x="1490" y="145" text-anchor="end" font-family="Arial, sans-serif" font-size="28" font-weight="700" fill="#64748b">${escapeXml(plan.platform || task.platform || 'Marketplace')}</text>
      <text x="800" y="230" text-anchor="middle" font-family="Arial, sans-serif" font-size="56" font-weight="800" fill="#0f172a">${escapeXml(titleText)}</text>
      <text x="800" y="292" text-anchor="middle" font-family="Arial, sans-serif" font-size="32" font-weight="600" fill="#475569">${escapeXml(subtitleText)}</text>
      ${plan.type === 'size_image' ? measurementOverlay(style) : ''}
      ${productShape(plan, style)}
      ${plan.type === 'compatibility_image' ? iconGrid(preview, style) : ''}
      ${plan.type === 'package_image' ? packageLayout(preview, style) : sectionCards(preview, style)}
      ${missingInfoBanner(preview)}
      <text x="800" y="1510" text-anchor="middle" font-family="Arial, sans-serif" font-size="24" font-weight="700" fill="#94a3b8">Mock preview only - not a final marketplace image</text>
    </svg>
  `;
}

export async function generateMockImages(task) {
  if (!task.imagePlans?.length) {
    const error = new Error('Image plans are required before generation');
    error.statusCode = 400;
    throw error;
  }

  const taskOutputDir = path.join(paths.outputDir, task.id);
  await fs.mkdir(taskOutputDir, { recursive: true });

  const generated = [];
  for (const [index, plan] of task.imagePlans.entries()) {
    generated.push(await generateMockImageForPlan({ task, plan, outputIndex: index + 1, version: 1 }));
  }
  return generated;
}

function versionedFileName(fileName, version) {
  if (!version || version <= 1) return fileName;
  const parsed = path.parse(fileName);
  return `${parsed.name}_v${version}_${Date.now()}${parsed.ext}`;
}

export async function generateMockImageForPlan({ task, plan, outputIndex, version = 1, regenerate = false, provider = 'mock', model = 'mock-image-v0.3' }) {
  try {
    const taskOutputDir = path.join(paths.outputDir, task.id);
    await fs.mkdir(taskOutputDir, { recursive: true });

    const info = productInfo(task);
    const sku = info.sku || task.id;
    const styledPlan = applyImageTemplateStyle(plan, { sku, outputIndex, version });
    const target = targetForPlan(task, styledPlan);
    const fileName = versionedFileName(buildImageFileName({
      platform: styledPlan.platform || styledPlan.platformName || target.platformName || styledPlan.platformId || target.platformId || task.platform,
      sku,
      type: styledPlan.type,
      index: outputIndex
    }), version);
    const absolutePath = path.join(taskOutputDir, fileName);
    const generationRequest = buildGenerationRequest({ task, plan: styledPlan });
    const generationSummary = generationRequestSummary(generationRequest);
    const mockPreview = previewForPlan({ task, plan: styledPlan, generationRequest });
    const textLayout = buildTextLayout({ task, plan: styledPlan, generationRequest });
    if (textLayout) {
      mockPreview.textLayout = textLayout;
      mockPreview.missingInfo = [
        ...mockPreview.missingInfo,
        ...textLayout.blockingIssues.map((issue) => issue.message)
      ];
      mockPreview.warnings = [
        ...mockPreview.warnings,
        ...textLayout.warnings.map((warning) => warning.message)
      ];
    }
    const compositeSettings = styledPlan.type === 'lifestyle_image' ? normalizeCompositeSettings(styledPlan.compositeSettings) : null;
    const now = new Date().toISOString();
    await sharp(Buffer.from(svgForPlan(styledPlan, task, mockPreview, textLayout)))
      .jpeg({ quality: 90 })
      .toFile(absolutePath);

    const relativePath = path.relative(paths.rootDir, absolutePath).replaceAll('\\', '/');
    const imageResult = {
      id: `${styledPlan.id}-image`,
      planId: styledPlan.id,
      targetId: styledPlan.targetId || target.id,
      platformId: styledPlan.platformId || target.platformId,
      platformName: styledPlan.platformName || target.platformName,
      site: styledPlan.site || target.site,
      language: styledPlan.language || target.language,
      categoryId: styledPlan.categoryId || target.categoryId,
      type: styledPlan.type,
      imageType: styledPlan.type,
      title: styledPlan.title,
      prompt: styledPlan.prompt,
      promptPreview: String(styledPlan.prompt || '').slice(0, 500),
      fileName,
      filePath: relativePath,
      previewUrl: `/outputs/${task.id}/${fileName}`,
      url: `/outputs/${task.id}/${fileName}`,
      provider,
      model,
      status: 'succeeded',
      version,
      generatedAt: now,
      regeneratedAt: regenerate || version > 1 ? now : null,
      isMockPreview: true,
      isRealGenerated: false,
      fallbackToMock: false,
      realGenerationError: null,
      productReferenceUsed: false,
      realBackgroundOnly: false,
      realGenerationMode: 'mock',
      subjectCompositeUsed: false,
      subjectExtractionMethod: null,
      subjectSourceImageId: null,
      subjectSourceDisplayName: null,
      subjectPreserved: false,
      backgroundGenerated: false,
      productGeneratedByAI: null,
      compositeMetadata: null,
      fallbackChain: [{ mode: 'mock', status: 'success' }],
      mattingProvider: null,
      mattingModel: null,
      mattingMethod: null,
      mattingConfidence: null,
      edgeQuality: null,
      backgroundType: null,
      mattingWarnings: [],
      mattingFallbackToSharp: false,
      externalMattingError: null,
      subjectPngPath: null,
      maskPath: null,
      mattingPreviewUsed: Boolean(styledPlan.mattingPreviewUsed),
      compositeMode: styledPlan.type === 'lifestyle_image' ? 'mock' : null,
      compositeSettings,
      compositeQuality: null,
      subjectScale: compositeSettings?.scale ?? null,
      subjectPlacement: compositeSettings?.placement || null,
      shadowApplied: Boolean(compositeSettings?.shadowEnabled),
      edgeFeatherApplied: Boolean(compositeSettings?.edgeFeather > 0),
      colorMatchApplied: compositeSettings?.colorMatch === 'basic',
      editAttempted: false,
      editSucceeded: false,
      editFailed: false,
      fallbackMode: null,
      productReference: generationRequest.productReference || null,
      referencePreprocess: null,
      generationRequest,
      generationRequestSummary: generationSummary,
      textLayout,
      renderedBy: isProgrammaticTextLayoutType(styledPlan.type) ? 'programmatic_text_layout' : 'mock_template',
      layoutSource: textLayout?.layoutSource || null,
      layoutEditedByUser: Boolean(textLayout?.layoutEditedByUser),
      layoutEditedAt: textLayout?.layoutEditedAt || null,
      mockPreview,
      riskWarnings: generationRequest.compliance.riskWarnings || []
    };
    return {
      ...imageResult,
      preserveQuality: assessProductPreserveQuality(imageResult),
      generationStrategy: buildGenerationStrategy({
        selectedMode: 'mock',
        generationRequest,
        plan: styledPlan
      })
    };
  } catch (error) {
    error.code = error.code || 'MOCK_IMAGE_GENERATION_FAILED';
    throw error;
  }
}
