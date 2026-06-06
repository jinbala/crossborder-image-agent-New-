import assert from 'node:assert/strict';
import { test } from 'node:test';
import { auditImagePlanAgainstRules } from '../src/services/ruleAuditService.js';

function plan(overrides = {}) {
  return {
    id: 'plan-1',
    type: 'feature_image',
    background: 'clean_neutral',
    textBlocks: [{ text: 'Compact Design', sourceFields: ['sellingPoints'] }],
    templateSeed: {
      backgroundStyle: 'clean_neutral',
      iconHints: ['check']
    },
    ...overrides
  };
}

function audit(imagePlan, options = {}) {
  return auditImagePlanAgainstRules({
    imagePlan,
    productInfo: {
      name: 'Portable External Drive',
      category: 'External Storage',
      ...options.productInfo
    },
    recognitionQuality: options.recognitionQuality || {},
    inferredCandidates: options.inferredCandidates || [],
    platformId: options.platformId || 'amazon',
    categoryId: options.categoryId || 'electronics_storage'
  });
}

function issueCodes(report) {
  return report.issues.map((item) => item.code);
}

test('rule audit rejects Amazon main image text blocks', () => {
  const report = audit(plan({
    type: 'main_image',
    background: 'pure_white',
    textBlocks: [{ text: 'Fast backup', sourceFields: ['sellingPoints'] }],
    templateSeed: { backgroundStyle: 'pure_white', iconHints: [] }
  }));

  assert.equal(report.passed, false);
  assert.ok(issueCodes(report).includes('MAIN_IMAGE_TEXT_NOT_ALLOWED'));
  assert.equal(report.issues.find((item) => item.code === 'MAIN_IMAGE_TEXT_NOT_ALLOWED').severity, 'error');
});

test('rule audit flags Amazon main image non-white background', () => {
  const report = audit(plan({
    type: 'main_image',
    background: 'clean_neutral',
    textBlocks: [],
    templateSeed: { backgroundStyle: 'soft-blue-panel', iconHints: [] }
  }));

  assert.equal(report.passed, false);
  assert.ok(issueCodes(report).includes('MAIN_IMAGE_BACKGROUND_NOT_WHITE'));
});

test('rule audit rejects Chinese image copy', () => {
  const report = audit(plan({
    textBlocks: [{ text: '中文卖点', sourceFields: ['sellingPoints'] }]
  }));

  assert.equal(report.passed, false);
  assert.ok(issueCodes(report).includes('TEXT_CONTAINS_CHINESE'));
});

test('rule audit rejects price discount and promotion words', () => {
  const report = audit(plan({
    textBlocks: [
      { text: '$19.99 limited time deal', sourceFields: ['sellingPoints'] },
      { text: '50% discount coupon', sourceFields: ['sellingPoints'] }
    ]
  }));

  assert.equal(report.passed, false);
  assert.ok(issueCodes(report).includes('TEXT_CONTAINS_PRICE'));
  assert.ok(issueCodes(report).includes('TEXT_CONTAINS_BANNED_WORD'));
});

test('rule audit warns on absolute claims such as Best No.1 and Guaranteed', () => {
  const report = audit(plan({
    textBlocks: [
      { text: 'Best No.1 Guaranteed performance', sourceFields: ['sellingPoints'] }
    ]
  }));

  assert.equal(report.passed, false);
  assert.ok(report.issues.some((item) => item.code === 'TEXT_CONTAINS_BANNED_WORD' && item.severity === 'error'));
});

test('rule audit blocks capacity certifications warranty and speed without evidence', () => {
  const report = audit(plan({
    type: 'variant_image',
    textBlocks: [
      { text: '5TB capacity', sourceFields: ['capacity'] },
      { text: 'CE certified', sourceFields: ['certifications'] },
      { text: '3 years warranty', sourceFields: ['warranty'] },
      { text: 'High speed transfer', sourceFields: ['speed'] }
    ]
  }), {
    recognitionQuality: {
      missingEvidenceFields: [
        { field: 'capacity' },
        { field: 'certifications' },
        { field: 'warranty' },
        { field: 'speed' }
      ]
    }
  });

  assert.equal(report.passed, false);
  assert.deepEqual(report.blockedFields.map((item) => item.fieldKey).sort(), ['capacity', 'certifications', 'speed', 'warranty']);
});

test('rule audit flags interface conflicts and inferred candidates as unsafe', () => {
  const report = audit(plan({
    textBlocks: [
      { text: 'USB 3.2 Type-C', sourceFields: ['interfaceType'] },
      { text: 'Works with all devices', sourceFields: ['compatibleDevices'] }
    ]
  }), {
    recognitionQuality: {
      conflictFields: [{ field: 'interfaceType', conflictValues: ['USB-C', 'Micro USB'] }],
      inferredOnlyFields: [{ field: 'compatibleDevices', inferredValues: ['all devices'] }]
    }
  });

  assert.equal(report.passed, false);
  assert.ok(report.issues.some((item) => item.code === 'HIGH_RISK_FIELD_CONFLICT' && item.fieldKey === 'interfaceType'));
  assert.ok(report.blockedFields.some((item) => item.fieldKey === 'compatibleDevices'));
});

test('rule audit does not allow inferredCandidates high-risk fields into image copy', () => {
  const report = audit(plan({
    type: 'variant_image',
    textBlocks: [{ text: '5TB capacity option', sourceFields: ['capacity'] }]
  }), {
    inferredCandidates: [{ field: 'capacity', value: '5TB', reason: 'AI guess without visible text' }]
  });

  assert.equal(report.passed, false);
  assert.ok(report.issues.some((item) => item.code === 'HIGH_RISK_FIELD_INFERRED_CANDIDATE' && item.fieldKey === 'capacity'));
  assert.ok(report.blockedFields.some((item) => item.fieldKey === 'capacity' && item.reason === 'inferredCandidate'));
});

test('rule audit returns recommendations and combined metadata', () => {
  const report = audit(plan());

  assert.equal(report.platformId, 'amazon');
  assert.equal(report.categoryId, 'electronics_storage');
  assert.ok(Array.isArray(report.issues));
  assert.ok(Array.isArray(report.warnings));
  assert.ok(Array.isArray(report.blockedFields));
  assert.ok(Array.isArray(report.cautionFields));
  assert.ok(report.recommendations.some((item) => /规则/.test(item) || /人工/.test(item)));
});
