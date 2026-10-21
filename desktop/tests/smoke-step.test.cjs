const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const {smokeStep}=require('../src/smoke-step.cjs');
test('hidden smoke probes use foreground-equivalent scheduling without changing production windows',async()=>{
  const source=await fs.readFile(path.join(__dirname,'..','src','main.cjs'),'utf8');
  assert.ok(source.includes('if (smoke) window.webContents.setBackgroundThrottling(false);'));
  assert.ok(source.includes('checks.smokeRendererForegroundFrames = window.webContents.getBackgroundThrottling() === false'));
});
async function fixture(t){const root=await fs.mkdtemp(path.join(os.tmpdir(),'crossborder-smoke-step-'));t.after(async()=>{assert.equal(path.dirname(await fs.realpath(root)),await fs.realpath(os.tmpdir()));await fs.rm(root,{recursive:true,force:true});});return root;}
test('smoke steps record live and completed progress without changing the checks',async t=>{
  const profileRoot=await fixture(t),checks={actual:true};
  const result=await smokeStep({profileRoot,name:'fixture',run:async()=>{assert.equal(JSON.parse(await fs.readFile(path.join(profileRoot,'smoke-progress.json'))).status,'running');return checks;}});
  assert.equal(result,checks);assert.equal(JSON.parse(await fs.readFile(path.join(profileRoot,'smoke-progress.json'))).status,'completed');
});
test('smoke step failures retain their phase and propagate the original error',async t=>{
  const profileRoot=await fixture(t),error=new Error('fixture error');
  await assert.rejects(smokeStep({profileRoot,name:'failed-fixture',run:()=>{throw error;}}),actual=>actual===error);
  const progress=JSON.parse(await fs.readFile(path.join(profileRoot,'smoke-progress.json')));assert.equal(progress.phase,'failed-fixture');assert.equal(progress.status,'failed');
});
test('a live but unresolved smoke action becomes a failed gate rather than waiting forever',async t=>{
  const profileRoot=await fixture(t);
  await assert.rejects(smokeStep({profileRoot,name:'unresolved',timeoutMs:15,run:()=>new Promise(()=>{})}),error=>error.code==='SMOKE_STEP_TIMEOUT');
  const progress=JSON.parse(await fs.readFile(path.join(profileRoot,'smoke-progress.json')));assert.equal(progress.status,'failed');assert.equal(progress.code,'SMOKE_STEP_TIMEOUT');
});
