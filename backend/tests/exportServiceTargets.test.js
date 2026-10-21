import {test,beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import AdmZip from 'adm-zip';
import {paths} from '../src/services/db.js';
import {createExportZip,buildTargetExportMetadata} from '../src/services/exportService.js';
const id='single-target-fixture',folder=path.join(paths.outputDir,id);
beforeEach(async()=>{await fs.rm(folder,{recursive:true,force:true});await fs.mkdir(folder,{recursive:true});for(const [file,color]of[['us.jpg','#306080'],['de.jpg','#c03020']])await sharp({create:{width:16,height:12,channels:3,background:color}}).jpeg().toFile(path.join(folder,file));});
function fixture(){return {id,platform:'Amazon',productInfo:{sku:'SINGLE'},productInfoConfirmed:{sku:'SINGLE'},targets:[{id:'us',platformId:'amazon',site:'US',language:'English'},{id:'de',platformId:'amazon',site:'DE',language:'German'}],generatedImages:[{id:'image-us',planId:'main-us',targetId:'us',platformId:'amazon',type:'main_image',fileName:'main.jpg',filePath:`outputs/${id}/us.jpg`,status:'succeeded'},{id:'image-de',planId:'main-de',targetId:'de',platformId:'amazon',type:'main_image',fileName:'main.jpg',filePath:`outputs/${id}/de.jpg`,status:'succeeded'}],reviewResults:[{imageId:'image-us',targetId:'us',platformId:'amazon',status:'passed'},{imageId:'image-de',targetId:'de',platformId:'amazon',status:'failed'}]};}
test('single-target ZIP and metadata never include another country of the same platform',async()=>{
  const task={...fixture(),exportTargetId:'us',imagePlans:[{id:'main-us',targetId:'us',type:'main_image'},{id:'main-de',targetId:'de',type:'main_image'}]},result=await createExportZip(task),zip=new AdmZip(path.join(paths.rootDir,result.filePath));
  const metadata=JSON.parse(zip.readAsText('metadata.json'));assert.deepEqual(metadata.generatedImages.map(image=>image.id),['image-us']);
  assert.deepEqual(metadata.imagePlanTrace.map(plan=>plan.planId),['main-us']);
  assert.deepEqual(JSON.parse(zip.readAsText('prompts.json')).imagePlans.map(plan=>plan.id),['main-us']);
  assert.deepEqual(metadata.reviewSummary,{totalImages:1,passCount:1,failCount:0,highRiskCount:0,mediumRiskCount:0,lowRiskCount:1,realReviewCount:0,mockReviewCount:1,fallbackReviewCount:0});
  assert.ok(zip.getEntry('amazon-US-English/images/main.jpg'));assert.equal(zip.getEntry('amazon-DE-German/images/main.jpg'),null);
  assert.equal(buildTargetExportMetadata(fixture(),'de').images[0].id,'image-de');assert.throws(()=>buildTargetExportMetadata(fixture(),'absent'),/not found/);
});
test('distinct target IDs with identical site/language have unique directories and no duplicate ZIP entries',async()=>{
  const task=fixture();task.targets[1]={...task.targets[1],site:'US',language:'English'};
  const result=await createExportZip(task),zip=new AdmZip(path.join(paths.rootDir,result.filePath));
  const files=zip.getEntries().filter(entry=>entry.entryName.endsWith('/images/main.jpg'));assert.equal(files.length,2);assert.notEqual(files[0].entryName,files[1].entryName);
  assert.equal(new Set(zip.getEntries().map(entry=>entry.entryName.toLowerCase())).size,zip.getEntries().length);
});
test('unknown or empty target selection fails before opening a ZIP output',async()=>{
  await assert.rejects(createExportZip({...fixture(),exportTargetId:'absent'}),error=>error.statusCode===400);
  assert.equal((await fs.readdir(folder)).some(name=>name.endsWith('.zip')),false);
});

test('repeated country exports preserve the old ZIP and have independent identities and checksums',async()=>{
  const task={...fixture(),exportTargetId:'us'},first=await createExportZip(task),before=await fs.readFile(path.join(paths.rootDir,first.filePath)),second=await createExportZip(task);
  assert.notEqual(first.filePath,second.filePath);assert.notEqual(first.id,second.id);assert.deepEqual(await fs.readFile(path.join(paths.rootDir,first.filePath)),before);
  assert.equal(first.bytes,before.length);assert.match(first.sha256,/^[a-f0-9]{64}$/);assert.deepEqual(first.targetIds,['us']);
});

test('source paths, corrupt files and duplicate ZIP names fail before opening an archive',async()=>{
  const task=fixture();task.exportTargetId='us';
  task.generatedImages[0].filePath='../outside.jpg';await assert.rejects(createExportZip(task),/SOURCE_PATH_REJECTED/);
  task.generatedImages[0].filePath=`outputs/${id}/us.jpg`;await fs.writeFile(path.join(folder,'us.jpg'),'corrupt');await assert.rejects(createExportZip(task),/IMAGE_DECODE_FAILED/);
  await sharp({create:{width:16,height:12,channels:3,background:'#406080'}}).jpeg().toFile(path.join(folder,'us.jpg'));
  task.generatedImages.push({...task.generatedImages[0],id:'another-image',planId:'another-plan'});await assert.rejects(createExportZip(task),error=>error.statusCode===409);
  assert.equal((await fs.readdir(folder)).some(name=>name.endsWith('.zip')),false);
});
