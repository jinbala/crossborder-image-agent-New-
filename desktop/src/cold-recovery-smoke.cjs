const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { spawn } = require('node:child_process');
const { isInside } = require('./runtime.cjs');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

async function wait(window, expression, deadline) {
  while (Date.now() < deadline) {
    if (await window.webContents.executeJavaScript(expression)) return true;
    await pause(100);
  }
  return false;
}

async function seedRecoveryProfile(dataRoot) {
  const profileParent = await fs.realpath(path.dirname(dataRoot));
  if (!profileParent.split(path.sep).includes('.smoke-data') || path.basename(dataRoot) !== 'workspace') throw new Error('Cold recovery fixtures require a smoke-only workspace');
  const profile = path.join(profileParent, `cold-recovery-${randomUUID()}`);
  await fs.mkdir(profile); // Never overwrite an existing profile, including the user's desktop profile.
  if (!isInside(profileParent, await fs.realpath(profile))) throw new Error('Fixture profile escaped smoke root');
  const workbench = path.join(profile, 'workspace', 'outputs', 'workbench');
  await fs.mkdir(workbench, { recursive: true });
  const manifests = [], timestamp = new Date().toISOString();
  for (let offset = 0; offset < 10000; offset += 64) {
    await Promise.all(Array.from({ length: Math.min(64, 10000 - offset) }, async (_, index) => {
      const id = `collect-job-cold-${String(offset + index).padStart(5, '0')}`;
      const directory = path.join(workbench, id), file = path.join(directory, 'manifest.json');
      const position = offset + index;
      const state = { id, type: 'collection-job', status: 'paused', options: { name: `冷启动恢复 ${id}`, mode: 'normal', replacementRules: [], minSales: 0, extraWaitMs: 0, timeoutMs: 10000, maxImagesPerProduct: 10, maxAttempts: 2, downloadOriginal: true, randomFileNames: false },
        summary: { total: 1, pending: 1 }, checkpointRevision: 2, createdAt: timestamp, updatedAt: timestamp,
        items: [{ id: 'item-00001', index: 1, sku: 'COLD', title: '', status: 'pending', attempts: 0, imageUrls: ['https://benchmark.invalid/a.png'], images: [], productUrl: 'https://benchmark.invalid/not-requested' }] };
      const bytes = JSON.stringify(state);
      await fs.mkdir(directory);
      async function fixtureFile(name, content) { const target = path.join(directory, name); await fs.writeFile(target, content, { flag: 'wx' }); manifests.push({ file: target, hash: digest(content) }); }
      if (position < 3) {
        if (position !== 1) await fixtureFile('manifest.json', '{interrupted');
        if (position !== 1) await fixtureFile('manifest.backup.json', bytes);
        if (position !== 0) {
          const archive = new (require('adm-zip'))();
          archive.addFile('manifest.json', Buffer.from(JSON.stringify({ ...state, checkpointRevision: position === 2 ? 1 : 2 })));
          await fixtureFile(`${id}.zip`, archive.toBuffer());
        }
      } else { await fs.writeFile(file, bytes, { flag: 'wx' }); manifests.push({ file, hash: digest(bytes) }); }
    }));
  }
  await fs.writeFile(path.join(profile, 'desktop-session.json'), JSON.stringify({ version: 1, runId: randomUUID(), state: 'running', startedAt: timestamp }), { flag: 'wx' });
  return { profile, manifests };
}

function workbook(rows) {
  const AdmZip = require('adm-zip'), archive = new AdmZip();
  const escape = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
  const cells = rows.map((values, row) => `<row r="${row + 1}">${values.map((value, col) => `<c r="${String.fromCharCode(65 + col)}${row + 1}" t="inlineStr"><is><t>${escape(value)}</t></is></c>`).join('')}</row>`).join('');
  const files = {
    '[Content_Types].xml': '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>',
    '_rels/.rels': '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
    'xl/workbook.xml': '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Products" sheetId="1" r:id="rId1"/></sheets></workbook>',
    'xl/_rels/workbook.xml.rels': '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>',
    'xl/worksheets/sheet1.xml': `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${cells}</sheetData></worksheet>`
  };
  for (const [name, contents] of Object.entries(files)) archive.addFile(name, Buffer.from(contents));
  return archive.toBuffer();
}

async function importPerformance(requestApi) {
  const rows = [['SKU', '销量', '商品链接', '图片链接'], ...Array.from({ length: 1000 }, (_, index) =>
    [`COLD-${index}`, String(index), `https://benchmark.invalid/product/${index}`, `https://images.benchmark.invalid/${index}.png`])];
  const metrics = {}, checks = {};
  for (const [format, bytes] of [['csv', Buffer.from('\ufeff' + rows.map(row => row.join(',')).join('\r\n'))], ['xlsx', workbook(rows)]]) {
    const form = new FormData(); form.append('sheet', new Blob([bytes]), `benchmark-1000.${format}`);
    form.append('options', JSON.stringify({ name: `1000-row ${format} import benchmark` }));
    const started = performance.now();
    const result = await (await requestApi('/api/workbench/collection-jobs', { method: 'POST', body: form })).json();
    metrics[`${format}ImportMs`] = Math.round(performance.now() - started);
    checks[`${format}ThousandRowImport`] = metrics[`${format}ImportMs`] < 10000 && result.items?.length === 1000 && result.items.every(item => item.status === 'pending') && result.status === 'queued';
  }
  return { metrics, checks };
}

async function coldRecoverySmoke({ dataRoot, requestApi, executable, appPath, packaged, version }) {
  const imports = await importPerformance(requestApi);
  const { profile, manifests } = await seedRecoveryProfile(dataRoot);
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const bootStart = Date.now();
  const code = await new Promise((resolve, reject) => {
    const child = spawn(executable, [...(packaged ? [] : [appPath]), '--smoke-test', '--smoke-recovery-probe', `--smoke-root=${profile}`, `--recovery-benchmark-start=${bootStart}`], { env, windowsHide: true, stdio: 'ignore' });
    const timer = setTimeout(() => { child.kill(); reject(new Error('Cold recovery child timed out (own smoke profile only)')); }, 120000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => { clearTimeout(timer); resolve(code); });
  });
  const report = JSON.parse(await fs.readFile(path.join(profile, 'recovery-performance.json'), 'utf8'));
  const checks = { ...imports.checks, ...report.checks,
    coldRecoveryChild: code === 0 && report.ok === true && report.version === version && report.packaged === packaged,
    coldRecoveryCleanExit: JSON.parse(await fs.readFile(path.join(profile, 'desktop-session.json'), 'utf8')).state === 'stopped' };
  let unchanged = true;
  for (let offset = 0; offset < manifests.length; offset += 64) {
    const matches = await Promise.all(manifests.slice(offset, offset + 64).map(async item => digest(await fs.readFile(item.file)) === item.hash));
    if (matches.some(value => !value)) unchanged = false;
  }
  checks.coldRecoveryManifestsUnchanged = unchanged;
  await fs.writeFile(path.join(dataRoot, 'recovery-performance.json'), JSON.stringify({ ...report, ok: Object.values(checks).every(Boolean), checks, metrics: { ...report.metrics, ...imports.metrics }, fixtureProfile: path.basename(profile), scope: 'Process-cold Electron restart with 10000 local metadata manifests; OS disk cache not purged. Mock services, no image download or paid/platform execution. Foreground-equivalent renderer timers.' }, null, 2));
  return checks;
}

async function runRecoveryProbe({ window, dataRoot, requestApi, startupRecovery, version, packaged, startupTrace }) {
  const bootStart = Number(process.argv.find(arg => arg.startsWith('--recovery-benchmark-start='))?.split('=')[1]);
  if (!Number.isFinite(bootStart) || bootStart > Date.now() || Date.now() - bootStart > 120000) throw new Error('Invalid cold recovery benchmark start');
  const checks = {}, metrics = {};
  await window.webContents.executeJavaScript(`(() => {
    const state=window.__recoveryProbe={ticks:0,maxGapMs:0,last:performance.now(),requests:0,writes:0,fetch:window.fetch};
    state.timer=setInterval(()=>{const now=performance.now();state.maxGapMs=Math.max(state.maxGapMs,now-state.last);state.last=now;state.ticks++;},50);
    window.fetch=(input,options)=>{const url=new URL(typeof input==='string'?input:input.url,location.href);if(url.pathname==='/api/desktop/runtime')state.requests++;if((options?.method||input?.method||'GET')!=='GET')state.writes++;return state.fetch.call(window,input,options);};
  })()`);
  try {
    checks.coldRecoveryStartupRoute = startupRecovery && await wait(window, `location.pathname==='/desktop' && Boolean(document.querySelector('[data-startup-recovery]'))`, bootStart + 30000);
    checks.coldRecoveryVisibleWithin30s = await wait(window, `document.querySelectorAll('[data-recovery-id]').length===50`, bootStart + 30000);
    metrics.firstVisibleMs = Date.now() - bootStart;
    // Diagnostics only: the acceptance clock still starts before child spawn,
    // not at navigation, authentication, API completion, or the first item.
    metrics.startupStagesMs = Object.fromEntries(Object.entries(startupTrace || {}).map(([name, timestamp]) => [name, timestamp - bootStart]));
    metrics.rendererStartup = await window.webContents.executeJavaScript(`(() => {
      const relative=value=>Math.round(performance.timeOrigin+value-${bootStart});
      const navigation=performance.getEntriesByType('navigation')[0];
      const resources=performance.getEntriesByType('resource').filter(entry=>{
        const url=new URL(entry.name);return url.origin===location.origin &&
          (url.pathname.startsWith('/assets/') || ['/api/auth/session','/api/desktop/runtime'].includes(url.pathname));
      });
      return {navigationStartMs:relative(0),domInteractiveMs:relative(navigation?.domInteractive||0),
        resources:resources.map(entry=>({path:new URL(entry.name).pathname,startMs:relative(entry.startTime),endMs:relative(entry.responseEnd),durationMs:Math.round(entry.duration)}))};
    })()`);
    const stages = ['mainEntered', 'appReady', 'sessionReady', 'extensionReady', 'serviceForked', 'serviceReady', 'windowStarting', 'windowCreated', 'cookieReady', 'documentLoaded'];
    checks.coldRecoveryStartupMeasurements = stages.every((name, index) => {
      const elapsed = metrics.startupStagesMs[name];
      return Number.isFinite(elapsed) && elapsed >= 0 && elapsed <= metrics.firstVisibleMs &&
        (!index || elapsed >= metrics.startupStagesMs[stages[index - 1]]);
    }) && metrics.rendererStartup.navigationStartMs >= 0 && metrics.rendererStartup.domInteractiveMs >= metrics.rendererStartup.navigationStartMs;
    checks.coldRecoveryIndexComplete = await wait(window, `document.querySelector('[data-recovery-index-status="completed"]')?.innerText.includes('collect-job-cold-') && document.querySelector('[data-recovery-pager]')?.innerText.includes('10000')`, bootStart + 90000);
    metrics.indexCompleteMs = Date.now() - bootStart;
    const pages = [];
    for (const page of [1, 2]) {
      const started = performance.now();
      const runtime = await (await requestApi(`/api/desktop/runtime?page=${page}&pageSize=50`)).json();
      metrics[`page${page}ResponseMs`] = Math.round(performance.now() - started); pages.push(runtime);
    }
    checks.coldRecoveryTenThousandPaged = pages.every((page, index) => page.recovery.length === 50 && page.recoveryPagination.page === index + 1 && page.recoveryPagination.total === 10000 && metrics[`page${index + 1}ResponseMs`] < 2000) && new Set(pages.flatMap(page => page.recovery.map(item => item.id))).size === 100;
    checks.coldRecoverySnapshotIndex = pages[0].indexStatus.recovered === 3 && pages[0].indexStatus.failed === 0 &&
      ['backup', 'archive', 'backup'].every((source, index) => pages[0].recovery.find(item => item.id === `collect-job-cold-${String(index).padStart(5, '0')}`)?.manifestRecovery?.source === source);
    checks.coldRecoverySnapshotNotice = await window.webContents.executeJavaScript(`Boolean(document.querySelector('[data-recovery-snapshot-count]')?.innerText.includes('3')) && document.querySelector('[data-recovery-id="collect-job-cold-00000"]')?.innerText.includes('只读')`);
    for (const index of [0, 1, 2]) {
      const detail = await (await requestApi(`/api/workbench/collection-jobs/collect-job-cold-${String(index).padStart(5, '0')}`)).json();
      checks.coldRecoverySnapshotIndex &&= detail.manifestRead?.readOnly === true && detail.items?.length === 1 && detail.items[0].status === 'pending';
    }
    const before = await window.webContents.executeJavaScript(`Array.from(document.querySelectorAll('[data-recovery-id]'),node=>node.dataset.recoveryId)`);
    await window.webContents.executeJavaScript(`document.querySelector('[data-recovery-pager] button:last-of-type').click()`);
    checks.coldRecoveryUiPagination = await wait(window, `Boolean(document.querySelector('[data-recovery-loaded-page="2"]')) && document.querySelectorAll('[data-recovery-id]').length===50`, Date.now() + 5000);
    const after = await window.webContents.executeJavaScript(`Array.from(document.querySelectorAll('[data-recovery-id]'),node=>node.dataset.recoveryId)`);
    checks.coldRecoveryUiPagination &&= before.length === 50 && after.length === 50 && new Set([...before, ...after]).size === 100 &&
      JSON.stringify(before) === JSON.stringify(pages[0].recovery.map(item => item.id)) && JSON.stringify(after) === JSON.stringify(pages[1].recovery.map(item => item.id));
    const requests = await window.webContents.executeJavaScript('window.__recoveryProbe.requests');
    await pause(1300);
    const ui = await window.webContents.executeJavaScript(`({...window.__recoveryProbe,fetch:null,timer:null})`);
    metrics.rendererMaxGapMs = Math.round(ui.maxGapMs); metrics.rendererTicks = ui.ticks; metrics.runtimeRequests = ui.requests;
    checks.coldRecoveryPollingStops = ui.requests === requests && ui.requests > 0;
    checks.coldRecoveryRendererResponsive = ui.ticks >= 10 && ui.maxGapMs < 1000;
    checks.coldRecoveryNoAutoExecution = ui.writes === 0;
    window.webContents.invalidate();
    await require('./smoke-screenshot.cjs').smokeScreenshot(window, path.join(dataRoot, 'cold-recovery.png'));
    await require('./smoke-screenshot.cjs').smokeScreenshot(window, path.join(dataRoot, 'cold-recovery-list.png'), { selector: '[data-recovery-index-status]' });
  } finally {
    await window.webContents.executeJavaScript(`(() => {const state=window.__recoveryProbe;clearInterval(state.timer);window.fetch=state.fetch;delete window.__recoveryProbe;})()`);
  }
  const report = { ok: Object.values(checks).every(Boolean), version, packaged, checks, metrics, fixtureCount: 10000 };
  await fs.writeFile(path.join(path.dirname(dataRoot), 'recovery-performance.json'), JSON.stringify(report, null, 2));
  return report;
}

module.exports = { coldRecoverySmoke, runRecoveryProbe };
