const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
async function waitFor(window, expression) {
  for (let i = 0; i < 120; i++) { if (await window.webContents.executeJavaScript(expression)) return true; await new Promise((resolve) => setTimeout(resolve, 100)); }
  throw new Error(`图片工作流验收超时：${expression}`);
}
async function language(window, locale) {
  await window.webContents.executeJavaScript(`(() => { const select = document.querySelector('select[aria-label="Interface language / 界面语言"]'); select.value = ${JSON.stringify(locale)}; select.dispatchEvent(new Event('change',{bubbles:true})); })()`);
  await waitFor(window, `document.documentElement.lang === ${JSON.stringify(locale)}`);
}
async function click(window, text) {
  await window.webContents.executeJavaScript(`(() => { const node = Array.from(document.querySelectorAll('button')).find((item)=>item.innerText===${JSON.stringify(text)}); if (!node || node.disabled) throw new Error('Button unavailable: ' + ${JSON.stringify(text)}); node.click(); })()`);
}
async function imageWorkflowSmoke({ window, origin, dataRoot, requestApi }) {
  const checks = {};
  const json = async (url, method = 'GET', body) => (await requestApi(url, { method, headers: { 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) })).json();
  const sample = await require('sharp')(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96"><rect width="96" height="96" fill="white"/><rect x="24" y="16" width="48" height="64" rx="6" fill="#2f5c89"/></svg>')).png().toBuffer();
  const upload = new FormData(); upload.append('images', new Blob([sample], { type: 'image/png' }), '原文服装样本-015.png');
  const uploaded = await (await requestApi('/api/tasks/upload', { method: 'POST', body: upload })).json(), id = uploaded.task.id;
  const task = async () => (await json(`/api/tasks/${encodeURIComponent(id)}`)).task;
  const original = uploaded.task.sourceImages[0], digest = (data) => createHash('sha256').update(data).digest('hex');
  const originalHash = digest(Buffer.from(await (await requestApi(original.previewUrl || original.url)).arrayBuffer()));
  await window.loadURL(`${origin}/matting`);
  await waitFor(window, `Boolean(document.querySelector('select option[value="${id}"]')) && !document.querySelector('[data-matting-refresh]')?.disabled`);
  await language(window, 'en-US');
  await window.webContents.executeJavaScript(`(() => { const select = Array.from(document.querySelectorAll('select')).find((node)=>node.querySelector('option[value="${id}"]')); select.value=${JSON.stringify(id)}; select.dispatchEvent(new Event('change',{bubbles:true})); })()`);
  checks.imageMattingTaskEnvelope = await waitFor(window, `document.querySelector('[data-matting-sharp]')?.disabled === false && document.body.innerText.includes('原文服装样本-015.png')`);
  await window.webContents.executeJavaScript('document.querySelector("[data-matting-sharp]").click()');
  checks.imageLocalSharpResult = await waitFor(window, `Boolean(document.querySelector('[data-matting-adopt]')) && document.body.innerText.includes('Quality score:')`);
  await window.webContents.executeJavaScript('window.__adoptDialogs=[]; window.confirm=(message)=>{window.__adoptDialogs.push(message);return false;}; void 0');
  await window.webContents.executeJavaScript('document.querySelector("[data-matting-adopt]").click()');
  checks.imageAdoptionCancellation = !(await task()).mattingSelection && await window.webContents.executeJavaScript('window.__adoptDialogs.length===1');
  await window.webContents.executeJavaScript('window.confirm=(message)=>{window.__adoptDialogs.push(message);return true;}; void 0');
  await window.webContents.executeJavaScript('document.querySelector("[data-matting-adopt]").click()');
  await waitFor(window, 'Boolean(document.querySelector("[data-matting-adopted] a"))');
  const adopted = (await task()).mattingSelection, adoptedBytes = Buffer.from(await (await requestApi(adopted.previewUrl)).arrayBuffer());
  checks.imageAdoptionPng = adopted.originalPreserved === true && adoptedBytes.subarray(1, 4).toString() === 'PNG' && originalHash === digest(Buffer.from(await (await requestApi(original.previewUrl || original.url)).arrayBuffer()));
  await window.loadURL(`${origin}/matting`);
  await waitFor(window, `Boolean(document.querySelector('select option[value="${id}"]')) && !document.querySelector('[data-matting-refresh]')?.disabled`);
  await window.webContents.executeJavaScript(`(() => { const select = Array.from(document.querySelectorAll('select')).find((node)=>node.querySelector('option[value="${id}"]')); select.value=${JSON.stringify(id)}; select.dispatchEvent(new Event('change',{bubbles:true})); })()`);
  checks.imageAdoptionReloaded = await waitFor(window, `document.querySelector('[data-matting-adopted] a')?.getAttribute('href') === ${JSON.stringify(adopted.previewUrl)}`);
  try { const preview = await window.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true }); if (!preview.isEmpty()) await fs.writeFile(path.join(dataRoot, 'matting-workflow-english.png'), preview.toPNG()); } catch { /* Optional visual artifact. */ }
  const recognized = await json(`/api/tasks/${id}/recognize`, 'POST', {});
  if (recognized.task.recognitionMeta?.provider !== 'mock') throw new Error('Smoke recognition must use the mock provider');
  window.webContents.session.webRequest.onBeforeRequest({ urls: [`${origin}/api/tasks/${id}`] }, (_details, callback) => callback({ cancel: true }));
  try { await window.loadURL(`${origin}/tasks/${id}/product`); await waitFor(window, 'Boolean(document.querySelector("[data-product-retry]")) && Boolean(document.querySelector("[role=alert]"))'); }
  finally { window.webContents.session.webRequest.onBeforeRequest(null); }
  await window.webContents.executeJavaScript('document.querySelector("[data-product-retry]").click()');
  checks.imageProductLoadRecovered = await waitFor(window, 'document.querySelector("h1")?.innerText === "Confirm product information" && !document.querySelector("[data-product-retry]")');
  await window.webContents.executeJavaScript(`(() => {
    for (const [label,value] of [['Product name','服饰-人工确认标题-015'],['SKU','FLOW-015-原文']]) {
      const input=Array.from(document.querySelectorAll('label')).find((node)=>node.innerText.startsWith(label))?.querySelector('input');
      if (!input) throw new Error('Product input missing: '+label);
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,value); input.dispatchEvent(new Event('input',{bubbles:true}));
    }
  })()`);
  await language(window, 'zh-CN'); await language(window, 'en-US');
  checks.imageProductDraftPreserved = await window.webContents.executeJavaScript(`Array.from(document.querySelectorAll('input')).some((node)=>node.value==='服饰-人工确认标题-015') && Array.from(document.querySelectorAll('input')).some((node)=>node.value==='FLOW-015-原文')`);
  await window.webContents.executeJavaScript('window.confirm=()=>true; void 0');
  await click(window, 'Save & continue');
  await waitFor(window, `location.pathname.endsWith('/rules') || Array.from(document.querySelectorAll('button')).some((node)=>node.innerText==='I have reviewed this; continue saving')`);
  if (await window.webContents.executeJavaScript(`!location.pathname.endsWith('/rules')`)) await click(window, 'I have reviewed this; continue saving');
  await waitFor(window, `location.pathname.endsWith('/rules')`);
  const confirmed = await task();
  checks.imageProductConfirmedOriginal = confirmed.productInfoConfirmed?.name === '服饰-人工确认标题-015' && confirmed.productInfoConfirmed?.sku === 'FLOW-015-原文' && confirmed.status === 'confirmed';
  await json(`/api/tasks/${id}/platforms`, 'POST', { targets: [{ platformId: 'amazon', site: 'US', language: 'English', categoryId: 'generic_ecommerce' }] });
  await window.loadURL(`${origin}/tasks/${id}/plans`);
  await waitFor(window, 'document.querySelector("h1")?.innerText === "Image plans"'); await click(window, 'Create image plans');
  await waitFor(window, 'Boolean(document.querySelector("[data-plan-title]"))');
  const planned = await task(), plan = planned.imagePlans.find((item) => item.type === 'main_image'), beforeSize = plan.size;
  await window.webContents.executeJavaScript(`(() => { const input=document.querySelector('[data-plan-title="${plan.id}"]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'主图-手工文案-015'); input.dispatchEvent(new Event('input',{bubbles:true})); })()`);
  await language(window, 'zh-CN'); await language(window, 'en-US');
  checks.imagePlanDraftPreserved = await window.webContents.executeJavaScript(`document.querySelector('[data-plan-title="${plan.id}"]')?.value === '主图-手工文案-015' && Boolean(document.querySelector('option[value="main_image"]'))`);
  await window.webContents.executeJavaScript(`Array.from(document.querySelector('[data-plan-title="${plan.id}"]').closest('section').querySelectorAll('button')).find((node)=>node.innerText==='Save plan changes').click()`);
  await waitFor(window, `document.querySelector('[data-plan-title="${plan.id}"]')?.closest('section').innerText.includes('This plan was edited manually')`);
  const savedPlan = (await task()).imagePlans.find((item) => item.id === plan.id);
  checks.imagePlanSavedOriginal = savedPlan.title === '主图-手工文案-015' && savedPlan.type === 'main_image' && savedPlan.size === beforeSize;
  let generationPosts = 0;
  window.webContents.session.webRequest.onBeforeRequest({ urls: [`${origin}/api/generate/single-image`] }, (_details, callback) => { generationPosts++; callback({ cancel: true }); });
  try {
    await window.webContents.executeJavaScript('window.__generationDialogs=[]; window.confirm=(message)=>{window.__generationDialogs.push(message);return false;}; void 0');
    await window.webContents.executeJavaScript('document.querySelector("[data-single-real]").click()');
    await waitFor(window, 'window.__generationDialogs.length===1 && !document.querySelector("[data-single-real]").disabled');
    checks.imageGenerationCancelledBeforePost = generationPosts === 0 && !(await task()).generatedImages.length && await window.webContents.executeJavaScript(`window.__generationDialogs[0].includes('Send images and product details') && window.__generationDialogs[0].includes('failed calls')`);
  } finally { window.webContents.session.webRequest.onBeforeRequest(null); }
  await language(window, 'zh-CN');
  return checks;
}
module.exports = { imageWorkflowSmoke };
