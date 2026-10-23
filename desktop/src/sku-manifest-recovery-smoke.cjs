const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

async function skuManifestRecoverySmoke({ window, origin, dataRoot, requestApi }) {
  const root = await fs.realpath(dataRoot), checks = {};
  if (!root.split(path.sep).includes('.smoke-data') || path.basename(root) !== 'workspace') throw new Error('Manifest fixtures require an owned smoke workspace');
  const mark = phase => fs.writeFile(path.join(root, 'sku-manifest-recovery-progress.json'), JSON.stringify({ phase, at: new Date().toISOString(), checks }));
  async function wait(expression) { for (let i = 0; i < 240; i++) { if (await window.webContents.executeJavaScript(expression)) return; await new Promise(resolve => setTimeout(resolve, 50)); } throw new Error(`Manifest recovery timed out: ${expression}`); }
  await mark('prepare');
  const png = await require('sharp')({ create: { width: 48, height: 32, channels: 3, background: '#507090' } }).png().toBuffer();
  const form = new FormData();
  for (let i = 0; i < 2; i++) form.append('images', new Blob([png], { type: 'image/png' }), 'fixture.png');
  form.append('relativePaths', JSON.stringify(['fixture/SKU-A/main.png', 'fixture/SKU-B/main.png']));
  form.append('options', JSON.stringify({ name: '清单恢复-仅本地夹具', generateSquare: false, preserveOriginals: false, matteImages: false, confirmPaidMatting: false }));
  const created = await requestApi('/api/workbench/sku-packs', { method: 'POST', body: form }), result = await created.json();
  if (!created.ok || result.status !== 'completed' || !/^sku-pack-[A-Za-z0-9_-]+$/.test(result.id)) throw new Error('Local manifest fixture creation failed');
  const directory = path.join(root, 'outputs', 'workbench', result.id), main = path.join(directory, 'manifest.json');
  if (await fs.realpath(directory) !== directory) throw new Error('Fixture directory must not be a link');
  const original = await fs.readFile(main), zipFile = path.join(directory, path.basename(result.downloadUrl)), zipBytes = await fs.readFile(zipFile);
  const archiveManifest = new (require('adm-zip'))(zipBytes).getEntry('manifest.json').getData();
  const outputs = await Promise.all(result.skuResults.flatMap(group => group.items).filter(item => item.status === 'success').map(async item => { const file = path.join(directory, 'package', item.outputFile); return { file, modified: (await fs.stat(file)).mtimeMs, hash: hash(await fs.readFile(file)) }; }));
  // Only this owned fixture is damaged. The following reads and repair use real endpoints.
  await fs.writeFile(main, '{smoke damaged primary');
  let mutations = 0, forbidden = 0, allowRepair = false;
  const repairPath = `/api/workbench/sku-packs/${result.id}/repair-manifest`;
  window.webContents.session.webRequest.onBeforeRequest({ urls: [`${origin}/api/*`] }, (details, callback) => {
    if (!['GET', 'HEAD'].includes(details.method)) { mutations++; if (!allowRepair || details.method !== 'POST' || new URL(details.url).pathname !== repairPath) { forbidden++; callback({ cancel: true }); return; } }
    callback({ cancel: false });
  });
  try {
    await mark('archive-readonly');
    await window.loadURL(`${origin}/results/${result.id}`); await wait(`!!document.querySelector('[data-manifest-recovery]')`);
    checks.skuCorruptResultReadOnly = mutations === 0 && await fs.readFile(main, 'utf8') === '{smoke damaged primary' && await window.webContents.executeJavaScript(`document.querySelector('[data-manifest-recovery]').innerText.includes('ZIP')`);
    await window.webContents.executeJavaScript(`(()=>{const select=document.querySelector('[aria-label="Interface language / 界面语言"]');select.value='en-US';select.dispatchEvent(new Event('change',{bubbles:true}));})()`);
    await wait(`document.querySelector('[data-manifest-recovery]').innerText.includes('read-only manifest snapshot')`);
    checks.skuCorruptSnapshotLocalized = mutations === 0 && await window.webContents.executeJavaScript(`document.querySelector('[data-manifest-repair]').innerText==='Preview and repair primary manifest'`);
    const downloadFile = path.join(root, 'sku-recovered-ui-manifest.json');
    const downloaded = new Promise((resolve, reject) => {
      const timer = setTimeout(() => { window.webContents.session.removeListener('will-download', save); reject(new Error('Recovered manifest download timed out')); }, 15000);
      function save(_event, item) { item.setSavePath(downloadFile); item.once('done', (_done, state) => { clearTimeout(timer); state === 'completed' ? resolve() : reject(new Error(`Recovered manifest download ${state}`)); }); }
      window.webContents.session.once('will-download', save);
    });
    await window.webContents.executeJavaScript(`document.querySelector('[data-result-manifest]').click()`); await downloaded;
    checks.skuRecoveredManifestDownload = (await fs.readFile(downloadFile)).equals(archiveManifest) && JSON.parse(await fs.readFile(downloadFile)).summary.outputCount === 2;
    await require('./smoke-screenshot.cjs').smokeScreenshot(window, path.join(root, 'sku-manifest-readonly-english.png'), { selector: '[data-manifest-recovery]' });
    // A source changed before preflight must be displayed before approval too.
    const backupBeforeGuard = await fs.readFile(`${main}.backup`), changedSource = JSON.parse(original);
    changedSource.checkpointRevision += 20; changedSource.name = 'changed snapshot before preflight';
    await fs.writeFile(`${main}.backup`, JSON.stringify(changedSource));
    await window.webContents.executeJavaScript(`window.__sourceGuard={confirm:window.confirm,calls:0};window.confirm=()=>{window.__sourceGuard.calls++;return false;};document.querySelector('[data-manifest-repair]').click();void 0`);
    await wait(`document.body.innerText.includes('recovery source is unavailable')&&document.querySelector('[data-manifest-recovery]')?.innerText.includes('backup')&&!document.querySelector('[data-manifest-repair]').disabled`);
    checks.skuRepairDisplayedSourceGuard = mutations === 0 && await window.webContents.executeJavaScript('window.__sourceGuard.calls===0');
    await window.webContents.executeJavaScript('window.confirm=window.__sourceGuard.confirm;delete window.__sourceGuard;void 0');
    await fs.writeFile(`${main}.backup`, backupBeforeGuard);
    await window.loadURL(`${origin}/results/${result.id}`); await wait(`document.querySelector('[data-manifest-recovery]')?.innerText.includes('published ZIP')`);
    await window.webContents.executeJavaScript(`window.__manifestRepair={fetch:window.fetch,confirm:window.confirm,dialogs:[],allow:false,hold:false,pending:null,result:null,status:null,payload:null};window.confirm=text=>{window.__manifestRepair.dialogs.push(text);return window.__manifestRepair.allow;};window.fetch=async(input,options)=>{const state=window.__manifestRepair,url=new URL(typeof input==='string'?input:input.url,location.href);if(url.origin!==location.origin)throw new Error('Manifest test forbids external calls');if((options?.method||'GET')!=='GET'){if(url.pathname!==${JSON.stringify(repairPath)})throw new Error('Manifest test forbids other writes');state.payload=JSON.parse(options.body);if(state.hold){state.pending=true;await new Promise(resolve=>state.release=resolve);}}const response=await state.fetch.call(window,input,options);if((options?.method||'GET')==='POST'){state.status=response.status;state.result=await response.clone().json();}return response;};document.querySelector('[data-manifest-repair]').click();void 0`);
    await wait(`window.__manifestRepair.dialogs.length===1&&!document.querySelector('[data-manifest-repair]').disabled`);
    checks.skuRepairCancelledNoMutation = mutations === 0 && await fs.readFile(main, 'utf8') === '{smoke damaged primary';
    await mark('stale-approval'); allowRepair = true;
    await window.webContents.executeJavaScript(`window.__manifestRepair.allow=true;window.__manifestRepair.hold=true;document.querySelector('[data-manifest-repair]').click();void 0`);
    await wait(`window.__manifestRepair.pending===true`); await fs.writeFile(main, '{changed after approval');
    await window.webContents.executeJavaScript(`window.__manifestRepair.release();void 0`);
    await wait(`window.__manifestRepair.status===409&&document.body.innerText.includes('主清单或恢复来源已变化')&&!document.querySelector('[data-manifest-repair]').disabled`);
    checks.skuRepairStaleApprovalRejected = await fs.readFile(main, 'utf8') === '{changed after approval' && (await fs.readdir(directory)).every(name => !name.startsWith('manifest.json.damaged-'));
    await mark('approved-repair');
    await window.webContents.executeJavaScript(`window.__manifestRepair.hold=false;window.__manifestRepair.status=null;window.__manifestRepair.result=null;document.querySelector('[data-manifest-repair]').click();void 0`);
    await wait(`window.__manifestRepair.status===200&&!document.querySelector('[data-manifest-recovery]')`);
    const repaired = await window.webContents.executeJavaScript('window.__manifestRepair.result'), payload = await window.webContents.executeJavaScript('window.__manifestRepair.payload');
    checks.skuRepairActualOnlyManifest = repaired.repaired === true && repaired.imagesProcessed === 0 && payload.confirm === true && /^[a-f0-9]{64}$/.test(payload.previewHash) && /^[a-f0-9]{64}$/.test(payload.sourceHash);
    if (!/^manifest\.json\.damaged-[A-Za-z0-9_-]+$/.test(repaired.preservedDamaged)) throw new Error('Unexpected damaged-manifest copy path');
    checks.skuRepairPreservesDamaged = await fs.readFile(path.join(directory, repaired.preservedDamaged), 'utf8') === '{changed after approval';
    checks.skuRepairImagesAndZipUnchanged = outputs.length === 2 && (await Promise.all(outputs.map(async item => (await fs.stat(item.file)).mtimeMs === item.modified && hash(await fs.readFile(item.file)) === item.hash))).every(Boolean) && (await fs.readFile(zipFile)).equals(zipBytes);
    checks.skuRepairWarningClears = (await fs.readFile(main)).equals(archiveManifest) && await window.webContents.executeJavaScript(`!document.querySelector('[data-manifest-repair]')`);
    await window.webContents.executeJavaScript(`window.fetch=window.__manifestRepair.fetch;window.confirm=window.__manifestRepair.confirm;delete window.__manifestRepair;void 0`);
    await mark('missing-primary'); allowRepair = false;
    await fs.unlink(main); await window.loadURL(`${origin}/results/${result.id}`); await wait(`!!document.querySelector('[data-manifest-recovery]')`);
    checks.skuMissingManifestReadOnly = await fs.stat(main).then(() => false, error => error.code === 'ENOENT') && await window.webContents.executeJavaScript(`document.querySelector('[data-manifest-recovery]').innerText.includes('published ZIP')`);
    // A clearly labelled newer-backup fixture exercises the alternative UI source.
    const backup = JSON.parse(original); backup.checkpointRevision += 10; backup.name = '备份原文 $&';
    await fs.writeFile(`${main}.backup`, JSON.stringify(backup)); await fs.writeFile(main, '{backup display fixture');
    await mark('backup-readonly'); await window.loadURL(`${origin}/results/${result.id}`); await wait(`document.querySelector('[data-manifest-recovery]')?.innerText.includes('read-only backup manifest')`);
    checks.skuBackupManifestReadOnly = await fs.readFile(main, 'utf8') === '{backup display fixture' && await window.webContents.executeJavaScript(`document.body.innerText.includes('备份原文 $&')`);
    checks.skuManifestNoAutomaticWrites = mutations === 2 && forbidden === 0;
  } finally {
    window.webContents.session.webRequest.onBeforeRequest(null);
    await window.webContents.executeJavaScript(`if(window.__manifestRepair){window.fetch=window.__manifestRepair.fetch;window.confirm=window.__manifestRepair.confirm;delete window.__manifestRepair;}void 0`);
  }
  await window.webContents.executeJavaScript(`(()=>{const select=document.querySelector('[aria-label="Interface language / 界面语言"]');select.value='zh-CN';select.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  await mark('completed'); return checks;
}
module.exports = { skuManifestRecoverySmoke };
