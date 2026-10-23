const path = require('node:path');
async function wait(window, expression) {
  for (let i = 0; i < 200; i++) { if (await window.webContents.executeJavaScript(expression)) return true; await new Promise(resolve => setTimeout(resolve, 100)); }
  throw new Error(`Acceptance persistence smoke timed out: ${expression}`);
}
const status = value => `document.querySelector('[data-acceptance-workspace-status]')?.getAttribute('data-acceptance-workspace-status')===${JSON.stringify(value)}`;
async function setInput(window, selector, value) {
  await window.webContents.executeJavaScript(`(() => {const node=document.querySelector(${JSON.stringify(selector)});if(!node)throw new Error('Missing acceptance input');Object.getOwnPropertyDescriptor(node instanceof HTMLTextAreaElement?HTMLTextAreaElement.prototype:HTMLInputElement.prototype,'value').set.call(node,${JSON.stringify(value)});node.dispatchEvent(new Event('input',{bubbles:true}));})()`);
}
async function click(window, label) {
  await window.webContents.executeJavaScript(`(() => {const node=Array.from(document.querySelectorAll('button')).find(item=>item.innerText===${JSON.stringify(label)});if(!node||node.matches(':disabled'))throw new Error('Acceptance button unavailable');node.click();})()`);
}
async function acceptanceWorkspaceSmoke({ window, origin, dataRoot, requestApi, restartService }) {
  const checks = {}, route = '/api/final-acceptance/workspace';
  const json = async (url, body) => (await requestApi(url, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {})).json();
  const stableTasks = async () => JSON.stringify((await json('/api/tasks')).tasks.map(({ id, status, updatedAt }) => ({ id, status, updatedAt })).sort((a,b)=>a.id.localeCompare(b.id)));
  const beforeTasks = await stableTasks(); let paidPosts = 0;
  window.webContents.session.webRequest.onBeforeRequest({ urls: ['http://127.0.0.1/*'] }, (details, callback) => { if (new URL(details.url).pathname==='/api/final-acceptance/real-api/run') { paidPosts++; callback({ cancel: true }); } else callback({ cancel: false }); });
  try {
    await window.loadURL(`${origin}/final-acceptance`); await wait(window, status('saved'));
    const previousTemplate = await json(route);
    await window.webContents.executeJavaScript('window.confirm=()=>true;document.querySelector("[data-acceptance-template]").click();void 0');
    for (let i=0;i<200;i++) { const current=await json(route); if(current.revision>previousTemplate.revision && current.document?.report?.meta?.generatedAt!==previousTemplate.document?.report?.meta?.generatedAt) break; await new Promise(resolve=>setTimeout(resolve,100)); }
    await wait(window, `document.querySelector('[data-acceptance-manual]') && !document.querySelector('[data-acceptance-template]').matches(':disabled') && ${status('saved')}`);
    await setInput(window, 'input[placeholder="问题标题"]', '持久化问题-018-原文'); await click(window, '新增问题');
    await wait(window, `Boolean(document.querySelector('[data-acceptance-delete]'))`);
    await setInput(window, '[data-acceptance-manual] input[placeholder="人工结论 / 备注"]', '袖口边缘需人工修正-018');
    await window.webContents.executeJavaScript(`(() => {const select=document.querySelector('[data-acceptance-manual] select');select.value='failed';select.dispatchEvent(new Event('change',{bubbles:true}));})()`);
    await setInput(window, 'input[placeholder="问题标题"]', '尚未添加的问题草稿-018');
    await wait(window, status('saved'));
    const saved = await json(route);
    checks.acceptanceDurableManualAndDraft = saved.document.report.issueLogs.some(issue=>issue.title==='持久化问题-018-原文') && saved.document.report.skuAcceptance[0].manualAcceptance.status==='failed' && saved.document.report.skuAcceptance[0].manualAcceptance.notes==='袖口边缘需人工修正-018' && saved.document.issueForm.title==='尚未添加的问题草稿-018';
    await window.webContents.executeJavaScript(`document.querySelectorAll('[data-acceptance-approval]').forEach(node=>node.click());void 0`);
    await window.loadURL(`${origin}/final-acceptance`); await wait(window, status('saved'));
    checks.acceptanceRefreshRestoresDraft = await window.webContents.executeJavaScript(`document.querySelector('input[placeholder="问题标题"]').value==='尚未添加的问题草稿-018' && document.querySelector('[data-acceptance-manual] select').value==='failed' && document.querySelector('[data-acceptance-manual] input[placeholder="人工结论 / 备注"]').value==='袖口边缘需人工修正-018'`);
    checks.acceptanceApprovalsNotRestored = await window.webContents.executeJavaScript(`Array.from(document.querySelectorAll('[data-acceptance-approval]')).length===3 && Array.from(document.querySelectorAll('[data-acceptance-approval]')).every(node=>!node.checked)`);
    await window.webContents.executeJavaScript(`window.__acceptanceFetch=window.fetch;window.__loseAcceptanceAck=true;window.fetch=async(input,options)=>{const response=await window.__acceptanceFetch(input,options);if(new URL(String(input),location.href).pathname===${JSON.stringify(route)}&&options?.method==='POST'&&response.ok&&window.__loseAcceptanceAck){window.__loseAcceptanceAck=false;throw new Error('fixture acknowledgement lost');}return response;};void 0`);
    await setInput(window, 'input[placeholder="问题标题"]', '回执丢失仍需恢复-018'); await wait(window, status('error'));
    // Simulate the user's explicit choice to reload despite the unsaved warning.
    window.webContents.once('will-prevent-unload', event => event.preventDefault());
    await window.loadURL(`${origin}/final-acceptance`); await wait(window, status('saved'));
    checks.acceptanceLostAckRefreshRecovery = (await json(route)).document.issueForm.title==='回执丢失仍需恢复-018' && await window.webContents.executeJavaScript(`document.querySelector('input[placeholder="问题标题"]').value==='回执丢失仍需恢复-018'`);
    origin = await restartService(); await window.loadURL(`${origin}/final-acceptance`); await wait(window, status('saved'));
    checks.acceptanceServiceRestartRecovery = (await json(route)).document.report.issueLogs.some(issue=>issue.title==='持久化问题-018-原文') && await window.webContents.executeJavaScript(`document.querySelector('[data-acceptance-manual] select').value==='failed'`);
    const other = await json(route); other.document.issueForm.title='另一窗口已保存-018';
    const changed = await json(route, { expectedActorId: other.actorId, generation: other.generation, revision: other.revision, requestId: require('node:crypto').randomUUID(), document: other.document });
    await setInput(window, 'input[placeholder="问题标题"]', '本页冲突不得覆盖-018'); await wait(window, status('conflict'));
    checks.acceptanceWindowConflictPreserved = (await json(route)).revision===changed.revision && (await json(route)).document.issueForm.title==='另一窗口已保存-018' && await window.webContents.executeJavaScript(`document.querySelector('input[placeholder="问题标题"]').value==='本页冲突不得覆盖-018'`);
    await window.webContents.executeJavaScript('window.confirm=()=>true;document.querySelector("[data-acceptance-reload]").click();void 0'); await wait(window, status('saved'));
    await window.webContents.executeJavaScript(`(() => {const select=document.querySelector('select[aria-label="Interface language / 界面语言"]');select.value='en-US';select.dispatchEvent(new Event('change',{bubbles:true}));})()`);
    await wait(window, `document.querySelector('[data-acceptance-workspace-status]')?.innerText.includes('Saved to this member')`);
    await require('./smoke-screenshot.cjs').smokeScreenshot(window, path.join(dataRoot, 'acceptance-workspace-english.png'), { selector: '[data-acceptance-workspace-status]' });
    const beforeReset = JSON.stringify(await json(route));
    await window.webContents.executeJavaScript('window.confirm=()=>false;document.querySelector("[data-acceptance-reset]").click();void 0');
    checks.acceptanceCancelledResetNoWrite = JSON.stringify(await json(route))===beforeReset;
    await window.webContents.executeJavaScript('window.confirm=()=>true;document.querySelector("[data-acceptance-reset]").click();void 0');
    await wait(window, `!document.querySelector('[data-acceptance-delete]') && ${status('saved')}`);
    checks.acceptanceConfirmedResetOnlyWorkspace = (await json(route)).document===null && await stableTasks()===beforeTasks;
    checks.acceptancePersistenceNoPaidRequests = paidPosts===0;
  } finally { window.webContents.session.webRequest.onBeforeRequest(null); }
  return checks;
}
module.exports = { acceptanceWorkspaceSmoke };
