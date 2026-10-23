const fs = require('node:fs/promises');
const path = require('node:path');
const AdmZip = require('adm-zip');
async function imagePackRecoverySmoke({ window, origin, dataRoot, requestApi, restartService }) {
  const root = await fs.realpath(dataRoot), checks = {};
  if (!root.split(path.sep).includes('.smoke-data') || path.basename(root) !== 'workspace') throw new Error('Image-pack recovery smoke requires an isolated workspace');
  const json = async (route, options) => { const response = await requestApi(route, options); if (!response.ok) throw new Error(`Image-pack recovery ${response.status}: ${route}`); return response.json(); };
  async function wait(expression) {
    for (let i = 0; i < 200; i++) { if (await window.webContents.executeJavaScript(expression)) return; await new Promise(resolve => setTimeout(resolve, 50)); }
    throw new Error(`Image-pack recovery UI timeout: ${expression}`);
  }
  const image = await require('sharp')({ create: { width: 60, height: 40, channels: 3, background: '#52718a' } }).png().toBuffer(), form = new FormData();
  form.append('images', new Blob([image], { type: 'image/png' }), 'valid.png');
  form.append('images', new Blob(['invalid local fixture'], { type: 'image/png' }), 'invalid.png');
  form.append('images', new Blob([image], { type: 'image/png' }), 'last.png');
  form.append('options', JSON.stringify({ prefix: '商品 图片', format: 'png' }));
  const pack = await json('/api/workbench/image-packs', { method: 'POST', body: form });
  if (!/^pack-[A-Za-z0-9_-]+$/.test(pack.id)) throw new Error('Unexpected image-pack fixture id');
  const dir = path.join(root, 'outputs', 'workbench', pack.id), main = path.join(dir, 'manifest.json');
  const first = path.join(dir, 'images', pack.items[0].fileName), originalImage = await fs.readFile(first), mtime = (await fs.stat(first)).mtimeMs;
  const originalZip = path.join(dir, path.basename(pack.downloadUrl)), zipBytes = await fs.readFile(originalZip), initial = await fs.readFile(main);
  checks.imagePackPartialContinuesAfterBadImage = pack.status === 'partial' && pack.summary.successCount === 2 && pack.summary.failedCount === 1 && pack.items[2].status === 'completed';
  checks.imagePackDurableInputs = (await fs.readdir(path.join(dir, 'inputs'))).length === 3;
  const oldOrigin = origin; origin = await restartService();
  checks.imagePackRestartStopsOldService = await fetch(`${oldOrigin}/api/health`).then(() => false, () => true);
  await window.loadURL(`${origin}/results/${pack.id}`);
  await wait(`document.querySelector('[data-image-pack-retry]')&&!document.querySelector('[data-image-pack-retry]').disabled`);
  checks.imagePackRestartOnlyOffersManualRetry = (await fs.readFile(main)).equals(initial) && await window.webContents.executeJavaScript(`document.querySelector('[data-image-pack-resume]').disabled`);
  await window.webContents.executeJavaScript(`window.__packConfirmCalls=0;window.confirm=()=>{window.__packConfirmCalls++;return false;};document.querySelector('[data-image-pack-retry]').click();void 0`);
  await wait(`window.__packConfirmCalls===1&&!document.querySelector('[data-image-pack-retry]').disabled`);
  checks.imagePackCancelApprovalNoWrites = (await fs.readFile(main)).equals(initial) && (await fs.readFile(originalZip)).equals(zipBytes);
  await window.webContents.executeJavaScript(`window.confirm=()=>true;document.querySelector('[data-image-pack-retry]').click();void 0`);
  let result;
  for (let i = 0; i < 200; i++) {
    result = JSON.parse(await fs.readFile(main));
    if (result.status === 'partial' && result.items[1].attempt === 2 && result.downloadUrl !== pack.downloadUrl) break;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  await wait(`document.querySelector('[data-image-pack-retry]')&&!document.querySelector('[data-image-pack-retry]').disabled&&document.querySelector('[data-result-download]').getAttribute('href').includes('-r1.zip')`);
  checks.imagePackApprovedRetryOnlyFailed = result.status === 'partial' && result.items[0].attempt === 1 && result.items[1].attempt === 2 && result.items[2].attempt === 1;
  checks.imagePackCompletedImageUnchanged = (await fs.readFile(first)).equals(originalImage) && (await fs.stat(first)).mtimeMs === mtime;
  checks.imagePackOldArchiveUnchanged = (await fs.readFile(originalZip)).equals(zipBytes) && result.downloadUrl !== pack.downloadUrl;
  const zip = new AdmZip(await fs.readFile(path.join(dir, path.basename(result.downloadUrl)))), manifest = JSON.parse(zip.readAsText('manifest.json'));
  checks.imagePackArchiveHasActualResultsOnly = zip.getEntries().filter(entry => entry.entryName.startsWith('images/')).length === 2 && !zip.getEntries().some(entry => entry.entryName.startsWith('inputs/')) && manifest.summary.successCount === 2 && manifest.summary.failedCount === 1 && manifest.items[1].attempt === 2;
  await window.webContents.executeJavaScript(`(()=>{const el=document.querySelector('[aria-label="Interface language / 界面语言"]');el.value='en-US';el.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  await wait(`document.querySelector('[data-image-pack-retry]').innerText==='Retry failed images'`);
  checks.imagePackRecoveryLocalized = await window.webContents.executeJavaScript(`document.body.innerText.includes('Image-pack checkpoint')&&document.body.innerText.includes('Per-image checkpoints are saved.')&&document.querySelector('[data-image-pack-resume]').innerText==='Continue unfinished images'`);
  await require('./smoke-screenshot.cjs').smokeScreenshot(window, path.join(root, 'image-pack-recovery-english.png'), { selector: '[data-image-pack-retry]' });
  await window.webContents.executeJavaScript(`(()=>{const el=document.querySelector('[aria-label="Interface language / 界面语言"]');el.value='zh-CN';el.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  return checks;
}
module.exports = { imagePackRecoverySmoke };
