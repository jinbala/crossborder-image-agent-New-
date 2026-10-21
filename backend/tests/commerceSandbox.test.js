import { test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import app from '../src/app.js';
import { platformDb } from '../src/services/platformStore.js';
import { createCommerceSandbox, runCommerceSandbox, stopCommerceSandbox } from '../src/services/commerceSandboxService.js';

const actor = { id: 'local-admin', role: 'admin', displayName: 'Local test' };
async function preview() {
  return (await request(app).post('/api/workbench/pricing-previews').send({ items: [{ sku: 'A', price: 10 }, { sku: 'B', price: 20 }, { sku: 'INVALID', price: 0 }], rules: [{ type: 'fixed', value: 1 }] }).expect(201)).body;
}
test('commerce sandbox requires current approval and retries failures without duplicate store writes', async () => {
  const source = await preview();
  await assert.rejects(createCommerceSandbox({ sourceId: source.id, confirm: true, mode: 'live' }, actor), /真实店铺/);
  const job = await createCommerceSandbox({ sourceId: source.id, confirm: true, mode: 'local-sandbox', failOnceSkus: ['B'] }, actor);
  await assert.rejects(runCommerceSandbox(job.id, { confirm: true, approvalHash: 'wrong' }, actor), /审批/);
  const partial = await runCommerceSandbox(job.id, { confirm: true, approvalHash: job.approvalHash }, actor);
  assert.equal(partial.state, 'partial'); assert.equal(partial.summary.successCount, 1); assert.equal(partial.summary.failedCount, 1); assert.equal(partial.summary.skippedCount, 1);
  const done = await runCommerceSandbox(job.id, { confirm: true, approvalHash: job.approvalHash, retryFailed: true }, actor);
  assert.equal(done.state, 'completed'); assert.equal(done.items[0].attempt, 1); assert.equal(done.items[1].attempt, 2);
  await runCommerceSandbox(job.id, { confirm: true, approvalHash: job.approvalHash, retryFailed: true }, actor);
  assert.equal(platformDb().prepare("SELECT count(*) AS n FROM platform_records WHERE kind='sandbox-receipt' AND json_extract(data,'$.jobId')=?").get(job.id).n, 2);
  assert.equal(done.liveWritesEnabled, false);
});
test('commerce sandbox survives interruption, stops at item boundary and isolates owner', async () => {
  const source = await preview(), job = await createCommerceSandbox({ sourceId: source.id, confirm: true, mode: 'local-sandbox' }, actor);
  const input = { confirm: true, approvalHash: job.approvalHash };
  await assert.rejects(runCommerceSandbox(job.id, input, actor, { afterItem() { throw new Error('crash'); } }), /crash/);
  const paused = await runCommerceSandbox(job.id, input, actor, { afterItem() { stopCommerceSandbox(job.id, { action: 'cancel', confirm: true }, actor); } });
  assert.equal(paused.state, 'cancelled'); assert.equal(paused.items[0].attempt, 1);
  await request(app).get(`/api/platform/commerce-sandbox/${job.id}`).expect(200);
  await assert.rejects(runCommerceSandbox(job.id, input, { id: 'another', role: 'operator' }), /不存在/);
});
