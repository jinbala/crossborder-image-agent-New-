import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {english} from '../src/i18n/messages.js';
import {translate} from '../src/i18n/core.js';
import {exportReportLabels,exportReportLabel,exportReportBoolean} from '../src/utils/exportReportLabels.js';
import {getExportPackageDisplayModel,exportPackageJson} from '../src/utils/exportPackage.js';
import {getListingExportDisplayModel,listingExportJson} from '../src/utils/listingExport.js';
import {getUploadReadinessDisplayModel,uploadReadinessJson} from '../src/utils/uploadReadiness.js';
import {getUploadPayloadDisplayModel,getUploadSandboxDisplayModel,uploadPayloadJson} from '../src/utils/uploadPayload.js';
import {getUploadSafetyDisplayModel,uploadSafetyJson} from '../src/utils/uploadSafety.js';
import {getScanCandidateDisplay,buildScanSummaryMessage,getScanFeedbackDisplay} from '../src/utils/importScan.js';
import {getSkuDisplayQueueStatus,getSkuDisplayQueueHint} from '../src/utils/batchStatusDisplay.js';
const en=(source,values)=>{assert.ok(Object.hasOwn(english,source),`Missing message: ${source}`);return translate('en-US',source,values);};
const zh=(source,values)=>translate('zh-CN',source,values);
const freeze=value=>{if(value&&typeof value==='object'){Object.freeze(value);Object.values(value).forEach(freeze);}return value;};
const raw='已完成';

test('owned export enums are catalogued, prototype names and unknown business strings never reach translation',()=>{
  for(const [group,labels] of Object.entries(exportReportLabels))for(const [value,source] of Object.entries(labels))assert.equal(exportReportLabel(group,value,en),en(source));
  const fail=()=>{throw new Error('business value reached translator');};
  for(const group of [...Object.keys(exportReportLabels),'constructor','__proto__'])for(const value of [raw,'constructor','__proto__','future-enum'])assert.equal(exportReportLabel(group,value,fail),value);
  assert.equal(exportReportBoolean(false,en),'No');assert.equal(exportReportBoolean(true,en),'Yes');
  assert.equal(exportReportBoolean('false',en),'Unknown');assert.equal(exportReportBoolean('true',en),'Unknown');
});

test('package cards, statuses and generated receipt localize without translating filenames, warnings or error codes',()=>{
  const input=freeze({result:{zipFile:'已完成-{name}-$&.zip',relativePath:'outputs/export-packages/a.zip',summary:{totalSku:2},warnings:[raw],directoryTree:[{path:`Amazon/${raw}/主图.jpg`,status:'ready',sourceType:'mock',errorCode:raw},{path:raw,status:'future-enum',sourceType:raw}]}});
  const before=JSON.stringify(input),model=getExportPackageDisplayModel(input,en);
  assert.equal(model.summaryCards[0].label,'Total SKUs');assert.equal(model.treeRows[0].status,'ready');assert.equal(model.treeRows[0].statusDisplay,'Ready');
  assert.equal(model.treeRows[0].sourceTypeDisplay,'Mock previews');assert.equal(model.treeRows[0].path,`Amazon/${raw}/主图.jpg`);assert.equal(model.treeRows[0].errorCode,raw);
  assert.equal(model.treeRows[1].statusDisplay,'future-enum');assert.equal(model.treeRows[1].sourceTypeDisplay,raw);
  assert.equal(model.resultText,'Generated 已完成-{name}-$&.zip');assert.equal(model.warningText,raw);assert.equal(JSON.stringify(input),before);
  assert.match(getExportPackageDisplayModel({},en).emptyText,/No export/);assert.equal(getExportPackageDisplayModel(input).summaryCards[0].label,'SKU 总数');
});

test('listing empty markers and receipt translate but field, SKU, platform, original warnings and recommendations stay raw',()=>{
  const input=freeze({result:{exportId:'原文-$&',summary:{missingRequiredFields:[{sku:raw,platform:raw,field:raw}],blockedFields:[{sku:raw,field:raw,status:'blocked'}],warnings:[raw],recommendations:[raw]}}});
  const before=JSON.stringify(input),model=getListingExportDisplayModel(input,en);
  assert.equal(model.noReviewText,'None');assert.equal(model.failedText,'None');assert.equal(model.missingText,`${raw} ${raw} ${raw}`);
  assert.equal(model.blockedText,`${raw} ${raw} Blocked`);assert.equal(model.resultText,'Generated 原文-$&');
  assert.equal(model.warningText,raw);assert.equal(model.recommendationText,raw);assert.equal(JSON.stringify(input),before);getListingExportDisplayModel({},en);
});

test('readiness and payload cards use selected locale while raw request objects and reports remain unchanged',()=>{
  const report=freeze({summary:{totalSku:1,canUploadNow:false},platformReports:[{platformId:'amazon',status:'blocked',canUpload:false}],skuReports:[{sku:raw,status:'warning',ready:false,missingFields:[raw],blockingIssues:[{code:raw,message:raw,severity:'high'}]}],warnings:[raw],recommendations:[raw],nextSuggestedAction:raw});
  const before=JSON.stringify(report),model=getUploadReadinessDisplayModel(report,en);
  assert.equal(model.summaryCards[0].label,'Total SKUs');assert.equal(model.summaryCards.at(-1).value,'No');assert.equal(model.platformRows[0].statusDisplay,'Blocked');
  assert.equal(model.skuRows[0].status,'warning');assert.equal(model.skuRows[0].statusDisplay,'Warnings');assert.equal(model.skuRows[0].missingFieldsText,raw);assert.equal(model.nextSuggestedAction,raw);
  const payload=freeze({summary:{totalSku:1},skuPayloads:[{sku:raw,status:'ready',payload:{title:raw,images:{main:raw}},warnings:[raw]}],recommendations:[raw]});
  const payloadBefore=JSON.stringify(payload),view=getUploadPayloadDisplayModel(payload,en);
  assert.equal(view.summaryCards[1].label,'Ready payloads');assert.equal(view.skuRows[0].statusDisplay,'Ready');assert.equal(view.skuRows[0].payload.title,raw);assert.equal(view.skuRows[0].payload.images.main,raw);
  assert.equal(view.recommendationText,raw);assert.equal(JSON.stringify(payload),payloadBefore);assert.equal(JSON.stringify(report),before);
  assert.equal(getUploadReadinessDisplayModel(report,zh).summaryCards[0].label,'SKU 总数');getUploadReadinessDisplayModel(null,en);getUploadPayloadDisplayModel(null,en);
});

test('sandbox booleans and statuses are display-only and never turn string flags into a successful upload',()=>{
  const input=freeze({summary:{accepted:1,uploaded:false,realNetworkCalled:false,externalApiCalled:false},simulatedResults:[{sku:raw,simulatedStatus:'accepted_with_warnings',status:'raw-future',uploaded:false,realNetworkCalled:'true',externalApiCalled:true,message:raw}],warnings:[raw]});
  const before=JSON.stringify(input),model=getUploadSandboxDisplayModel(input,en);
  assert.equal(model.summaryCards[0].label,'Simulated acceptance');assert.equal(model.summaryCards[3].value,'No');
  assert.equal(model.resultRows[0].simulatedStatus,'accepted_with_warnings');assert.equal(model.resultRows[0].status,'raw-future');assert.equal(model.resultRows[0].statusDisplay,'Simulated acceptance (warnings)');
  assert.equal(model.resultRows[0].uploadedText,'No');assert.equal(model.resultRows[0].realNetworkCalledText,'Unknown');assert.equal(model.resultRows[0].externalApiCalledText,'Yes');
  assert.equal(model.resultRows[0].message,raw);assert.equal(JSON.stringify(input),before);getUploadSandboxDisplayModel(null,en);
});

test('safety display requires strict boolean capability flags and keeps variable names and raw findings intact',()=>{
  const input=freeze({summary:{readyForRealUpload:false},credentialStatus:{platforms:[{platformId:'amazon',configured:'false',sandboxSupported:false,realUploadSupported:'true',requiredVariables:['NOT_A_SECRET_VARIABLE_NAME'],warnings:[raw]}]},securityFindings:[{severity:'critical',code:'RAW',message:raw}],recommendations:[raw]});
  const before=JSON.stringify(input),model=getUploadSafetyDisplayModel(input,en);
  assert.equal(model.summaryCards[2].value,'No');assert.equal(model.platformRows[0].configuredText,'Not configured');
  assert.equal(model.platformRows[0].realUploadText,'Real upload unsupported');assert.equal(model.platformRows[0].requiredVariablesText,'NOT_A_SECRET_VARIABLE_NAME');
  assert.equal(model.findingText,`Critical - RAW - ${raw}`);assert.equal(model.recommendationText,raw);assert.equal(JSON.stringify(input),before);getUploadSafetyDisplayModel(null,en);
});

test('scan and queue hints interpolate raw identifiers without translating custom reasons or changing selection and state',()=>{
  assert.equal(buildScanSummaryMessage({summary:{totalFolders:12}},en),'Scan complete: 12 SKU folders found');
  const input=freeze({status:'imported',existingBatchId:raw}),model=getScanCandidateDisplay(input,{},en);
  assert.equal(model.label,'Imported into another batch');assert.equal(model.hint,`Imported into another batch: ${raw}`);assert.equal(model.selectable,false);assert.equal(model.status,'imported');
  assert.equal(getScanCandidateDisplay({status:'skipped',reason:raw},{},en).hint,raw);
  assert.equal(getScanCandidateDisplay({status:'constructor',reason:raw},{},en).label,'constructor');
  const sku=freeze({taskId:'task',sku:raw,status:'uploaded',rowSource:'currentBatchTask'}),queue=getSkuDisplayQueueStatus(sku,null,null,en);
  assert.equal(queue.status,'pending');assert.equal(queue.label,'Pending');assert.match(getSkuDisplayQueueHint(sku,null,null,en),/API costs/);
  const plan=freeze({resumeGroups:{blocked:[{taskId:'task',reason:raw}]}});
  assert.equal(getSkuDisplayQueueHint({taskId:'task'},null,plan,en),`Blocked: ${raw}`);
});

test('all exported JSON bytes remain identical after Chinese and English display projections',()=>{
  const report=freeze({summary:{totalSku:1},warnings:[raw],recommendations:[raw],status:'ready',files:[{fileName:raw}],directoryTree:[{path:raw,status:'ready',sourceType:'mock'}]});
  const downloads=()=>[exportPackageJson(report),listingExportJson(report),uploadReadinessJson(report),uploadPayloadJson(report),uploadSafetyJson(report)];const before=downloads();
  for(const t of [zh,en]){getExportPackageDisplayModel({result:report},t);getListingExportDisplayModel({result:report},t);getUploadReadinessDisplayModel(report,t);getUploadPayloadDisplayModel(report,t);getUploadSandboxDisplayModel(report,t);getUploadSafetyDisplayModel(report,t);}
  assert.deepEqual(downloads(),before);
});

test('batch page explicitly passes locale to projections and renders display labels, not localized request values',()=>{
  const page=fs.readFileSync(new URL('../src/pages/BatchPage.jsx',import.meta.url),'utf8');
  for(const call of ['getUploadReadinessDisplayModel(uploadReadinessReport, t)','getUploadPayloadDisplayModel(uploadPayloadPreview, t)','getUploadSandboxDisplayModel(uploadSandboxReport, t)','getUploadSafetyDisplayModel(uploadSafetyReport, t)','getScanFeedbackDisplay(scanFeedback, t)'])assert.ok(page.includes(call),call);
  assert.ok(page.includes('{row.statusDisplay}'));assert.ok(page.includes('getSkuDisplayQueueStatus(sku, batchStabilityReport, batchResumePlan, t)'));
});

test('stored scan feedback changes language without repeating the scan or guessing error state from translated text',()=>{
  const feedback=freeze({status:'completed',totalFolders:3});
  assert.equal(getScanFeedbackDisplay(feedback,en).text,'Scan complete: 3 SKU folders found');
  assert.equal(getScanFeedbackDisplay(feedback,zh).text,'扫描完成，共发现 3 个 SKU 文件夹');
  assert.equal(getScanFeedbackDisplay({status:'failed',message:raw},en).text,`Scan failed: ${raw}`);
  assert.equal(getScanFeedbackDisplay({status:'failed',message:raw},en).isError,true);
  assert.equal(getScanFeedbackDisplay({status:'scanning'},en).isError,false);
  assert.deepEqual(getScanFeedbackDisplay(null,en),{text:'',isError:false});
});

test('CSV and package previews transmit the explicit real-sample option using the same strict boolean contract as generation',async()=>{
  const {api}=await import('../src/services/api.js'),previous=global.fetch,calls=[];
  global.fetch=async(input)=>{calls.push(new URL(input,'http://localhost'));return Response.json({preview:{}});};
  try{for(const preview of [api.getListingCsvPreview,api.getExportPackagePreview]){await preview('batch',{includeRealSamples:true});await preview('batch',{includeRealSamples:'true'});}
    assert.deepEqual(calls.map(url=>url.searchParams.get('includeRealSamples')),['true','false','true','false']);
  }finally{global.fetch=previous;}
});
