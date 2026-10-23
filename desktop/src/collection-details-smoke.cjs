const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');

async function collectionDetailsSmoke({ window, origin, dataRoot, requestApi }) {
  const root = await fs.realpath(dataRoot);
  if (!root.split(path.sep).includes('.smoke-data') || path.basename(root) !== 'workspace') throw new Error('Collection details require an owned smoke workspace');
  const checks = {};
  async function json(route, options) {
    const response = await requestApi(route, options), value = await response.json();
    if (!response.ok) throw new Error(`Collection details fixture ${response.status}: ${route}`);
    return value;
  }
  async function wait(expression) {
    for (let i = 0; i < 200; i++) {
      if (await window.webContents.executeJavaScript(expression)) return;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error(`Collection details timed out: ${expression}`);
  }
  async function select(selector, value) {
    await window.webContents.executeJavaScript(`(()=>{const el=document.querySelector(${JSON.stringify(selector)});el.value=${JSON.stringify(value)};el.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  }
  async function search(value) {
    await window.webContents.executeJavaScript(`(()=>{const el=document.querySelector('[data-collection-item-search]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el,${JSON.stringify(value)});el.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  }
  const rows = Array.from({ length: 60 }, (_, i) => ({ sku: `TABLE-${String(i + 1).padStart(3, '0')}`, title: i ? '筛选商品原文' : '=1+1', sales: i < 45 ? 2 : 0, imageUrls: [`https://fixture.invalid/table-${i}.png`] }));
  const job = await json('/api/workbench/collection-jobs/rows', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ rows, options: { name: '采集明细分页夹具', minSales: 1, extraWaitMs: 0 } }) });
  const manifestFile = path.join(root, 'outputs', 'workbench', job.id, 'manifest.json');
  const before = await fs.readFile(manifestFile);
  await window.loadURL(`${origin}/workbench/collection?jobId=${encodeURIComponent(job.id)}`);
  await wait(`document.querySelectorAll('[data-collection-item]').length===25`);
  const first = await window.webContents.executeJavaScript(`Array.from(document.querySelectorAll('[data-collection-item]')).map(el=>el.dataset.collectionItem)`);
  await window.webContents.executeJavaScript(`document.querySelector('[data-collection-item-next]').click()`);
  await wait(`document.querySelector('[data-collection-item-pagination]')?.innerText.includes('2 / 3')`);
  const second = await window.webContents.executeJavaScript(`Array.from(document.querySelectorAll('[data-collection-item]')).map(el=>el.dataset.collectionItem)`);
  checks.collectionDetailPagesBounded = first.length === 25 && second.length === 25 && new Set([...first, ...second]).size === 50 && first.every((id, i) => id === job.items[i].id) && second.every((id, i) => id === job.items[i + 25].id);
  await select('[data-collection-item-status]', 'pending');
  await wait(`document.querySelector('[data-collection-item-pagination]')?.innerText.includes('1 / 2')&&document.querySelector('[data-collection-item-pagination]').innerText.includes('45')`);
  await window.webContents.executeJavaScript(`document.querySelector('[data-collection-item-next]').click()`);
  await wait(`document.querySelectorAll('[data-collection-item]').length===20`);
  checks.collectionDetailStatusFilters = await window.webContents.executeJavaScript(`Array.from(document.querySelectorAll('[data-collection-item]')).every(el=>el.innerText.includes('待处理'))&&document.querySelector('[data-collection-item-status]').value==='pending'`);

  const csvFile = path.join(root, 'collection-filtered-ui.csv');
  const downloaded = new Promise((resolve, reject) => {
    const timer = setTimeout(() => { window.webContents.session.removeListener('will-download', save); reject(new Error('Collection CSV download timed out')); }, 15000);
    function save(_event, item) { item.setSavePath(csvFile); item.once('done', (_done, state) => { clearTimeout(timer); state === 'completed' ? resolve() : reject(new Error(`Collection CSV ${state}`)); }); }
    window.webContents.session.once('will-download', save);
  });
  await window.webContents.executeJavaScript(`document.querySelector('[data-collection-item-export]').click()`);
  await downloaded;
  const csv = await fs.readFile(csvFile, 'utf8'), lines = csv.replace(/^\uFEFF/, '').trimEnd().split('\r\n');
  checks.collectionDetailCsvAllFiltered = csv.startsWith('\uFEFF') && lines.length === 46 && csv.includes('"TABLE-001"') && csv.includes('"TABLE-045"') && !csv.includes('"TABLE-046"') && csv.includes('"\'=1+1"') && lines.slice(1).every(line => line.includes('"pending"'));
  await search('TABLE-003');
  await wait(`document.querySelectorAll('[data-collection-item]').length===1&&document.querySelector('[data-collection-items]').innerText.includes('TABLE-003')`);
  await select('[data-collection-item-status]', 'skipped');
  await wait(`!!document.querySelector('[data-collection-items-empty]')&&document.querySelectorAll('[data-collection-item]').length===0`);
  checks.collectionDetailSearchAndEmpty = await window.webContents.executeJavaScript(`document.querySelector('[data-collection-item-next]').disabled&&document.querySelector('[data-collection-item-prev]').disabled`);
  await search('');
  await wait(`document.querySelectorAll('[data-collection-item]').length===15`);
  await select('[data-collection-item-size]', '100');
  await select('[data-collection-item-status]', '');
  await wait(`document.querySelectorAll('[data-collection-item]').length===60`);
  checks.collectionDetailPageSize = true;
  await select('[aria-label="Interface language / 界面语言"]', 'en-US');
  await wait(`document.querySelector('[data-collection-item-export]')?.innerText==='Export filtered products CSV'`);
  checks.collectionDetailLanguageKeepsRaw = await window.webContents.executeJavaScript(`document.querySelector('[data-collection-items]').innerText.includes('筛选商品原文')&&document.querySelector('[data-collection-items]').innerText.includes('Pending')&&document.querySelector('[data-collection-item-size]').value==='100'`);
  await window.webContents.executeJavaScript(`document.querySelector('[data-collection-items]').scrollIntoView({block:'center'})`);
  await require('./smoke-screenshot.cjs').smokeScreenshot(window, path.join(root, 'collection-details-english.png'));
  await select('[aria-label="Interface language / 界面语言"]', 'zh-CN');
  checks.collectionDetailReadOnly = (await fs.readFile(manifestFile)).equals(before);

  // Actual local cancellation, then reject a late upload before processing data.
  await json(`/api/platform/task-center/${job.id}/actions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'cancel', confirm: true }) });
  const cancelled = await json(`/api/workbench/collection-jobs/${job.id}`);
  const cancelledBytes = await fs.readFile(manifestFile);
  const lateStatus = await window.webContents.executeJavaScript(`fetch(${JSON.stringify(`/api/workbench/collection-jobs/${job.id}/browser-images`)},{method:'POST',body:new FormData()}).then(response=>response.status)`);
  checks.collectionCancelledRejectsLateUpload = lateStatus === 409 && (await fs.readFile(manifestFile)).equals(cancelledBytes);
  await window.loadURL(`${origin}/workbench/collection?jobId=${encodeURIComponent(job.id)}`);
  await wait(`document.querySelector('[data-collection-next-step]')?.dataset.collectionNextStep==='cancelled'`);
  checks.collectionCancelledGuide = cancelled.status === 'cancelled' && await window.webContents.executeJavaScript(`document.querySelector('[data-collection-next-step]').innerText.includes('不会自动继续下载')`);

  // Explicit response fixture: no real run/network is allowed for fixture.invalid.
  // Exercise UI confirmation and stop acknowledgement with real click handlers.
  await window.webContents.executeJavaScript(`window.__tableRun={fetch:window.fetch,confirm:window.confirm,calls:0,confirmations:0,allow:false,job:${JSON.stringify(cancelled)}};window.confirm=()=>{window.__tableRun.confirmations++;return window.__tableRun.allow;};window.fetch=(input,options)=>{const state=window.__tableRun,url=new URL(typeof input==='string'?input:input.url,location.href);if(url.origin!==location.origin)throw new Error('Table smoke forbids remote requests');if((options?.method||'GET')==='POST'){if(url.pathname!==${JSON.stringify(`/api/workbench/collection-jobs/${job.id}/run`)})throw new Error('Table smoke forbids other writes');state.calls++;return Promise.resolve(new Response(JSON.stringify({...state.job,status:'paused',summary:{...state.job.summary,pendingCount:44},stopRequested:'pause'}),{status:200,headers:{'Content-Type':'application/json'}}));}return state.fetch.call(window,input,options);};void 0;`);
  try {
    await window.webContents.executeJavaScript(`Array.from(document.querySelectorAll('button')).find(el=>el.innerText==='连续处理全部').click()`);
    checks.collectionCancelledRequiresConfirmation = await window.webContents.executeJavaScript('window.__tableRun.calls===0&&window.__tableRun.confirmations===1');
    await window.webContents.executeJavaScript(`window.__tableRun.allow=true;Array.from(document.querySelectorAll('button')).find(el=>el.innerText==='连续处理全部').click()`);
    await wait(`window.__tableRun.calls===1&&Array.from(document.querySelectorAll('button')).some(el=>el.innerText==='连续处理全部'&&!el.disabled)&&document.querySelector('[data-collection-next-step]')?.dataset.collectionNextStep==='pending'`);
    // A second renderer task confirms no next batch was queued after the response.
    await window.webContents.executeJavaScript('new Promise(resolve=>setTimeout(resolve,100))');
    checks.collectionContinuousHonorsStop = await window.webContents.executeJavaScript('window.__tableRun.calls===1&&window.__tableRun.confirmations===2');
  } finally {
    await window.webContents.executeJavaScript('window.fetch=window.__tableRun.fetch;window.confirm=window.__tableRun.confirm;delete window.__tableRun;void 0');
  }
  checks.collectionStopFixtureNoWrites = createHash('sha256').update(await fs.readFile(manifestFile)).digest('hex') === createHash('sha256').update(cancelledBytes).digest('hex');
  return checks;
}

module.exports = { collectionDetailsSmoke };
