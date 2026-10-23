const fs=require('node:fs/promises');
const path=require('node:path');
const {isInside}=require('./runtime.cjs');
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function wait(window,expression){for(let i=0;i<200;i++){if(await window.webContents.executeJavaScript(expression))return true;await pause(100);}throw new Error(`Export report UI timed out: ${expression}`);}
async function locale(window,value){await window.webContents.executeJavaScript(`(()=>{const el=document.querySelector('select[aria-label="Interface language / 界面语言"]');el.value=${JSON.stringify(value)};el.dispatchEvent(new Event('change',{bubbles:true}));})()`);await wait(window,`document.documentElement.lang===${JSON.stringify(value)}`);}
async function click(window,selector,expression){await wait(window,`document.querySelector(${JSON.stringify(selector)})&&!document.querySelector(${JSON.stringify(selector)}).disabled`);await window.webContents.executeJavaScript(`document.querySelector(${JSON.stringify(selector)}).click()`);await wait(window,expression+`&&!document.querySelector(${JSON.stringify(selector)}).disabled`);}
async function screenshot(window,file,selector){await require('./smoke-screenshot.cjs').smokeScreenshot(window,file,{selector});}
async function download(window,destination,selector){const done=new Promise((resolve,reject)=>{const timer=setTimeout(()=>{window.webContents.session.removeListener('will-download',save);reject(new Error('Export report JSON download timed out'));},15000);function save(_event,item){item.setSavePath(destination);item.once('done',(_done,state)=>{clearTimeout(timer);state==='completed'?resolve():reject(new Error(`Export report download ${state}`));});}window.webContents.session.once('will-download',save);});await window.webContents.executeJavaScript(`document.querySelector(${JSON.stringify(selector)}).click()`);await done;return fs.readFile(destination,'utf8');}

async function exportReportsI18nSmoke({window,origin,dataRoot,requestApi}){
  const root=await fs.realpath(dataRoot),checks={};if(!root.split(path.sep).includes('.smoke-data')||path.basename(root)!=='workspace')throw new Error('Export report verification requires an owned smoke workspace');
  const batches=(await(await requestApi('/api/batches')).json()).batchTasks,batch=batches.find(item=>item.name==='多目标-022-原文');if(!batch)throw new Error('Missing actual multi-target mock fixture');
  const sqlite=await fs.realpath(path.join(root,'backend','data','app.sqlite'));if(!isInside(root,sqlite))throw new Error('Export report database escaped smoke workspace');
  const snapshot=()=>{const db=new(require('better-sqlite3'))(sqlite,{readonly:true});try{return JSON.stringify({batch:db.prepare('SELECT data_json FROM batch_tasks WHERE id=?').get(batch.id),tasks:db.prepare('SELECT id,data_json FROM tasks WHERE id IN (SELECT value FROM json_each(?)) ORDER BY id').all(JSON.stringify(batch.skuTasks.map(sku=>sku.taskId)))});}finally{db.close();}};
  const before=snapshot();await window.loadURL(`${origin}/batches/${batch.id}`);await wait(window,`document.querySelector('[data-export-package-preview]')&&!document.querySelector('[data-export-package-preview]').disabled`);await locale(window,'en-US');
  await window.webContents.executeJavaScript(`(()=>{window.__exportLocale={fetch:window.fetch,calls:[],replies:{}};window.fetch=async(input,options)=>{const url=new URL(typeof input==='string'?input:input.url,location.href),method=options?.method||input?.method||'GET';if(url.origin!==location.origin)throw new Error('Export localization test refuses external network');if(method!=='GET'&&!['/api/batches/${batch.id}/upload-payload/preview','/api/batches/${batch.id}/upload-sandbox/simulate'].includes(url.pathname))throw new Error('Export localization test refuses non-preview mutation');window.__exportLocale.calls.push({path:url.pathname,query:url.search,method,body:options?.body});const response=await window.__exportLocale.fetch.call(window,input,options);if(!response.ok)throw new Error('Export report request failed '+response.status);if(response.headers.get('content-type')?.includes('json'))window.__exportLocale.replies[url.pathname]=await response.clone().json();return response;};})()`);
  try{
    await window.webContents.executeJavaScript(`document.querySelector('[data-export-package-samples]').click()`);await pause(30);
    await click(window,'[data-export-package-preview]',`document.querySelector('[data-export-package-card="totalSku"]')?.innerText.includes('Total SKUs')`);
    checks.exportReportPackageEnglish=await window.webContents.executeJavaScript(`document.querySelector('[data-export-package-card="readyImageCount"]').innerText.includes('Exportable images')&&Array.from(document.querySelectorAll('[data-export-package-path]')).some(el=>el.innerText.includes('Ready / Mock previews'))`);
    await screenshot(window,path.join(root,'export-report-package-english.png'),'[data-export-package-card="totalSku"]');
    await window.webContents.executeJavaScript(`document.querySelector('[data-listing-csv-samples]').click()`);await pause(30);
    await click(window,'[data-listing-csv-preview]',`Boolean(window.__exportLocale.replies['/api/batches/${batch.id}/listing-csv/preview'])`);
    checks.exportReportSamplePreviewOptions=await window.webContents.executeJavaScript(`['export-package/preview','listing-csv/preview'].every(end=>window.__exportLocale.calls.some(call=>call.path.endsWith(end)&&new URLSearchParams(call.query).get('includeRealSamples')==='true'))`);
    await click(window,'[data-upload-readiness-preview]',`document.querySelector('[data-upload-readiness-card]')?.innerText.includes('Total SKUs')`);
    checks.exportReportReadinessEnglish=await window.webContents.executeJavaScript(`Array.from(document.querySelectorAll('[data-upload-readiness-card]')).some(el=>el.innerText.includes('Can upload now'))`);
    await click(window,'[data-upload-payload-preview]',`document.querySelector('[data-upload-payload-card]')?.innerText.includes('Total SKUs')`);
    await click(window,'[data-upload-sandbox-preview]',`document.querySelector('[data-upload-sandbox-card]')?.innerText.includes('Simulated acceptance')`);
    checks.exportReportPayloadSandboxEnglish=await window.webContents.executeJavaScript(`Array.from(document.querySelectorAll('[data-upload-payload-card]')).some(el=>el.innerText.includes('Ready payloads'))&&Array.from(document.querySelectorAll('[data-upload-sandbox-card]')).some(el=>el.innerText.includes('Real network called')&&el.innerText.includes('No'))`);
    await screenshot(window,path.join(root,'export-report-sandbox-english.png'),'[data-upload-sandbox-card]');
    await click(window,'[data-upload-safety-preview]',`Boolean(document.querySelector('[data-upload-safety-card]'))`);
    checks.exportReportSafetyEnglish=await window.webContents.executeJavaScript(`Array.from(document.querySelectorAll('[data-upload-safety-card]')).some(el=>el.innerText.includes('Ready for real upload')&&el.innerText.includes('No'))`);
    const english=[];for(const name of ['readiness','payload','sandbox','safety'])english.push(await download(window,path.join(root,`export-report-${name}-en.json`),`[data-upload-${name}-download]`));
    const calls=await window.webContents.executeJavaScript('window.__exportLocale.calls.length');
    await locale(window,'zh-CN');await wait(window,`document.querySelector('[data-upload-readiness-card]')?.innerText.includes('SKU 总数')`);
    const chinese=[];for(const name of ['readiness','payload','sandbox','safety'])chinese.push(await download(window,path.join(root,`export-report-${name}-zh.json`),`[data-upload-${name}-download]`));
    checks.exportReportDownloadsKeepOriginal=english.every((value,index)=>value===chinese[index])&&JSON.parse(english[2]).uploaded===false;
    checks.exportReportLocaleNoRequests=await window.webContents.executeJavaScript(`window.__exportLocale.calls.length===${calls}&&document.querySelector('[data-export-package-samples]').checked&&document.querySelector('[data-listing-csv-samples]').checked`);
    const callsMade=await window.webContents.executeJavaScript('window.__exportLocale.calls');
    checks.exportReportDryRunRequestEnums=callsMade.filter(call=>call.method==='POST').every(call=>{const body=JSON.parse(call.body);return body.platforms.every(platform=>['temu','miaoshou','amazon','noon','ozon','rakuten'].includes(platform))&&(body.confirmDryRun===true||body.confirmSandboxSubmit===true)&&!Object.hasOwn(body,'confirmPaidApi');});
  }catch(error){
    await fs.writeFile(path.join(root,'export-report-failure.json'),JSON.stringify(await window.webContents.executeJavaScript(`({text:document.body.innerText.slice(-35000),calls:window.__exportLocale.calls,replies:window.__exportLocale.replies})`),null,2));
    await screenshot(window,path.join(root,'export-report-failure.png'),'[data-export-package-preview]');throw error;
  }finally{await window.webContents.executeJavaScript('window.fetch=window.__exportLocale.fetch;delete window.__exportLocale;void 0');}
  checks.exportReportNoBusinessMutation=snapshot()===before;
  // Scan-response fixture tests rendering only. Existing scanner filesystem tests
  // remain separate; this does not claim an additional real filesystem scan.
  await window.loadURL(`${origin}/batches`);await wait(window,`Array.from(document.querySelectorAll('button')).some(el=>el.innerText.includes('扫描导入目录'))`);
  await window.webContents.executeJavaScript(`(()=>{window.__scanLocale={fetch:window.fetch,calls:0};window.fetch=async(input,options)=>{const url=new URL(typeof input==='string'?input:input.url,location.href);if(url.pathname==='/api/import-scan/status')return Response.json({enabled:true,validRoot:true,allowedExtensions:['png'],rootDir:'display-fixture-only'});if(url.pathname==='/api/import-scan/scan'){window.__scanLocale.calls++;return Response.json({summary:{totalFolders:1},candidates:[{status:'new',folderName:'已完成',folderPath:'display-fixture-only',imageCount:1,totalSize:100}]});}return window.__scanLocale.fetch.call(window,input,options);};Array.from(document.querySelectorAll('button')).find(el=>el.innerText==='刷新').click();})()`);
  await wait(window,`document.querySelector('[data-scan-preview]')&&!document.querySelector('[data-scan-preview]').disabled`);
  await window.webContents.executeJavaScript(`document.querySelector('[data-scan-preview]').click()`);
  try{await wait(window,`document.querySelector('[data-scan-feedback]')?.innerText.includes('扫描完成，共发现 1 个 SKU 文件夹')`);await locale(window,'en-US');await wait(window,`document.querySelector('[data-scan-feedback]')?.innerText.includes('Scan complete: 1 SKU folders found')`);
    checks.exportReportScanFeedbackLiveLocale=await window.webContents.executeJavaScript(`window.__scanLocale.calls===1&&document.querySelector('[data-scan-feedback]').dataset.error==='false'&&document.body.innerText.includes('已完成')&&document.body.innerText.includes('Ready to import')&&document.body.innerText.includes('Found by scanning / awaiting import')`);
    await screenshot(window,path.join(root,'export-report-scan-english.png'),'[data-scan-feedback]');
    await locale(window,'zh-CN');
  }finally{await window.webContents.executeJavaScript('window.fetch=window.__scanLocale.fetch;delete window.__scanLocale;void 0');}
  return checks;
}
module.exports={exportReportsI18nSmoke};
