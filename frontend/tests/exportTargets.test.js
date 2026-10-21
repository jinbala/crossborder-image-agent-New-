import { test } from 'node:test';
import assert from 'node:assert/strict';
import { exportTargetsForTask, exportTargetsForPlatform, resolveExportImageTarget, latestImagesForExportTarget, structuredTargetFolder, singleTargetFolder, exportImageKey, exportImageSourceType, exportImageExclusion, reviewBelongsToExportTarget, latestExportImages } from '../src/utils/exportTargets.js';
const targets=[{id:'us',platformId:'amazon',site:'US',language:'English'},{id:'de',platformId:'amazon',site:'DE',language:'German'}];
test('target IDs, aliases and plan references keep same-platform countries separate',()=>{
  const task={targets:[{...targets[0],targetId:'alias-us'},targets[1]],imagePlans:[{id:'plan',targetId:'de'}]};
  assert.equal(resolveExportImageTarget(task,{targetId:'alias-us'}).target.id,'us');assert.equal(resolveExportImageTarget(task,{planId:'plan'}).target.id,'de');
  assert.equal(resolveExportImageTarget(task,{platformId:'amazon',site:'DE'}).target.id,'de');
});
test('unknown, ambiguous and conflicting image targets never fall through to another country',()=>{
  const task={targets};assert.equal(resolveExportImageTarget(task,{platformId:'amazon'}).code,'IMAGE_TARGET_AMBIGUOUS');
  assert.equal(resolveExportImageTarget(task,{targetId:'missing'}).target,null);assert.equal(resolveExportImageTarget(task,{targetId:'us',platformId:'temu'}).code,'IMAGE_TARGET_CONFLICT');
});
test('legacy target IDs are deterministic and missing platforms are explicit placeholders',()=>{
  assert.deepEqual(exportTargetsForTask({platformId:'amazon'}),exportTargetsForTask({platformId:'amazon'}));
  assert.equal(exportTargetsForPlatform({targets},'temu')[0].placeholder,true);
});
test('latest successful versions are chosen within a target before source exclusion',()=>{
  const task={targets,generatedImages:[{type:'main_image',targetId:'us',version:3,id:'new',provider:'mock'},{type:'main_image',targetId:'de',version:9,id:'de'},{type:'main_image',targetId:'us',version:2,id:'old'},{type:'main_image',targetId:'us',version:4,id:'failed',status:'failed'}]};
  assert.equal(latestImagesForExportTarget(task,targets[0]).get('main_image').id,'new');assert.equal(exportImageExclusion(latestImagesForExportTarget(task,targets[0]).get('main_image'),{includeMockImages:false}),'IMAGE_EXCLUDED_MOCK');
});
test('same-profile targets have distinct stable Windows-safe folders and tuple keys',()=>{
  const siblings=[targets[0],{...targets[0],id:'other/原文'}];
  assert.notEqual(structuredTargetFolder(siblings[0],siblings),structuredTargetFolder(siblings[1],siblings));
  assert.notEqual(singleTargetFolder(siblings[0],siblings),singleTargetFolder(siblings[1],siblings));
  assert.equal(singleTargetFolder(targets[0],targets),'amazon-US-English');assert.equal(structuredTargetFolder(targets[0],[targets[0]]),'');
  assert.notEqual(exportImageKey('a:b','c','d'),exportImageKey('a','b:c','d'));
});
test('mock provenance cannot be disguised by an explicit real label; sample opt-in is independent',()=>{
  for(const image of [{sourceType:'fallbackMock'},{fallbackToMock:true},{sourceType:'real',provider:'mock'},{isMockPreview:true},{sourceType:'fallback_mock'}])assert.equal(exportImageExclusion(image,{includeMockImages:false}),'IMAGE_EXCLUDED_MOCK');
  assert.equal(exportImageSourceType({sourceType:'real',fallbackToMock:true}),'fallbackMock');
  assert.equal(exportImageExclusion({sourceType:'realSample'},{includeMockImages:true}),'IMAGE_EXCLUDED_REAL_SAMPLE');
  assert.equal(exportImageExclusion({sourceType:'realSample'},{includeRealSamples:true}),null);
  assert.equal(exportImageSourceType({sourceType:{invalid:true}}),'generated');
});

test('review image identity and latest plan versions cannot cross targets or count obsolete images',()=>{
  const task={targets,generatedImages:[{id:'old-us',planId:'plan-us',targetId:'us',version:1},{id:'new-us',planId:'plan-us',targetId:'us',version:2},{id:'de-image',targetId:'de',planId:'plan-de'}]};
  assert.equal(reviewBelongsToExportTarget(task,{targetId:'us',imageId:'de-image'},targets[0]),false);
  assert.equal(reviewBelongsToExportTarget(task,{imageId:'de-image'},targets[1]),true);
  assert.deepEqual(latestExportImages(task).map(image=>image.id),['new-us','de-image']);
});
