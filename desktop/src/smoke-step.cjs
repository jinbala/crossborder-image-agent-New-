const fs = require('node:fs/promises');
const path = require('node:path');
const { redact } = require('./runtime.cjs');
async function smokeStep({ profileRoot, name, run, timeoutMs = 90000 }) {
  const file=path.join(profileRoot,'smoke-progress.json'),started=Date.now();let timer;
  const write=state=>fs.writeFile(file,JSON.stringify({phase:name,startedAt:new Date(started).toISOString(),...state},null,2));
  await write({status:'running'});
  try {
    const result=await Promise.race([Promise.resolve().then(run),new Promise((_resolve,reject)=>{
      timer=setTimeout(()=>reject(Object.assign(new Error(`Smoke step timed out: ${name}`),{code:'SMOKE_STEP_TIMEOUT'})),timeoutMs);
    })]);
    await write({status:'completed',durationMs:Date.now()-started});return result;
  } catch(error) {
    await write({status:'failed',durationMs:Date.now()-started,error:redact(error.message,[profileRoot]),code:error.code||null});throw error;
  } finally { clearTimeout(timer); }
}
module.exports={smokeStep};
