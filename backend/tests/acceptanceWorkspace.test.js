import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import request from 'supertest';
import app from '../src/app.js';
import { withActor, claimResource } from '../src/services/ownershipService.js';
import { platformDb, platformBackup, restorePlatformBackup } from '../src/services/platformStore.js';
import { paths } from '../src/services/dbPaths.js';
import { createMember, AGREEMENT_VERSION } from '../src/services/accountService.js';
import { beginWorkspaceRestore } from '../src/services/workspaceLifecycle.js';
import { getAcceptanceWorkspace, saveAcceptanceWorkspace, resetAcceptanceWorkspace, validateAcceptanceWorkspace } from '../src/services/acceptanceWorkspaceService.js';

const owners = new Set(), members = new Set();
const user = (role = 'operator') => { const actor = { id: `acceptance-${randomUUID()}`, role }; owners.add(actor.id); return actor; };
const document = () => ({ report: { issueLogs: [{ title: '原文问题-服装边缘', relatedTaskId: '', status: 'open' }], moduleAcceptance: [{ moduleKey: 'matting', manualAcceptance: { status: 'failed', reviewer: '测试人', notes: '袖口待修' } }] }, issueForm: { title: '尚未添加的问题' }, realApiForm: { taskId: '', confirmPaidApi: true, confirmRealApi: true, confirmNoPlatformUpload: true }, realApiReport: { apiCalls: [{ confirmPaidApi: true, apiKey: 'fixture-not-a-secret' }] } });
const payload = (context, value = document()) => ({ expectedActorId: context.actorId, generation: context.generation, revision: context.revision, requestId: randomUUID(), document: value });
afterEach(() => {
  for (const id of owners) platformDb().prepare('DELETE FROM acceptance_workspaces WHERE owner_id=?').run(id);
  for (const id of members) { platformDb().prepare('DELETE FROM sessions WHERE user_id=?').run(id); platformDb().prepare('DELETE FROM members WHERE id=?').run(id); }
  owners.clear(); members.clear();
});

test('acceptance documents survive another process, preserve manual text and never persist paid approvals', async () => {
  const actor = user();
  await withActor(actor, async () => {
    const before = getAcceptanceWorkspace(), body = payload(before), saved = saveAcceptanceWorkspace(body);
    assert.equal(saved.revision, 1); assert.equal(saved.document.report.issueLogs[0].title, '原文问题-服装边缘');
    assert.equal(saved.document.realApiForm.confirmPaidApi, undefined); assert.equal(saved.document.realApiForm.confirmRealApi, undefined);
    assert.equal(saved.document.realApiForm.confirmNoPlatformUpload, undefined); assert.equal(saved.document.realApiReport.apiCalls[0].apiKey, undefined);
    const child = `import {withActor} from './src/services/ownershipService.js';import {getAcceptanceWorkspace} from './src/services/acceptanceWorkspaceService.js';console.log(JSON.stringify(withActor(${JSON.stringify(actor)},()=>getAcceptanceWorkspace())));`;
    const restored = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', child], { cwd: path.resolve(import.meta.dirname, '..'), encoding: 'utf8' }));
    assert.deepEqual(restored.document, saved.document); assert.equal(restored.generation, saved.generation);
  });
});
test('lost save acknowledgement replays once, stale revisions and reused IDs cannot overwrite current data', () => {
  withActor(user(), () => {
    const first = payload(getAcceptanceWorkspace()), saved = saveAcceptanceWorkspace(first);
    assert.equal(saveAcceptanceWorkspace(first).revision, 1); assert.equal(saveAcceptanceWorkspace(first).replayed, true);
    assert.throws(() => saveAcceptanceWorkspace({ ...first, document: { report: { title: 'different' } } }), error => error.code === 'ACCEPTANCE_REQUEST_CONFLICT');
    assert.throws(() => saveAcceptanceWorkspace({ ...first, requestId: randomUUID() }), error => error.code === 'ACCEPTANCE_REVISION_CONFLICT');
    const next = saveAcceptanceWorkspace(payload(saved, { report: { title: '新版本' } }));
    assert.equal(next.revision, 2); assert.throws(() => saveAcceptanceWorkspace(first), error => error.statusCode === 409);
    assert.equal(getAcceptanceWorkspace().document.report.title, '新版本');
  });
});
test('workspaces are private even from another admin; actor mismatch, readonly and support cannot mutate', () => {
  const alice = user(), bob = user('admin');
  const first = withActor(alice, () => payload(getAcceptanceWorkspace())); withActor(alice, () => saveAcceptanceWorkspace(first));
  withActor(bob, () => { assert.equal(getAcceptanceWorkspace().document, null); assert.throws(() => saveAcceptanceWorkspace(first), error => error.code === 'ACCEPTANCE_ACTOR_CHANGED'); });
  withActor({ ...alice, role: 'viewer' }, () => { assert.equal(getAcceptanceWorkspace().editable, false); assert.throws(() => saveAcceptanceWorkspace(first), error => error.statusCode === 403); });
  withActor({ ...alice, role: 'support' }, () => assert.throws(getAcceptanceWorkspace, error => error.statusCode === 403));
});
test('reassigned references are redacted and cannot be cached, saved or overwritten without explicit reset', () => {
  const alice = user(), bob = user(), taskId = `acceptance-task-${randomUUID()}`;
  withActor(alice, () => claimResource('image', taskId));
  const saved = withActor(alice, () => saveAcceptanceWorkspace(payload(getAcceptanceWorkspace(), { report: { skuAcceptance: [{ taskId, notes: '原成员业务内容' }] } })));
  platformDb().prepare("UPDATE resource_owners SET owner_id=? WHERE kind='image' AND resource_id=?").run(bob.id, taskId);
  withActor(alice, () => {
    const current = getAcceptanceWorkspace(); assert.equal(current.unavailable, true); assert.equal(current.document, null);
    assert.throws(() => validateAcceptanceWorkspace(saved.document, alice.id), error => error.statusCode === 404);
    assert.throws(() => saveAcceptanceWorkspace(payload(current, { report: {} })), error => error.code === 'ACCEPTANCE_UNAVAILABLE');
    const resetBody = { expectedActorId: alice.id, generation: current.generation, revision: current.revision };
    assert.throws(() => resetAcceptanceWorkspace(resetBody), error => error.statusCode === 400);
    const reset = resetAcceptanceWorkspace({ ...resetBody, confirm: true }); assert.equal(reset.document, null); assert.notEqual(reset.generation, saved.generation);
  });
  platformDb().prepare("DELETE FROM resource_owners WHERE kind='image' AND resource_id=?").run(taskId);
});
test('backup restore preserves saved reports but invalidates pre-restore generations and respects restore barriers', async () => {
  const actor = user(), file = path.join(paths.dataDir, `acceptance-test-${randomUUID()}.sqlite`);
  try {
    await withActor(actor, async () => {
      const saved = saveAcceptanceWorkspace(payload(getAcceptanceWorkspace())); await fs.writeFile(file, platformBackup());
      const release = beginWorkspaceRestore(); try { assert.throws(getAcceptanceWorkspace, error => error.code === 'WORKSPACE_BUSY'); } finally { release(); }
      restorePlatformBackup(file); const restored = getAcceptanceWorkspace();
      assert.deepEqual(restored.document, saved.document); assert.notEqual(restored.generation, saved.generation);
      assert.throws(() => saveAcceptanceWorkspace(payload(saved)), error => error.code === 'ACCEPTANCE_CONTEXT_CHANGED');
    });
  } finally { await fs.rm(file, { force: true }); }
});
test('HTTP requires session, CSRF, current member and appropriate role for acceptance persistence', async () => {
  const previous = process.env.WEB_AUTH_ENABLED, password = 'Acceptance-fixture-password-123';
  try {
    process.env.WEB_AUTH_ENABLED = 'true';
    const route = '/api/final-acceptance/workspace';
    await request(app).get(route).expect(401);
    for (const role of ['operator', 'designer', 'viewer', 'support']) {
      const name = `acc-${randomUUID().slice(0, 12)}`;
      const member = await createMember({ username: name, password, role }, { id: 'fixture-admin', role: 'admin' }); members.add(member.id); owners.add(member.id);
      const response = await request(app).post('/api/auth/login').send({ username: name, password, agree: true, agreementVersion: AGREEMENT_VERSION }).expect(200);
      const cookie = response.headers['set-cookie'][0].split(';')[0], csrf = response.body.csrf;
      if (role === 'support') { await request(app).get(route).set('Cookie', cookie).expect(403); continue; }
      const context = (await request(app).get(route).set('Cookie', cookie).expect(200)).body;
      await request(app).post(route).set('Cookie', cookie).send(payload(context)).expect(403);
      const saved = await request(app).post(route).set('Cookie', cookie).set('X-CSRF-Token', csrf).send(payload(context)).expect(role === 'viewer' ? 403 : 200);
      if (role !== 'viewer') assert.equal(saved.body.revision, 1);
    }
  } finally { if (previous === undefined) delete process.env.WEB_AUTH_ENABLED; else process.env.WEB_AUTH_ENABLED = previous; }
});

test('corrupt and excessive documents fail closed without silently replacing the stored report', () => {
  const actor=user(); withActor(actor,()=>{
    const saved=saveAcceptanceWorkspace(payload(getAcceptanceWorkspace()));
    const oversized=payload(saved,{report:{notes:'x'.repeat(1024*1024)}});
    assert.throws(()=>saveAcceptanceWorkspace(oversized),error=>error.statusCode===413);
    assert.equal(getAcceptanceWorkspace().revision,saved.revision);
    platformDb().prepare('UPDATE acceptance_workspaces SET payload=? WHERE owner_id=?').run('{broken-json',actor.id);
    const corrupt=getAcceptanceWorkspace(); assert.equal(corrupt.corrupt,true); assert.equal(corrupt.document,null);
    assert.throws(()=>saveAcceptanceWorkspace(payload(corrupt)),error=>error.code==='ACCEPTANCE_UNAVAILABLE');
    assert.equal(platformDb().prepare('SELECT payload FROM acceptance_workspaces WHERE owner_id=?').get(actor.id).payload,'{broken-json');
  });
});
