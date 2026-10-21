import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { english } from '../src/i18n/messages.js';
import { translate } from '../src/i18n/core.js';
import { BATCH_GUIDE_STEPS, getBatchGuideState } from '../src/utils/batchWorkflowGuide.js';
import { batchReportLabels, batchReportLabel } from '../src/utils/batchReportLabels.js';
import { getBatchReviewReportDisplayModel, buildBatchReviewReportDownload } from '../src/utils/batchReviewReport.js';
import { getBatchStabilityDisplayModel, buildBatchStabilityReportDownload } from '../src/utils/batchStability.js';
import { getBatchResumePlanDisplayModel, buildBatchResumePlanDownload } from '../src/utils/batchResumePlan.js';
import { getSkuRetryDisplayModel, buildSkuRetryResultDownload } from '../src/utils/skuRetry.js';

const en = (source, values) => { assert.ok(Object.hasOwn(english, source), `Missing dynamic UI message: ${source}`); return translate('en-US', source, values); };
const freeze = object => { if (object && typeof object==='object') { Object.freeze(object); for(const value of Object.values(object)) freeze(value); } return object; };
const protocol = guide => ({ counts: guide.counts, currentStepId: guide.currentStepId, steps: guide.steps.map(step=>({id:step.id,status:step.status,nextAction:step.nextAction,primary:step.primaryAction.id,action:step.primaryAction.action,secondary:step.secondaryActions.map(item=>item.action)})) });
const raw = '当前步骤'; // A real catalog key used as business data must stay raw.

test('all guide states translate dynamic messages without changing actions, counts, IDs or template names', () => {
  const states=['uploaded','recognized','confirmed','rules_selected','planned','generated','reviewed','exported','failed'];
  for(const state of states) {
    const input=freeze({workflowTemplateSnapshot:{name:raw},skuTasks:[{skuId:raw,taskId:'task-fixture',status:state,retryable:true,requiresUserAction:true,lastErrorCategory:'network'}]});
    const before=JSON.stringify(input), chinese=getBatchGuideState(input), display=getBatchGuideState(input,en);
    assert.deepEqual(protocol(display),protocol(chinese)); assert.equal(JSON.stringify(input),before);
    assert.equal(display.steps[1].progressText,`Selected: ${raw}`);
    assert.equal(display.steps[0].title,'Import SKUs');
    for(const step of display.steps) assert.ok(!/[\u3400-\u9fff]/.test(step.description));
    assert.ok(display.warnings.every(warning=>!/[\u3400-\u9fff]/.test(warning.message)));
  }
  assert.equal(getBatchGuideState({},en).steps[0].progressText,'No SKUs imported yet');
  getBatchGuideState({skuTasks:[{status:'uploaded'}]},en);
  assert.equal(getBatchGuideState({skuTasks:[{status:'uploaded'}]}).steps[0].progressText,'已导入 1 个 SKU');
  assert.equal(BATCH_GUIDE_STEPS[0].description,'从扫描目录或本地文件夹导入 SKU 图片。');
});

test('guide counts unknown error categories including prototype names safely and keeps original output by default', () => {
  const input=freeze({skuTasks:[{status:'failed',lastErrorCategory:'__proto__'},{status:'failed',lastErrorCategory:'constructor'}]});
  const original=getBatchGuideState(input), localized=getBatchGuideState(input,en);
  assert.equal(original.warnings[0].message,'2 个 SKU 失败：__proto__ 1 / constructor 1');
  assert.equal(localized.warnings[0].message,'2 failed SKUs: __proto__ 1 / constructor 1');
  assert.equal(original.steps[0].title,'导入 SKU'); assert.equal(original.currentStepId,localized.currentStepId);
});

test('owned enums translate through complete catalogs while unknown codes and custom values never reach translation', () => {
  for(const [group,labels] of Object.entries(batchReportLabels)) for(const [value,label] of Object.entries(labels)) {
    assert.equal(batchReportLabel(group,value,en),translate('en-US',label));
    assert.equal(batchReportLabel(group,value),value);
  }
  const unexpected=()=>{throw new Error('Unknown business text must not be translated');};
  for(const group of [...Object.keys(batchReportLabels),'constructor','__proto__','unknown']) {
    assert.equal(batchReportLabel(group,raw,unexpected),raw); assert.equal(batchReportLabel(group,'__proto__',unexpected),'__proto__');
  }
});

test('review cards translate but issue codes, recommendations, original names and fix titles remain unchanged', () => {
  getBatchReviewReportDisplayModel(null,en); getBatchReviewReportDisplayModel({meta:{totalSku:0}},en);
  const input=freeze({meta:{totalSku:1},summary:{fatalCount:1},batchFixSummary:{byActionType:{editTextLayout:1,[raw]:1},topFixSuggestions:[{title:raw,severity:'fatal'}],recommendations:[raw]},topRiskSku:[{sku:raw,productName:raw}],recommendations:[raw],issuesByCode:{[raw]:2},issuesByImageType:{main_image:1}});
  const before=JSON.stringify(input), model=getBatchReviewReportDisplayModel(input,en);
  assert.equal(model.overviewCards[0].label,'Total SKUs'); assert.equal(model.riskCards[0].label,'Critical risk');
  assert.equal(model.fixActionRows[0].label,'Adjust text layout'); assert.equal(model.fixActionRows[0].key,'editTextLayout');
  assert.equal(model.fixActionRows[1].label,raw); assert.equal(model.issueRows[0].label,raw);
  assert.equal(model.topRiskSku[0].productName,raw); assert.equal(model.topFixSuggestions[0].title,raw);
  assert.deepEqual(model.recommendations,[raw]); assert.deepEqual(model.fixRecommendations,[raw]);
  assert.equal(JSON.stringify(input),before); assert.equal(getBatchReviewReportDisplayModel(input).riskCards[0].label,'fatal');
});

test('stability translates only known default step titles, never custom labels, raw errors or report bodies', () => {
  getBatchStabilityDisplayModel(null,en); getBatchStabilityDisplayModel({summary:{totalSku:0}},en);
  const input=freeze({summary:{totalSku:1},stepSummary:JSON.parse('{"upload":{"label":"上传"},"imagePlan":{"label":"当前步骤"},"constructor":{},"__proto__":{}}'),skuProgress:[{sku:raw}],failures:[{errorMessage:raw}],recommendations:[raw],resumePlan:{blockedReasons:[raw],recommendations:[raw]}});
  const before=JSON.stringify(input), model=getBatchStabilityDisplayModel(input,en);
  assert.equal(model.summaryCards[0].label,'Total SKUs'); assert.equal(model.stepRows[0].label,'Upload');
  assert.equal(model.stepRows[1].label,raw); assert.equal(model.stepRows[2].label,'constructor'); assert.equal(model.stepRows[3].label,'__proto__');
  assert.equal(model.failureRows[0].errorMessage,raw); assert.equal(model.resumePlan.blockedReasons[0],raw);
  assert.equal(JSON.stringify(input),before);
});

test('recovery groups localize without modifying ordered retry steps, suggestions or mode values', () => {
  const empty=getBatchResumePlanDisplayModel(null,en); assert.equal(empty.groupSections.waiting.title,'Awaiting recognition');
  const input=freeze({summary:{totalSku:1},resumeGroups:{safeMockRetry:[{sku:raw,recommendedRetryStep:'imageGeneration',suggestion:raw}]},orderedPlan:[{taskId:'task',mode:'mockOnly',recommendedRetryStep:'imageGeneration',suggestion:raw}],warnings:[raw],recommendations:[raw]});
  const before=JSON.stringify(input), model=getBatchResumePlanDisplayModel(input,en);
  assert.equal(model.groupSections.safeMockRetry.title,'Safe mock retry'); assert.equal(model.orderedRows[0].mode,'mockOnly');
  assert.equal(model.orderedRows[0].suggestion,raw); assert.equal(model.groupSections.safeMockRetry.rows[0].recommendedRetryStep,'imageGeneration');
  getBatchResumePlanDisplayModel({summary:{totalSku:0}},en); assert.equal(JSON.stringify(input),before);
});

test('single-SKU retry localizes display codes and snapshots but preserves reasons and executable enum arrays', () => {
  const input=freeze({retryPlan:{allowedRetrySteps:['imageGeneration',raw],blockedRetrySteps:[{retryStep:'export',reason:raw}],warnings:[raw]},retryResult:{status:'completed',durationMs:1000,resultSummary:{message:raw},beforeSnapshot:{imagePlanCount:1,generatedImageCount:0},afterSnapshot:{imagePlanCount:1,generatedImageCount:1}}});
  const before=JSON.stringify(input), model=getSkuRetryDisplayModel(input,en);
  assert.equal(model.allowedStepsText,`Generate images / ${raw}`); assert.equal(model.blockedStepsText,`Export: ${raw}`);
  assert.equal(model.resultStatusText,'Completed'); assert.equal(model.resultSummaryText,raw);
  assert.ok(model.snapshotSummary.includes('Generated-image count: 0 -> 1')); assert.deepEqual(model.allowedSteps,['imageGeneration',raw]);
  assert.equal(JSON.stringify(input),before); getSkuRetryDisplayModel({},en);
});

test('all report download bytes stay unchanged after both language projections and UI passes only explicit labels', () => {
  const report=freeze({meta:{batchId:'batch'},summary:{totalSku:1},recommendations:[raw],warnings:[raw],issueLogs:[{title:raw}],resumeGroups:{},orderedPlan:[{sku:raw,mode:'mockOnly'}]});
  const options={report,plan:report,batchId:'batch',timestamp:'fixed',taskId:'task',retryPlan:report,retryResult:report};
  const downloads=()=>[buildBatchReviewReportDownload(options),buildBatchStabilityReportDownload(options),buildBatchResumePlanDownload(options),buildSkuRetryResultDownload(options)];
  const before=downloads(); getBatchReviewReportDisplayModel(report,en);getBatchStabilityDisplayModel(report,en);getBatchResumePlanDisplayModel(report,en);getSkuRetryDisplayModel(options,en);
  assert.deepEqual(downloads(),before);
  const page=fs.readFileSync(new URL('../src/pages/BatchPage.jsx',import.meta.url),'utf8');
  for(const call of ['getBatchGuideState(batchTask || { skuTasks: [] }, t)','getBatchReviewReportDisplayModel(batchReviewReport, t)','getBatchStabilityDisplayModel(batchStabilityReport, t)','getBatchResumePlanDisplayModel(batchResumePlan, t)','getSkuRetryDisplayModel({ retryPlan, retryResult }, t)']) assert.ok(page.includes(call),call);
  assert.ok(page.includes('value={step}>{batchReportLabel(\'step\', step, t)}'));
});
