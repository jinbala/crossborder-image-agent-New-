import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  buildRecognitionQualityExport,
  buildRecognitionQualityFileName,
  buildRecognitionQualityJson,
  buildRecognitionQualitySoftWarning,
  canSaveWithRecognitionQualitySoftWarning,
  recognitionQualityActionAdvice,
  recognitionQualityDisplaySections,
  recognitionQualityFieldLabel,
  recognitionQualityRiskLevel,
  recognitionQualityStatusLabel,
  recognitionQualityWarningText
} from '../src/utils/recognitionQuality.js';

function report() {
  return {
    summary: {
      totalFields: 10,
      confirmedWithEvidence: 4,
      needsManualConfirm: 2,
      inferredOnly: 1,
      conflicted: 1,
      blockedHighRisk: 2
    },
    highRiskFields: [{ field: 'capacity', label: '容量', status: 'conflicted' }],
    missingEvidenceFields: [{ field: 'warranty', label: '保修', status: 'blockedHighRisk' }],
    conflictFields: [{ field: 'capacity', label: '容量', conflictValues: ['1tb', '2tb'] }],
    inferredOnlyFields: [{ field: 'compatibleDevices', label: '兼容设备', inferredValues: ['Laptop'] }],
    fields: [
      {
        field: 'brand',
        status: 'confirmedWithEvidence',
        value: ['Acme'],
        evidenceCount: 1,
        evidenceSources: ['visible_text'],
        confidence: 0.92
      },
      {
        field: 'interfaceType',
        status: 'needsManualConfirm',
        value: ['USB-C'],
        evidenceCount: 1,
        evidenceSources: ['visual'],
        confidence: 0.55,
        isHighRisk: true
      },
      {
        field: 'capacity',
        status: 'conflicted',
        value: ['1TB'],
        conflictValues: ['1tb', '2tb'],
        evidenceCount: 2,
        evidenceSources: ['visible_text']
      },
      {
        field: 'compatibleDevices',
        status: 'inferredOnly',
        inferredValues: ['Laptop'],
        evidenceCount: 0
      }
    ],
    recognition: {
      provider: 'gemini',
      model: 'gemini-test',
      durationMs: 1234
    },
    risks: [{ type: 'capacity_conflict', level: 'high', message: '容量冲突' }],
    evidenceSummary: {
      totalEvidence: 6,
      bySource: { visible_text: 4, visual: 2 },
      byImage: [{ imageIndex: 0, count: 3 }, { imageIndex: 1, count: 3 }]
    }
  };
}

function taskWithQuality(overrides = {}) {
  return {
    id: 'task-123',
    productInfo: {
      sku: 'SKU-001',
      name: 'Portable SSD'
    },
    recognitionQuality: report(),
    recognitionMeta: {
      provider: 'openai',
      model: 'vision-test',
      durationMs: 2345,
      secretPreview: 'sk-should-not-export'
    },
    confidence: { productName: 0.91 },
    visibleText: [
      { text: '1TB', imageName: 'front.jpg', localPath: 'D:\\Users\\secret\\front.jpg' },
      { text: '.env OPENAI_API_KEY=sk-secret', imageName: 'box.jpg' }
    ],
    fieldEvidence: {
      capacity: [
        {
          source: 'visible_text',
          imageName: 'front.jpg',
          localPath: 'C:\\Users\\secret\\front.jpg',
          text: '1TB',
          confidence: 0.95
        }
      ]
    },
    risks: [
      { type: 'capacity_conflict', message: 'capacity conflict', path: 'D:\\Code\\secret\\backend\\data\\app.sqlite' }
    ],
    sourceImages: [
      { displayName: 'front.jpg', originalName: 'front-original.jpg', path: 'D:\\Users\\secret\\front.jpg' }
    ],
    ...overrides
  };
}

test('recognition quality helpers return clear Chinese labels and non-blocking warning text', () => {
  assert.equal(recognitionQualityStatusLabel('confirmedWithEvidence'), '有可靠证据');
  assert.equal(recognitionQualityStatusLabel('blockedHighRisk'), '高风险缺证据');
  assert.match(recognitionQualityWarningText(report()), /不会阻止人工确认保存/);
});

test('recognition quality helpers map field keys to Chinese names', () => {
  assert.equal(recognitionQualityFieldLabel('capacity'), '容量');
  assert.equal(recognitionQualityFieldLabel('interfaceType'), '接口类型');
  assert.equal(recognitionQualityFieldLabel('packageIncluded'), '包装清单');
  assert.equal(recognitionQualityFieldLabel('sellingPoints'), '卖点');
  assert.equal(recognitionQualityFieldLabel('unknownField'), 'unknownField');
});

test('recognition quality helpers provide Chinese action advice for each status', () => {
  assert.equal(
    recognitionQualityActionAdvice('confirmedWithEvidence'),
    '该字段有图片或文字证据，通常可以作为确认信息使用。'
  );
  assert.equal(
    recognitionQualityActionAdvice('needsManualConfirm'),
    '该字段有值，但证据不足，建议人工核对后再确认。'
  );
  assert.equal(
    recognitionQualityActionAdvice('inferredOnly'),
    '该字段来自 AI 推测，不会自动进入确认信息或图片文案。需要使用时请人工确认。'
  );
  assert.equal(
    recognitionQualityActionAdvice('conflicted'),
    '该字段在不同证据中出现多个候选值，请人工选择正确值。'
  );
  assert.equal(
    recognitionQualityActionAdvice('blockedHighRisk'),
    '该字段属于高风险字段且缺少必要证据，不建议用于商品信息或图片文案。'
  );
});

test('recognition quality helpers calculate low medium and high risk levels', () => {
  assert.deepEqual(recognitionQualityRiskLevel({
    summary: { conflicted: 0, blockedHighRisk: 0, needsManualConfirm: 0, inferredOnly: 0 }
  }), {
    level: 'low',
    label: '低风险',
    message: '识别结果整体较可靠，仍建议人工确认关键字段。'
  });
  assert.deepEqual(recognitionQualityRiskLevel({
    summary: { conflicted: 0, blockedHighRisk: 0, needsManualConfirm: 2, inferredOnly: 1 }
  }), {
    level: 'medium',
    label: '中风险',
    message: '部分字段需要人工核对，确认后再生成图片方案。'
  });
  assert.deepEqual(recognitionQualityRiskLevel(report()), {
    level: 'high',
    label: '高风险',
    message: '存在冲突或高风险缺证据字段，建议先修正商品信息再继续。'
  });
});

test('recognition quality display sections are layered and safe for empty or malformed reports', () => {
  const emptySections = recognitionQualityDisplaySections(null);
  const malformedSections = recognitionQualityDisplaySections({ summary: null, fields: null });
  const sections = recognitionQualityDisplaySections(report());

  assert.match(emptySections.emptyText, /暂无识别质量报告。请先完成商品识别，或刷新页面后重试。/);
  assert.equal(emptySections.blocksSave, false);
  assert.match(malformedSections.overviewText, /共分析 0 个字段/);
  assert.equal(malformedSections.blocksSave, false);

  assert.match(sections.overviewText, /总体风险：高风险/);
  assert.match(sections.focusText, /容量/);
  assert.match(sections.inferredText, /不会自动进入确认信息或图片文案/);
  assert.match(sections.evidenceFieldsText, /品牌.*Acme.*文字证据/);
  assert.match(sections.evidenceSummaryText, /来源图片 2 张/);
  assert.match(sections.evidenceSummaryText, /Provider：gemini/);
});

test('recognition quality display sections include stats risks conflicts inferred and evidence summary', () => {
  const sections = recognitionQualityDisplaySections(report());

  assert.match(sections.statsText, /共分析 10 个字段/);
  assert.match(sections.highRiskText, /容量/);
  assert.match(sections.missingEvidenceText, /保修/);
  assert.match(sections.conflictText, /1tb.*2tb/);
  assert.match(sections.inferredText, /兼容设备/);
  assert.match(sections.evidenceText, /文字证据 4 条/);
  assert.equal(sections.blocksSave, false);
});

test('product confirmation page contains recognition quality review copy', () => {
  const content = readFileSync(new URL('../src/pages/ProductInfoPage.jsx', import.meta.url), 'utf8');

  assert.match(content, /识别质量复查/);
  assert.match(content, /总览/);
  assert.match(content, /需要人工重点检查/);
  assert.match(content, /AI 推测字段/);
  assert.match(content, /证据字段/);
  assert.match(content, /证据来源摘要/);
});

test('soft warning summary is generated for high risk conflicts and blocked high-risk fields', () => {
  const warning = buildRecognitionQualitySoftWarning(report());

  assert.equal(warning.shouldWarn, true);
  assert.equal(warning.title, '识别质量存在需要人工确认的字段');
  assert.match(warning.body, /证据不足、AI 推测或冲突/);
  assert.equal(warning.risks.length <= 5, true);
  assert.match(warning.risks.join('\n'), /容量/);
  assert.match(warning.risks.join('\n'), /保修/);
  assert.equal(warning.risks.some((item) => item.includes('capacity')), false);
});

test('soft warning includes high-risk inferredOnly fields and remaining count', () => {
  const manyRiskReport = {
    summary: { conflicted: 1, blockedHighRisk: 1, inferredOnly: 1, needsManualConfirm: 4 },
    conflictFields: [
      { field: 'capacity', conflictValues: ['1TB', '2TB'] },
      { field: 'interfaceType', conflictValues: ['USB-C', 'Micro USB'] }
    ],
    missingEvidenceFields: [
      { field: 'certifications' },
      { field: 'warranty' },
      { field: 'material' }
    ],
    inferredOnlyFields: [
      { field: 'compatibleDevices', isHighRisk: true, inferredValues: ['Laptop'] }
    ],
    fields: [
      { field: 'dimensions', status: 'needsManualConfirm', isHighRisk: true },
      { field: 'brand', status: 'needsManualConfirm', isHighRisk: true }
    ]
  };

  const warning = buildRecognitionQualitySoftWarning(manyRiskReport);

  assert.equal(warning.shouldWarn, true);
  assert.equal(warning.risks.length, 5);
  assert.equal(warning.remainingCount, 3);
  assert.match(warning.moreText, /还有 3 条风险字段/);
  assert.equal(warning.allRisks.some((item) => /兼容设备.*AI 推测/.test(item)), true);
});

test('soft warning is skipped for missing or low-risk recognitionQuality', () => {
  assert.equal(buildRecognitionQualitySoftWarning(null).shouldWarn, false);
  assert.equal(buildRecognitionQualitySoftWarning({ summary: null, fields: null }).shouldWarn, false);
  assert.equal(buildRecognitionQualitySoftWarning({
    summary: { conflicted: 0, blockedHighRisk: 0, needsManualConfirm: 0, inferredOnly: 0 },
    fields: []
  }).shouldWarn, false);
});

test('save guard only allows original save logic after user confirms warning', () => {
  const warning = buildRecognitionQualitySoftWarning(report());
  let saveCalls = 0;
  const saveOriginal = () => {
    saveCalls += 1;
    return 'saved';
  };

  assert.equal(canSaveWithRecognitionQualitySoftWarning({ warning, riskConfirmed: false, saveOriginal }), false);
  assert.equal(saveCalls, 0);
  assert.equal(canSaveWithRecognitionQualitySoftWarning({ warning, riskConfirmed: true, saveOriginal }), 'saved');
  assert.equal(saveCalls, 1);
  assert.equal(canSaveWithRecognitionQualitySoftWarning({ warning: buildRecognitionQualitySoftWarning(null), riskConfirmed: false, saveOriginal }), 'saved');
  assert.equal(saveCalls, 2);
});

test('product confirmation page contains soft warning modal copy and buttons', () => {
  const content = readFileSync(new URL('../src/pages/ProductInfoPage.jsx', import.meta.url), 'utf8');

  assert.match(content, /识别质量存在需要人工确认的字段/);
  assert.match(content, /返回检查/);
  assert.match(content, /我已确认，继续保存/);
});

test('recognition quality export builds JSON report structure for current task', () => {
  const exported = buildRecognitionQualityExport(taskWithQuality());

  assert.equal(exported.meta.taskId, 'task-123');
  assert.equal(exported.meta.sku, 'SKU-001');
  assert.equal(exported.meta.productName, 'Portable SSD');
  assert.equal(exported.meta.recognitionProvider, 'gemini');
  assert.equal(exported.meta.recognitionModel, 'gemini-test');
  assert.equal(exported.meta.recognitionDurationMs, 1234);
  assert.equal(exported.meta.overallRiskLevel, 'high');
  assert.equal(exported.summary.totalFields, 10);
  assert.ok(Array.isArray(exported.fieldGroups.confirmedWithEvidence));
  assert.ok(Array.isArray(exported.fieldGroups.needsManualConfirm));
  assert.ok(Array.isArray(exported.fieldGroups.inferredOnly));
  assert.ok(Array.isArray(exported.fieldGroups.conflicted));
  assert.ok(Array.isArray(exported.fieldGroups.blockedHighRisk));
  assert.ok(Array.isArray(exported.highRiskAudit));
  assert.ok(exported.evidenceSummary);
  assert.ok(exported.softWarningSummary);
  assert.ok(Array.isArray(exported.notes));
});

test('recognition quality export uses Chinese labels suggestions and inferred safety note', () => {
  const exported = buildRecognitionQualityExport(taskWithQuality());
  const fields = Object.values(exported.fieldGroups).flat();
  const inferred = exported.fieldGroups.inferredOnly[0];

  assert.equal(fields.some((field) => field.fieldLabel === '容量'), true);
  assert.equal(fields.some((field) => field.fieldLabel === '接口类型'), true);
  assert.match(inferred.suggestion, /不会自动进入确认信息或图片文案/);
  assert.match(exported.notes.join('\n'), /AI 推测字段不会自动进入确认信息或图片文案/);
});

test('recognition quality export includes soft warning top risks and remaining count', () => {
  const exported = buildRecognitionQualityExport(taskWithQuality());

  assert.equal(exported.softWarningSummary.shouldWarn, true);
  assert.equal(exported.softWarningSummary.topRisks.length <= 5, true);
  assert.equal(typeof exported.softWarningSummary.remainingRiskCount, 'number');
  assert.match(exported.softWarningSummary.warningTitle, /识别质量/);
  assert.match(exported.softWarningSummary.warningMessage, /证据不足/);
});

test('recognition quality export strips env api keys and local absolute paths', () => {
  const json = buildRecognitionQualityJson(taskWithQuality());

  assert.doesNotMatch(json, /\.env/i);
  assert.doesNotMatch(json, /OPENAI_API_KEY/i);
  assert.doesNotMatch(json, /sk-secret|sk-should-not-export/);
  assert.doesNotMatch(json, /[A-Z]:\\/);
  assert.doesNotMatch(json, /node_modules/i);
  assert.doesNotMatch(json, /app\.sqlite/i);
  assert.match(json, /front\.jpg/);
});

test('recognition quality export file name includes taskId and timestamp', () => {
  const fileName = buildRecognitionQualityFileName('task-123', '2026-06-01T02:03:04.000Z');

  assert.equal(fileName, 'recognition-quality-task-123-2026-06-01T02-03-04-000Z.json');
});

test('recognition quality export returns safe empty state when report is missing', () => {
  const exported = buildRecognitionQualityExport({ id: 'task-empty', productInfo: { sku: 'SKU-EMPTY' } });

  assert.equal(exported.meta.taskId, 'task-empty');
  assert.equal(exported.meta.sku, 'SKU-EMPTY');
  assert.equal(exported.summary.totalFields, 0);
  assert.deepEqual(exported.fieldGroups.confirmedWithEvidence, []);
  assert.equal(exported.softWarningSummary.shouldWarn, false);
});

test('product confirmation page contains recognition quality export button and empty export hint', () => {
  const content = readFileSync(new URL('../src/pages/ProductInfoPage.jsx', import.meta.url), 'utf8');

  assert.match(content, /导出识别质量报告/);
  assert.match(content, /暂无可导出的识别质量报告，请先完成商品识别。/);
  assert.match(content, /downloadRecognitionQualityJson/);
});
