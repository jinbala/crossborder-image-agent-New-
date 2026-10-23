const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const AdmZip = require('adm-zip');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
async function wait(window, expression) {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (await window.webContents.executeJavaScript(expression)) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`Workbench snapshot UI timed out: ${expression}`);
}
async function workbenchSnapshotSmoke({ window, origin, dataRoot, requestApi }) {
  const root = await fs.realpath(dataRoot), checks = {};
  if (!root.split(path.sep).includes('.smoke-data') || path.basename(root) !== 'workspace') throw new Error('Snapshot smoke requires an isolated smoke workspace');
  const json = async (route, options) => { const response = await requestApi(route, options); if (!response.ok) throw new Error(`Snapshot fixture ${response.status}: ${route}`); return response.json(); };
  const plan = await json('/api/workbench/collection-plans', { method: 'POST', body: JSON.stringify({ name: '只读快照-本地夹具', urls: ['https://fixture.invalid/product'] }), headers: { 'Content-Type': 'application/json' } });
  if (!/^collect-[A-Za-z0-9_-]+$/.test(plan.id)) throw new Error('Unexpected snapshot fixture id');
  const directory = path.join(root, 'outputs', 'workbench', plan.id), main = path.join(directory, 'manifest.json'), backup = await fs.readFile(`${main}.backup`);
  checks.genericProducerAtomicBackup = backup.equals(await fs.readFile(main));
  await fs.writeFile(main, '{snapshot smoke interrupted primary'); const names = await fs.readdir(directory);
  await window.loadURL(`${origin}/results/${plan.id}`);
  await wait(window, `document.querySelector('[data-manifest-recovery]')&&document.querySelector('[data-result-manifest]')`);
  checks.genericReadOnlyBackupVisible = await window.webContents.executeJavaScript(`!document.querySelector('[data-manifest-repair]')&&document.querySelector('[data-manifest-recovery]').innerText.includes('不会修复主清单')`);
  await window.webContents.executeJavaScript(`(()=>{const select=document.querySelector('[aria-label="Interface language / 界面语言"]');select.value='en-US';select.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  await wait(window, `document.querySelector('[data-manifest-recovery]').innerText.includes('never repair the primary manifest')`);
  checks.genericReadOnlyNoticeLocalized = await window.webContents.executeJavaScript(`document.querySelector('[data-result-manifest]').innerText==='Download full manifest'&&!document.querySelector('[data-manifest-repair]')`);
  const destination = path.join(root, 'generic-recovered-manifest.json');
  const saved = new Promise((resolve, reject) => {
    const timer = setTimeout(() => { window.webContents.session.removeListener('will-download', save); reject(new Error('Snapshot download timed out')); }, 15000);
    function save(_event, item) { item.setSavePath(destination); item.once('done', (_done, state) => { clearTimeout(timer); state === 'completed' ? resolve() : reject(new Error(`Snapshot download ${state}`)); }); }
    window.webContents.session.once('will-download', save);
  });
  await window.webContents.executeJavaScript(`document.querySelector('[data-result-manifest]').click()`); await saved;
  checks.genericFullSnapshotDownloaded = (await fs.readFile(destination)).equals(backup);
  await require('./smoke-screenshot.cjs').smokeScreenshot(window, path.join(root, 'generic-snapshot-readonly-english.png'), { selector: '[data-manifest-recovery]' });
  checks.genericReadDoesNotRepair = await fs.readFile(main, 'utf8') === '{snapshot smoke interrupted primary' && JSON.stringify(await fs.readdir(directory)) === JSON.stringify(names);
  const png = await require('sharp')({ create: { width: 48, height: 32, channels: 3, background: '#506080' } }).png().toBuffer(), form = new FormData();
  form.append('images', new Blob([png], { type: 'image/png' }), 'local-fixture.png'); form.append('options', JSON.stringify({ format: 'png' }));
  const pack = await json('/api/workbench/image-packs', { method: 'POST', body: form });
  if (!/^pack-[A-Za-z0-9_-]+$/.test(pack.id)) throw new Error('Unexpected pack fixture id');
  const packDirectory = path.join(root, 'outputs', 'workbench', pack.id), zipPath = path.join(packDirectory, `${pack.id}.zip`), zipBytes = await fs.readFile(zipPath), zipMtime = (await fs.stat(zipPath)).mtimeMs;
  await fs.writeFile(path.join(packDirectory, 'manifest.json'), '{pack snapshot smoke interrupted');
  const detail = await json(`/api/workbench/jobs/${pack.id}`), response = await requestApi(`/api/workbench/jobs/${pack.id}/manifest`);
  checks.genericArchiveReadOnlySnapshot = detail.manifestRead?.source === 'archive' && detail.manifestRead?.canRepair === false && detail.pagination.total === 1;
  checks.genericArchiveExactDownload = response.ok && Buffer.from(await response.arrayBuffer()).equals(new AdmZip(zipBytes).getEntry('manifest.json').getData());
  checks.genericArchiveUnchanged = hash(await fs.readFile(zipPath)) === hash(zipBytes) && (await fs.stat(zipPath)).mtimeMs === zipMtime && await fs.readFile(path.join(packDirectory, 'manifest.json'), 'utf8') === '{pack snapshot smoke interrupted';
  await window.webContents.executeJavaScript(`(()=>{const select=document.querySelector('[aria-label="Interface language / 界面语言"]');select.value='zh-CN';select.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  return checks;
}
module.exports = { workbenchSnapshotSmoke };
