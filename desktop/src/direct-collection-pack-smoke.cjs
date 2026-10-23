const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
async function directCollectionPackSmoke({ window, origin, dataRoot, requestApi, jobId, expectedImageHash }) {
  const root = await fs.realpath(dataRoot), checks = {};
  if (!root.split(path.sep).includes('.smoke-data') || path.basename(root) !== 'workspace' || !/^collect-job-[A-Za-z0-9_-]+$/.test(jobId)) throw new Error('Direct collection smoke needs its own workspace');
  async function wait(expression) {
    for (let i = 0; i < 250; i++) { if (await window.webContents.executeJavaScript(expression)) return; await new Promise(resolve => setTimeout(resolve, 50)); }
    throw new Error(`Direct collection pack timed out: ${expression}`);
  }
  const sourceFile = path.join(root, 'outputs', 'workbench', jobId, 'manifest.json'), before = await fs.readFile(sourceFile);
  await window.loadURL(`${origin}/workbench/collection?jobId=${encodeURIComponent(jobId)}`);
  await wait(`!!document.querySelector('[data-collection-pack-direct]')`);
  const route = `/api/workbench/collection-jobs/${jobId}/sku-pack`;
  await window.webContents.executeJavaScript(`window.__directPack={fetch:window.fetch,confirm:window.confirm,posts:0,dialogs:0,allow:false,dropOnce:true,result:null,payload:null};window.confirm=()=>{window.__directPack.dialogs++;return window.__directPack.allow;};window.fetch=async(input,options)=>{const state=window.__directPack,url=new URL(typeof input==='string'?input:input.url,location.href),method=options?.method||'GET';if(url.origin!==location.origin)throw new Error('Direct smoke forbids external requests');if(method!=='GET'){if(method!=='POST'||url.pathname!==${JSON.stringify(route)})throw new Error('Direct smoke forbids unrelated writes');state.payload=JSON.parse(options.body);if(state.payload.options.matteImages||state.payload.options.confirmPaidMatting)throw new Error('Direct smoke forbids remote matting');state.posts++;}const response=await state.fetch.call(window,input,options);if(method==='POST'){state.result=await response.clone().json();if(response.ok&&state.dropOnce){state.dropOnce=false;throw new Error('模拟图包回执丢失，保留原请求');}}return response;};void 0;`);
  let result;
  try {
    await window.webContents.executeJavaScript(`document.querySelector('[data-collection-pack-direct]').click()`);
    await wait(`!!document.querySelector('[data-collection-pack-count]')&&!document.querySelector('[data-sku-pack-submit]').disabled`);
    checks.collectionDirectEntryLoadsSource = await window.webContents.executeJavaScript(`location.search.includes('collectionJobId=')&&document.querySelector('[data-collection-pack-count]').innerText.includes('13')&&!document.querySelector('input[webkitdirectory]')`);
    checks.collectionDirectEntryNoAutoWrite = await window.webContents.executeJavaScript('window.__directPack.posts===0');
    await window.webContents.executeJavaScript(`document.querySelector('[data-sku-pack-submit]').click()`);
    checks.collectionDirectCancelConfirmationNoWrite = await window.webContents.executeJavaScript('window.__directPack.posts===0&&window.__directPack.dialogs===1');
    await window.webContents.executeJavaScript(`window.__directPack.allow=true;document.querySelector('[data-sku-pack-submit]').click()`);
    await wait(`document.querySelector('[role=alert]')?.innerText.includes('模拟图包回执丢失')&&!document.querySelector('[data-sku-pack-submit]').disabled`);
    result = await window.webContents.executeJavaScript('window.__directPack.result');
    checks.collectionDirectLostReplyRetainsSource = result.status === 'completed' && await window.webContents.executeJavaScript(`window.__directPack.posts===1&&document.querySelector('[data-collection-pack-count]').innerText.includes('13')`);
    const archive = path.join(root, 'outputs', 'workbench', result.id, `${result.id}.zip`), beforeReplay = await fs.readFile(archive), modified = (await fs.stat(archive)).mtimeMs;
    await window.webContents.executeJavaScript(`document.querySelector('[data-sku-pack-submit]').click()`);
    await wait(`!!document.querySelector('[data-sku-pack-provenance]')&&!document.querySelector('[data-sku-pack-submit]').disabled`);
    const replay = await window.webContents.executeJavaScript('window.__directPack.result');
    checks.collectionDirectReplayOnePack = replay.id === result.id && replay.transfer.replayed === true && (await fs.stat(archive)).mtimeMs === modified && (await fs.readFile(archive)).equals(beforeReplay);
    checks.collectionDirectLocalProcessing = replay.summary.skuCount === 13 && replay.summary.inputCount === 13 && replay.summary.generatedSquareCount === 13 && replay.summary.failedCount === 0 && replay.summary.mattedCount === 0;
    checks.collectionDirectProvenanceInUi = await window.webContents.executeJavaScript(`document.querySelector('[data-sku-pack-provenance]').innerText.includes('没有重复处理')&&document.querySelector('[data-sku-pack-provenance] a[href="/results/${result.id}"]')!==null`);
    const destination = path.join(root, 'direct-collection-pack-ui.zip');
    const downloaded = new Promise((resolve, reject) => {
      const timer = setTimeout(() => { window.webContents.session.removeListener('will-download', save); reject(new Error('Direct pack ZIP download timed out')); }, 15000);
      function save(_event, item) { item.setSavePath(destination); item.once('done', (_done, state) => { clearTimeout(timer); state === 'completed' ? resolve() : reject(new Error(`Direct pack download ${state}`)); }); }
      window.webContents.session.once('will-download', save);
    });
    await window.webContents.executeJavaScript(`document.querySelector(${JSON.stringify(`a[href="${replay.downloadUrl}"]`)}).click()`); await downloaded;
    const zip = new(require('adm-zip'))(await fs.readFile(destination)), manifest = JSON.parse(zip.getEntry('manifest.json').getData());
    const originals = zip.getEntries().filter(entry => !entry.isDirectory && entry.entryName.includes('/originals/'));
    checks.collectionDirectZipOriginals = originals.length === 13 && originals.every(entry => hash(entry.getData()) === expectedImageHash);
    checks.collectionDirectZipSourceRecords = manifest.source.jobId === jobId && manifest.source.images.length === 13 && manifest.source.images.every(image => image.itemId && image.sha256 === expectedImageHash && !Object.hasOwn(image, 'path'));
    checks.collectionDirectSourceUnchanged = (await fs.readFile(sourceFile)).equals(before);
    await window.webContents.executeJavaScript(`document.querySelector('[data-sku-pack-provenance]').scrollIntoView({block:'center'});void 0`);
    await require('./smoke-screenshot.cjs').smokeScreenshot(window, path.join(root, 'direct-collection-pack-result.png'));
  } finally { await window.webContents.executeJavaScript('window.fetch=window.__directPack.fetch;window.confirm=window.__directPack.confirm;delete window.__directPack;void 0'); }
  await window.loadURL(`${origin}/results/${encodeURIComponent(result.id)}`);
  await wait(`!!document.querySelector('[data-result-collection-source]')`);
  checks.collectionDirectResultReloadSource = await window.webContents.executeJavaScript(`document.querySelector('[data-result-collection-source] a').getAttribute('href')===${JSON.stringify(`/workbench/collection?jobId=${jobId}`)}`);
  const detail = await (await requestApi(`/api/workbench/jobs/${result.id}`)).json();
  checks.collectionDirectPersistentTrace = detail.source.jobId === jobId && detail.source.images.length === 13 && detail.summary.inputCount === 13;

  // Explicit read-only configuration fixture enables a provider option for the
  // cancellation gate. Every POST and external origin is blocked in this probe.
  await window.loadURL(`${origin}/workbench/collection?jobId=${encodeURIComponent(jobId)}`);
  await wait(`!!document.querySelector('[data-collection-pack-direct]')`);
  await window.webContents.executeJavaScript(`window.__packApproval={fetch:window.fetch,confirm:window.confirm,posts:0,dialogs:[]};window.fetch=(input,options)=>{const state=window.__packApproval,url=new URL(typeof input==='string'?input:input.url,location.href);if(url.origin!==location.origin)throw new Error('Approval smoke forbids external traffic');if((options?.method||'GET')!=='GET'){state.posts++;throw new Error('Approval smoke forbids writes');}if(url.pathname==='/api/matting/config')return Promise.resolve(Response.json({externalConfigured:true,dataDestinations:[{provider:'external',origin:'https://pack-approval.invalid'}]}));return state.fetch.call(window,input,options);};window.confirm=message=>{window.__packApproval.dialogs.push(message);return !message.includes('批准本次图包抠图');};document.querySelector('[data-collection-pack-direct]').click();void 0;`);
  try {
    await wait(`!!document.querySelector('[data-collection-pack-count]')&&!document.querySelector('[data-sku-pack-submit]').disabled`);
    await window.webContents.executeJavaScript(`Array.from(document.querySelectorAll('label')).find(el=>el.innerText.includes('处理前先抠图')).querySelector('input').click()`);
    await wait(`Array.from(document.querySelectorAll('select')).some(el=>Array.from(el.options).some(option=>option.value==='external'&&!option.disabled))`);
    await window.webContents.executeJavaScript(`(()=>{const el=Array.from(document.querySelectorAll('select')).find(el=>Array.from(el.options).some(option=>option.value==='external'));el.value='external';el.dispatchEvent(new Event('change',{bubbles:true}));})()`);
    await wait(`Array.from(document.querySelectorAll('label')).some(el=>el.innerText.includes('我确认可能产生 API 费用'))`);
    await window.webContents.executeJavaScript(`Array.from(document.querySelectorAll('label')).find(el=>el.innerText.includes('我确认可能产生 API 费用')).querySelector('input').click();document.querySelector('[data-sku-pack-submit]').click();void 0`);
    await wait(`window.__packApproval.dialogs.some(text=>text.includes('批准本次图包抠图'))&&!document.querySelector('[data-sku-pack-submit]').disabled`);
    checks.skuPackPaidDestinationBeforeSubmit = await window.webContents.executeJavaScript(`window.__packApproval.dialogs.some(text=>text.includes('https://pack-approval.invalid')&&text.includes('13')&&text.includes('失败或重试'))`);
    checks.skuPackPaidCancellationNoPost = await window.webContents.executeJavaScript('window.__packApproval.posts===0');
  } finally { await window.webContents.executeJavaScript('window.fetch=window.__packApproval.fetch;window.confirm=window.__packApproval.confirm;delete window.__packApproval;void 0'); }
  return checks;
}
module.exports = { directCollectionPackSmoke };
