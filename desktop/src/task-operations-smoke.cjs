const fs = require('node:fs/promises');
const path = require('node:path');
async function waitFor(window, expression) {
  for (let i = 0; i < 150; i++) { if (await window.webContents.executeJavaScript(expression)) return true; await new Promise((resolve) => setTimeout(resolve, 100)); }
  throw new Error(`任务操作验收超时：${expression}`);
}
async function locale(window, value) {
  await window.webContents.executeJavaScript(`(() => { const select=document.querySelector('select[aria-label="Interface language / 界面语言"]'); select.value=${JSON.stringify(value)}; select.dispatchEvent(new Event('change',{bubbles:true})); })()`);
  await waitFor(window, `document.documentElement.lang===${JSON.stringify(value)}`);
}
async function click(window, label) {
  await window.webContents.executeJavaScript(`(() => { const button=Array.from(document.querySelectorAll('button')).find(node=>node.innerText===${JSON.stringify(label)}); if(!button || button.disabled) throw new Error('Button unavailable: '+${JSON.stringify(label)}); button.click(); })()`);
}
async function taskOperationsSmoke({ window, origin, dataRoot, requestApi }) {
  const checks = {};
  const json = async (url, method = 'GET', body) => { const response = await requestApi(url, { method, headers: { 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) }); const result = await response.json(); if (!response.ok) throw new Error(`${method} ${url}: ${result.error || response.status}`); return result; };
  await window.loadURL(`${origin}/workflow-templates`); await locale(window, 'en-US');
  await waitFor(window, `document.querySelector('[data-template-form]')?.disabled===false && document.querySelector('h1')?.innerText==='Workflow templates'`);
  await window.webContents.executeJavaScript(`(() => { const fields=document.querySelector('[data-template-form]'); for(const [label,value] of [['Name','工作流-016-原文'],['Description','只保存在本机的模板说明-原文']]) { const node=Array.from(fields.querySelectorAll('label')).find(item=>item.innerText.startsWith(label))?.querySelector('input'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(node,value); node.dispatchEvent(new Event('input',{bubbles:true})); } })()`);
  await locale(window, 'zh-CN'); await locale(window, 'en-US');
  checks.templateLocaleDraftPreserved = await window.webContents.executeJavaScript(`Array.from(document.querySelectorAll('input')).some(node=>node.value==='工作流-016-原文') && document.querySelector('textarea').value==='amazon,US,English,general' && document.querySelector('[data-template-form] select').value==='mock'`);
  await window.webContents.executeJavaScript('document.querySelector("[data-template-save]").click()');
  await waitFor(window, `document.querySelector('[data-template-notice]')?.innerText.includes('Saved template: 工作流-016-原文') && !document.querySelector('[data-template-refresh]').disabled`);
  const created = (await json('/api/workflow-templates')).templates.find(item => item.name === '工作流-016-原文');
  checks.templateCreatedOriginal = Boolean(created && created.description === '只保存在本机的模板说明-原文' && created.defaultTargets[0].platformId === 'amazon' && created.providers.visionProvider === 'mock');
  await window.webContents.executeJavaScript(`document.querySelector('[data-template-id="${created.id}"]').click()`); await click(window, 'Edit');
  await window.webContents.executeJavaScript(`(() => { const node=document.querySelector('[data-template-form] input'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(node,'工作流-016-修改原文'); node.dispatchEvent(new Event('input',{bubbles:true})); window.__templateDialogs=[]; window.confirm=message=>{window.__templateDialogs.push(message);return false;}; })()`);
  await window.webContents.executeJavaScript('document.querySelector("[data-template-save]").click()');
  await waitFor(window, 'window.__templateDialogs.length===1');
  checks.templateCancelledEditSafe = (await json(`/api/workflow-templates/${created.id}`)).template.name === created.name;
  await window.webContents.executeJavaScript('window.confirm=message=>{window.__templateDialogs.push(message);return true;}; void 0');
  await window.webContents.executeJavaScript('document.querySelector("[data-template-save]").click()');
  await waitFor(window, `document.querySelector('[data-template-notice]')?.innerText.includes('Saved template: 工作流-016-修改原文') && !document.querySelector('[data-template-refresh]').disabled`);
  checks.templateEditedOriginal = (await json(`/api/workflow-templates/${created.id}`)).template.name === '工作流-016-修改原文';
  await window.webContents.executeJavaScript('window.confirm=message=>{window.__templateDialogs.push(message);return false;}; void 0');
  let deleteCalls = 0;
  window.webContents.session.webRequest.onBeforeRequest({ urls: [`${origin}/api/workflow-templates/${created.id}`] }, (details, callback) => { if (details.method === 'DELETE') deleteCalls++; callback({}); });
  try { await window.webContents.executeJavaScript('document.querySelector("[data-template-delete]").click()'); await waitFor(window, 'window.__templateDialogs.length===3'); checks.templateCancelledDeleteSafe = deleteCalls === 0 && (await json('/api/workflow-templates')).templates.some(item => item.id === created.id); }
  finally { window.webContents.session.webRequest.onBeforeRequest(null); }
  await window.webContents.executeJavaScript('window.confirm=message=>{window.__templateDialogs.push(message);return true;}; void 0');
  await window.webContents.executeJavaScript('document.querySelector("[data-template-delete]").click()');
  await waitFor(window, `document.querySelector('[data-template-notice]')?.innerText.includes('Deleted template: 工作流-016-修改原文') && !document.querySelector('[data-template-refresh]').disabled`);
  checks.templateConfirmedDelete = !(await json('/api/workflow-templates')).templates.some(item => item.id === created.id);
  const sample = await require('sharp')({ create: { width: 64, height: 64, channels: 3, background: '#2f5c89' } }).png().toBuffer();
  const upload = async (name) => { const body = new FormData(); body.append('images', new Blob([sample], { type: 'image/png' }), `${name}.png`); const result = await (await requestApi('/api/tasks/upload', { method: 'POST', body })).json(); return result.task; };
  const original = await upload('流程-A-016'), other = await upload('流程-B-016'), id = original.id;
  const recognized = (await json(`/api/tasks/${id}/recognize`, 'POST', {})).task;
  if (recognized.recognitionMeta?.provider !== 'mock') throw new Error('Smoke must not use a real model');
  await json(`/api/tasks/${id}/product`, 'PATCH', { productInfo: { ...recognized.productInfo, sku: 'FLOW-016-原文', name: '商品-016-原文' } });
  for (const page of ['rules', 'generate', 'review', 'export']) {
    window.webContents.session.webRequest.onBeforeRequest({ urls: [`${origin}/api/tasks/${id}`] }, (_details, callback) => callback({ cancel: true }));
    try { await window.loadURL(`${origin}/tasks/${id}/${page}`); await waitFor(window, 'Boolean(document.querySelector("[data-task-load-failure] [role=alert]")) && Boolean(document.querySelector("[data-task-retry]"))'); }
    finally { window.webContents.session.webRequest.onBeforeRequest(null); }
    await window.webContents.executeJavaScript('document.querySelector("[data-task-retry]").click()');
    checks[`taskReadRecovered${page[0].toUpperCase() + page.slice(1)}`] = await waitFor(window, 'Boolean(document.querySelector("h1")) && !document.querySelector("[data-task-load-failure]")');
  }
  // A delayed read for task A must not replace B after an in-app route change.
  let releaseRead, readCompleted;
  const completed = new Promise(resolve => { readCompleted = resolve; });
  window.webContents.session.webRequest.onCompleted({ urls: [`${origin}/api/tasks/${id}`] }, () => readCompleted());
  window.webContents.session.webRequest.onBeforeRequest({ urls: [`${origin}/api/tasks/${id}`] }, (_details, callback) => { let released = false; releaseRead = () => { if (released) return; released = true; callback({}); }; });
  try {
    await window.webContents.executeJavaScript(`history.pushState({},'', '/tasks/${id}/export'); window.dispatchEvent(new PopStateEvent('popstate')); void 0`);
    // Current route is already A: first visit B, then A to force a fresh request.
    await window.webContents.executeJavaScript(`history.pushState({},'', '/tasks/${other.id}/export'); window.dispatchEvent(new PopStateEvent('popstate')); void 0`);
    await waitFor(window, `location.pathname==='/tasks/${other.id}/export' && Boolean(document.querySelector('h1')) && !document.body.innerText.includes('FLOW-016-原文')`);
    await window.webContents.executeJavaScript(`history.pushState({},'', '/tasks/${id}/export'); window.dispatchEvent(new PopStateEvent('popstate')); void 0`);
    for (let i = 0; !releaseRead && i < 100; i++) await new Promise(resolve => setTimeout(resolve, 30));
    if (!releaseRead) throw new Error('Delayed task read was not intercepted');
    await window.webContents.executeJavaScript(`history.pushState({},'', '/tasks/${other.id}/export'); window.dispatchEvent(new PopStateEvent('popstate')); void 0`);
    await waitFor(window, `location.pathname==='/tasks/${other.id}/export' && Boolean(document.querySelector('h1')) && !document.body.innerText.includes('FLOW-016-原文')`);
    releaseRead();
    await Promise.race([completed, new Promise((_, reject) => setTimeout(() => reject(new Error('Released task read did not complete')), 10000))]);
    await new Promise(resolve => setTimeout(resolve, 300));
    checks.taskLateReadIgnored = await window.webContents.executeJavaScript(`location.pathname==='/tasks/${other.id}/export' && !document.body.innerText.includes('FLOW-016-原文') && !document.querySelector('[data-task-load-failure]')`);
  } finally { if (releaseRead) releaseRead(); window.webContents.session.webRequest.onBeforeRequest(null); window.webContents.session.webRequest.onCompleted(null); }
  window.webContents.session.webRequest.onBeforeRequest({ urls: [`${origin}/api/tasks/platform-rules`] }, (_details, callback) => callback({ cancel: true }));
  try { await window.loadURL(`${origin}/tasks/${id}/rules`); await waitFor(window, 'Boolean(document.querySelector("[data-rules-retry]"))'); }
  finally { window.webContents.session.webRequest.onBeforeRequest(null); }
  await locale(window, 'en-US'); await window.webContents.executeJavaScript('document.querySelector("[data-rules-retry]").click()');
  checks.platformConfigReadRecovered = await waitFor(window, 'Boolean(document.querySelector("[data-rules-save]")) && !document.querySelector("[data-rules-save]").disabled');
  await click(window, 'Amazon + Temu'); await locale(window, 'zh-CN'); await locale(window, 'en-US');
  checks.platformDraftPreserved = await window.webContents.executeJavaScript(`document.querySelector('[data-target-site="amazon"]')?.value==='US' && document.querySelector('[data-target-language="temu"]')?.value==='English'`);
  await window.webContents.executeJavaScript('document.querySelector("[data-rules-save]").click()'); await waitFor(window, 'location.pathname.endsWith("/plans")');
  const targets = (await json(`/api/tasks/${id}`)).task.targets;
  checks.platformUiSavedOriginal = targets.length === 2 && targets.some(item => item.platformId === 'amazon' && item.language === 'English') && targets.some(item => item.platformId === 'temu');
  await json(`/api/tasks/${id}/image-plans`, 'POST', {});
  await json(`/api/tasks/${id}/generate`, 'POST', {}); await json(`/api/tasks/${id}/review`, 'POST', { mode: 'mock' });
  await window.loadURL(`${origin}/tasks/${id}/export`);
  await waitFor(window, `document.body.innerText.includes('FLOW-016-原文') && document.querySelector('a[href*="/export?targetId="]')`);
  checks.englishTaskStepNavigation = await window.webContents.executeJavaScript(`Array.from(document.querySelectorAll('[data-task-step-nav] a')).map(node=>node.innerText).join('|')==='Product information|Platform rules|Image plans|Generation preview|Compliance review|Export'`);
  checks.englishTaskProgressFits = await window.webContents.executeJavaScript(`Array.from(document.querySelectorAll('[data-task-progress-grid] > div')).every(node=>node.scrollWidth<=node.clientWidth+1)`);
  const allUrl = await window.webContents.executeJavaScript(`Array.from(document.querySelectorAll('a')).find(node=>node.getAttribute('href')==='/api/tasks/${id}/export')?.getAttribute('href')`);
  if (!allUrl) throw new Error('Export page did not expose its all-platform ZIP link');
  const zipped = await requestApi(allUrl), bytes = Buffer.from(await zipped.arrayBuffer());
  const archive = new (require('adm-zip'))(bytes), metadata = JSON.parse(archive.readAsText('metadata.json'));
  const imageEntries = archive.getEntries().filter(entry => /\.(?:png|jpe?g|webp)$/i.test(entry.entryName));
  checks.exportUiZip = zipped.ok && imageEntries.length === 16 && metadata.generatedImages.length === 16 && metadata.targets.length === 2 && metadata.productInfoConfirmed.sku === 'FLOW-016-原文' && await window.webContents.executeJavaScript(`document.body.innerText.includes('mock previews') && document.body.innerText.includes('FLOW-016-原文')`);
  await require('./smoke-screenshot.cjs').smokeScreenshot(window, path.join(dataRoot, 'task-export-english.png'));
  await window.loadURL(`${origin}/legacy-dashboard`); checks.englishLegacyDashboard = await waitFor(window, `document.querySelector('h1')?.innerText==='Home' && document.body.innerText.includes('FLOW-016-原文')`);
  await locale(window, 'zh-CN');
  return checks;
}
module.exports = { taskOperationsSmoke };
