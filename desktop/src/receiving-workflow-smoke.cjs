const fs=require('node:fs/promises');
const path=require('node:path');
const {createHash}=require('node:crypto');
const {BrowserWindow}=require('electron');
const hash=value=>createHash('sha256').update(value).digest('hex');
async function wait(window,expression){for(let i=0;i<200;i++){if(await window.webContents.executeJavaScript(expression))return true;await new Promise(resolve=>setTimeout(resolve,50));}throw new Error(`Receiving workflow UI timed out: ${expression}`);}
async function download(window,destination,selector){const done=new Promise((resolve,reject)=>{const timer=setTimeout(()=>{window.webContents.session.removeListener('will-download',save);reject(new Error('Collection ZIP download timed out'));},15000);function save(_event,item){item.setSavePath(destination);item.once('done',(_done,state)=>{clearTimeout(timer);state==='completed'?resolve():reject(new Error(`Collection download ${state}`));});}window.webContents.session.once('will-download',save);});await window.webContents.executeJavaScript(`document.querySelector(${JSON.stringify(selector)}).click()`);await done;return fs.readFile(destination);}
async function screenshot(window,file){await window.webContents.executeJavaScript('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');await require('./smoke-screenshot.cjs').smokeScreenshot(window,file);}

async function receivingWorkflowSmoke({window,origin,dataRoot,requestApi}){
  const root=await fs.realpath(dataRoot),checks={};if(!root.split(path.sep).includes('.smoke-data')||path.basename(root)!=='workspace')throw new Error('Receiving tests require an owned smoke workspace');
  const json=async(route,options)=>{const response=await requestApi(route,options),value=await response.json();if(!response.ok)throw new Error(`Receiving fixture ${route}: ${response.status}`);return value;};
  const rows=Array.from({length:13},(_,index)=>({sku:`RECEIVE-${index+1}`,title:'接收结果原文',imageUrls:[`https://fixture.invalid/not-requested-${index+1}.png`]}));
  const job=await json('/api/workbench/collection-jobs/rows',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({rows,options:{name:'客户端接收流程-原文'}})});
  const png=await require('sharp')({create:{width:64,height:32,channels:3,background:'#507090'}}).png().toBuffer();
  for(let index=0;index<rows.length;index++){
    const form=new FormData();form.append('itemId',job.items[index].id);form.append('sourceUrl',rows[index].imageUrls[0]);form.append('image',new Blob([png],{type:'image/png'}),'fixture.png');
    await json(`/api/workbench/collection-jobs/${job.id}/browser-images`,{method:'POST',body:form});
  }
  const completed=await json(`/api/workbench/collection-jobs/${job.id}`);
  checks.collectionReceivedLocalBytes=completed.summary.downloadedCount===13&&completed.items.every(item=>item.images.length===1&&item.images[0].sha256===hash(png));
  await window.loadURL(`${origin}/workbench/collection?jobId=${encodeURIComponent(job.id)}`);
  await wait(window,`document.querySelector('[data-collection-next-step]')?.dataset.collectionNextStep==='ready'&&document.querySelectorAll('[data-collection-preview]').length===12`);
  await wait(window,`document.querySelector('[data-collection-preview] img')?.naturalWidth===64`);
  checks.collectionResultGuideVisible=await window.webContents.executeJavaScript(`document.querySelector('[data-collection-next-step]').innerText.includes('图片已收到')&&document.querySelector('[data-collection-next-step] a[href="/workbench/sku-pack"]')!==null`);
  const first=await window.webContents.executeJavaScript(`Array.from(document.querySelectorAll('[data-collection-preview] img')).map(image=>image.getAttribute('src'))`);
  await screenshot(window,path.join(root,'collection-received-next-step.png'));
  await window.webContents.executeJavaScript(`document.querySelector('[data-collection-preview-next]').click()`);await wait(window,`document.querySelectorAll('[data-collection-preview]').length===1&&document.querySelector('[data-collection-preview] img')?.naturalWidth===64`);
  const second=await window.webContents.executeJavaScript(`document.querySelector('[data-collection-preview] img').getAttribute('src')`);
  checks.collectionPreviewsPaged=first.length===12&&new Set([...first,second]).size===13&&[...first,second].every(url=>url.startsWith(`/outputs/workbench/${job.id}/images/`));
  const bytes=await download(window,path.join(root,'collection-received-ui.zip'),'[data-collection-download]'),zip=new(require('adm-zip'))(bytes),images=zip.getEntries().filter(entry=>entry.entryName.startsWith('images/')&&!entry.isDirectory);
  checks.collectionReceivedZipOriginals=images.length===13&&images.every(entry=>hash(entry.getData())===hash(png));
  await window.webContents.executeJavaScript(`window.__receivingFetch=window.fetch;window.__receivingPosts=0;window.fetch=(input,options)=>{if((options?.method||input?.method||'GET')!=='GET')window.__receivingPosts++;return window.__receivingFetch.call(window,input,options);};document.querySelector('[data-collection-next-step] a[href="/workbench/sku-pack"]').click();`);
  try{await wait(window,`location.pathname==='/workbench/sku-pack'&&Array.from(document.querySelectorAll('button')).some(el=>el.innerText==='生成 SKU 图包'&&el.disabled)`);
    checks.collectionNextStepDoesNotAutoProcess=await window.webContents.executeJavaScript('window.__receivingPosts===0');
  }finally{await window.webContents.executeJavaScript('window.fetch=window.__receivingFetch;void 0');}

  const probe=new BrowserWindow({width:420,height:650,useContentSize:true,show:false,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});
  probe.webContents.setWindowOpenHandler(()=>({action:'deny'}));
  try{
    await probe.loadFile(path.join(__dirname,'..','runtime','browser-extension','temu-deep-collector','popup.html'));
    // Real popup layout/JS, explicitly stubbed Chrome API; not an installed Edge
    // extension, account session, Temu request or OS permission prompt.
    await probe.webContents.executeJavaScript(`window.__popupFixture={paired:true,calls:[],state:{status:'manual',rows:[{imageUrls:['https://fixture.invalid/image.png']}],failures:[],options:{name:'原任务'}}};window.chrome={runtime:{sendMessage:async message=>{const fixture=window.__popupFixture;fixture.calls.push(message.type);if(message.type==='connection')return {ok:true,result:{paired:fixture.paired,mode:fixture.paired?'desktop':'unconfigured',serviceUrl:fixture.paired?'http://127.0.0.1:60011':''}};if(message.type==='finish-manual')fixture.state={...fixture.state,status:'completed',backendJob:{id:'popup-fixture-only'}};return {ok:true,result:fixture.state};}},permissions:{request:async()=>true}};elements.error.textContent='';refresh();`);
    await wait(probe,`elements.workflowStep.innerText.includes('第 2 步')`);
    checks.popupManualActionsAboveFold=await probe.webContents.executeJavaScript(`['collectCurrent','finishManual'].every(id=>{const r=document.getElementById(id).getBoundingClientRect();return r.top>=0&&r.bottom<=innerHeight;})&&!document.getElementById('collectionSettings').open&&!document.getElementById('automaticCollection').open`);
    await probe.webContents.executeJavaScript(`elements.name.value='用户任务原文';refresh();`);await wait(probe,`elements.name.value==='用户任务原文'`);checks.popupEditsSurvivePolling=true;
    await probe.webContents.executeJavaScript(`elements.finishManual.click()`);await wait(probe,`elements.workflowStep.innerText.includes('第 3 步')&&!elements.finishManual.disabled`);
    checks.popupManualSendNextStep=await probe.webContents.executeJavaScript(`elements.openJob.style.display==='inline-block'&&elements.openJob.href==='crossborder-workbench://collection?jobId=popup-fixture-only'&&window.__popupFixture.calls.filter(type=>type==='finish-manual').length===1`);
    await screenshot(probe,path.join(root,'extension-popup-ready.png'));
    await probe.webContents.executeJavaScript(`window.__popupFixture.paired=false;window.__popupFixture.state.backendJob=null;refresh();`);await wait(probe,`elements.workflowStep.innerText.includes('展开“客户端连接”')`);
    await probe.webContents.executeJavaScript(`elements.finishManual.click()`);await wait(probe,`elements.connectionDetails.open&&elements.error.innerText.includes('不要清空')`);
    checks.popupUnpairedRecoveryVisible=await probe.webContents.executeJavaScript(`elements.finishManual.getBoundingClientRect().bottom<=innerHeight&&window.__popupFixture.state.rows.length===1&&window.__popupFixture.calls.filter(type=>type==='finish-manual').length===1`);
    await screenshot(probe,path.join(root,'extension-popup-pairing-guidance.png'));
  }finally{probe.destroy();}
  return checks;
}
module.exports={receivingWorkflowSmoke};
