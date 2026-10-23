const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');

async function skuResultsResumeSmoke({ window, origin, dataRoot, requestApi }) {
  const root = await fs.realpath(dataRoot), checks = {};
  if (!root.split(path.sep).includes('.smoke-data') || path.basename(root) !== 'workspace') throw new Error('SKU tests need an owned smoke workspace');
  async function wait(expression) {
    for (let i = 0; i < 250; i++) { if (await window.webContents.executeJavaScript(expression)) return; await new Promise(resolve => setTimeout(resolve, 50)); }
    throw new Error(`SKU results/recovery timed out: ${expression}`);
  }
  const mark = phase => fs.writeFile(path.join(root, 'sku-results-resume-progress.json'), JSON.stringify({ phase, at: new Date().toISOString(), checks }));
  async function select(selector, value) { await window.webContents.executeJavaScript(`(()=>{const el=document.querySelector(${JSON.stringify(selector)});el.value=${JSON.stringify(value)};el.dispatchEvent(new Event('change',{bubbles:true}));})()`); }
  async function search(value) { await window.webContents.executeJavaScript(`(()=>{const el=document.querySelector('[data-sku-result-search]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el,${JSON.stringify(value)});el.dispatchEvent(new Event('input',{bubbles:true}));})()`); }
  await mark('input');
  const png = await require('sharp')({ create: { width: 64, height: 32, channels: 3, background: '#49727f' } }).png().toBuffer();
  const inputs = Array.from({ length: 35 }, (_, index) => ({ sku: index === 0 ? '=1+1' : index === 1 ? '已完成' : `SKU-${String(index + 1).padStart(3, '0')}`, bytes: (index < 30 ? png : Buffer.from('corrupt fixture only')).toString('base64') }));
  await window.loadURL(`${origin}/workbench/sku-pack`);
  await wait(`!!document.querySelector('input[webkitdirectory]')`);
  await window.webContents.executeJavaScript(`window.__skuTable={fetch:window.fetch,result:null,posts:0};window.fetch=async(input,options)=>{const state=window.__skuTable,url=new URL(typeof input==='string'?input:input.url,location.href);if(url.origin!==location.origin)throw new Error('SKU fixture forbids external calls');if(options?.method==='POST'){if(url.pathname!=='/api/workbench/sku-packs')throw new Error('SKU fixture forbids other writes');const config=JSON.parse(options.body.get('options'));if(config.generateSquare||config.matteImages)throw new Error('SKU table fixture must remain small and local');state.posts++;}const response=await state.fetch.call(window,input,options);if(options?.method==='POST')state.result=await response.clone().json();return response;};(()=>{const selection=new DataTransfer();for(const source of ${JSON.stringify(inputs)}){const file=new File([Uint8Array.from(atob(source.bytes),char=>char.charCodeAt(0))],'main.png',{type:'image/png'});Object.defineProperty(file,'webkitRelativePath',{value:'fixture/'+source.sku+'/main.png'});selection.items.add(file);}const input=document.querySelector('input[webkitdirectory]');input.files=selection.files;input.dispatchEvent(new Event('change',{bubbles:true}));Array.from(document.querySelectorAll('label')).find(el=>el.innerText.includes('额外生成方图')).querySelector('input').click();})();void 0;`);
  let result;
  try {
    await window.webContents.executeJavaScript(`document.querySelector('[data-sku-pack-submit]').click()`);
    await wait(`window.__skuTable.result?.status==='completed_with_errors'&&document.querySelectorAll('[data-sku-result-row]').length===25`);
    result = await window.webContents.executeJavaScript('window.__skuTable.result');
    const resultManifest = path.join(root, 'outputs', 'workbench', result.id, 'manifest.json'), beforeTable = await fs.readFile(resultManifest);
    checks.skuTableRealMixedResult = result.summary.skuCount === 35 && result.summary.outputCount === 30 && result.summary.failedCount === 5;
    const first = await window.webContents.executeJavaScript(`Array.from(document.querySelectorAll('[data-sku-result-row]')).map(el=>el.dataset.skuResultRow)`);
    await window.webContents.executeJavaScript(`document.querySelector('[data-sku-result-next]').click()`); await wait(`document.querySelectorAll('[data-sku-result-row]').length===10`);
    const second = await window.webContents.executeJavaScript(`Array.from(document.querySelectorAll('[data-sku-result-row]')).map(el=>el.dataset.skuResultRow)`);
    checks.skuTableBoundedPages = first.length === 25 && second.length === 10 && new Set([...first, ...second]).size === 35;
    await select('[data-sku-result-status]', 'completed'); await wait(`document.querySelector('[data-sku-result-pagination]').innerText.includes('30')&&document.querySelectorAll('[data-sku-result-row]').length===25`);
    await window.webContents.executeJavaScript(`document.querySelector('[data-sku-result-next]').click()`); await wait(`document.querySelectorAll('[data-sku-result-row]').length===5`);
    checks.skuTableStatusFilter = true;
    const destination = path.join(root, 'sku-filtered-results-ui.csv');
    const downloaded = new Promise((resolve, reject) => {
      const timer = setTimeout(() => { window.webContents.session.removeListener('will-download', save); reject(new Error('SKU CSV download timed out')); }, 15000);
      function save(_event, item) { item.setSavePath(destination); item.once('done', (_done, state) => { clearTimeout(timer); state === 'completed' ? resolve() : reject(new Error(`SKU CSV ${state}`)); }); }
      window.webContents.session.once('will-download', save);
    });
    await window.webContents.executeJavaScript(`document.querySelector('[data-sku-result-export]').click()`); await downloaded;
    const csv = await fs.readFile(destination, 'utf8');
    checks.skuTableCsvAllFiltered = csv.startsWith('\uFEFF') && csv.trimEnd().split('\r\n').length === 31 && csv.includes('"\'=1+1"') && csv.includes('已完成') && !csv.includes('SKU-031') && csv.includes('"completed"');
    await search('SKU-003'); await wait(`document.querySelectorAll('[data-sku-result-row]').length===1`);
    await select('[data-sku-result-status]', 'failed'); await wait(`!!document.querySelector('[data-sku-results-empty]')`);
    checks.skuTableSearchEmpty = await window.webContents.executeJavaScript(`document.querySelector('[data-sku-result-prev]').disabled&&document.querySelector('[data-sku-result-next]').disabled`);
    await search(''); await select('[data-sku-result-status]', ''); await select('[data-sku-result-size]', '100'); await wait(`document.querySelectorAll('[data-sku-result-row]').length===35`);
    await select('[aria-label="Interface language / 界面语言"]', 'en-US'); await wait(`document.querySelector('[data-sku-result-export]').innerText==='Export filtered SKU results CSV'`);
    checks.skuTableLanguageKeepsRaw = await window.webContents.executeJavaScript(`document.querySelector('[data-sku-results]').innerText.includes('已完成')&&document.querySelector('[data-sku-results]').innerText.includes('Completed')&&document.querySelector('[data-sku-result-size]').value==='100'`);
    await require('./smoke-screenshot.cjs').smokeScreenshot(window, path.join(root, 'sku-results-english.png'), { selector: '[data-sku-result-search]' });
    await select('[aria-label="Interface language / 界面语言"]', 'zh-CN');
    checks.skuTableReadOnly = (await fs.readFile(resultManifest)).equals(beforeTable) && await window.webContents.executeJavaScript('window.__skuTable.posts===1');
  } finally { await window.webContents.executeJavaScript('window.fetch=window.__skuTable.fetch;delete window.__skuTable;void 0'); }
  await mark('recovery');
  const directory = path.join(root, 'outputs', 'workbench', result.id), manifest = path.join(directory, 'manifest.json');
  const previousZip = await fs.readFile(path.join(directory, path.basename(result.downloadUrl)));
  const completedFiles = result.skuResults.flatMap(group => group.items.filter(item => item.status === 'success').map(item => path.join(directory, 'package', item.outputFile)));
  const snapshots = await Promise.all(completedFiles.map(async file => ({ file, time: (await fs.stat(file)).mtimeMs, hash: createHash('sha256').update(await fs.readFile(file)).digest('hex') })));
  await window.loadURL(`${origin}/results/${result.id}`);
  await wait(`Array.from(document.querySelectorAll('button')).some(el=>el.innerText==='重试失败 SKU')`);
  await window.webContents.executeJavaScript(`window.__skuResume={fetch:window.fetch,confirm:window.confirm,posts:0,dialogs:[],payload:null,result:null,allow:false};window.confirm=text=>{window.__skuResume.dialogs.push(text);return window.__skuResume.allow;};window.fetch=async(input,options)=>{const state=window.__skuResume,url=new URL(typeof input==='string'?input:input.url,location.href);if(url.origin!==location.origin)throw new Error('Resume fixture forbids external calls');if(options?.method==='POST'){if(url.pathname!==${JSON.stringify(`/api/workbench/sku-packs/${result.id}/resume`)})throw new Error('Resume fixture forbids unrelated writes');state.posts++;state.payload=JSON.parse(options.body);}const response=await state.fetch.call(window,input,options);if(options?.method==='POST')state.result=await response.clone().json();return response;};Array.from(document.querySelectorAll('button')).find(el=>el.innerText==='重试失败 SKU').click();void 0;`);
  try {
    await wait(`window.__skuResume.dialogs.length===1&&Array.from(document.querySelectorAll('button')).some(el=>el.innerText==='重试失败 SKU'&&!el.disabled)`);
    checks.skuResumeScopeBeforeWrite = await window.webContents.executeJavaScript(`window.__skuResume.posts===0&&window.__skuResume.dialogs[0].includes('5 个 SKU、5 张')`);
    await window.webContents.executeJavaScript(`window.__skuResume.allow=true;Array.from(document.querySelectorAll('button')).find(el=>el.innerText==='重试失败 SKU').click();void 0`);
    await wait(`window.__skuResume.result?.error||(window.__skuResume.result?.resumeApproval?.imageCount===5&&Array.from(document.querySelectorAll('button')).some(el=>el.innerText==='重试失败 SKU'&&!el.disabled))`);
    const resumeFailure = await window.webContents.executeJavaScript('window.__skuResume.result?.error||null');
    if (resumeFailure) {
      await fs.writeFile(path.join(root, 'sku-resume-api-error.json'), JSON.stringify(resumeFailure));
      const locks = await require('./zip-lock-diagnostic.cjs').inspectSmokeZipLock(path.join(directory, `${result.id}.zip`)).catch(error => ({ error: error.message }));
      await fs.writeFile(path.join(root, 'sku-resume-lock-diagnostic.json'), JSON.stringify(locks));
      throw new Error(`SKU resume API failed: ${JSON.stringify(resumeFailure)}; lock holders: ${JSON.stringify(locks)}`);
    }
    checks.skuResumeActualSealedPost = await window.webContents.executeJavaScript(`window.__skuResume.posts===1&&window.__skuResume.payload.confirm===true&&window.__skuResume.payload.confirmPaidMatting===false&&/^[a-f0-9]{64}$/.test(window.__skuResume.payload.previewHash)`);
    checks.skuResumeCompletedOutputsUnchanged = snapshots.length === 30 && (await Promise.all(snapshots.map(async item => (await fs.stat(item.file)).mtimeMs === item.time && createHash('sha256').update(await fs.readFile(item.file)).digest('hex') === item.hash))).every(Boolean);
    const saved = JSON.parse(await fs.readFile(manifest));
    checks.skuResumePersistentScope = saved.resumeApproval.imageCount === 5 && saved.summary.outputCount === 30 && saved.summary.failedCount === 5;
    checks.skuResumePriorArchivePreserved = saved.archiveGeneration === 1 && saved.downloadUrl !== result.downloadUrl && (await fs.readFile(path.join(directory, path.basename(result.downloadUrl)))).equals(previousZip);
    // Only the configuration/scope responses are fixtures in the next phase;
    // deny every POST so no remote processing can happen during cancellation.
    await window.webContents.executeJavaScript(`window.__skuResume.remoteFixture=true;window.__skuResume.dialogs=[];window.__skuResume.posts=0;window.confirm=text=>{window.__skuResume.dialogs.push(text);return !text.includes('批准本次图包抠图');};window.fetch=async(input,options)=>{const state=window.__skuResume,url=new URL(typeof input==='string'?input:input.url,location.href);if(url.origin!==location.origin)throw new Error('Resume approval forbids external traffic');if((options?.method||'GET')!=='GET'){state.posts++;throw new Error('Resume approval forbids writes');}if(url.pathname==='/api/matting/config')return Response.json({dataDestinations:[{provider:'external',origin:'https://resume-approval.invalid'}]});const response=await state.fetch.call(window,input,options);if(url.pathname.endsWith('/resume-preview')){const value=await response.json();return Response.json({...value,remote:true,options:{...value.options,matteImages:true,mattingProvider:'external'}});}return response;};Array.from(document.querySelectorAll('button')).find(el=>el.innerText==='重试失败 SKU').click();void 0;`);
    await wait(`window.__skuResume.dialogs.some(text=>text.includes('批准本次图包抠图'))&&Array.from(document.querySelectorAll('button')).some(el=>el.innerText==='重试失败 SKU'&&!el.disabled)`);
    checks.skuResumeRemoteOriginShown = await window.webContents.executeJavaScript(`window.__skuResume.dialogs.some(text=>text.includes('https://resume-approval.invalid')&&text.includes('图片数量：5'))`);
    checks.skuResumeRemoteCancelNoPost = await window.webContents.executeJavaScript('window.__skuResume.posts===0');
  } finally { await window.webContents.executeJavaScript('window.fetch=window.__skuResume.fetch;window.confirm=window.__skuResume.confirm;delete window.__skuResume;void 0'); }
  // Explicit ZIP-failure checkpoint fixture in the owned smoke workspace.
  // The subsequent preview, approval and local ZIP rebuild use real endpoints.
  const finalizeFixture = JSON.parse(await fs.readFile(manifest));
  finalizeFixture.status = 'paused'; finalizeFixture.recovery.available = false; delete finalizeFixture.recovery.finalizePending; finalizeFixture.error = { code: 'EPERM', message: 'smoke legacy ZIP publication failure checkpoint' };
  await fs.copyFile(path.join(directory, `${result.id}.zip`), path.join(directory, `${result.id}.zip.tmp`));
  await fs.writeFile(manifest, JSON.stringify(finalizeFixture));
  await mark('zip-finalization');
  await window.loadURL(`${origin}/results/${result.id}`); await wait(`Array.from(document.querySelectorAll('button')).some(el=>el.innerText==='仅重新生成结果包')`);
  if (!(await window.webContents.executeJavaScript(`document.querySelector('[data-result-download]')?.innerText==='下载上次保存的结果包'`))) throw new Error('Pending ZIP must identify the previously saved download');
  await window.webContents.executeJavaScript(`window.__skuFinalize={fetch:window.fetch,confirm:window.confirm,posts:0,dialogs:[],allow:false,result:null,payload:null};window.confirm=text=>{window.__skuFinalize.dialogs.push(text);return window.__skuFinalize.allow;};window.fetch=async(input,options)=>{const state=window.__skuFinalize,url=new URL(typeof input==='string'?input:input.url,location.href);if(url.origin!==location.origin)throw new Error('ZIP-only test forbids external calls');if(options?.method==='POST'){if(url.pathname!==${JSON.stringify(`/api/workbench/sku-packs/${result.id}/resume`)})throw new Error('ZIP-only test forbids other writes');state.posts++;state.payload=JSON.parse(options.body);}const response=await state.fetch.call(window,input,options);if(options?.method==='POST')state.result=await response.clone().json();return response;};Array.from(document.querySelectorAll('button')).find(el=>el.innerText==='仅重新生成结果包').click();void 0;`);
  try {
    await wait(`window.__skuFinalize.dialogs.length===1&&Array.from(document.querySelectorAll('button')).some(el=>el.innerText==='仅重新生成结果包'&&!el.disabled)`);
    checks.skuFinalizeCancellationNoPost = await window.webContents.executeJavaScript(`window.__skuFinalize.posts===0&&window.__skuFinalize.dialogs[0].includes('不会重做图片或调用抠图服务')`);
    await window.webContents.executeJavaScript(`window.__skuFinalize.allow=true;Array.from(document.querySelectorAll('button')).find(el=>el.innerText==='仅重新生成结果包').click();void 0`);
    await wait(`window.__skuFinalize.result?.error||window.__skuFinalize.result?.resumeApproval?.onlyFinalize===true`);
    const finalizeFailure = await window.webContents.executeJavaScript('window.__skuFinalize.result?.error||null');
    if (finalizeFailure) { await fs.writeFile(path.join(root, 'sku-finalize-api-error.json'), JSON.stringify(finalizeFailure)); throw new Error(`ZIP-only API failed: ${JSON.stringify(finalizeFailure)}`); }
    checks.skuFinalizeActualOnlyZip = await window.webContents.executeJavaScript('window.__skuFinalize.posts===1&&window.__skuFinalize.payload.confirmPaidMatting===false&&window.__skuFinalize.result.resumeApproval.imageCount===0&&window.__skuFinalize.result.summary.failedCount===5');
    checks.skuFinalizeOutputsUnchanged = (await Promise.all(snapshots.map(async item => (await fs.stat(item.file)).mtimeMs === item.time && createHash('sha256').update(await fs.readFile(item.file)).digest('hex') === item.hash))).every(Boolean);
    const finalized = await window.webContents.executeJavaScript('window.__skuFinalize.result');
    const zipped = new (require('adm-zip'))(path.join(directory, path.basename(finalized.downloadUrl)));
    checks.skuFinalizeZipApproval = JSON.parse(zipped.getEntry('manifest.json').getData()).resumeApproval.onlyFinalize === true;
    await wait(`document.querySelector('[data-sku-archive-version]')?.innerText.includes('结果包版本：2')&&document.querySelector('[data-result-download]')?.getAttribute('href')?.endsWith(${JSON.stringify(finalized.downloadUrl)})`);
    checks.skuFinalizeDownloadVersion = finalized.archiveGeneration === 2 && finalized.downloadUrl !== finalizeFixture.downloadUrl && (await fs.readFile(path.join(directory, path.basename(result.downloadUrl)))).equals(previousZip);
  } finally { await window.webContents.executeJavaScript('window.fetch=window.__skuFinalize.fetch;window.confirm=window.__skuFinalize.confirm;delete window.__skuFinalize;void 0'); }
  await mark('completed');
  return checks;
}
module.exports = { skuResultsResumeSmoke };
