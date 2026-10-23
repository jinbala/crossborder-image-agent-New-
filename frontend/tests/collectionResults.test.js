import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {collectionPreviewUrl,collectionResultGuide,collectionPreviewPage,collectionItemsPage,collectionItemsFiltered,collectionItemsCsv,collectionStatusLabel,collectionRunShouldStop} from '../src/utils/collectionResults.js';
import {english} from '../src/i18n/messages.js';
test('collection next steps distinguish pending, partial, downloaded and empty outcomes',()=>{
  const cases=[[{pendingCount:1,downloadedCount:2},'pending'],[{failedCount:1,downloadedCount:2},'partial'],[{warningCount:1},'partial'],[{downloadedCount:2},'ready'],[{downloadedCount:0},'empty'],[{downloadedCount:'invalid'},'empty']];
  for(const [summary,kind]of cases){const job=Object.freeze({summary:Object.freeze(summary)}),before=JSON.stringify(job),guide=collectionResultGuide(job);assert.equal(guide.kind,kind);assert.equal(JSON.stringify(job),before);assert.ok(Object.hasOwn(english,guide.title));assert.ok(Object.hasOwn(english,guide.description));}
});
test('preview URLs refuse other jobs, remote sources, traversal, encoded separators and non-raster content',()=>{
  assert.equal(collectionPreviewUrl('job-1','/outputs/workbench/job-1/images/SKU/主图.png'),'/outputs/workbench/job-1/images/SKU/主图.png');
  for(const url of ['https://img.example/a.png','//img.example/a.png','/outputs/workbench/other/images/a.png','/outputs/workbench/job-1/images/../a.png','/outputs/workbench/job-1/images/%2e%2e/a.png','/outputs/workbench/job-1/images/a%2fb.png','/outputs/workbench/job-1/images/a.svg','/outputs/workbench/job-1/images/a.png?token=secret','C:\\private\\a.png','/outputs/workbench/job-1/images/%ZZ.png'])assert.equal(collectionPreviewUrl('job-1',url),'');
});
test('preview pages are bounded, clamp stale pages, skip failures and preserve original SKU titles',()=>{
  const job={id:'job-1',items:[{sku:'已完成',title:'可用',images:Array.from({length:29},(_,index)=>({status:'success',url:`/outputs/workbench/job-1/images/SKU/${index}.png`,file:`SKU/${index}.png`}))},{images:[{status:'failed',url:'/outputs/workbench/job-1/images/a.png'},{status:'success',url:'https://example.org/a.png'}]}]};
  const before=JSON.stringify(job),page=collectionPreviewPage(job,2);assert.equal(page.total,29);assert.equal(page.pages,3);assert.equal(page.images.length,12);assert.equal(page.images[0].sku,'已完成');assert.equal(page.images[0].title,'可用');
  assert.equal(collectionPreviewPage(job,999).page,3);assert.equal(collectionPreviewPage(job,1,999).images.length,24);assert.equal(collectionPreviewPage(null).total,0);assert.equal(JSON.stringify(job),before);
});
test('collection result UI has explicit next steps and previews, with no automatic processing on read',()=>{
  const source=fs.readFileSync(new URL('../src/pages/CollectionWorkbenchPage.jsx',import.meta.url),'utf8');
  assert.ok(source.includes('data-collection-next-step'));assert.ok(source.includes('data-collection-preview'));
  assert.ok(source.includes('to="/workbench/sku-pack"'));assert.ok(source.includes('collectionPreviewPage(job, previewPage)'));
});

test('collection item pages cap rendered rows, preserve ordering and clamp invalid or stale pages',()=>{
  const job={items:Array.from({length:5000},(_,index)=>Object.freeze({id:`item-${index}`,sku:`SKU-${index}`,title:'原文',status:'pending'}))};
  const before=JSON.stringify(job),page=collectionItemsPage(job,{page:2});
  assert.equal(page.items.length,25);assert.equal(page.items[0].id,'item-25');assert.equal(page.pages,200);
  assert.equal(collectionItemsPage(job,{page:999,pageSize:999}).items.length,100);
  assert.equal(collectionItemsPage(job,{page:999,pageSize:999}).page,50);
  assert.equal(collectionItemsPage(job,{q:'not-found',page:999}).page,1);
  assert.equal(collectionItemsPage(job,{page:-1,pageSize:'bad'}).pageSize,25);
  assert.equal(collectionItemsPage(null).total,0);assert.equal(JSON.stringify(job),before);
});

test('collection search combines literal text and exact status without translating business fields',()=>{
  const job={items:[{id:'a',sku:'已完成',title:'针织 A',status:'completed',productUrl:'https://example.org/Style-A'},
    {id:'b',sku:'B',title:'针织 B',status:'failed',error:{message:'连接失败 原文'}},
    {id:'c',sku:'C',status:'skipped',pageWarning:{message:'销量 原文'}}]};
  assert.deepEqual(collectionItemsFiltered(job,{q:'针织',status:'failed'}).map(item=>item.id),['b']);
  for(const q of [' 已完成 ','style-a','针织 A'])assert.equal(collectionItemsFiltered(job,{q})[0].id,'a');
  assert.equal(collectionItemsFiltered(job,{q:'原文'}).length,2);
  assert.equal(collectionItemsFiltered(job,{q:'.*'}).length,0);
  assert.equal(collectionItemsFiltered(job,{status:'constructor'}).length,0);
});

test('filtered collection CSV exports all matches with stable raw statuses, BOM and safe quoted cells',()=>{
  const job={items:Array.from({length:60},(_,index)=>({id:`i-${index}`,sku:`SKU-${index}`,title:index===0?'针织,"原文"\n换行':'原文',status:index<45?'failed':'skipped',sales:0,attempts:2,error:{code:'RAW',message:'原文'},images:[{status:'success'},{status:'failed'}],imageUrls:['https://img.example/a','https://img.example/b']}))};
  const before=JSON.stringify(job),csv=collectionItemsCsv(job,{status:'failed',page:2,pageSize:25});
  assert.ok(csv.startsWith('\uFEFF"itemId"'));assert.ok(csv.includes('"i-0"'));assert.ok(csv.includes('"i-44"'));assert.ok(!csv.includes('"i-45"'));
  assert.ok(csv.includes('"针织,""原文""\n换行"'));assert.ok(csv.includes('"failed","1","2","2","RAW","原文"'));
  assert.equal(collectionItemsCsv(null).split('\r\n').length,2);assert.equal(JSON.stringify(job),before);
});

test('CSV formula guards cover whitespace, tab, CR, LF and formula prefixes without changing the manifest',()=>{
  const values=['=1+1','+SUM(A1)','-1+2','@cmd',' \t=cmd','\tplain','\rplain','\nplain','\u0000=1'];
  for(const title of values){const job={items:[{title,status:'pending'}]},before=JSON.stringify(job);assert.ok(collectionItemsCsv(job).includes(`"'${title}"`));assert.equal(JSON.stringify(job),before);}
  assert.ok(collectionItemsCsv({items:[{title:'针织 原文 $& {sku}'}]}).includes('"针织 原文 $& {sku}"'));
});

test('cancelled guides take priority over pending images and manual stop flags end continuous loops',()=>{
  const guide=collectionResultGuide({status:'cancelled',summary:{pendingCount:1,downloadedCount:2}});
  assert.equal(guide.kind,'cancelled');assert.ok(Object.hasOwn(english,guide.title));assert.ok(Object.hasOwn(english,guide.description));
  assert.equal(collectionStatusLabel('cancelled'),'已取消');assert.equal(collectionStatusLabel('__proto__'),'__proto__');assert.equal(collectionStatusLabel('constructor'),'constructor');
  for(const result of [{status:'cancelled'},{status:'paused',stopRequested:'pause'},{status:'paused',stopRequested:'cancel'}])assert.equal(collectionRunShouldStop(result),true);
  for(const result of [null,{status:'paused'},{status:'queued'},{stopRequested:'unknown'}])assert.equal(collectionRunShouldStop(result),false);
});

test('collection table renders bounded projection with filters, all-filtered CSV and explicit cancelled resume',()=>{
  const source=fs.readFileSync(new URL('../src/pages/CollectionWorkbenchPage.jsx',import.meta.url),'utf8');
  assert.ok(!source.includes('job.items.map('));assert.ok(source.includes('itemPage.items.map('));
  for(const marker of ['search','status','size','export','next','prev','pagination'])assert.ok(source.includes(`data-collection-item-${marker}`));
  assert.ok(source.includes('collectionItemsCsv(job, itemQuery)'));assert.ok(source.includes('URL.revokeObjectURL(url)'));
  assert.ok(source.includes('collectionRunShouldStop(current)'));assert.ok(source.includes('window.confirm(t('));assert.ok(source.includes('executing.current'));
});
