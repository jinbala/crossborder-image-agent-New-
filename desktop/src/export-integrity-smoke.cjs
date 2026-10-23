const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { isInside } = require('./runtime.cjs');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
async function wait(window, expression) {
  for (let attempt=0;attempt<250;attempt++) { if (await window.webContents.executeJavaScript(expression)) return true; await new Promise(resolve=>setTimeout(resolve,100)); }
  throw new Error(`Structured export verification timed out: ${expression}`);
}
async function exportIntegritySmoke({ window, origin, dataRoot, requestApi }) {
  const root=await fs.realpath(dataRoot);
  if (!root.split(path.sep).includes('.smoke-data') || path.basename(root)!=='workspace') throw new Error('Export integrity fixtures require a smoke-only workspace');
  const json=async route=>(await requestApi(route)).json(), checks={};
  const selected=(await json('/api/batches')).batchTasks.find(batch=>batch.name==='批量-017-原文');
  if (!selected) throw new Error('Missing owned generated batch fixture');
  const batch=(await json(`/api/batches/${selected.id}`)).batchTask;
  const tasks=await Promise.all(batch.skuTasks.filter(sku=>sku.taskId).map(async sku=>(await json(`/api/tasks/${sku.taskId}`)).task));
  // GET /tasks/:id adds normalizedReviewReport.meta.generatedAt on every read.
  // Compare persisted records byte-for-byte as well as all stable HTTP fields.
  const sqliteFile=await fs.realpath(path.join(root,'backend','data','app.sqlite'));
  if(!isInside(root,sqliteFile))throw new Error('Fixture database escaped smoke root');
  const persistentSnapshot=()=>{
    const db=new(require('better-sqlite3'))(sqliteFile,{readonly:true});
    try{return JSON.stringify({batch:db.prepare('SELECT data_json FROM batch_tasks WHERE id=?').get(batch.id),tasks:db.prepare('SELECT id,data_json FROM tasks WHERE id IN (SELECT value FROM json_each(?)) ORDER BY id').all(JSON.stringify(tasks.map(task=>task.id)))});}
    finally{db.close();}
  };
  const persistedBefore=persistentSnapshot();
  const stableTask=value=>{const copy=structuredClone(value);if(copy.normalizedReviewReport?.meta)delete copy.normalizedReviewReport.meta.generatedAt;return JSON.stringify(copy);};
  const task=tasks.find(task=>task.generatedImages?.length>=3);
  if (!task) throw new Error('Missing generated task fixture');
  const images=[...new Map(task.generatedImages.map(image=>[image.imageType||image.type,image])).values()].slice(0,3);
  const originals=await Promise.all(images.map(async image=>{
    const file=await fs.realpath(path.resolve(root,image.filePath));
    if(!isInside(root,file) || !isInside(path.join(root,'outputs'),file))throw new Error('Fixture image is outside owned smoke outputs');
    return {file,bytes:await fs.readFile(file)};
  }));
  await window.loadURL(`${origin}/batches/${batch.id}`);
  await wait(window,`Boolean(document.querySelector('[data-export-package-preview]')) && !document.querySelector('[data-export-package-preview]').disabled`);
  await window.webContents.executeJavaScript(`(() => {
    const state=window.__exportIntegrity={fetch:window.fetch,writes:[],result:null,dialogs:[],confirm:window.confirm};
    window.fetch=async(input,options)=>{const url=new URL(typeof input==='string'?input:input.url,location.href),method=options?.method||input?.method||'GET';if(method!=='GET')state.writes.push({path:url.pathname,method});const response=await state.fetch.call(window,input,options);if(method==='POST'&&url.pathname.endsWith('/export-package'))state.result=await response.clone().json();return response;};
    window.confirm=message=>{state.dialogs.push(message);return false;};
    document.querySelector('[data-export-package-preview]').click();
  })()`);
  await wait(window,`Boolean(document.querySelector('[data-export-package-card="readyImageCount"]')) && !document.querySelector('[data-export-package-preview]').disabled`);
  const initial=await window.webContents.executeJavaScript(`({ready:Number(document.querySelector('[data-export-package-card="readyImageCount"]').dataset.value),missing:Number(document.querySelector('[data-export-package-card="missingImageCount"]').dataset.value)})`);
  checks.structuredExportLivePreview=initial.ready>=3;
  await window.webContents.executeJavaScript(`document.querySelector('[data-export-package-create]').click()`);
  checks.structuredExportCancelledNoWrite=await window.webContents.executeJavaScript(`window.__exportIntegrity.dialogs.length===1&&window.__exportIntegrity.writes.length===0&&!document.querySelector('[data-export-package-result]')`);
  const sharp=require('sharp'), png=await sharp({create:{width:16,height:12,channels:4,background:{r:20,g:40,b:60,alpha:0}}}).png().toBuffer();
  try {
    await fs.writeFile(originals[0].file,png);
    await fs.unlink(originals[1].file);
    await fs.writeFile(originals[2].file,'corrupt owned fixture image');
    await window.webContents.executeJavaScript(`window.confirm=()=>true;document.querySelector('[data-export-package-create]').click();void 0`);
    await wait(window,`Boolean(window.__exportIntegrity.result?.relativePath)&&Boolean(document.querySelector('[data-export-package-result]'))&&!document.querySelector('[data-export-package-create]').disabled`);
    const result=await window.webContents.executeJavaScript('window.__exportIntegrity.result');
    checks.structuredExportFinalUiOverridesPreview=await window.webContents.executeJavaScript(`document.querySelector('[data-export-package-card="readyImageCount"]').dataset.value===${JSON.stringify(String(initial.ready-2))}&&document.querySelector('[data-export-package-card="missingImageCount"]').dataset.value===${JSON.stringify(String(initial.missing+2))}&&document.querySelector('[data-export-package-checksum]').innerText.includes(${JSON.stringify(result.sha256)})`);
    const downloaded=path.join(root,'structured-export-ui.zip');
    const done=new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{window.webContents.session.removeListener('will-download',save);reject(new Error('Structured ZIP download timed out'));},20000);
      function save(_event,item){item.setSavePath(downloaded);item.once('done',(_done,state)=>{clearTimeout(timer);state==='completed'?resolve():reject(new Error(`Structured ZIP download ${state}`));});}
      window.webContents.session.once('will-download',save);
    });
    await window.webContents.executeJavaScript(`document.querySelector('[data-export-package-result] a').click()`);await done;
    const bytes=await fs.readFile(downloaded),zip=new(require('adm-zip'))(bytes);
    checks.structuredExportDownloadChecksum=hash(bytes)===result.sha256&&bytes.length===result.bytes;
    const manifest=JSON.parse(zip.readAsText(`${result.packageId}/manifest.json`));
    checks.structuredExportManifestCounts=manifest.readyImageCount===initial.ready-2&&manifest.missingImageCount===initial.missing+2&&manifest.imageErrorCount===2&&manifest.files.every(file=>Boolean(zip.getEntry(`${result.packageId}/${file.path}`))===file.exists);
    const errorRows=result.directoryTree.filter(row=>row.errorCode);
    checks.structuredExportFailureReasons=errorRows.length===2&&errorRows.some(row=>row.errorCode==='SOURCE_FILE_MISSING')&&errorRows.some(row=>row.errorCode==='IMAGE_DECODE_FAILED')&&await window.webContents.executeJavaScript(`${JSON.stringify(errorRows.map(row=>row.path))}.every(path=>Array.from(document.querySelectorAll('[data-export-package-path]')).some(node=>node.dataset.exportPackagePath===path&&node.dataset.status==='missing'))`);
    const imageFile=manifest.files.find(file=>file.exists&&file.imageType===(images[0].imageType||images[0].type));
    const jpeg=zip.readFile(`${result.packageId}/${imageFile.path}`),metadata=await sharp(jpeg).metadata();
    checks.structuredExportRealJpeg=metadata.format==='jpeg'&&metadata.width===16&&metadata.height===12&&hash(jpeg)===imageFile.sha256&&(await sharp(jpeg).raw().toBuffer()).every(value=>value>=250);
    const csv=zip.readAsText(`${result.packageId}/reports/listing-csv/amazon-listing.csv`);
    checks.structuredExportListingUsesExistingImages=errorRows.every(row=>!csv.includes(row.path));
    checks.structuredExportNoBusinessMutation=persistentSnapshot()===persistedBefore&&JSON.stringify((await json(`/api/batches/${batch.id}`)).batchTask)===JSON.stringify(batch)&&(await Promise.all(tasks.map(async task=>stableTask((await json(`/api/tasks/${task.id}`)).task)===stableTask(task)))).every(Boolean)&&await window.webContents.executeJavaScript(`window.__exportIntegrity.writes.length===1&&window.__exportIntegrity.writes[0].path.endsWith('/export-package')`);
    await require('./smoke-screenshot.cjs').smokeScreenshot(window,path.join(root,'structured-export-final.png'),{selector:'[data-export-package-card="readyImageCount"]'});
    await window.webContents.executeJavaScript(`document.querySelector('[data-export-package-options] input').click()`);
    checks.structuredExportOptionChangeClearsStaleResult=await wait(window,`!document.querySelector('[data-export-package-result]')&&!document.querySelector('[data-export-package-card]')`);
    checks.structuredExportOptionChangeKeepsZip=(await fs.stat(downloaded)).size===result.bytes;
    await fs.writeFile(path.join(root,'structured-export-result.json'),JSON.stringify(result,null,2));
  } finally {
    for(const original of originals)await fs.writeFile(original.file,original.bytes);
    await window.webContents.executeJavaScript(`(() => {const state=window.__exportIntegrity;window.fetch=state.fetch;window.confirm=state.confirm;delete window.__exportIntegrity;})()`);
  }
  checks.structuredExportSourcesRestored=(await Promise.all(originals.map(async item=>hash(await fs.readFile(item.file))===hash(item.bytes)))).every(Boolean);
  return checks;
}
module.exports={exportIntegritySmoke};
