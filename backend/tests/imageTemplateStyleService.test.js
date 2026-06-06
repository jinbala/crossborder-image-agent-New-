import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  IMAGE_TEMPLATE_TYPES,
  buildTemplateSeedVariants,
  getImageTemplateStyle,
  isMarketplaceSafeEnglishCopy,
  recognitionQualityBlockedFields,
  selectTemplateSeed,
  sanitizeMarketplaceTextBlocks
} from '../src/services/imageTemplateStyleService.js';

const chinesePattern = /[\u3400-\u9fff]/;
const promoPattern = /\b(price|sale|discount|off|coupon|deal|best|no\.?\s*1|guaranteed)\b|[$€£¥]|\d+\s?%/i;

test('image template style catalog covers eight image types with distinct names or layouts', () => {
  assert.deepEqual(IMAGE_TEMPLATE_TYPES, [
    'main_image',
    'feature_image',
    'size_image',
    'compatibility_image',
    'package_image',
    'lifestyle_image',
    'detail_image',
    'variant_image'
  ]);

  const styles = IMAGE_TEMPLATE_TYPES.map((type) => getImageTemplateStyle(type));
  assert.equal(new Set(styles.map((item) => item.templateName)).size, 8);
  assert.equal(new Set(styles.map((item) => item.layoutStyle)).size, 8);
  assert.equal(styles.every((item) => item.productPlacement), true);

  const visibleCopy = JSON.stringify(styles.flatMap((item) => [
    item.templateName,
    item.title,
    item.subtitle,
    item.safetyNotes,
    item.iconHints
  ]));
  assert.doesNotMatch(visibleCopy, chinesePattern);
  assert.doesNotMatch(visibleCopy, promoPattern);
});

test('marketplace text sanitizer excludes Chinese promotion and blocked recognition fields', () => {
  const blockedFields = recognitionQualityBlockedFields({
    missingEvidenceFields: [{ field: 'capacity' }],
    conflictFields: [{ field: 'compatibleDevices' }],
    inferredOnlyFields: [{ field: 'warranty' }]
  });
  const blocks = sanitizeMarketplaceTextBlocks([
    { text: 'Fast Backup', sourceFields: ['sellingPoints'] },
    { text: '中文卖点', sourceFields: ['sellingPoints'] },
    { text: '50% OFF', sourceFields: ['sellingPoints'] },
    { text: '5TB', sourceFields: ['capacity'] },
    { text: 'Works with all devices', sourceFields: ['compatibleDevices'] }
  ], { blockedFields });

  assert.deepEqual(blocks.map((block) => block.text), ['Fast Backup']);
  assert.equal(isMarketplaceSafeEnglishCopy('Compact Design'), true);
  assert.equal(isMarketplaceSafeEnglishCopy('中文卖点'), false);
  assert.equal(isMarketplaceSafeEnglishCopy('Best Deal 50% OFF'), false);
});

test('template seed variants create two to three safe variants per SKU and image type', () => {
  for (const type of IMAGE_TEMPLATE_TYPES) {
    const variants = buildTemplateSeedVariants({ sku: 'HD-001', templateType: type });

    assert.ok(variants.length >= 2);
    assert.ok(variants.length <= 3);
    assert.equal(new Set(variants.map((item) => item.variantId)).size, variants.length);
    assert.ok(new Set(variants.map((item) => [
      item.templateName,
      item.layoutStyle,
      item.productPlacement,
      item.backgroundStyle
    ].join('|'))).size >= 2);

    const visibleCopy = JSON.stringify(variants.flatMap((item) => [
      item.templateName,
      item.layoutStyle,
      item.productPlacement,
      item.backgroundStyle,
      item.iconHints,
      item.safetyNotes
    ]));
    assert.doesNotMatch(visibleCopy, chinesePattern);
    assert.doesNotMatch(visibleCopy, promoPattern);

    if (type === 'main_image') {
      assert.equal(variants.every((item) => item.backgroundStyle === 'pure_white'), true);
      assert.equal(variants.every((item) => item.allowedTextBlocks.length === 0), true);
      assert.equal(variants.every((item) => item.iconHints.length === 0), true);
    }
  }
});

test('template seed selection is deterministic and varies across regenerated versions', () => {
  const first = selectTemplateSeed({ sku: 'HD-001', templateType: 'feature_image', version: 1 });
  const repeated = selectTemplateSeed({ sku: 'HD-001', templateType: 'feature_image', version: 1 });
  const versionIds = [1, 2, 3].map((version) => (
    selectTemplateSeed({ sku: 'HD-001', templateType: 'feature_image', version }).variantId
  ));

  assert.deepEqual(repeated, first);
  assert.ok(new Set(versionIds).size >= 2);
});
