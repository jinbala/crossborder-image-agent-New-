import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRecoveryLoader, recoveryIndexPending, recoveryStateMessage } from '../src/utils/desktopRecovery.js';
import { english } from '../src/i18n/messages.js';

const runtime = (status='completed', page=1) => ({ indexStatus:{status}, recovery:[{id:`task-${page}`}], recoveryPagination:{page,pageSize:50,total:10000} });
function clock() {
  const timers=new Map();let seq=0;
  return { timers, schedule:(fn,ms)=>{const id=++seq;timers.set(id,{fn,ms});return id;}, cancel:id=>timers.delete(id),
    async tick(){const [id,timer]=timers.entries().next().value;timers.delete(id);timer.fn();await new Promise(resolve=>setImmediate(resolve));} };
}

test('pending historical scans refresh automatically and completed scans stop polling', async()=>{
  const timer=clock(), data=[], calls=[];let count=0;
  const loader=createRecoveryLoader({...timer,getRuntime:async page=>{calls.push(page);return runtime(['pending','running','completed'][count++],page);},onData:value=>data.push(value)});
  try {
    await loader.load(1);assert.equal(timer.timers.size,1);await timer.tick();await timer.tick();
    assert.deepEqual(calls,[1,1,1]);assert.deepEqual(data.map(value=>value.runtime.indexStatus.status),['pending','running','completed']);assert.equal(timer.timers.size,0);
    assert.equal(recoveryIndexPending(runtime('failed')),false);assert.equal(recoveryIndexPending(),false);
  } finally {loader.dispose();}
});
test('a late old page is aborted and cannot replace a newer recovery page', {timeout:3000},async()=>{
  const timer=clock(), results=[], pending=new Map(), signals=[];
  const loader=createRecoveryLoader({...timer,getRuntime:(page,{signal})=>{signals.push(signal);return new Promise(resolve=>pending.set(page,()=>resolve(runtime('completed',page))));},onData:({page})=>results.push(page)});
  try {
    const first=loader.load(1), second=loader.load(2);assert.equal(signals[0].aborted,true);
    pending.get(2)();await second;pending.get(1)();await first;assert.deepEqual(results,[2]);
  } finally {for(const release of pending.values())release();loader.dispose();}
});
test('scan poll failures use bounded backoff and a manual refresh can recover', async()=>{
  const timer=clock(), errors=[], results=[];let fail=false;
  const loader=createRecoveryLoader({...timer,getRuntime:async page=>{if(fail)throw new Error('temporary scan read failure');return runtime('running',page);},onData:value=>results.push(value),onError:error=>errors.push(error.message)});
  try {
    await loader.load(1);fail=true;await timer.tick();assert.equal([...timer.timers.values()][0].ms,1000);
    await timer.tick();assert.equal([...timer.timers.values()][0].ms,2000);await timer.tick();assert.equal(timer.timers.size,0);assert.equal(errors.length,3);assert.equal(results.length,1);
    fail=false;await loader.load(1);assert.equal(results.length,2);assert.equal(timer.timers.size,1);
  } finally {loader.dispose();}
});
test('initial connection errors do not start an endless background retry',async()=>{
  const timer=clock(), errors=[];
  const loader=createRecoveryLoader({...timer,getRuntime:async()=>{throw new Error('offline');},onError:error=>errors.push(error.message)});
  try {await loader.load();assert.deepEqual(errors,['offline']);assert.equal(timer.timers.size,0);}finally{loader.dispose();}
});
test('unmounting cancels timers and in-flight callbacks from the previous page or member', {timeout:3000},async()=>{
  const timer=clock(), values=[];let release,signal;
  const loader=createRecoveryLoader({...timer,getRuntime:(_page,options)=>{signal=options.signal;return new Promise(resolve=>{release=()=>resolve(runtime('running'));});},onData:value=>values.push(value),onError:value=>values.push(value)});
  const pending=loader.load(1);loader.dispose();release();await pending;
  assert.equal(signal.aborted,true);assert.deepEqual(values,[]);assert.equal(timer.timers.size,0);
});
test('malformed responses and wrong-page responses fail without replacing a valid list',async()=>{
  const timer=clock(), values=[], errors=[];let response=runtime();
  const loader=createRecoveryLoader({...timer,getRuntime:async()=>response,onData:value=>values.push(value),onError:value=>errors.push(value)});
  try {await loader.load(1);response=runtime('completed',2);await loader.load(1);response={};await loader.load(1);
    assert.equal(values.length,1);assert.equal(errors.length,2);assert.ok(errors.every(error=>error.code==='RECOVERY_INVALID_RESPONSE'));assert.equal(timer.timers.size,0);
  }finally{loader.dispose();}
});
test('runtime API forwards the abort signal without changing pagination parameters',async()=>{
  const original=globalThis.fetch;let captured;
  try {
    globalThis.fetch=async(url,options)=>{captured={url,options};return Response.json(runtime('completed',2));};
    const {api}=await import('../src/services/api.js'), controller=new AbortController();
    await api.getDesktopRuntime({page:2,pageSize:50},{signal:controller.signal});
    assert.equal(captured.url,'/api/desktop/runtime?page=2&pageSize=50');assert.equal(captured.options.signal,controller.signal);
  }finally{globalThis.fetch=original;}
});
test('desktop recovery uses member/page-scoped loaders with separate errors and safe polling, not task execution',()=>{
  const page=fs.readFileSync(new URL('../src/pages/DesktopPage.jsx',import.meta.url),'utf8');
  assert.match(page,/\[recoveryPage, actorId\]/);assert.match(page,/loader\.dispose\(\)/);assert.match(page,/setRecoveryError\(null\)/);
  assert.match(page,/data-recovery-index-status/);assert.match(page,/data-recovery-pager/);
  assert.match(page,/recoveryIndexPending\(runtime\)/);assert.match(page,/历史任务索引未完成/);
});

test('recovery translates controlled states and hints without changing user titles', () => {
  assert.equal(recoveryStateMessage('waiting_user'), '等待人工');
  assert.equal(english[recoveryStateMessage('waiting_user')], 'Awaiting user');
  assert.equal(recoveryStateMessage('future-state'), 'future-state');
  for (const message of ['查看已保存的预览或计划，核对后手动确认；不会自动执行', '从 SKU 恢复点继续，已完成 SKU 不重复', '选择断点继续或重试失败商品', '仅本地模拟：核对差异并重新确认审批；不会写入真实店铺', '查看任务详情并手动确认继续']) assert.ok(english[message], message);
  const page = fs.readFileSync(new URL('../src/pages/DesktopPage.jsx', import.meta.url), 'utf8');
  assert.match(page, /t\(recoveryStateMessage\(item.state\)\)/); assert.match(page, /t\(item.hint\)/);
  assert.doesNotMatch(page, /t\(item.name\)/);
});
