import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { acceptanceDocument, acceptanceJournalKey, acceptanceNeedsUnloadWarning, createAcceptanceWorkspace } from '../src/utils/acceptanceWorkspace.js';

const clone = value => JSON.parse(JSON.stringify(value));
const storage = () => { const map = new Map(); return { getItem: key => map.get(key), setItem: (key, value) => map.set(key, value), removeItem: key => map.delete(key) }; };
const doc = title => ({ report: { title, issueLogs: [{ title: '未翻译原文' }] }, issueForm: { title: '问题草稿' }, realApiForm: { taskId: '', confirmPaidApi: true, confirmRealApi: true, confirmNoPlatformUpload: true } });

test('unload warning follows current save/reset state and protects UI edits before the autosave effect runs',()=>{
  const original=doc('original'),saved={status:'saved',document:acceptanceDocument(original)};
  assert.equal(acceptanceNeedsUnloadWarning(saved,original),false);
  assert.equal(acceptanceNeedsUnloadWarning(saved,doc('edited')),true);
  for(const status of ['dirty','saving','error','conflict'])assert.equal(acceptanceNeedsUnloadWarning({...saved,status},original),true);
  const reset={status:'saved',document:acceptanceDocument({})};assert.equal(acceptanceNeedsUnloadWarning(reset,{}),false);
  assert.equal(acceptanceNeedsUnloadWarning(undefined,original),false);
  const page=fs.readFileSync(new URL('../src/pages/FinalAcceptancePage.jsx',import.meta.url),'utf8');
  assert.match(page,/acceptanceNeedsUnloadWarning\(workspaceController\.current\?\.snapshot\(\), currentDocument\.current\)/);
});
function fixture(journal = storage()) {
  let context = { actorId: 'member-A', editable: true, generation: 'generation-A', revision: 0, document: null, unavailable: false, corrupt: false };
  let calls = [], counter = 0, rejectAfterSave = false, barrier = null;
  const api = {
    getAcceptanceWorkspace: async () => clone(context),
    validateAcceptanceWorkspace: async document => ({ document: acceptanceDocument(document) }),
    saveAcceptanceWorkspace: async body => {
      calls.push(clone(body)); if (barrier) { const wait = barrier; barrier = null; await wait; }
      if (body.requestId !== context.lastRequestId) {
        if (body.revision !== context.revision || body.generation !== context.generation) throw Object.assign(new Error('fixture conflict'), { status: 409 });
        context = { ...context, revision: context.revision + 1, document: acceptanceDocument(body.document), lastRequestId: body.requestId };
      }
      if (rejectAfterSave) { rejectAfterSave = false; throw new Error('fixture acknowledgement lost'); }
      return clone(context);
    },
    resetAcceptanceWorkspace: async () => (context = { ...context, document: null, revision: 0, generation: 'new-generation' })
  };
  const controllers = [];
  const create = options => { const controller = createAcceptanceWorkspace(api, { actorId: 'member-A', journal, delay: 10000, uuid: () => `request-fixture-${++counter}`, ...options }); controllers.push(controller); return controller; };
  return { api, create, journal, calls, context: () => context, replace: next => { context = { ...context, ...next }; }, rejectNext: () => { rejectAfterSave = true; }, block: () => { let release; barrier = new Promise(resolve => { release = resolve; }); return release; }, dispose: () => controllers.forEach(controller => controller.dispose()) };
}

test('acceptance state saves original decisions and form drafts but no credentials or paid approval flags', async () => {
  const f = fixture(); try {
    const controller = f.create(); await controller.open(); controller.change(doc('原始报告')); await controller.flush();
    assert.equal(controller.snapshot().status, 'saved'); assert.equal(f.context().revision, 1);
    assert.equal(f.context().document.report.title, '原始报告'); assert.equal(f.context().document.issueForm.title, '问题草稿');
    assert.equal(f.context().document.realApiForm.confirmPaidApi, undefined); assert.equal(f.journal.getItem(acceptanceJournalKey('member-A')), undefined);
    const reopened = f.create(); await reopened.open(); assert.equal(reopened.snapshot().document.report.title, '原始报告');
    assert.deepEqual(acceptanceDocument({ realApiForm: { password: 'x', token: 'ordinary', accessToken: 'x', confirmRealApi: true } }).realApiForm, {});
  } finally { f.dispose(); }
});
test('typing during an in-flight save serializes the newest version without dropping later edits', async () => {
  const f = fixture(); try {
    const controller = f.create(); await controller.open(); controller.change(doc('first'));
    const release = f.block(), saving = controller.flush(); controller.change(doc('newest')); assert.equal(f.calls.length, 1);
    release(); await saving;
    assert.equal(f.calls.length, 2); assert.equal(f.context().revision, 2); assert.equal(f.context().document.report.title, 'newest');
    assert.equal(controller.snapshot().status, 'saved');
  } finally { f.dispose(); }
});
test('lost acknowledgement survives refresh and retries the same request before saving newer pending changes', async () => {
  const f = fixture(); try {
    const controller = f.create(); await controller.open(); controller.change(doc('first')); f.rejectNext(); await controller.flush();
    assert.equal(controller.snapshot().status, 'error'); controller.change(doc('latest after failure')); controller.dispose();
    const recovered = f.create(); await recovered.open();
    assert.equal(recovered.snapshot().status, 'saved'); assert.equal(f.context().document.report.title, 'latest after failure');
    assert.equal(f.calls[0].requestId, f.calls[1].requestId); assert.equal(f.context().revision, 2);
    assert.equal(JSON.stringify(f.calls).includes('confirmPaidApi'), false);
  } finally { f.dispose(); }
});
test('other-window changes conflict without overwriting or silently discarding the local report', async () => {
  const f = fixture(); try {
    const controller = f.create(); await controller.open(); controller.change(doc('local report'));
    f.replace({ revision: 1, document: acceptanceDocument(doc('other window')) }); await controller.flush();
    assert.equal(controller.snapshot().status, 'conflict'); assert.equal(controller.snapshot().document.report.title, 'local report');
    assert.equal(f.context().document.report.title, 'other window'); assert.ok(f.journal.getItem(acceptanceJournalKey('member-A')));
    await controller.open({ discardLocal: true }); assert.equal(controller.snapshot().document.report.title, 'other window');
    assert.equal(f.journal.getItem(acceptanceJournalKey('member-A')), undefined);
  } finally { f.dispose(); }
});
test('restore generation or ownership changes never automatically replay or display a stale journal', async () => {
  const f = fixture(); try {
    const controller = f.create(); await controller.open(); controller.change(doc('stale local')); controller.dispose();
    f.replace({ generation: 'restored-generation', document: acceptanceDocument(doc('restored report')) });
    const recovered = f.create(); await recovered.open();
    assert.equal(recovered.snapshot().status, 'conflict'); assert.equal(recovered.snapshot().document.report.title, 'restored report'); assert.equal(f.calls.length, 0);
    f.replace({ generation: 'generation-A' }); f.api.validateAcceptanceWorkspace = async () => { throw Object.assign(new Error('reference no longer owned'), { status: 404 }); };
    const denied = f.create(); await denied.open(); assert.equal(denied.snapshot().status, 'blocked'); assert.notEqual(denied.snapshot().document.report.title, 'stale local');
  } finally { f.dispose(); }
});
test('readonly users cannot save or reset through the editing controller and storage quota failures remain visible', async () => {
  const f = fixture({ getItem: () => { throw new Error('quota'); }, setItem: () => { throw new Error('quota'); }, removeItem: () => { throw new Error('quota'); } });
  try {
    const controller = f.create(); await controller.open(); controller.change(doc('server still saves')); await controller.flush();
    assert.equal(controller.snapshot().status, 'saved'); assert.equal(controller.snapshot().journalUnavailable, true);
    f.replace({ editable: false }); const readonly = f.create(); await readonly.open(); readonly.change(doc('must not save')); await readonly.flush(); await readonly.reset();
    assert.equal(f.calls.length, 1); assert.equal(f.context().document.report.title, 'server still saves');
  } finally { f.dispose(); }
});

test('definitively rejected input can be corrected and saved with a fresh request', async () => {
  const f = fixture(); try {
    const original = f.api.saveAcceptanceWorkspace; let reject = true;
    f.api.saveAcceptanceWorkspace = async body => { if (reject) throw Object.assign(new Error('bad task reference'), { status: 404 }); return original(body); };
    const controller = f.create(); await controller.open(); controller.change(doc('bad input')); await controller.flush();
    assert.equal(controller.snapshot().status, 'error'); assert.equal(controller.snapshot().inFlight, null);
    reject = false; controller.change(doc('corrected input')); await controller.flush(); assert.equal(f.context().document.report.title, 'corrected input');
  } finally { f.dispose(); }
});

test('corrupt journal is retained with a conflict and never treated as a successful recovery', async () => {
  const f = fixture(); try {
    f.journal.setItem(acceptanceJournalKey('member-A'), '{broken-json');
    const controller = f.create(); await controller.open(); assert.equal(controller.snapshot().status, 'conflict');
    assert.equal(f.journal.getItem(acceptanceJournalKey('member-A')), '{broken-json'); assert.equal(f.calls.length, 0);
  } finally { f.dispose(); }
});

test('explicit reset cancels pending autosave and does not recreate the removed report', async () => {
  const f = fixture(); try {
    const controller = f.create({ delay: 10 }); await controller.open(); controller.change(doc('pending removal'));
    await controller.reset(); await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(controller.snapshot().status, 'saved'); assert.equal(controller.snapshot().document.report, null);
    assert.equal(f.calls.length, 0); assert.equal(f.context().document, null);
  } finally { f.dispose(); }
});

test('out-of-order initial reads cannot replace a newer workspace response', async () => {
  const f = fixture(); try {
    let release, reads = 0;
    f.api.getAcceptanceWorkspace = () => ++reads===1 ? new Promise(resolve=>{release=resolve;}) : Promise.resolve({ ...f.context(), document: acceptanceDocument(doc('new response')) });
    const controller = f.create(), first=controller.open(); await controller.open();
    release({ ...f.context(), document: acceptanceDocument(doc('stale response')) }); await first;
    assert.equal(controller.snapshot().document.report.title, 'new response');
  } finally { f.dispose(); }
});
test('acceptance page protects unsaved unload, persists forms, resets approvals on recovery and requires reset confirmation', () => {
  const page = fs.readFileSync(new URL('../src/pages/FinalAcceptancePage.jsx', import.meta.url), 'utf8');
  assert.match(page, /beforeunload/); assert.match(page, /confirmRealApi: false, confirmPaidApi: false, confirmNoPlatformUpload: false/);
  assert.match(page, /fieldset disabled=\{!workspaceEditable \|\| Boolean\(busy\)\}/); assert.match(page, /controller\.dispose\(\)/);
  assert.match(page, /重置当前成员的验收工作区/); assert.match(page, /data-acceptance-workspace-status/);
});
