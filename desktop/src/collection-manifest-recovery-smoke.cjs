const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
async function collectionManifestRecoverySmoke({ window, origin, dataRoot, requestApi }) {
  const root = await fs.realpath(dataRoot), checks = {};
  if (!root.split(path.sep).includes('.smoke-data') || path.basename(root) !== 'workspace') throw new Error('Collection repair requires an isolated smoke workspace');
  const json = async (route, options) => { const response = await requestApi(route, options); if (!response.ok) throw new Error(`Collection repair fixture ${response.status}: ${route}`); return response.json(); };
  async function wait(expression) { for (let i = 0; i < 240; i++) { if (await window.webContents.executeJavaScript(expression)) return; await new Promise(resolve => setTimeout(resolve, 50)); } throw new Error(`Collection repair UI timed out: ${expression}`); }
  const job = await json('/api/workbench/collection-jobs/rows', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ rows: [1, 2].map(i => ({ sku: `RECOVER-${i}`, title: '恢复原文 $&', imageUrls: [`https://fixture.invalid/repair-${i}.png`] })), options: { name: '本地采集恢复夹具', extraWaitMs: 0 } }) });
  if (!/^collect-job-[A-Za-z0-9_-]+$/.test(job.id)) throw new Error('Invalid collection fixture id');
  const directory = path.join(root, 'outputs', 'workbench', job.id), main = path.join(directory, 'manifest.json'), backupFile = path.join(directory, 'manifest.backup.json');
  const png = await require('sharp')({ create: { width: 48, height: 32, channels: 3, background: '#709050' } }).png().toBuffer();
  async function upload(item) {
    const form = new FormData(); form.append('itemId', item.id); form.append('sourceUrl', item.imageUrls[0]); form.append('image', new Blob([png], { type: 'image/png' }), 'fixture.png');
    return json(`/api/workbench/collection-jobs/${job.id}/browser-images`, { method: 'POST', body: form });
  }
  const uploaded = await upload(job.items[0]), imageFile = path.join(directory, 'images', ...uploaded.image.file.split('/'));
  const imageBefore = { hash: hash(await fs.readFile(imageFile)), modified: (await fs.stat(imageFile)).mtimeMs }, backup = await fs.readFile(backupFile);
  checks.collectionCheckpointCurrentBackup = backup.equals(await fs.readFile(main)) && JSON.parse(backup).summary.downloadedCount === 1;
  await fs.writeFile(main, '{collection damaged');
  let mutations = 0, forbidden = 0, allowRepair = false;
  const repairPath = `/api/workbench/collection-jobs/${job.id}/repair-manifest`;
  window.webContents.session.webRequest.onBeforeRequest({ urls: [`${origin}/api/*`] }, (details, callback) => {
    if (!['GET', 'HEAD'].includes(details.method)) { mutations++; if (!allowRepair || details.method !== 'POST' || new URL(details.url).pathname !== repairPath) { forbidden++; callback({ cancel: true }); return; } }
    callback({ cancel: false });
  });
  try {
    await window.loadURL(`${origin}/results/${job.id}`); await wait(`!!document.querySelector('[data-open-collection-recovery]')`);
    checks.collectionGenericRecoveryLink = await window.webContents.executeJavaScript(`!document.querySelector('[data-manifest-repair]')`);
    await window.webContents.executeJavaScript(`document.querySelector('[data-open-collection-recovery]').click()`);
    await wait(`!!document.querySelector('[data-collection-manifest-recovery]')`);
    checks.collectionRecoveryBlocksContinuation = await window.webContents.executeJavaScript(`document.querySelector('[data-collection-run-all]').disabled&&document.querySelector('[data-collection-run-batch]').disabled`);
    await window.webContents.executeJavaScript(`(()=>{const el=document.querySelector('[aria-label="Interface language / 界面语言"]');el.value='en-US';el.dispatchEvent(new Event('change',{bubbles:true}));})()`);
    await wait(`document.querySelector('[data-collection-manifest-repair]')?.innerText==='Preview and repair primary manifest'`);
    checks.collectionRecoveryEnglishKeepsRaw = await window.webContents.executeJavaScript(`document.querySelector('[data-collection-manifest-recovery]').innerText.includes('read-only backup manifest')&&document.body.innerText.includes('恢复原文 $&')&&document.querySelector('[data-collection-next-step="recovery"]').innerText.includes('confirm repair')`);
    const destination = path.join(root, 'collection-recovered-full-manifest.json');
    const downloaded = new Promise((resolve, reject) => { const timer = setTimeout(() => { window.webContents.session.removeListener('will-download', save); reject(new Error('Collection full manifest download timed out')); }, 15000); function save(_event, item) { item.setSavePath(destination); item.once('done', (_done, state) => { clearTimeout(timer); state === 'completed' ? resolve() : reject(new Error(`Collection full manifest download ${state}`)); }); } window.webContents.session.once('will-download', save); });
    await window.webContents.executeJavaScript(`document.querySelector('[data-collection-manifest]').click()`); await downloaded;
    checks.collectionRecoveryExactDownload = (await fs.readFile(destination)).equals(backup) && await fs.readFile(main, 'utf8') === '{collection damaged';
    await require('./smoke-screenshot.cjs').smokeScreenshot(window, path.join(root, 'collection-recovery-english.png'), { selector: '[data-collection-manifest-recovery]' });
    await window.webContents.executeJavaScript(`window.__collectionRepair={confirm:window.confirm,fetch:window.fetch,allow:false,dialogs:0,status:null,result:null,payload:null};window.confirm=()=>{window.__collectionRepair.dialogs++;return window.__collectionRepair.allow;};window.fetch=async(input,options)=>{const state=window.__collectionRepair,url=new URL(typeof input==='string'?input:input.url,location.href);if(url.origin!==location.origin)throw new Error('Collection smoke forbids remote calls');const response=await state.fetch.call(window,input,options);if(options?.method==='POST'){state.payload=JSON.parse(options.body);state.status=response.status;state.result=await response.clone().json();}return response;};document.querySelector('[data-collection-manifest-repair]').click();void 0`);
    await wait(`window.__collectionRepair.dialogs===1&&!document.querySelector('[data-collection-manifest-repair]').disabled`);
    checks.collectionRepairCancelNoMutation = mutations === 0 && await fs.readFile(main, 'utf8') === '{collection damaged';
    allowRepair = true;
    await window.webContents.executeJavaScript(`window.__collectionRepair.allow=true;document.querySelector('[data-collection-manifest-repair]').click();void 0`);
    await wait(`window.__collectionRepair.status===200&&!document.querySelector('[data-collection-manifest-recovery]')`);
    const result = await window.webContents.executeJavaScript('window.__collectionRepair.result'), payload = await window.webContents.executeJavaScript('window.__collectionRepair.payload');
    if (!/^manifest\.json\.damaged-[A-Za-z0-9_-]+$/.test(result.preservedDamaged)) throw new Error('Invalid preserved collection filename');
    checks.collectionRepairOnlyApprovedManifest = result.repaired === true && result.imagesProcessed === 0 && payload.confirm === true && /^[a-f0-9]{64}$/.test(payload.previewHash) && /^[a-f0-9]{64}$/.test(payload.sourceHash) && (await fs.readFile(main)).equals(backup);
    checks.collectionRepairPreservesOriginal = await fs.readFile(path.join(directory, result.preservedDamaged), 'utf8') === '{collection damaged' && (await fs.readFile(backupFile)).equals(backup) && hash(await fs.readFile(imageFile)) === imageBefore.hash && (await fs.stat(imageFile)).mtimeMs === imageBefore.modified;
    checks.collectionRepairDoesNotAutoResume = mutations === 1 && forbidden === 0 && JSON.parse(await fs.readFile(main)).summary.pendingCount === 1 && await window.webContents.executeJavaScript(`!document.querySelector('[data-collection-run-all]').disabled&&!document.querySelector('[data-collection-run-batch]').disabled`);
  } finally {
    window.webContents.session.webRequest.onBeforeRequest(null);
    await window.webContents.executeJavaScript(`if(window.__collectionRepair){window.fetch=window.__collectionRepair.fetch;window.confirm=window.__collectionRepair.confirm;delete window.__collectionRepair;}void 0`);
  }
  // Complete with an actual local upload, then read a published ZIP without a backup.
  await upload(job.items[1]); const completed = await json(`/api/workbench/collection-jobs/${job.id}`);
  const zipFile = path.join(directory, path.basename(completed.downloadUrl)), zipBytes = await fs.readFile(zipFile), archived = new (require('adm-zip'))(zipBytes).getEntry('manifest.json').getData();
  await fs.unlink(backupFile); await fs.writeFile(main, '{archive recovery fixture');
  await window.loadURL(`${origin}/workbench/collection?jobId=${encodeURIComponent(job.id)}`); await wait(`document.querySelector('[data-collection-manifest-recovery]')?.innerText.includes('published ZIP')`);
  checks.collectionArchiveRecoveryReadOnly = (await fs.readFile(zipFile)).equals(zipBytes) && await fs.readFile(main, 'utf8') === '{archive recovery fixture';
  const preview = await json(`${repairPath.replace('/repair-manifest', '')}/manifest-repair-preview`);
  await json(repairPath, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ confirm: true, previewHash: preview.previewHash, sourceHash: preview.sourceHash }) });
  checks.collectionArchiveRepairZipUnchanged = (await fs.readFile(main)).equals(archived) && (await fs.readFile(zipFile)).equals(zipBytes);
  await window.webContents.executeJavaScript(`(()=>{const el=document.querySelector('[aria-label="Interface language / 界面语言"]');el.value='zh-CN';el.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  return checks;
}
module.exports = { collectionManifestRecoverySmoke };
