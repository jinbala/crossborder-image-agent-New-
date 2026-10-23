const fs = require('node:fs/promises');
const path = require('node:path');
const AdmZip = require('adm-zip');

async function waitingRecoverySmoke({ window, origin, dataRoot, requestApi, restartService }) {
  const root = await fs.realpath(dataRoot), checks = {};
  if (!root.split(path.sep).includes('.smoke-data') || path.basename(root) !== 'workspace') throw new Error('Waiting recovery tests require an owned smoke workspace');
  const json = async (route, body) => (await requestApi(route, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {})).json();
  async function wait(expression) {
    for (let i = 0; i < 160; i++) { if (await window.webContents.executeJavaScript(expression)) return true; await new Promise(resolve => setTimeout(resolve, 50)); }
    throw new Error(`Waiting recovery timed out: ${expression}`);
  }
  async function click(label) {
    await window.webContents.executeJavaScript(`(()=>{const el=Array.from(document.querySelectorAll('button')).find(el=>el.innerText===${JSON.stringify(label)});if(!el||el.disabled)throw new Error('Recovery button unavailable');el.click();})()`);
  }
  async function language(locale) {
    await wait(`!!document.querySelector('[aria-label="Interface language / 界面语言"]')`);
    await window.webContents.executeJavaScript(`(()=>{const el=document.querySelector('[aria-label="Interface language / 界面语言"]');el.value=${JSON.stringify(locale)};el.dispatchEvent(new Event('change',{bubbles:true}));})()`);
    await wait(`document.documentElement.lang===${JSON.stringify(locale)}`);
  }
  const workbook = new AdmZip();
  workbook.addFile('xl/workbook.xml', Buffer.from('<workbook><sheets><sheet name="Upload" sheetId="1"/></sheets></workbook>'));
  workbook.addFile('xl/worksheets/sheet1.xml', Buffer.from('<worksheet><sheetData><row r="1">' + ['SKU', 'Title', 'Price', 'Stock', 'Main image'].map((text, col) => `<c r="${String.fromCharCode(65 + col)}1" t="inlineStr"><is><t>${text}</t></is></c>`).join('') + '</row></sheetData></worksheet>'));
  const form = new FormData(); form.append('template', new Blob([workbook.toBuffer()]), '恢复-业务原文.xlsx');
  form.append('options', JSON.stringify({ platformId: 'amazon', records: [{ sku: 'WAIT-RECOVERY', title: '等待-业务原文', price: 10, stock: 1, mainImageUrl: 'https://recovery.invalid/not-fetched.png' }] }));
  const template = await (await requestApi('/api/workbench/template-fills/preview', { method: 'POST', body: form })).json();
  if (!template.canExecute) throw new Error('Waiting template fixture is not executable');
  const preview = await json('/api/workbench/pricing-previews', { items: [{ sku: 'WAIT-SANDBOX', price: 10 }], rules: [{ type: 'fixed', value: 1 }] });
  const sandbox = await json('/api/platform/commerce-sandbox', { sourceId: preview.id, mode: 'local-sandbox', confirm: true });
  const directory = path.join(root, 'outputs', 'workbench', template.id), primary = path.join(directory, 'manifest.json');
  const before = await fs.readFile(primary), oldOrigin = origin;
  origin = await restartService(); // Restarts this isolated service, never the user's client.
  checks.waitingRecoveryOldServiceStopped = await fetch(`${oldOrigin}/api/health`).then(() => false, () => true);
  await language('en-US');
  const ids = [template.id, sandbox.id];
  await wait(ids.map(id => `document.querySelector('[data-recovery-id="${id}"] [data-recovery-state="waiting_user"]')?.innerText==='Awaiting user'`).join('&&'));
  checks.waitingRecoveryRestartVisible = true;
  checks.waitingRecoveryEnglishHints = await window.webContents.executeJavaScript(ids.map(id => `document.querySelector('[data-recovery-id="${id}"]')?.innerText.includes('Nothing runs automatically.')`).join('&&'));
  checks.waitingRecoveryUserTitlePreserved = await window.webContents.executeJavaScript(`document.querySelector('[data-recovery-id="${template.id}"]')?.innerText.includes('恢复-业务原文.xlsx')`);
  checks.waitingRecoveryReadsPreservePreview = before.equals(await fs.readFile(primary)) && (await json(`/api/platform/commerce-sandbox/${sandbox.id}`)).version === sandbox.version;
  checks.waitingRecoveryNoAutomaticOutput = await fs.access(path.join(directory, 'filled-template.xlsx')).then(() => false, error => error.code === 'ENOENT');
  await require('./smoke-screenshot.cjs').smokeScreenshot(window, path.join(root, 'waiting-recovery-english.png'), { selector: `[data-recovery-id="${template.id}"]` });
  await fs.writeFile(primary, '{interrupted-template-smoke');
  await window.webContents.executeJavaScript(`document.querySelector('[data-recovery-id="${template.id}"] a').click()`);
  await wait(`document.body.innerText.includes('Continue workbook-copy approval') && document.body.innerText.includes('WAIT-RECOVERY')`);
  checks.waitingRecoveryTemplateLink = true;
  await wait(`!!document.querySelector('[data-manifest-repair]')&&document.querySelector('[data-template-execute]')?.disabled`);
  checks.waitingRecoveryTemplateBlocksReadOnly = true;
  await window.webContents.executeJavaScript(`window.__templateRepairConfirm=0;window.confirm=()=>{window.__templateRepairConfirm++;return false;};document.querySelector('[data-manifest-repair]').click();void 0`);
  await wait(`window.__templateRepairConfirm===1&&!document.querySelector('[data-manifest-repair]').disabled`);
  checks.waitingRecoveryTemplateRepairCancelSafe = await fs.readFile(primary, 'utf8') === '{interrupted-template-smoke';
  await window.webContents.executeJavaScript(`window.confirm=()=>true;document.querySelector('[data-manifest-repair]').click();void 0`);
  await wait(`!document.querySelector('[data-manifest-recovery]')&&!document.querySelector('[data-template-execute]')?.disabled`);
  checks.waitingRecoveryTemplateRepairedNotExecuted = before.equals(await fs.readFile(primary)) && await fs.access(path.join(directory, 'filled-template.xlsx')).then(() => false, error => error.code === 'ENOENT');
  await window.webContents.executeJavaScript('window.confirm=()=>false;void 0'); await click('Approve changes & create copy');
  checks.waitingRecoveryTemplateCancelSafe = before.equals(await fs.readFile(primary));
  await window.webContents.executeJavaScript('window.confirm=()=>true;void 0'); await click('Approve changes & create copy');
  await wait(`!!document.querySelector('[data-result-download]')`);
  const completed = await json(`/api/workbench/jobs/${template.id}`);
  checks.waitingRecoveryTemplateApproved = completed.status === 'completed' && (await requestApi(completed.downloadUrl)).ok;
  await window.loadURL(`${origin}/desktop`); await wait(`!!document.querySelector('[data-recovery-id="${sandbox.id}"]')`);
  await window.webContents.executeJavaScript(`document.querySelector('[data-recovery-id="${sandbox.id}"] a').click()`);
  await wait(`document.querySelector('h1')?.innerText==='Local simulation sandbox' && document.body.innerText.includes('WAIT-SANDBOX')`);
  checks.waitingRecoverySandboxLink = true;
  await window.webContents.executeJavaScript('window.confirm=()=>false;void 0'); await click('Approve & continue simulation');
  checks.waitingRecoverySandboxCancelSafe = (await json(`/api/platform/commerce-sandbox/${sandbox.id}`)).version === sandbox.version;
  await window.webContents.executeJavaScript('window.confirm=()=>true;void 0'); await click('Approve & continue simulation');
  await wait(`document.body.innerText.includes('completed') && document.body.innerText.includes('receipt-')`);
  const simulated = await json(`/api/platform/commerce-sandbox/${sandbox.id}`);
  checks.waitingRecoverySandboxApproved = simulated.liveWritesEnabled === false && simulated.summary.successCount === 1 && simulated.items[0].attempt === 1;
  const recovery = await json('/api/desktop/runtime?pageSize=100');
  checks.waitingRecoveryCompletedRemoved = ids.every(id => !recovery.recovery.some(item => item.id === id));
  await window.loadURL(`${origin}/desktop`); await wait(`document.querySelector('h1')?.innerText==='Desktop & recovery'`); await language('zh-CN');
  await fs.writeFile(path.join(root, 'waiting-recovery-report.json'), JSON.stringify({ checks, scope: 'Real isolated local API previews, service restart, recovery links, UI approval cancellation/confirmation. No model calls, image requests or live shop writes.' }, null, 2));
  return checks;
}
module.exports = { waitingRecoverySmoke };
