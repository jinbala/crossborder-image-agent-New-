import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';

async function popup({ paired = true, allow = true, sendGate } = {}) {
  const elements = {}, events = [];
  const state = { status: 'awaiting_transfer', cursor: 1, urls: [], rows: [{ productUrl: 'https://www.temu.com/goods.html?goods_id=1', imageUrls: ['https://img.example/a.png'] }], failures: [], options: {} };
  const element = (id) => elements[id] ||= { value: '', checked: id === 'browserSessionDownload', style: {}, listeners: {}, textContent: '', addEventListener(type, fn) { this.listeners[type] = fn; } };
  const context = vm.createContext({ URL, Set, Math, Number, Boolean, String, Object, Error,
    document: { getElementById: element }, window: { setInterval() {}, setTimeout() {}, confirm: () => true },
    chrome: { runtime: { sendMessage: async (message) => {
      events.push(message.type);
      if (message.type === 'finish-manual' && sendGate) await sendGate;
      return { ok: true, result: message.type === 'connection' ? { serviceUrl: paired ? 'http://127.0.0.1:60011' : '', paired, mode: paired ? 'desktop' : 'unconfigured' } : state };
    } }, permissions: { request: async ({ origins }) => { events.push('image-permission'); assert.deepEqual(Array.from(origins), ['https://img.example/*']); return allow; } } }
  });
  const source = await fs.readFile(new URL('../../browser-extension/temu-deep-collector/popup.js', import.meta.url), 'utf8');
  vm.runInContext(source, context); await vm.runInContext('refresh()', context); events.length = 0;
  return { elements, events, state, click: (id) => elements[id].listeners.click(), refresh: () => vm.runInContext('refresh()', context) };
}
test('manual transfer view displays a manual count instead of the misleading 1 / 0 progress', async () => {
  const fixture = await popup(); assert.match(fixture.elements.status.textContent, /手动清单：1 个商品/); assert.doesNotMatch(fixture.elements.status.textContent, /1 \/ 0/);
});

test('partial transfer displays stages and pending counts but never renders signed image addresses', async () => {
  const fixture = await popup();
  fixture.state.backendJob = { id: 'existing-job' };
  fixture.state.browserTransfer = { total: 3, success: 1, failed: 1, pending: 1, failures: [{ stage: 'local-upload', code: 'LOCAL_SERVICE_UNREACHABLE', message: '本机服务已断开', sourceUrl: 'https://img.example/private.png?token=private-signed-query' }] };
  await fixture.refresh();
  assert.match(fixture.elements.status.textContent, /未处理 1/); assert.match(fixture.elements.status.textContent, /本机接收/);
  assert.match(fixture.elements.status.textContent, /LOCAL_SERVICE_UNREACHABLE/); assert.doesNotMatch(fixture.elements.status.textContent, /private-signed-query|private.png/);
  assert.match(fixture.elements.workflowStep.textContent, /回传未完成/); assert.equal(fixture.elements.finishManual.disabled, false);
});
test('unpaired send preserves the list and does not request image permissions or create a task', async () => {
  const fixture = await popup({ paired: false }); await fixture.click('finishManual'); assert.match(fixture.elements.error.textContent, /先展开/); assert.equal(fixture.events.length, 0);
});
test('image permission consent is requested before the asynchronous backend transfer', async () => {
  const fixture = await popup(); await fixture.click('finishManual'); assert.deepEqual(fixture.events, ['image-permission', 'finish-manual']);
});
test('denied permission never starts transfer and refresh does not hide the error', async () => {
  const fixture = await popup({ allow: false }); await fixture.click('finishManual'); assert.deepEqual(fixture.events, ['image-permission']); assert.match(fixture.elements.error.textContent, /未授权图片域名/); await fixture.refresh(); assert.match(fixture.elements.error.textContent, /未授权图片域名/);
});
test('polling connection metadata preserves an address currently being edited', async () => {
  const fixture = await popup(); fixture.elements.serviceUrl.value = 'http://127.0.0.1:61111'; await fixture.refresh(); assert.equal(fixture.elements.serviceUrl.value, 'http://127.0.0.1:61111');
});

test('the three manual actions precede pairing and collapsed advanced settings in popup markup', async () => {
  const html=await fs.readFile(new URL('../../browser-extension/temu-deep-collector/popup.html',import.meta.url),'utf8');
  for(const id of ['collectCurrent','finishManual','openJob'])assert.ok(html.indexOf(`id="${id}"`)<html.indexOf('id="connectionDetails"'));
  assert.match(html,/2\. 发送到本地工作台/);assert.match(html,/3\. 查看下载任务/);
  assert.doesNotMatch(html,/<details[^>]*id="(?:collectionSettings|automaticCollection)"[^>]*\bopen\b/);
  const manifest = JSON.parse(await fs.readFile(new URL('../../browser-extension/temu-deep-collector/manifest.json', import.meta.url), 'utf8'));
  assert.ok(html.includes(`<small>${manifest.version}</small>`));
});

test('next-step guidance follows the actual list and job, without treating pairing as a completed image transfer',async()=>{
  const fixture=await popup();assert.match(fixture.elements.workflowStep.textContent,/第 2 步/);assert.equal(fixture.elements.finishManual.disabled,false);
  fixture.state.rows=[];await fixture.refresh();assert.equal(fixture.elements.finishManual.disabled,true);assert.match(fixture.elements.workflowStep.textContent,/第 1 步/);
  fixture.state.rows=[{imageUrls:[]}];fixture.state.backendJob={id:'fixture-&-任务'};await fixture.refresh();
  assert.match(fixture.elements.workflowStep.textContent,/第 3 步/);assert.equal(fixture.elements.openJob.style.display,'inline-block');
  assert.equal(fixture.elements.openJob.href,`crossborder-workbench://collection?jobId=${encodeURIComponent('fixture-&-任务')}`);
});

test('unpaired guidance opens connection controls and preserves list and entered task name',async()=>{
  const fixture=await popup({paired:false});fixture.elements.name.value='自定义任务';await fixture.click('finishManual');
  assert.equal(fixture.elements.connectionDetails.open,true);assert.equal(fixture.state.rows.length,1);await fixture.refresh();
  assert.equal(fixture.elements.name.value,'自定义任务');assert.match(fixture.elements.workflowStep.textContent,/展开“客户端连接”/);
});

test('double send and concurrent collect cannot repeat permission requests or transfers while the first send is pending',async()=>{
  let release;const gate=new Promise(resolve=>{release=resolve;}),fixture=await popup({sendGate:gate});
  const first=fixture.click('finishManual');await new Promise(setImmediate);
  assert.equal(fixture.elements.finishManual.disabled,true);assert.equal(fixture.elements.collectCurrent.disabled,true);
  await fixture.click('finishManual');await fixture.click('collectCurrent');assert.deepEqual(fixture.events,['image-permission','finish-manual']);
  release();await first;assert.equal(fixture.elements.finishManual.disabled,false);assert.equal(fixture.elements.collectCurrent.disabled,false);
});
