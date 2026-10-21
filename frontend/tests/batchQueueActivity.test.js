import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { batchQueueActivity } from '../src/utils/batchQueueActivity.js';
import { translate } from '../src/i18n/core.js';

test('cancelled but draining queue remains busy and polling until the last request releases its lock', () => {
  assert.deepEqual(batchQueueActivity({ queue: { status: 'cancelled', runningJobs: 1 }, locks: { isRunning: true } }), { running: false, paused: false, busy: true, draining: true, poll: true });
  assert.deepEqual(batchQueueActivity({ queue: { status: 'cancelled', runningJobs: 0 }, locks: { isRunning: false } }), { running: false, paused: false, busy: false, draining: false, poll: false });
  assert.equal(batchQueueActivity().poll, false);
});

test('paused queue polls in-flight work but a settled paused lease does not poll forever', () => {
  assert.equal(batchQueueActivity({ queue: { status: 'paused', runningJobs: 1 }, locks: { isRunning: true } }).poll, true);
  const settled = batchQueueActivity({ queue: { status: 'paused', runningJobs: 0 }, locks: { isRunning: true } });
  assert.equal(settled.poll, false); assert.equal(settled.busy, true); assert.equal(settled.paused, true);
  assert.equal(batchQueueActivity({ queue: { status: 'running' } }).poll, true);
});

test('completed records remain busy and polling while the live worker finishes statistics and logs',()=>{
  const current={queue:{status:'completed',runningJobs:0},locks:{isRunning:false},runtime:{queueActive:true}};
  assert.equal(batchQueueActivity(current).busy,true);assert.equal(batchQueueActivity(current).poll,true);
  current.runtime.queueActive=false;assert.equal(batchQueueActivity(current).busy,false);assert.equal(batchQueueActivity(current).poll,false);
});

test('batch page uses live lock state for restart guards and keeps polling cancellation results', () => {
  const page = fs.readFileSync(new URL('../src/pages/BatchPage.jsx', import.meta.url), 'utf8');
  assert.match(page, /!batchQueueActivity\(batchTask\)\.poll/);
  assert.match(page, /batchTask\?\.locks\?\.isRunning/);
  assert.match(page, /data-queue-draining/);
  assert.match(page, /disabled=\{Boolean\(busy\) \|\| queueBusy\}[\s\S]*?api\.startBatchQueue/);
  const message = '取消已生效，当前 SKU 请求仍在结束中；不会启动新 SKU 或自动重试。队列锁释放后才可开始新队列，未处理项不会计为成功。';
  assert.match(translate('en-US', message), /unprocessed items are not counted as successes/);
});
