import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { translate } from '../src/i18n/core.js';
import { english } from '../src/i18n/messages.js';
import { reportDisplayLabel, reportDisplayLabels, reportUi } from '../src/utils/reportDisplayLabels.js';
import { templateAuditDisplaySections, downloadTemplateAuditJson, buildTemplateAuditDownload } from '../src/utils/templateAudit.js';
import { singleImageAcceptanceReportSections, threeSampleGenerationSections, threeSampleCanRun, buildSingleImageGenerationDownload, buildThreeSampleGenerationDownload } from '../src/utils/singleImageGeneration.js';
import { getReviewReportDisplayModel, buildReviewReportDownload } from '../src/utils/reviewReport.js';
import { getAutoFixPlanDisplayModel, getAutoFixExecutionDisplayModel, buildAutoFixPlanDownload } from '../src/utils/autoFixPlan.js';
import { getFinalAcceptanceDisplayModel, getRealApiAcceptanceDisplayModel, buildFinalAcceptanceJsonDownload, buildFinalAcceptanceCsvDownload, buildFinalAcceptanceIssuesCsvDownload } from '../src/utils/finalAcceptance.js';

const t = (key, params) => translate('en-US', key, params);
const raw = '已完成 $& {unknown}';
function freeze(value) { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; }
const template = () => ({ meta: { taskId: 'fixture', imageCount: 2, expectedImageTypes: ['main_image', 'detail_image'] }, imageTypeCoverage: [{ imageType: 'main_image', exists: true, templateName: raw, status: 'present' }, { imageType: 'detail_image', exists: true, status: 'present' }], templateDiversity: { diversityScore: 72, diversityLevel: 'medium', warnings: [raw] }, textSafety: {}, fieldSafety: {}, amazonMainImageCheck: { pass: true, isPureWhite: true, productPlacement: raw }, ruleAuditSummary: { passed: false, platformId: raw, issues: [{ code: 'TEXT_CONTAINS_PRICE', message: raw }], imagePlanRuleAudit: [{ imageType: 'main_image', imageTypeLabel: '平台主图', issueCount: 1 }] } });
const single = () => ({ taskId: 'fixture', meta: { imageType: 'main_image', modelName: raw }, generationResult: { status: 'succeeded', fallbackUsed: false, outputType: 'real-generated' }, qualityScore: { score: 83, level: 'good', warnings: [raw] }, manualChecklist: { edges: false }, conclusion: { recommendedNextAction: raw } });

test('report labels only translate owned enums, cover the catalog, and preserve unknown/prototype codes', () => {
  for (const [kind, labels] of Object.entries(reportDisplayLabels)) for (const [code, key] of Object.entries(labels)) { assert.ok(Object.hasOwn(english, key), key); assert.equal(reportDisplayLabel(kind, code, t), t(key)); assert.equal(reportDisplayLabel(kind, code), code); }
  for (const value of ['__proto__', 'constructor', 'toString', '已完成', raw, 'new-provider-status', null]) assert.equal(reportDisplayLabel('status', value, t), value);
  assert.equal(reportDisplayLabel('__proto__', 'passed', t), 'passed');
  assert.equal(reportUi()('{name}: {count}', { name: raw, count: 2 }), `${raw}: 2`);
});

test('template labels and counts switch without rewriting names, rule text, warnings or download bytes', () => {
  const report = freeze(template()), before = buildTemplateAuditDownload(report, 'fixed').json, display = templateAuditDisplaySections(report, t);
  assert.match(display.summaryText, /All 2 image types/); assert.doesNotMatch(display.summaryText, /8/);
  assert.equal(display.coverageRows[0].imageTypeLabel, t('平台主图')); assert.equal(display.coverageRows[0].templateName, raw); assert.equal(display.coverageRows[0].status, 'present'); assert.equal(display.coverageRows[0].statusLabel, 'Generated');
  assert.match(display.ruleAuditGroups[0].summaryText, /1 rule issues/); assert.ok(display.amazonText.includes(raw)); assert.ok(display.ruleAuditCopyRiskText.includes(raw)); assert.ok(display.diversityText.includes(raw));
  assert.equal(buildTemplateAuditDownload(report, 'fixed').json, before);
});

test('template missing/unsafe branches localize and unknown image codes never resolve prototype properties', () => {
  assert.match(templateAuditDisplaySections(null, t).emptyText, /No template acceptance/);
  const report = template(); report.textSafety.containsPrice = true; report.fieldSafety.usesConflictedFields = true; report.imageTypeCoverage[0].imageType = '__proto__';
  const display = templateAuditDisplaySections(report, t);
  assert.equal(display.coverageRows[0].imageTypeLabel, '__proto__'); assert.match(display.textSafetyText, /Copy safety failed/); assert.match(display.fieldSafetyText, /Field safety failed/);
});

test('missing or string-valued template checks cannot become passed or generated', () => {
  for (const value of [undefined, 'false', 'true', 1, null]) {
    const report = template(); report.textSafety = { containsChinese: value }; report.fieldSafety = { usesInferredCandidates: value }; report.amazonMainImageCheck.pass = value; report.imageTypeCoverage[0].exists = value;
    const display = templateAuditDisplaySections(report, t);
    for (const label of ['Copy safety', 'Field safety', 'Amazon main image']) { const card = display.summaryCards.find(item => item.label === label); assert.notEqual(card.value, t('通过')); assert.notEqual(card.tone, 'ok'); }
    assert.equal(display.coverageRows[0].exists, false); assert.match(display.textSafetyText, /not checked/);
  }
});

test('single-image controlled status, quality and checklist localize while model and raw reports stay original', () => {
  const report = freeze(single()), before = buildSingleImageGenerationDownload(report, 'fixed').json, display = singleImageAcceptanceReportSections(report, t);
  assert.match(display.statusText, /Successful/); assert.match(display.qualityText, /83 \/ Good/); assert.match(display.manualChecklistText, /1 items/); assert.ok(display.providerText.includes(raw)); assert.ok(display.conclusionText.includes(raw)); assert.deepEqual(display.warnings, [raw]);
  assert.equal(buildSingleImageGenerationDownload(report, 'fixed').json, before); assert.equal(display.cards[0].label, t('图片类型'));
  assert.match(singleImageAcceptanceReportSections(null, t).emptyText, /No real-generation/);
});

test('sample comparison translates aggregate fields and requires strict current fee approval', () => {
  for (const confirmPaidApi of ['false', 'true', 1, {}, false]) assert.equal(threeSampleCanRun({ confirmPaidApi, samples: [{}] }, t).canRun, false);
  assert.equal(threeSampleCanRun({ confirmPaidApi: true, samples: [{}] }, t).canRun, true);
  assert.equal(threeSampleCanRun({ confirmPaidApi: true, samples: [] }, t).canRun, false); assert.equal(threeSampleCanRun({ confirmPaidApi: true, samples: [{}, {}, {}, {}] }, t).canRun, false);
  const report = freeze({ aggregateReport: { summary: { totalSamples: 1, failedCount: 1 }, comparison: { commonWarnings: [raw] }, sampleReports: [single()] } }), before = buildThreeSampleGenerationDownload(report, 'fixed').json;
  const display = threeSampleGenerationSections(report, t); assert.match(display.summaryText, /Failed 1/); assert.ok(display.comparisonText.includes(raw)); assert.equal(display.sampleCards[0].imageType, 'main_image'); assert.equal(display.sampleCards[0].imageTypeLabel, t('平台主图')); assert.equal(buildThreeSampleGenerationDownload(report, 'fixed').json, before);
});

test('structured review labels translate without touching severity/action codes, titles or original messages', () => {
  const report = freeze({ meta: { reviewMode: 'mock' }, summary: { totalIssues: 1, highCount: 1 }, groupedIssues: [{ groupKey: 'group', severity: 'high', title: raw, messages: [raw], imageTypes: ['main_image'] }], fixSuggestions: [{ actionType: 'removeText', title: raw }], nextSuggestedAction: raw }), before = buildReviewReportDownload({ report, timestamp: 'fixed' }).json;
  const display = getReviewReportDisplayModel(report, t); assert.equal(display.complianceGroups[0].severityLabel, t('高风险')); assert.equal(display.complianceGroups[0].severity, 'high'); assert.equal(display.complianceGroups[0].title, raw); assert.deepEqual(display.complianceGroups[0].messages, [raw]); assert.equal(display.fixSuggestions[0].actionType, 'removeText'); assert.equal(display.fixSuggestions[0].actionTypeLabel, t('删除违规文案')); assert.equal(display.nextSuggestedAction, raw); assert.equal(buildReviewReportDownload({ report, timestamp: 'fixed' }).json, before);
});

test('correction labels and selectable state are display-only for every plan bucket', () => {
  const plan = freeze({ summary: { totalFixSuggestions: 5 }, plannedActions: [{ actionId: 'a', actionType: 'removeText', title: raw }], manualActions: [{ actionType: 'manualCheck' }], blockedActions: [{ actionType: 'regenerateRealSample' }], mockOnlyActions: [{ actionType: 'skipMockOnly' }], noActionNeededActions: [{ actionType: '__proto__' }], warnings: [raw] }), before = buildAutoFixPlanDownload({ plan, timestamp: 'fixed' }).json;
  const display = getAutoFixPlanDisplayModel(plan, t); assert.equal(display.plannedActions[0].selectable, true); assert.equal(display.plannedActions[0].title, raw); assert.equal(display.manualActions[0].selectable, false); assert.equal(display.blockedActions[0].actionTypeLabel, t('真实生图需单独确认')); assert.equal(display.noActionNeededActions[0].actionTypeLabel, '__proto__'); assert.equal(buildAutoFixPlanDownload({ plan, timestamp: 'fixed' }).json, before);
  assert.equal(getAutoFixExecutionDisplayModel({ summary: { executedCount: 2 }, warnings: [raw] }, t).summaryCards[0].label, 'Executed'); assert.match(getAutoFixExecutionDisplayModel(null, t).emptyText, /No correction/);
});

test('final acceptance translates statuses but never marks pending/missing as passed or changes exports', () => {
  const report = freeze({ summary: { overallStatus: 'pending' }, skuAcceptance: [{ sku: raw, productName: raw, testAssetStatus: 'missing', overallStatus: 'pending', steps: [{ status: 'pending' }, { status: 'constructor' }], riskSummary: { reviewRisk: 'high', unknownKey: raw } }], moduleAcceptance: [{ moduleKey: 'templateAudit', moduleName: '模板验收', status: 'pending' }, { moduleKey: 'custom', moduleName: raw, status: 'unrecognized' }], warnings: [raw] });
  const builders = [buildFinalAcceptanceJsonDownload, buildFinalAcceptanceCsvDownload, buildFinalAcceptanceIssuesCsvDownload], before = builders.map(fn => fn({ report, timestamp: 'fixed' }).content), display = getFinalAcceptanceDisplayModel(report, t);
  assert.equal(display.skuRows[0].overallStatus, 'pending'); assert.equal(display.skuRows[0].testAssetStatusLabel, 'Missing'); assert.equal(display.skuRows[0].productName, raw); assert.match(display.skuRows[0].stepSummary, /constructor: 1/); assert.ok(display.skuRows[0].riskText.includes(raw)); assert.equal(display.moduleRows[0].moduleNameLabel, 'Template acceptance'); assert.equal(display.moduleRows[1].moduleNameLabel, raw); assert.equal(display.moduleRows[1].statusLabel, 'unrecognized'); assert.deepEqual(builders.map(fn => fn({ report, timestamp: 'fixed' }).content), before);
});

test('issue summaries and real API counts localize while user notes, raw warnings and approvals are unchanged', () => {
  const report = freeze({ summary: { overallStatus: 'passed' }, issueLogs: [{ issueId: 'a', title: raw, severity: 'blocker', status: 'open', isBlockingFinalRelease: true }] });
  const display = getFinalAcceptanceDisplayModel(report, t); assert.equal(display.issueRows[0].title, raw); assert.match(display.issueBlockingText, /Unresolved release-blocking issues: 1/); assert.equal(display.summaryCards.find(card => card.label === 'Overall status').value, t('部分完成')); assert.equal(report.summary.overallStatus, 'passed');
  const api = getRealApiAcceptanceDisplayModel({ summary: { overallStatus: 'failed', realApiCallCount: 2 }, warnings: [raw] }, t); assert.equal(api.summaryCards[0].value, t('失败')); assert.equal(api.summaryCards[1].value, '2'); assert.equal(api.warningText, raw);
});

test('template export confirmation uses current locale and cancellation never creates a download', () => {
  let prompt, created = 0;
  const result = downloadTemplateAuditJson(template(), { t, confirm: text => { prompt = text; return false; }, createElement: () => { created++; } });
  assert.match(prompt, /sanitized JSON export/); assert.equal(result.reason, 'cancelled'); assert.equal(created, 0);
});

test('all report callsites include the current translator and memo dependencies without localizing request values', () => {
  for (const page of ['GeneratePage', 'ImagePlanPage']) { const source = fs.readFileSync(new URL(`../src/pages/${page}.jsx`, import.meta.url), 'utf8'); assert.ok(source.includes('templateAuditDisplaySections(templateAudit, t), [templateAudit, t]')); assert.ok(source.includes('singleImageAcceptanceReportSections(singleImageReport, t), [singleImageReport, t]')); assert.ok(source.includes('threeSampleGenerationSections(threeSampleReport, t), [threeSampleReport, t]')); assert.ok(source.includes('downloadTemplateAuditJson(templateAudit, { t })')); }
  const review = fs.readFileSync(new URL('../src/pages/ReviewPage.jsx', import.meta.url), 'utf8'); assert.ok(review.includes('getReviewReportDisplayModel(task?.normalizedReviewReport, t)')); assert.ok(review.includes('[autoFixPlan, t]'));
  const acceptance = fs.readFileSync(new URL('../src/pages/FinalAcceptancePage.jsx', import.meta.url), 'utf8'); assert.ok(acceptance.includes('getFinalAcceptanceDisplayModel(report, t), [report, t]')); assert.ok(acceptance.includes('value={moduleKey}>{reportDisplayLabel')); assert.ok(acceptance.includes('value={severity}>{reportDisplayLabel')); assert.ok(acceptance.includes('value={status}>{reportDisplayLabel'));
});
