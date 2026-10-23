const fs = require('node:fs/promises');
const path = require('node:path');

async function reportDetailsI18nSmoke({ window, origin, dataRoot, requestApi }) {
  const root = await fs.realpath(dataRoot), checks = {};
  if (!root.split(path.sep).includes('.smoke-data') || path.basename(root) !== 'workspace') throw new Error('Report tests require an owned smoke workspace');
  const mark = phase => fs.writeFile(path.join(root, 'report-details-progress.json'), JSON.stringify({ phase, at: new Date().toISOString(), checks }));
  async function wait(expression) { for (let i = 0; i < 200; i++) { if (await window.webContents.executeJavaScript(expression)) return; await new Promise(resolve => setTimeout(resolve, 50)); } throw new Error(`Report details timed out: ${expression}`); }
  async function json(route) { const response = await requestApi(route); if (!response.ok) throw new Error(`Report fixture ${route}: ${response.status}`); return response.json(); }
  async function locale(value) { await window.webContents.executeJavaScript(`(()=>{const el=document.querySelector('[aria-label="Interface language / 界面语言"]');el.value=${JSON.stringify(value)};el.dispatchEvent(new Event('change',{bubbles:true}));})()`); await wait(`document.documentElement.lang===${JSON.stringify(value)}`); }
  async function download(selector, name) {
    const destination = path.join(root, name);
    const done = new Promise((resolve, reject) => {
      const timer = setTimeout(() => { window.webContents.session.removeListener('will-download', save); reject(new Error('Report JSON download timed out')); }, 15000);
      function save(_event, item) { item.setSavePath(destination); item.once('done', (_done, state) => { clearTimeout(timer); state === 'completed' ? resolve() : reject(new Error(`Report download ${state}`)); }); }
      window.webContents.session.once('will-download', save);
    });
    await window.webContents.executeJavaScript(`document.querySelector(${JSON.stringify(selector)}).click()`); await done; return fs.readFile(destination);
  }
  const stable = task => JSON.stringify({ status: task.status, productInfo: task.productInfo, imagePlans: task.imagePlans, generatedImages: task.generatedImages, review: task.review });
  await mark('generation');
  let task;
  for (const entry of (await json('/api/tasks')).tasks) { const candidate = (await json(`/api/tasks/${entry.id}`)).task; if (candidate.generatedImages?.length === 8 && candidate.imagePlans?.length) { task = candidate; break; } }
  if (!task) throw new Error('No preceding local mock task available for report display');
  const id = task.id, before = stable(task), raw = '业务原文-已完成 $& {unknown}';
  await window.loadURL(`${origin}/tasks/${id}/generate`); await wait(`!!document.querySelector('[data-template-report-summary]')`); await locale('en-US');
  checks.reportTemplateDynamicEnglish = await window.webContents.executeJavaScript(`document.querySelector('[data-template-report-summary]').innerText.includes('template diversity score')`);
  // Explicit response-only report fixtures. No real-generation request is ever
  // forwarded; a second network gate rejects every actual API mutation.
  const single = { taskId: id, meta: { taskId: id, imageType: 'main_image', modelName: raw, testMode: 'display-fixture-only' }, generationResult: { status: 'succeeded', fallbackUsed: false, outputType: 'display-fixture-only' }, qualityScore: { score: 83, level: 'good', warnings: [raw] }, manualChecklist: { edges: false }, conclusion: { recommendedNextAction: raw } };
  const review = { meta: { taskId: id, reviewMode: 'mock' }, summary: { totalIssues: 1, highCount: 1 }, groupedIssues: [{ groupKey: 'report-fixture', severity: 'high', title: raw, messages: [raw], imageTypes: ['main_image'] }], fixSuggestions: [{ suggestionId: 'fixture', actionType: 'removeText', title: raw }], nextSuggestedAction: raw };
  const plan = { summary: { totalFixSuggestions: 1, autoFixCandidateCount: 1 }, plannedActions: [{ actionId: 'fixture', actionType: 'removeText', title: raw, target: { imageType: 'main_image' } }], warnings: [raw] };
  let writes = 0;
  window.webContents.session.webRequest.onBeforeRequest({ urls: [`${origin}/api/*`] }, (details, callback) => { const mutation = !['GET', 'HEAD'].includes(details.method); if (mutation) writes++; callback({ cancel: mutation }); });
  await window.webContents.executeJavaScript(`window.__reportDetails={fetch:window.fetch,confirm:window.confirm,submissions:0,blocked:0,dialogs:[]};window.confirm=text=>{window.__reportDetails.dialogs.push(text);return true;};window.fetch=async(input,options)=>{const state=window.__reportDetails,url=new URL(typeof input==='string'?input:input.url,location.href),method=options?.method||input?.method||'GET';if(url.origin!==location.origin)throw new Error('Report fixture forbids external traffic');if(method==='POST'&&url.pathname==='/api/generate/single-image'){const payload=JSON.parse(options.body);if(payload.confirmReal!==true||payload.mattingProvider!=='sharp')throw new Error('Fixture needs normal strict approval and local preprocessing');state.submissions++;return Response.json({report:${JSON.stringify(single)}});}if(method!=='GET'){state.blocked++;throw new Error('Report fixture forbids writes');}if(url.pathname==='/api/matting/config')return Response.json({generationDestination:{origin:'https://report-display.invalid'}});if(url.pathname===${JSON.stringify(`/api/tasks/${id}`)})return Response.json({task:${JSON.stringify({ ...task, normalizedReviewReport: review })}});if(url.pathname===${JSON.stringify(`/api/tasks/${id}/auto-fix-plan`)})return Response.json({autoFixPlan:${JSON.stringify(plan)}});return state.fetch.call(window,input,options);};document.querySelector('[data-single-report-run]').click();void 0;`);
  try {
    await wait(`document.querySelector('[data-single-report-title]')?.innerText==='Real-generation acceptance report'`);
    checks.reportSingleFixtureDynamicEnglish = await window.webContents.executeJavaScript(`document.querySelector('[data-single-report-status]').innerText.includes('Successful')&&document.body.innerText.includes('Quality score: 83 / Good')&&window.__reportDetails.submissions===1&&window.__reportDetails.dialogs[0].includes('report-display.invalid')`);
    const english = await download('[data-single-report-download]', 'single-report-ui-en.json');
    await locale('zh-CN'); await wait(`document.querySelector('[data-single-report-title]')?.innerText==='真实生图验收报告'`);
    checks.reportSingleLocaleKeepsRaw = await window.webContents.executeJavaScript(`document.querySelector('[data-single-report-status]').innerText.includes('成功')&&document.body.innerText.includes(${JSON.stringify(raw)})`);
    const chinese = await download('[data-single-report-download]', 'single-report-ui-zh.json');
    checks.reportSingleJsonUnchanged = english.equals(chinese) && JSON.parse(english).meta.modelName === raw && JSON.parse(english).meta.testMode === 'display-fixture-only';
    await locale('en-US');
    await require('./smoke-screenshot.cjs').smokeScreenshot(window, path.join(root, 'single-report-details-english.png'), { selector: '[data-single-report-title]' });
    await window.webContents.executeJavaScript(`document.querySelector('a[href="/tasks/${id}/review"]').click()`);
    await wait(`document.querySelector('[data-review-report-summary]')?.innerText.includes('High risk')`);
    checks.reportReviewDynamicEnglish = await window.webContents.executeJavaScript(`document.body.innerText.includes(${JSON.stringify(raw)})&&document.body.innerText.includes('Remove noncompliant copy')`);
    await window.webContents.executeJavaScript(`document.querySelector('[data-auto-fix-preview]').click()`);
    await wait(`!!document.querySelector('[data-auto-fix-summary]')`);
    checks.reportCorrectionDynamicEnglish = await window.webContents.executeJavaScript(`!/[\u3400-\u9fff]/.test(document.querySelector('[data-auto-fix-summary]').innerText)&&document.body.innerText.includes(${JSON.stringify(raw)})`);
    const reviewEn = await download('[data-review-report-download]', 'single-review-ui-en.json');
    await locale('zh-CN'); await wait(`document.querySelector('[data-review-report-summary]')?.innerText.includes('高风险')`);
    const reviewZh = await download('[data-review-report-download]', 'single-review-ui-zh.json');
    checks.reportReviewJsonUnchanged = reviewEn.equals(reviewZh) && JSON.parse(reviewEn).groupedIssues[0].title === raw;
    checks.reportDetailsNoNetworkWrites = writes === 0 && await window.webContents.executeJavaScript('window.__reportDetails.blocked===0&&window.__reportDetails.submissions===1');
  } finally {
    window.webContents.session.webRequest.onBeforeRequest(null);
    await window.webContents.executeJavaScript('if(window.__reportDetails){window.fetch=window.__reportDetails.fetch;window.confirm=window.__reportDetails.confirm;delete window.__reportDetails;}void 0');
  }
  checks.reportDetailsNoTaskMutation = stable((await json(`/api/tasks/${id}`)).task) === before;
  await mark('final-acceptance');
  await window.loadURL(`${origin}/final-acceptance`); await wait(`document.querySelector('[data-acceptance-workspace-status]')?.dataset.acceptanceWorkspaceStatus==='saved'`);
  // The preceding workspace tests intentionally reset their report. Prepare an
  // actual local template and wait for its own autosave before observing locale
  // changes; setup writes are not claimed as read-only language operations.
  await window.webContents.executeJavaScript(`if(!document.querySelector('[data-final-report-summary]'))document.querySelector('[data-acceptance-template]').click();void 0`);
  await wait(`!!document.querySelector('[data-final-report-summary]')&&document.querySelector('[data-acceptance-workspace-status]')?.dataset.acceptanceWorkspaceStatus==='saved'`);
  await locale('en-US'); await wait(`document.querySelector('[data-final-report-summary]')?.innerText.includes('Overall status')`);
  checks.reportFinalDynamicEnglish = await window.webContents.executeJavaScript(`(()=>{const options=Array.from(document.querySelectorAll('option[value="templateAudit"]'));return document.querySelector('[data-final-report-summary]').innerText.includes('Readiness level')&&options.length>0&&options.every(el=>el.innerText==='Template acceptance');})()`);
  await window.webContents.executeJavaScript('window.__finalReportProbe={fetch:window.fetch,writes:0};window.fetch=(input,options)=>{const url=new URL(typeof input==="string"?input:input.url,location.href);if(url.origin!==location.origin)throw new Error("Final report test forbids external traffic");if((options?.method||input?.method||"GET")!=="GET"){window.__finalReportProbe.writes++;throw new Error("Final report test forbids writes");}return window.__finalReportProbe.fetch.call(window,input,options);};void 0');
  try {
    const english = await download('[data-acceptance-json]', 'final-report-ui-en.json');
    await locale('zh-CN'); await wait(`document.querySelector('[data-final-report-summary]')?.innerText.includes('总体状态')`);
    const chinese = await download('[data-acceptance-json]', 'final-report-ui-zh.json');
    checks.reportFinalLocaleJsonUnchanged = english.equals(chinese);
    checks.reportFinalOptionsUnchanged = await window.webContents.executeJavaScript(`(()=>{const modules=Array.from(document.querySelectorAll('option[value="templateAudit"]')),statuses=Array.from(document.querySelectorAll('option[value="wontFix"]'));return modules.length>0&&statuses.length>0&&modules.every(el=>el.value==='templateAudit'&&el.innerText==='模板验收')&&statuses.every(el=>el.value==='wontFix'&&el.innerText==='暂不修复');})()`);
    await locale('en-US'); await wait(`document.querySelector('[data-final-report-summary]')?.innerText.includes('Overall status')`);
    checks.reportFinalLanguageNoWrites = await window.webContents.executeJavaScript('window.__finalReportProbe.writes===0');
    await require('./smoke-screenshot.cjs').smokeScreenshot(window, path.join(root, 'final-report-details-english.png'), { selector: '[data-final-report-summary]' });
  } finally { await window.webContents.executeJavaScript('window.fetch=window.__finalReportProbe.fetch;delete window.__finalReportProbe;void 0'); }
  await locale('zh-CN'); await mark('completed');
  return checks;
}
module.exports = { reportDetailsI18nSmoke };
