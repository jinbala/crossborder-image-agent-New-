const fs = require('node:fs/promises');
const path = require('node:path');
async function waitFor(window, expression) {
  for (let i = 0; i < 180; i++) { if (await window.webContents.executeJavaScript(expression)) return true; await new Promise(resolve => setTimeout(resolve, 100)); }
  throw new Error(`旧工作流验收超时：${expression}`);
}
async function language(window, locale) {
  await window.webContents.executeJavaScript(`(() => {const select=document.querySelector('select[aria-label="Interface language / 界面语言"]');select.value=${JSON.stringify(locale)};select.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  await waitFor(window, `document.documentElement.lang===${JSON.stringify(locale)}`);
}
async function click(window, label) {
  await window.webContents.executeJavaScript(`(() => {const node=Array.from(document.querySelectorAll('button')).find(item=>item.innerText===${JSON.stringify(label)});if(!node || node.disabled)throw new Error('Button unavailable: '+${JSON.stringify(label)});node.click();})()`);
}
async function legacyWorkflowSmoke({ window, origin, dataRoot, requestApi }) {
  const checks = {};
  const json = async (url, method = 'GET', body) => { const response = await requestApi(url, { method, headers: { 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) }); const result = await response.json(); if (!response.ok) throw new Error(`${method} ${url}: ${JSON.stringify(result.error)}`); return result; };
  const fixture = path.join(dataRoot, 'legacy-fixture-017');
  const sharp = require('sharp');
  for (const name of ['SKU-017-A', 'SKU-017-B']) { const directory = path.join(fixture, name); await fs.mkdir(directory, { recursive: true }); await sharp({ create: { width: 96, height: 96, channels: 3, background: '#6a85a0' } }).png().toFile(path.join(directory, '原图-017.png')); }
  const imported = await json('/api/batches/import-folder', 'POST', { folderPath: fixture, name: '批量-017-原文', defaultTargets: [{ platformId: 'amazon', site: 'US', language: 'English', categoryId: 'generic_ecommerce' }] }), batchId = imported.batchTask.id;
  const batch = async () => (await json(`/api/batches/${batchId}`)).batchTask;
  const waitBatch = async (previousStart = null) => { for (let i = 0; i < 150; i++) { const current = await batch(); if (current.queue?.startedAt && current.queue.startedAt !== previousStart && ['completed', 'partial_failed', 'failed'].includes(current.queue.status)) return current; await new Promise(resolve => setTimeout(resolve, 100)); } throw new Error('Batch did not finish'); };
  await window.loadURL(`${origin}/batches/${batchId}`); await language(window, 'en-US');
  checks.englishBatchPage = await waitFor(window, `document.querySelector('h1')?.innerText==='Batch SKU tasks' && document.body.innerText.includes('waits for human confirmation')`);
  await click(window, 'Start current batch'); const prepared = await waitBatch();
  const ids = prepared.skuTasks.filter(item => item.taskId).map(item => item.taskId);
  const recognized = await Promise.all(ids.map(async id => (await json(`/api/tasks/${id}`)).task));
  checks.batchPrepareWaitsForHuman = ids.length === 2 && recognized.every(item => item.status === 'recognized' && !item.productInfoConfirmed && !item.imagePlans.length);
  const id = ids[0]; await window.loadURL(`${origin}/tasks/${id}/product`);
  await waitFor(window, `document.querySelector('h1')?.innerText==='Confirm product information'`);
  await window.webContents.executeJavaScript('window.confirm=()=>true; void 0'); await click(window, 'Save & continue');
  await waitFor(window, `location.pathname.endsWith('/rules') || Array.from(document.querySelectorAll('button')).some(node=>node.innerText==='I have reviewed this; continue saving')`);
  if (await window.webContents.executeJavaScript(`!location.pathname.endsWith('/rules')`)) await click(window, 'I have reviewed this; continue saving');
  await waitFor(window, `location.pathname.endsWith('/rules')`);
  await json(`/api/tasks/${ids[1]}/product`, 'PATCH', { productInfo: recognized[1].productInfo });
  await window.loadURL(`${origin}/batches/${batchId}`); await waitFor(window, `document.querySelector('h1')?.innerText==='Batch SKU tasks'`);
  await click(window, 'Start current batch'); await waitBatch(prepared.queue.startedAt);
  checks.batchConfirmedContinuesToPlan = (await Promise.all(ids.map(async own => (await json(`/api/tasks/${own}`)).task))).every(item => item.status === 'planned' && item.productInfoConfirmed?.name && item.imagePlans.length === 8);
  await window.loadURL(`${origin}/tasks/${id}/generate`); checks.englishGenerationPage = await waitFor(window, `document.querySelector('h1')?.innerText==='Image generation & preview'`);
  await click(window, 'Generate mock previews');
  for (let i = 0; i < 180; i++) { const current = (await json(`/api/tasks/${id}`)).task; if (current.status === 'generated') break; await new Promise(resolve => setTimeout(resolve, 100)); }
  const generated = (await json(`/api/tasks/${id}`)).task;
  checks.mockGenerationUiComplete = generated.generatedImages.length === 8 && generated.generatedImages.every(item => item.isMockPreview && !item.isRealGenerated);
  await waitFor(window, `Array.from(document.querySelectorAll('button')).some(node=>node.innerText==='Preview background removal')`);
  let mattingPosts = 0;
  window.webContents.session.webRequest.onBeforeRequest({ urls: [`${origin}/api/tasks/${id}/plans/*/matting-preview`] }, (details, callback) => { if (details.method === 'POST') mattingPosts++; callback({ cancel: true }); });
  try {
    await window.webContents.executeJavaScript(`window.__mattingFetch=window.fetch;window.__mattingDialogs=[];window.fetch=async(input,init)=>String(input).endsWith('/tasks/provider-config')?new Response(JSON.stringify({paidDestinations:{matting:{provider:'external',origin:'https://matting-approval-test.invalid',local:false}}}),{status:200,headers:{'Content-Type':'application/json'}}):window.__mattingFetch(input,init);window.confirm=message=>{window.__mattingDialogs.push(message);return false;};void 0`);
    await click(window, 'Preview background removal'); await waitFor(window, 'window.__mattingDialogs.length===1');
    checks.cancelledRemoteMattingPreviewNoPost = mattingPosts === 0 && await window.webContents.executeJavaScript(`window.__mattingDialogs[0].includes('matting-approval-test.invalid')`);
  } finally { window.webContents.session.webRequest.onBeforeRequest(null); await window.webContents.executeJavaScript('window.fetch=window.__mattingFetch;void 0'); }
  await waitFor(window, `Array.from(document.querySelectorAll('button')).some(node=>node.innerText==='Preview background removal' && !node.disabled)`);
  await click(window, 'Preview background removal');
  checks.localMattingPreviewUi = await waitFor(window, 'Boolean(document.querySelector(\'img[src*="/matting-preview/"]\'))');
  await window.loadURL(`${origin}/tasks/${id}/review`); await waitFor(window, `document.querySelector('h1')?.innerText==='Compliance review'`);
  await click(window, 'Start review');
  for (let i = 0; i < 100; i++) { if ((await json(`/api/tasks/${id}`)).task.status === 'reviewed') break; await new Promise(resolve => setTimeout(resolve, 100)); }
  checks.mockReviewUiComplete = (await json(`/api/tasks/${id}`)).task.status === 'reviewed';
  let reviewPosts = 0;
  window.webContents.session.webRequest.onBeforeRequest({ urls: [`${origin}/api/tasks/${id}/review`] }, (details, callback) => { if (details.method === 'POST') reviewPosts++; callback({ cancel: true }); });
  try {
    // Synthetic read-only preflight response; the dialog is cancelled, so no
    // real model or review endpoint can run during this test.
    await window.webContents.executeJavaScript(`window.__originalFetch=window.fetch; window.__paidDialogs=[]; window.fetch=async(input,init)=>String(input).endsWith('/tasks/provider-config')?new Response(JSON.stringify({paidDestinations:{review:{provider:'openai',origin:'https://approval-test.invalid'}}}),{status:200,headers:{'Content-Type':'application/json'}}):window.__originalFetch(input,init);window.confirm=message=>{window.__paidDialogs.push(message);return false;};void 0`);
    await click(window, 'Real vision review'); await waitFor(window, 'window.__paidDialogs.length===1');
    checks.cancelledRealReviewNoPost = reviewPosts === 0 && await window.webContents.executeJavaScript(`window.__paidDialogs[0].includes('approval-test.invalid') && window.__paidDialogs[0].includes('automatic retries')`);
  } finally { window.webContents.session.webRequest.onBeforeRequest(null); await window.webContents.executeJavaScript('window.fetch=window.__originalFetch; void 0'); }
  await window.loadURL(`${origin}/stress-test`); await waitFor(window, `document.querySelector('[data-stress-batch] option[value="${batchId}"]')`);
  await window.webContents.executeJavaScript(`(() => {const select=document.querySelector('[data-stress-batch]');select.value=${JSON.stringify(batchId)};select.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  await language(window, 'zh-CN'); await language(window, 'en-US');
  checks.stressDraftPreserved = await window.webContents.executeJavaScript(`document.querySelector('[data-stress-batch]').value===${JSON.stringify(batchId)}`);
  await window.webContents.executeJavaScript('document.querySelector("[data-stress-run]").click()');
  checks.mockStressUiReport = await waitFor(window, `!document.querySelector('[data-stress-run]').disabled && document.body.innerText.includes('SKU details') && document.body.innerText.includes('Mock Vision')`);
  window.webContents.session.webRequest.onBeforeRequest({ urls: [`${origin}/api/final-acceptance/template*`] }, (_details, callback) => callback({ cancel: true }));
  try { await window.loadURL(`${origin}/final-acceptance`); await waitFor(window, `document.querySelector('[data-acceptance-workspace-status]')?.getAttribute('data-acceptance-workspace-status')==='saved'`); await window.webContents.executeJavaScript('document.querySelector("[data-acceptance-template]").click()'); await waitFor(window, 'Boolean(document.querySelector("[role=alert]"))'); }
  finally { window.webContents.session.webRequest.onBeforeRequest(null); }
  await window.webContents.executeJavaScript('document.querySelector("[data-acceptance-template]").click()');
  checks.acceptanceReadFailureRecovered = await waitFor(window, `document.querySelector('[data-acceptance-json]')?.disabled===false && !document.querySelector('[role=alert]')`);
  const stableTask = ({ status, productInfoConfirmed, imagePlans, generatedImages, review, updatedAt }) => JSON.stringify({ status, productInfoConfirmed, imagePlans, generatedImages, review, updatedAt });
  const beforeAcceptance = stableTask((await json(`/api/tasks/${id}`)).task);
  await window.webContents.executeJavaScript(`(() => {const node=document.querySelector('input[placeholder="Issue title"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(node,'验收问题-017-原文');node.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  await click(window, 'Add issue'); await waitFor(window, 'Boolean(document.querySelector("[data-acceptance-delete]"))');
  await language(window, 'zh-CN'); await language(window, 'en-US');
  checks.acceptanceOriginalIssuePreserved = await window.webContents.executeJavaScript(`Array.from(document.querySelectorAll('input')).some(node=>node.value==='验收问题-017-原文') && Boolean(document.querySelector('option[value="pending"]'))`);
  await window.webContents.executeJavaScript('window.__acceptanceDialogs=[];window.confirm=message=>{window.__acceptanceDialogs.push(message);return false;};void 0');
  await window.webContents.executeJavaScript('document.querySelector("[data-acceptance-template]").click();document.querySelector("[data-acceptance-delete]").click();');
  checks.acceptanceCancelledChangesSafe = await window.webContents.executeJavaScript(`window.__acceptanceDialogs.length===2 && Array.from(document.querySelectorAll('input')).some(node=>node.value==='验收问题-017-原文')`);
  const output = path.join(dataRoot, 'acceptance-ui-017.json');
  const downloaded = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { window.webContents.session.removeListener('will-download', save); reject(new Error('Acceptance JSON download timed out')); }, 15000);
    function save(_event, item) { item.setSavePath(output); item.once('done', (_done, state) => { clearTimeout(timeout); if (state === 'completed') resolve(); else reject(new Error(`Acceptance download ${state}`)); }); }
    window.webContents.session.once('will-download', save);
  });
  await window.webContents.executeJavaScript('document.querySelector("[data-acceptance-json]").click()'); await downloaded;
  const report = JSON.parse(await fs.readFile(output, 'utf8'));
  checks.acceptanceUiDownloadedOriginal = (report.issueLogs || []).some(issue => issue.title === '验收问题-017-原文');
  await window.webContents.executeJavaScript('window.confirm=()=>true;document.querySelector("[data-acceptance-delete]").click();void 0');
  checks.acceptanceConfirmedIssueDeletion = await waitFor(window, '!document.querySelector("[data-acceptance-delete]")');
  await waitFor(window, `document.querySelector('[data-acceptance-workspace-status]')?.getAttribute('data-acceptance-workspace-status')==='saved'`);
  checks.acceptanceNoTaskMutation = stableTask((await json(`/api/tasks/${id}`)).task) === beforeAcceptance;
  await require('./smoke-screenshot.cjs').smokeScreenshot(window, path.join(dataRoot, 'legacy-acceptance-english.png'));
  await language(window, 'zh-CN');
  // Controlled read-only responses exercise the actual renderer's cancellation
  // drain/poll transitions. Live-worker ordering is covered by backend barriers.
  const stableBatchBefore = JSON.stringify(await batch());
  const queueFixture = JSON.parse(stableBatchBefore);
  queueFixture.status = 'cancelled';
  queueFixture.queue = { ...queueFixture.queue, status: 'cancelled', totalJobs: 2, completedJobs: 0, failedJobs: 0, skippedJobs: 0, runningJobs: 1, pendingJobs: 1 };
  queueFixture.locks = { ...queueFixture.locks, isRunning: true };
  await window.loadURL(`${origin}/batches/${batchId}`);
  await waitFor(window, `Array.from(document.querySelectorAll('button')).some(node=>node.innerText==='刷新')`);
  await window.webContents.executeJavaScript(`(() => {
    window.__queueOriginalFetch=window.fetch;window.__queueFixtureMode='draining';window.__queueFixtureReads=0;window.__queueFixtureWrites=0;
    const fixture=${JSON.stringify(queueFixture)};
    window.fetch=async(input,options)=>{
      const url=new URL(typeof input==='string'?input:input.url,location.href);
      const method=options?.method||input?.method||'GET';
      if(method!=='GET')window.__queueFixtureWrites++;
      if(method==='GET'&&url.pathname===${JSON.stringify(`/api/batches/${batchId}`)}){
        window.__queueFixtureReads++;
        const result=structuredClone(fixture);
        if(window.__queueFixtureMode==='settled'){result.locks.isRunning=false;result.queue.runningJobs=0;result.queue.completedJobs=1;}
        return Response.json({batchTask:result});
      }
      return window.__queueOriginalFetch(input,options);
    };void 0;
  })()`);
  try {
    await click(window, '刷新');
    await waitFor(window, `Array.from(document.querySelectorAll('button')).some(node=>['展开高级操作','收起高级操作'].includes(node.innerText))`);
    if (await window.webContents.executeJavaScript(`Array.from(document.querySelectorAll('button')).some(node=>node.innerText==='展开高级操作')`)) await click(window, '展开高级操作');
    checks.queueDrainUiBlocksRestart = await waitFor(window, `document.querySelector('[data-queue-draining]') && ['开始队列','批量识别','应用平台 targets','批量生成方案','批量生成图片','批量审核'].every(label=>Array.from(document.querySelectorAll('button')).find(node=>node.innerText===label)?.disabled===true)`);
    await language(window, 'en-US');
    checks.queueDrainUiEnglishNotice = await waitFor(window, `document.querySelector('[data-queue-draining]')?.innerText.includes('unprocessed items are not counted as successes')`);
    await window.webContents.executeJavaScript(`(() => {document.querySelector('[data-queue-draining]').scrollIntoView({block:'center'});return new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>setTimeout(resolve,200))));})()`);
    await require('./smoke-screenshot.cjs').smokeScreenshot(window, path.join(dataRoot, 'queue-draining-english.png'));
    await window.webContents.executeJavaScript(`window.__queueFixtureMode='settled';window.__queueBeforePoll=window.__queueFixtureReads;void 0`);
    checks.queueDrainUiPollsUntilReleased = await waitFor(window, `window.__queueFixtureReads>window.__queueBeforePoll && !document.querySelector('[data-queue-draining]') && Array.from(document.querySelectorAll('button')).find(node=>node.innerText==='Start queue')?.disabled===false`);
    checks.queueDrainUiNoBackendMutation = (await window.webContents.executeJavaScript('window.__queueFixtureWrites===0')) && JSON.stringify(await batch()) === stableBatchBefore;
  } finally {
    await window.webContents.executeJavaScript('window.fetch=window.__queueOriginalFetch;void 0');
  }
  await language(window, 'zh-CN');
  return checks;
}
module.exports = { legacyWorkflowSmoke };
