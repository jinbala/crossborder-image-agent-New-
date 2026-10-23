const fs = require('node:fs/promises');
const path = require('node:path');
async function wait(window, expression) {
  for(let i=0;i<200;i++){if(await window.webContents.executeJavaScript(expression))return true;await new Promise(resolve=>setTimeout(resolve,100));}
  throw new Error(`Batch report localization timed out: ${expression}`);
}
async function locale(window, value) {
  await window.webContents.executeJavaScript(`(() => {const select=document.querySelector('select[aria-label="Interface language / 界面语言"]');select.value=${JSON.stringify(value)};select.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  await wait(window,`document.documentElement.lang===${JSON.stringify(value)}`);
}
async function download(window, destination) {
  const done = new Promise((resolve,reject)=>{
    const timeout=setTimeout(()=>{window.webContents.session.removeListener('will-download',save);reject(new Error('Batch report download timed out'));},15000);
    function save(_event,item){item.setSavePath(destination);item.once('done',(_done,state)=>{clearTimeout(timeout);state==='completed'?resolve():reject(new Error(`Batch report download ${state}`));});}
    window.webContents.session.once('will-download',save);
  });
  await window.webContents.executeJavaScript('document.querySelector("[data-batch-review-export]").click()'); await done;
  return fs.readFile(destination,'utf8');
}
async function batchReportsI18nSmoke({window,origin,dataRoot,requestApi}) {
  const checks={}, json=async route=>(await requestApi(route)).json();
  const selected=(await json('/api/batches')).batchTasks.find(batch=>batch.name==='批量-017-原文');
  if(!selected)throw new Error('Missing owned batch fixture for report display verification');
  const id=selected.id, route=`/api/batches/${id}`;
  const before=JSON.stringify((await json(route)).batchTask);
  const batch=JSON.parse(before), taskId=batch.skuTasks[0].taskId;
  batch.workflowTemplateSnapshot={...(batch.workflowTemplateSnapshot||{}),id:'report-ui-fixture',name:'当前步骤'};
  batch.skuTasks=batch.skuTasks.map((sku,index)=>({...sku,status:index?'failed':'recognized',currentStep:index?'imageGeneration':'waiting_confirm',requiresUserAction:Boolean(index),retryable:Boolean(index),lastErrorCategory:index?'network':null}));
  batch.queue={...batch.queue,status:'completed',runningJobs:0};batch.locks={...batch.locks,isRunning:false};
  const review={meta:{batchId:id,totalSku:2},summary:{fatalCount:1,needsManualReviewSku:1},batchFixSummary:{byActionType:{editTextLayout:1,manualCheck:1},topFixSuggestions:[{sku:'当前步骤',suggestionId:'display-fixture',title:'当前步骤',actionType:'editTextLayout',severity:'fatal'}],recommendations:['当前步骤']},topRiskSku:[{sku:'当前步骤',taskId,productName:'当前步骤',topIssues:[{severity:'fatal',title:'当前步骤'}]}],issuesByCode:{RAW_REPORT_FIXTURE:1},issuesByImageType:{compatibility_image:1},recommendations:['当前步骤']};
  const stability={summary:{totalSku:2,failedSku:1,pendingSku:1},stepSummary:{upload:{label:'上传',total:2},imageGeneration:{label:'图片生成',total:2}},failures:[{sku:'当前步骤',taskId,failedStep:'imageGeneration',severity:'high',errorMessage:'当前步骤',suggestion:'当前步骤',canRetry:true}],recommendations:['当前步骤'],resumePlan:{canResume:false,safeResumeSteps:['imageGeneration'],blockedReasons:['当前步骤'],recommendations:['当前步骤']}};
  const row={sku:'当前步骤',taskId,recommendedRetryStep:'imageGeneration',mode:'mockOnly',suggestion:'当前步骤'};
  const resume={summary:{totalSku:2,recoverableSku:1,waitingSku:1},resumeGroups:{safeMockRetry:[row]},orderedPlan:[{...row,order:1}],warnings:['当前步骤'],recommendations:['当前步骤']};
  const retry={batchId:id,taskId,allowedRetrySteps:['imagePlan','imageGeneration','review'],blockedRetrySteps:[{retryStep:'recognition',reason:'当前步骤'}],warnings:['当前步骤'],nextSuggestedAction:'当前步骤'};
  await window.loadURL(`${origin}/batches/${id}`);
  await wait(window,`document.querySelector('h1') && Array.from(document.querySelectorAll('button')).some(node=>['刷新','Refresh'].includes(node.innerText))`);
  await locale(window,'en-US');
  await window.webContents.executeJavaScript(`(() => {
    window.__batchReportFetch=window.fetch;window.__batchReportWrites=0;
    const fixtures=${JSON.stringify({[route]:{batchTask:batch},[`${route}/review-report`]:{reviewReport:review},[`${route}/stability`]:{batchStabilityReport:stability},[`${route}/resume-plan`]:{batchResumePlan:resume},[`${route}/tasks/${taskId}/retry-plan`]:{retryPlan:retry}})};
    window.fetch=async(input,options)=>{const route=new URL(typeof input==='string'?input:input.url,location.href).pathname;const method=options?.method||input?.method||'GET';if(method!=='GET')window.__batchReportWrites++;if(method==='GET'&&Object.hasOwn(fixtures,route))return Response.json(fixtures[route]);return window.__batchReportFetch(input,options);};
    Array.from(document.querySelectorAll('button')).find(node=>node.innerText==='Refresh').click();void 0;
  })()`);
  try {
    checks.batchGuideOwnedLabels = await wait(window,`document.body.innerText.includes('1 SKUs awaiting human confirmation') && document.querySelector('[data-batch-guide-template]')?.innerText.includes('当前步骤') && document.body.innerText.includes('1 failed SKUs: network 1')`);
    checks.batchReviewOwnedLabels = await wait(window,`document.querySelector('[data-batch-review-summary]')?.innerText.includes('SKUs needing human review') && document.body.innerText.includes('Critical risk') && document.body.innerText.includes('Adjust text layout') && document.body.innerText.includes('Compatibility image')`);
    checks.batchStabilityOwnedLabels = await wait(window,`document.body.innerText.includes('Progress percentage') && document.querySelector('[data-batch-failure]')?.innerText.includes('Generate images / High risk') && document.querySelector('[data-batch-failure]')?.innerText.includes('当前步骤')`);
    checks.batchResumeOwnedLabels = await wait(window,`document.body.innerText.includes('Safe mock retry') && document.body.innerText.includes('Estimated retry actions') && document.body.innerText.includes('Mock only')`);
    await window.webContents.executeJavaScript('document.querySelector("[data-sku-retry-preview]").click()'); await wait(window,`Boolean(document.querySelector('[data-sku-retry-step]'))`);
    await window.webContents.executeJavaScript(`(() => {const select=document.querySelector('[data-sku-retry-step]');select.value='imageGeneration';select.dispatchEvent(new Event('change',{bubbles:true}));})()`);
    await wait(window,`document.querySelector('[data-sku-retry-step]')?.value==='imageGeneration'`);
    await require('./smoke-screenshot.cjs').smokeScreenshot(window,path.join(dataRoot,'batch-report-labels-english.png'),{selector:'[data-batch-review-summary]'});
    const english=await download(window,path.join(dataRoot,'batch-report-ui-en.json'));
    await locale(window,'zh-CN'); await wait(window,`document.querySelector('[data-batch-review-summary]')?.innerText.includes('需人工复查 SKU')`);
    const chinese=await download(window,path.join(dataRoot,'batch-report-ui-zh.json'));
    checks.batchRetryOptionsKeepEnums = await window.webContents.executeJavaScript(`document.querySelector('[data-sku-retry-step]')?.value==='imageGeneration' && JSON.stringify(Array.from(document.querySelector('[data-sku-retry-step]').options).map(node=>node.value))===JSON.stringify(['imagePlan','imageGeneration','review']) && Array.from(document.querySelector('[data-sku-retry-step]').options).some(node=>node.value==='imageGeneration'&&node.text==='图片生成')`);
    checks.batchReportExportKeepsOriginal = english===chinese && JSON.stringify(JSON.parse(english))===JSON.stringify(review);
    checks.batchReportLocaleReadOnly = await window.webContents.executeJavaScript('window.__batchReportWrites===0') && JSON.stringify((await json(route)).batchTask)===before;
  } finally {await window.webContents.executeJavaScript('window.fetch=window.__batchReportFetch;void 0');}
  return checks;
}
module.exports={batchReportsI18nSmoke};
