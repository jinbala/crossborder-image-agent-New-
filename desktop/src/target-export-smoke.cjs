const fs=require('node:fs/promises');
const path=require('node:path');
const {createHash}=require('node:crypto');
const {isInside}=require('./runtime.cjs');
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function wait(window,expression){for(let i=0;i<250;i++){if(await window.webContents.executeJavaScript(expression))return true;await pause(100);}throw new Error(`Target export UI timed out: ${expression}`);}
async function shot(window,file,selector){await window.webContents.executeJavaScript(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:'center'});new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>setTimeout(resolve,200))))`);await require('./smoke-screenshot.cjs').smokeScreenshot(window,file);}
async function download(window,destination,expression){
  const done=new Promise((resolve,reject)=>{const timer=setTimeout(()=>{window.webContents.session.removeListener('will-download',save);reject(new Error('Target ZIP download timed out'));},20000);function save(_event,item){item.setSavePath(destination);item.once('done',(_done,state)=>{clearTimeout(timer);state==='completed'?resolve():reject(new Error(`Target ZIP download ${state}`));});}window.webContents.session.once('will-download',save);});
  await window.webContents.executeJavaScript(expression);await done;return fs.readFile(destination);
}
async function targetExportSmoke({window,origin,dataRoot,requestApi}){
  const root=await fs.realpath(dataRoot),checks={};
  if(!root.split(path.sep).includes('.smoke-data')||path.basename(root)!=='workspace')throw new Error('Multi-target fixtures require an owned smoke workspace');
  const started=Date.now(),history=[];
  const progress=async phase=>{history.push({phase,elapsedMs:Date.now()-started});await fs.writeFile(path.join(root,'target-export-progress.json'),JSON.stringify({phase,history,url:window.webContents.getURL(),loading:window.webContents.isLoading()},null,2));};
  await progress('import');
  const json=async(route,body,method=body?'POST':'GET')=>(await requestApi(route,{method,...(body?{headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:{})})).json();
  const input=path.join(root,'target-fixture-022','SKU-022');await fs.mkdir(input,{recursive:true});
  const original=await require('sharp')({create:{width:48,height:48,channels:3,background:'#426080'}}).png().toBuffer();await fs.writeFile(path.join(input,'原图.png'),original);
  const batch=(await json('/api/batches/import-folder',{folderPath:path.dirname(input),name:'多目标-022-原文',defaultTargets:[{platformId:'amazon',site:'US',language:'English'},{platformId:'amazon',site:'DE',language:'German'}]})).batchTask;
  const prepare=async()=>{
    const started=await json(`/api/batches/${batch.id}/queue/start`,{action:'prepare',mode:'mock',concurrency:1});
    for(let i=0;i<400;i++){const current=(await json(`/api/batches/${batch.id}`)).batchTask;if(current.queue?.startedAt===started.batchTask.queue?.startedAt&&['completed','partial_failed','failed'].includes(current.queue.status)&&!current.locks?.isRunning&&current.runtime?.queueActive===false)return current;await pause(100);}throw new Error('Target fixture preparation timed out');
  };
  await progress('prepare-initial');
  const prepared=await prepare(),id=prepared.skuTasks[0].taskId;
  let task=(await json(`/api/tasks/${id}`)).task;
  await progress('confirm-and-prepare');
  await json(`/api/tasks/${id}/product`,{productInfo:task.productInfo},'PATCH');await prepare();
  await progress('generate-sixteen-mock-images');await json(`/api/tasks/${id}/generate`,{});
  await progress('review-mock-images');await json(`/api/tasks/${id}/review`,{mode:'mock'});task=(await json(`/api/tasks/${id}`)).task;
  const targets=task.targets,us=targets.find(target=>target.site==='US'),de=targets.find(target=>target.site==='DE');
  checks.targetMockWorkflow=Boolean(us&&de)&&task.generatedImages.length===16&&task.generatedImages.every(image=>image.provider==='mock');
  if(!checks.targetMockWorkflow)throw new Error('Same-platform US/DE mock fixture is incomplete');
  await progress('open-single-export');await window.loadURL(`${origin}/tasks/${id}/export`);
  await wait(window,`document.querySelector('[data-export-target-id="${us.id}"]')?.dataset.imageCount==='8'&&document.querySelector('[data-export-target-id="${de.id}"]')?.dataset.imageCount==='8'`);
  checks.targetUiCounts=await window.webContents.executeJavaScript(`document.querySelectorAll('[data-export-target-id]').length===2`);
  await shot(window,path.join(root,'single-export-targets.png'),'[data-export-target-id]');
  await progress('download-us-target');const usBytes=await download(window,path.join(root,'target-us-ui.zip'),`document.querySelector('[data-export-target-id="${us.id}"] a').click()`);
  await progress('download-de-target');const deBytes=await download(window,path.join(root,'target-de-ui.zip'),`document.querySelector('[data-export-target-id="${de.id}"] a').click()`);
  const Zip=require('adm-zip'),usZip=new Zip(usBytes),deZip=new Zip(deBytes);
  const usMeta=JSON.parse(usZip.readAsText('metadata.json')),deMeta=JSON.parse(deZip.readAsText('metadata.json'));
  checks.targetSingleDownloadsIsolated=usMeta.generatedImages.length===8&&usMeta.generatedImages.every(image=>image.targetId===us.id)&&deMeta.generatedImages.length===8&&deMeta.generatedImages.every(image=>image.targetId===de.id);
  task=(await json(`/api/tasks/${id}`)).task;
  const recent=task.exports.slice(-2);checks.targetSingleHistoryImmutable=recent.length===2&&recent[0].filePath!==recent[1].filePath&&hash(await fs.readFile(path.resolve(root,recent[0].filePath)))===hash(usBytes)&&hash(await fs.readFile(path.resolve(root,recent[1].filePath)))===hash(deBytes);
  const originals=await Promise.all(task.generatedImages.slice(0,2).map(async image=>{const file=await fs.realpath(path.resolve(root,image.filePath));if(!isInside(path.join(root,'outputs'),file))throw new Error('Target source fixture escaped smoke outputs');return {file,bytes:await fs.readFile(file)};}));
  await progress('open-batch-export');await window.loadURL(`${origin}/batches/${batch.id}`);await wait(window,`document.querySelector('[data-export-package-preview]')&&!document.querySelector('[data-export-package-preview]').disabled`);
  await progress('configure-package');
  // Keep only Amazon selected; the default additional Temu slot would otherwise
  // add eight missing placeholder images and obscure this target-specific check.
  await window.webContents.executeJavaScript(`(() => {const options=document.querySelector('[data-export-package-options]');const labels=Array.from(options.querySelectorAll('label'));const temu=labels.find(node=>node.innerText.trim()==='Temu')?.querySelector('input');if(temu?.checked)temu.click();const locale=document.querySelector('select[aria-label="Interface language / 界面语言"]');locale.value='zh-CN';locale.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  await window.webContents.executeJavaScript(`(() => {const state=window.__targetExport={fetch:window.fetch,result:null,preview:null};window.fetch=async(input,options)=>{const response=await state.fetch.call(window,input,options);const url=new URL(typeof input==='string'?input:input.url,location.href);if(url.pathname.endsWith('/export-package/preview'))state.preview=(await response.clone().json()).preview;if(url.pathname.endsWith('/export-package')&&options?.method==='POST')state.result=await response.clone().json();return response;};window.confirm=()=>true;})()`);
  try{
    await progress('preview-corrupt-and-missing-sources');
    await fs.unlink(originals[0].file);await fs.writeFile(originals[1].file,'bad target fixture');
    await window.webContents.executeJavaScript(`document.querySelector('[data-export-package-preview]').click()`);
    await wait(window,`window.__targetExport.preview?.summary.readyImageCount===14&&document.querySelector('[data-export-package-card="readyImageCount"]')?.dataset.value==='14'&&!document.querySelector('[data-export-package-preview]').disabled`);
    checks.targetPreflightReadsRealFiles=await window.webContents.executeJavaScript(`window.__targetExport.preview.preflight.sourceFilesChecked===16&&Array.from(document.querySelectorAll('[data-export-package-path]')).some(node=>node.innerText.includes('SOURCE_FILE_MISSING'))&&Array.from(document.querySelectorAll('[data-export-package-path]')).some(node=>node.innerText.includes('IMAGE_DECODE_FAILED'))`);
    await shot(window,path.join(root,'target-preflight-errors.png'),'[data-export-package-preflight]');
    for(const item of originals)await fs.writeFile(item.file,item.bytes);
    await progress('create-sixteen-image-package');
    await window.webContents.executeJavaScript(`document.querySelector('[data-export-package-create]').click()`);
    await wait(window,`window.__targetExport.result?.summary.readyImageCount===16&&document.querySelector('[data-export-package-card="readyImageCount"]')?.dataset.value==='16'&&!document.querySelector('[data-export-package-create]').disabled`);
    const result=await window.webContents.executeJavaScript('window.__targetExport.result'),bytes=await download(window,path.join(root,'target-structured-ui.zip'),`document.querySelector('[data-export-package-result] a').click()`),zip=new Zip(bytes);
    const manifest=JSON.parse(zip.readAsText(`${result.packageId}/manifest.json`));
    checks.targetStructuredGroups=manifest.targets.length===2&&new Set(manifest.targets.map(target=>target.folder)).size===2&&manifest.readyImageCount===16&&result.sha256===hash(bytes);
    const groupFiles=manifest.targets.map(target=>({target,manifest:JSON.parse(zip.readAsText(`${result.packageId}/${target.folder}/manifest.json`))}));
    checks.targetStructuredImagesTrace=groupFiles.every(group=>group.manifest.images.length===8&&group.manifest.images.every(image=>image.targetId===group.target.targetId&&image.exists&&image.sha256===hash(zip.readFile(`${result.packageId}/${group.target.folder}/${image.fileName}`))));
    const csv=zip.readAsText(`${result.packageId}/reports/listing-csv/amazon-listing.csv`);checks.targetStructuredCsvRows=csv.includes('target_id,site,language')&&manifest.targets.every(target=>csv.includes(`${target.folder}/01_main.jpg`));
    await shot(window,path.join(root,'multi-target-export.png'),'[data-export-package-card="readyImageCount"]');
    await progress('preview-without-mock');
    await window.webContents.executeJavaScript(`window.__targetExport.result=null;window.__targetExport.preview=null;document.querySelector('[data-export-package-mock]').click();document.querySelector('[data-export-package-preview]').click();`);
    await wait(window,`window.__targetExport.preview?.summary.readyImageCount===0&&document.querySelector('[data-export-package-card="readyImageCount"]')?.dataset.value==='0'&&!document.querySelector('[data-export-package-preview]').disabled`);
    checks.targetRealOnlyPreview=await window.webContents.executeJavaScript(`window.__targetExport.preview.preflight.sourceFilesChecked===0&&window.__targetExport.preview.directoryTree.filter(row=>row.path.endsWith('.jpg')).every(row=>row.exclusionCode==='IMAGE_EXCLUDED_MOCK')`);
    await progress('create-without-mock');await window.webContents.executeJavaScript(`document.querySelector('[data-export-package-create]').click()`);await wait(window,`window.__targetExport.result?.sha256&&document.querySelector('[data-export-package-result]')&&!document.querySelector('[data-export-package-create]').disabled`);
    const realOnly=await window.webContents.executeJavaScript('window.__targetExport.result'),none=new Zip(Buffer.from(await(await requestApi('/'+realOnly.relativePath)).arrayBuffer()));
    checks.targetRealOnlyZip=realOnly.summary.readyImageCount===0&&!none.getEntries().some(entry=>entry.entryName.endsWith('.jpg'));
    await fs.writeFile(path.join(root,'target-export-result.json'),JSON.stringify({multi:result,realOnly},null,2));
  }finally{for(const item of originals)await fs.writeFile(item.file,item.bytes);await window.webContents.executeJavaScript(`window.fetch=window.__targetExport.fetch;delete window.__targetExport;void 0`);}
  checks.targetSourceIntegrity=hash(await fs.readFile(path.join(input,'原图.png')))===hash(original)&&(await Promise.all(originals.map(async item=>hash(await fs.readFile(item.file))===hash(item.bytes)))).every(Boolean);
  await progress('completed');
  return checks;
}
module.exports={targetExportSmoke};
