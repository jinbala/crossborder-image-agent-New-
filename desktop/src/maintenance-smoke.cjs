const fs = require('node:fs/promises');
const path = require('node:path');
async function waitFor(window, expression) {
  for (let attempt = 0; attempt < 120; attempt++) {
    if (await window.webContents.executeJavaScript(expression)) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`维护页面验收超时：${expression}`);
}
async function language(window, locale) {
  await window.webContents.executeJavaScript(`(() => { const select = document.querySelector('select[aria-label="Interface language / 界面语言"]'); select.value = ${JSON.stringify(locale)}; select.dispatchEvent(new Event('change', {bubbles:true})); })()`);
  await waitFor(window, `document.documentElement.lang === ${JSON.stringify(locale)}`);
}
async function openPage(window, origin, route, heading) {
  await window.loadURL(`${origin}${route}`);
  await waitFor(window, `document.querySelector('h1')?.innerText === ${JSON.stringify(heading)}`);
}
async function clickText(window, text, scope = 'document') {
  await window.webContents.executeJavaScript(`(() => { const button = Array.from(${scope}.querySelectorAll('button')).find((node) => node.innerText === ${JSON.stringify(text)}); if (!button || button.disabled) throw new Error('Button unavailable: ' + ${JSON.stringify(text)}); button.click(); })()`);
}
async function maintenanceSmoke({ window, origin, dataRoot, requestApi }) {
  const checks = {}, fixtureNote = '验收备注-用户原文-001', fixtureRoot = 'D:\\仅测试\\用户原文';
  const json = async (route, method, payload) => (await requestApi(route, { method, headers: { 'Content-Type': 'application/json' }, ...(payload ? { body: JSON.stringify(payload) } : {}) })).json();
  window.webContents.session.webRequest.onBeforeRequest({ urls: [`${origin}/api/settings/effective`] }, (_details, callback) => callback({ cancel: true }));
  try {
    await window.loadURL(`${origin}/settings`);
    await waitFor(window, 'Boolean(document.querySelector("[data-settings-retry]")) && Boolean(document.querySelector("[role=alert]"))');
  } finally { window.webContents.session.webRequest.onBeforeRequest(null); }
  await window.webContents.executeJavaScript('document.querySelector("[data-settings-retry]").click()');
  checks.maintenanceSettingsLoadRecovered = await waitFor(window, 'Boolean(document.querySelector("textarea")) && !document.querySelector("[data-settings-retry]")');
  await waitFor(window, `Boolean(document.querySelector('select[aria-label="Interface language / 界面语言"]')) && Boolean(document.querySelector('textarea'))`);
  await language(window, 'en-US');
  checks.englishSettings = await waitFor(window, `document.querySelector('h1')?.innerText === 'Settings center' && document.body.innerText.includes('Provider preferences')`);
  await window.webContents.executeJavaScript(`(() => {
    function input(label) { return Array.from(document.querySelectorAll('label')).find((node) => node.innerText.trim() === label)?.querySelector('input'); }
    for (const [label, value] of [['Currency','CNY'],['Default import directory',${JSON.stringify(fixtureRoot)}],['Default concurrency','3']]) {
      const target = input(label); if (!target) throw new Error('Missing settings input: ' + label);
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(target,value); target.dispatchEvent(new Event('input',{bubbles:true}));
    }
  })()`);
  await language(window, 'zh-CN'); await language(window, 'en-US');
  checks.maintenanceSettingsFormPreserved = await window.webContents.executeJavaScript(`Array.from(document.querySelectorAll('input')).some((node)=>node.value===${JSON.stringify(fixtureRoot)}) && Array.from(document.querySelectorAll('input')).some((node)=>node.value==='CNY') && Boolean(document.querySelector('option[value="balanced"]')) && Boolean(document.querySelector('option[value="real_background"]'))`);
  await clickText(window, 'Save settings');
  await waitFor(window, `document.body.innerText.includes('Settings saved.')`);
  const saved = (await json('/api/settings/effective', 'GET')).userSettings;
  checks.maintenanceSettingsPersisted = saved.cost.currency === 'CNY' && saved.defaults.batchConcurrency === 3 && saved.importScan.rootDir === fixtureRoot && saved.importScan.enabled === false;
  await openPage(window, origin, '/snapshots', 'Project snapshots / backup & restore');
  await waitFor(window, `Array.from(document.querySelectorAll('label')).some((node)=>node.innerText.includes('Restore SQLite task database') && node.querySelector('input')?.checked)`);
  await window.webContents.executeJavaScript(`(() => {
    for (const text of ['Include uploads / originals','Include outputs / generated images','Include docs / reports','Include accounts, templates & workspace']) {
      const input = Array.from(document.querySelectorAll('label')).find((node)=>node.innerText===text)?.querySelector('input'); if (input?.checked) input.click();
    }
    const note = document.querySelector('input[placeholder]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(note,${JSON.stringify(fixtureNote)}); note.dispatchEvent(new Event('input',{bubbles:true}));
  })()`);
  await language(window, 'zh-CN'); await language(window, 'en-US');
  await clickText(window, 'Create snapshot');
  await waitFor(window, `Boolean(Array.from(document.querySelectorAll('[data-snapshot-id]')).find((node)=>node.innerText.includes(${JSON.stringify(fixtureNote)})))`);
  const snapshot = (await json('/api/snapshots', 'GET')).snapshots.find((entry) => entry.metadata?.notes?.includes(fixtureNote));
  if (!snapshot) throw new Error('Snapshot created by UI is missing');
  checks.maintenanceSnapshotOptionsPreserved = Object.values(snapshot.metadata.includeOptions).every((value) => value === false) && snapshot.metadata.safety.privateAccountDataIncluded === false && snapshot.metadata.notes[0] === fixtureNote;
  try { const preview = await window.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true }); if (!preview.isEmpty()) await fs.writeFile(path.join(dataRoot, 'maintenance-backup-english.png'), preview.toPNG()); } catch { /* Visual capture availability does not weaken functional checks. */ }
  await json('/api/settings', 'PUT', { ...saved, cost: { ...saved.cost, currency: 'USD' } });
  await window.webContents.executeJavaScript(`(() => {
    for (const text of ['Restore db.json','Restore workspace (revoke old access)','Restore material ledger','Restore uploads','Restore outputs','Restore docs']) {
      const input = Array.from(document.querySelectorAll('label')).find((node)=>node.innerText===text)?.querySelector('input'); if (input?.checked) input.click();
    }
    window.__maintenanceConfirm = []; window.confirm = (text) => { window.__maintenanceConfirm.push(text); return false; };
  })()`);
  const row = `document.querySelector('[data-snapshot-id="${snapshot.snapshotId}"]')`;
  await clickText(window, 'Restore', row);
  checks.maintenanceCancelledRestoreSafe = (await json('/api/settings/effective', 'GET')).userSettings.cost.currency === 'USD' && await window.webContents.executeJavaScript(`window.__maintenanceConfirm.length === 1 && window.__maintenanceConfirm[0].startsWith('Restoring overwrites selected')`);
  await window.webContents.executeJavaScript('window.confirm = (text) => { window.__maintenanceConfirm.push(text); return true; }; void 0');
  await clickText(window, 'Restore', row);
  await waitFor(window, `document.body.innerText.includes('Restore completed:')`);
  checks.maintenanceBackupRoundTrip = (await json('/api/settings/effective', 'GET')).userSettings.cost.currency === 'CNY' && await window.webContents.executeJavaScript('window.__maintenanceConfirm.length === 2');
  const temporary = path.join(dataRoot, '.vision-tmp', '临时样本-locale.tmp');
  await fs.mkdir(path.dirname(temporary), { recursive: true }); await fs.writeFile(temporary, 'isolated smoke fixture');
  const older = new Date(Date.now() - 100 * 86400000); await fs.utimes(temporary, older, older);
  await openPage(window, origin, '/cleanup', 'Data cleanup / temporary files');
  await window.webContents.executeJavaScript(`(() => {
    for (const input of document.querySelectorAll('input[type=checkbox]')) {
      const should = input.closest('label').innerText.includes('Temporary vision files'); if (input.checked !== should) input.click();
    }
    const input = document.querySelector('input[type=number]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'0'); input.dispatchEvent(new Event('input',{bubbles:true}));
  })()`);
  await new Promise((resolve) => setTimeout(resolve, 100)); await clickText(window, 'Preview cleanup candidates');
  await waitFor(window, `document.body.innerText.includes('临时样本-locale.tmp') && document.body.innerText.includes('Safe to delete')`);
  await window.webContents.executeJavaScript('window.__cleanupConfirm = []; window.confirm = (text) => { window.__cleanupConfirm.push(text); return false; }; void 0');
  await clickText(window, 'Delete previewed files');
  const retained = await fs.stat(temporary).then(() => true, () => false);
  await window.webContents.executeJavaScript('window.confirm = (text) => { window.__cleanupConfirm.push(text); return true; }; void 0');
  await clickText(window, 'Delete previewed files');
  await waitFor(window, `document.body.innerText.includes('Cleanup completed:')`);
  checks.maintenanceCleanupConfirmation = retained && !(await fs.stat(temporary).then(() => true, () => false)) && await window.webContents.executeJavaScript(`window.__cleanupConfirm.length === 2 && window.__cleanupConfirm.every((text)=>text.includes('cannot be undone'))`);
  checks.englishStorage = await openPage(window, origin, '/storage', 'Storage management / SQLite trial').then(() => waitFor(window, `document.body.innerText.includes('SQLite trial actions') && document.body.innerText.includes('Current storage status')`));
  await openPage(window, origin, '/health', 'System health checks');
  checks.englishHealthRawReport = await waitFor(window, `document.body.innerText.includes('Core environment variables') && Array.from(document.querySelectorAll('pre')).some((node)=>node.innerText.includes('# CrossBorder Image Agent 系统健康检查报告'))`);
  await language(window, 'zh-CN');
  checks.maintenanceLanguageRestored = await waitFor(window, `document.querySelector('h1')?.innerText === '系统健康检查'`);
  return checks;
}
module.exports = { maintenanceSmoke };
