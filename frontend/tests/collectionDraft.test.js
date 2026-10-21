import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertCollectionDraftContext, recoverCollectionDraft } from '../src/utils/collectionDraft.js';
import { api } from '../src/services/api.js';

const context = { actorId: 'alice', generation: 'original-generation', draft: { id: 'original-draft', state: 'pending' } };
const job = { id: 'collect-job-original', creation: { durable: true } };
test('recovery rejects stale members and corrupt records before any network mutation', async () => {
  let mutations = 0; const fake = { submitCollectionDraft() { mutations++; } };
  assert.throws(() => assertCollectionDraftContext(context, 'bob'));
  await assert.rejects(recoverCollectionDraft(fake, context, 'bob'));
  for (const state of ['unavailable', 'corrupt']) await assert.rejects(recoverCollectionDraft(fake, { ...context, draft: { ...context.draft, state } }, 'alice'));
  assert.equal(mutations, 0);
});
test('lost submit reply preserves server draft and retry acknowledges only its recovered task', async () => {
  let attempts = 0; const calls = [], visible = [];
  const fake = {
    async submitCollectionDraft(id, actor) { calls.push(['submit', id, actor]); if (!attempts++) throw new Error('reply lost'); return job; },
    async acknowledgeCollectionDraft(...args) { calls.push(['ack', ...args]); },
    async getCollectionDraft() { return { ...context, draft: null, generation: 'next' }; }
  };
  await assert.rejects(recoverCollectionDraft(fake, context, 'alice', (value) => visible.push(value)), /reply lost/);
  assert.equal(calls.filter(([type]) => type === 'ack').length, 0);
  const result = await recoverCollectionDraft(fake, context, 'alice', (value) => visible.push(value));
  assert.deepEqual(calls, [['submit', 'original-draft', 'alice'], ['submit', 'original-draft', 'alice'], ['ack', 'original-draft', 'alice', job.id]]);
  assert.deepEqual(visible, [job]); assert.equal(result.context.draft, null);
});
test('a known task remains visible if acknowledgement fails and invalid replies are never acknowledged', async () => {
  let visible = null, acknowledgements = 0;
  const fake = { async submitCollectionDraft() { return job; }, async acknowledgeCollectionDraft() { acknowledgements++; throw new Error('ack lost'); } };
  await assert.rejects(recoverCollectionDraft(fake, context, 'alice', (value) => { visible = value; }), /ack lost/);
  assert.equal(visible.id, job.id); assert.equal(acknowledgements, 1);
  fake.submitCollectionDraft = async () => ({ id: 'unconfirmed' });
  await assert.rejects(recoverCollectionDraft(fake, context, 'alice'));
  assert.equal(acknowledgements, 1);
});
test('API helpers use staged rows or multipart input, explicit member/generation, and compare-bound acknowledgement', async () => {
  const previous = global.fetch, calls = [];
  global.fetch = async (url, options) => { calls.push({ url, ...options }); return { ok: true, async json() { return context; } }; };
  try {
    await api.stageCollectionRows([{ productUrl: 'https://shop.example/item' }], { name: '原文' }, context);
    assert.deepEqual(JSON.parse(calls[0].body), { rows: [{ productUrl: 'https://shop.example/item' }], options: { name: '原文' }, expectedActorId: 'alice', generation: context.generation });
    await api.stageCollectionSheet(new File(['SKU,图片链接'], '原表.csv'), { name: '原文' }, context);
    assert.ok(calls[1].body instanceof FormData); assert.equal(calls[1].body.get('sheet').name, '原表.csv'); assert.equal(calls[1].body.get('expectedActorId'), 'alice');
    await api.acknowledgeCollectionDraft(context.draft.id, 'alice', job.id);
    assert.deepEqual(JSON.parse(calls[2].body), { expectedActorId: 'alice', jobId: job.id });
    await api.discardCollectionDraft(context.draft.id, 'alice'); assert.equal(JSON.parse(calls[3].body).confirm, true);
    assert.ok(calls.every((call) => !call.url.includes('/collection-jobs')));
  } finally { global.fetch = previous; }
});
