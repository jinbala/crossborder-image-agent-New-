import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {collectionPreviewUrl,collectionResultGuide,collectionPreviewPage} from '../src/utils/collectionResults.js';
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
