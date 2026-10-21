import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import sharp from 'sharp';
import fs from 'node:fs/promises';
import path from 'node:path';
import app from '../src/app.js';
import { platformDb } from '../src/services/platformStore.js';
import { AGREEMENT_VERSION } from '../src/services/accountService.js';
import { withActor, claimResource } from '../src/services/ownershipService.js';
import { createTask, createBatchTask, paths } from '../src/services/db.js';
import { platformBackup, restorePlatformBackup } from '../src/services/platformStore.js';
import AdmZip from 'adm-zip';

const password = 'Member-test-password-123';
const call = (actor, method, route) => request(app)[method](route).set('Cookie', actor.cookie).set('X-CSRF-Token', actor.csrf);
let admin, alice, bob, viewer, image;
beforeEach(async () => {
  process.env.WEB_AUTH_ENABLED = 'true';
  const db = platformDb();
  for (const table of ['resource_assets', 'resource_owners', 'oauth_pending', 'shop_connections', 'erp_grants', 'record_revisions', 'sync_receipts', 'device_codes', 'devices', 'sessions', 'members', 'audit_events', 'platform_records', 'platform_meta', 'space_archives', 'task_index']) db.prepare(`DELETE FROM ${table}`).run();
  await request(app).post('/api/auth/bootstrap').send({ username: 'owner', password, agree: true, agreementVersion: AGREEMENT_VERSION }).expect(201);
  async function login(username) {
    const response = await request(app).post('/api/auth/login').send({ username, password, agree: true, agreementVersion: AGREEMENT_VERSION }).expect(200);
    return { ...response.body.user, cookie: response.headers['set-cookie'][0].split(';')[0], csrf: response.body.csrf };
  }
  admin = await login('owner');
  for (const [username, role] of [['alice', 'operator'], ['bob', 'operator'], ['observer', 'viewer']]) await call(admin, 'post', '/api/platform/members').send({ username, password, role }).expect(201);
  [alice, bob, viewer] = await Promise.all(['alice', 'bob', 'observer'].map(login));
  image = await sharp({ create: { width: 320, height: 320, channels: 3, background: '#3456ab' } }).png().toBuffer();
});
afterEach(() => { process.env.WEB_AUTH_ENABLED = 'false'; });

test('Web collection drafts require member identity, CSRF and ownership, without exposing another member payload', async () => {
  const route = '/api/workbench/collection-drafts';
  const context = (await call(alice, 'get', route).expect(200)).body;
  const payload = { expectedActorId: alice.id, generation: context.generation, rows: [{ productUrl: 'https://shop.example/alice' }], options: { name: 'Alice private draft' } };
  await request(app).post(`${route}/rows`).set('Cookie', alice.cookie).send(payload).expect(403);
  await call(bob, 'post', `${route}/rows`).send(payload).expect(409);
  const draft = (await call(alice, 'post', `${route}/rows`).send(payload).expect(201)).body.draft;
  assert.equal((await call(bob, 'get', route).expect(200)).body.draft, null);
  await call(viewer, 'get', route).expect(403);
  await call(bob, 'post', `${route}/${draft.id}/submit`).send({ expectedActorId: bob.id }).expect(404);
  const job = (await call(alice, 'post', `${route}/${draft.id}/submit`).send({ expectedActorId: alice.id }).expect(201)).body;
  await call(bob, 'get', `/api/workbench/collection-jobs/${job.id}`).expect(404);
  await call(alice, 'post', `${route}/${draft.id}/ack`).send({ expectedActorId: alice.id, jobId: job.id }).expect(200);
  assert.equal((await call(alice, 'get', route).expect(200)).body.draft, null);
});

test('members cannot enumerate, mutate or download another member image task or cached report', async () => {
  const upload = (actor) => call(actor, 'post', '/api/tasks/upload').attach('images', image, { filename: '产品.png', contentType: 'image/png' }).expect(201);
  const [left, right] = await Promise.all([upload(alice), upload(bob)]);
  const task = left.body.task;
  assert.equal((await call(alice, 'get', '/api/tasks').expect(200)).body.tasks.some((item) => item.id === task.id), true);
  assert.equal((await call(bob, 'get', '/api/tasks').expect(200)).body.tasks.some((item) => item.id === task.id), false);
  await call(alice, 'get', task.sourceImages[0].previewUrl).expect(200);
  await call(bob, 'get', task.sourceImages[0].previewUrl).expect(404);
  await call(viewer, 'get', task.sourceImages[0].previewUrl).expect(404);
  await call(admin, 'get', task.sourceImages[0].previewUrl).expect(200);
  for (const route of [`/api/tasks/${task.id}`, `/api/generate/${task.id}/report`, `/api/final-acceptance/real-api/${task.id}/report`]) await call(bob, 'get', route).expect(404);
  await call(bob, 'patch', `/api/tasks/${task.id}/product`).send({ name: 'tamper' }).expect(404);
  await call(bob, 'post', '/api/matting/run').send({ taskId: task.id, provider: 'sharp' }).expect(404);
  await call(bob, 'get', right.body.task.sourceImages[0].previewUrl).expect(200);
  const center = (await call(bob, 'get', '/api/platform/task-center').expect(200)).body;
  assert.ok(!center.records.some((item) => item.id === task.id));
  assert.equal(center.pagination.total, 1);
});

test('products, exact-SKU links, materials, exports and workbench file trees are member scoped', async () => {
  const product = (await call(alice, 'post', '/api/platform/records/product').send({ data: { sku: 'SAME-SKU', title: 'Alice only' } }).expect(201)).body;
  await call(bob, 'post', '/api/platform/records/product').send({ data: { sku: 'SAME-SKU', title: 'Bob only' } }).expect(201);
  assert.equal((await call(bob, 'get', '/api/platform/records/product').expect(200)).body.records[0].data.title, 'Bob only');
  await call(bob, 'get', `/api/platform/products/${product.id}/links`).expect(404);
  await call(bob, 'get', `/api/platform/record-history/${product.id}`).expect(404);
  await call(bob, 'patch', `/api/platform/records/product/${product.id}`).send({ baseVersion: 1, data: { sku: 'SAME-SKU', title: 'tamper' } }).expect(404);
  const imported = (await call(alice, 'post', '/api/workbench/materials/import').send({ records: [{ sku: 'SAME-SKU', platformId: 'temu', materialId: 'PRIVATE-MATERIAL' }] }).expect(201)).body;
  assert.equal((await call(bob, 'get', '/api/workbench/materials').expect(200)).body.records.length, 0);
  assert.ok(!(await call(bob, 'get', '/api/workbench/materials/export.csv').expect(200)).text.includes('PRIVATE-MATERIAL'));
  await call(bob, 'patch', `/api/workbench/materials/${imported.records[0].id}`).send({ notes: 'tamper' }).expect(404);
  const pack = (await call(alice, 'post', '/api/workbench/image-packs').attach('images', image, { filename: 'source.png', contentType: 'image/png' }).expect(201)).body;
  await call(alice, 'get', pack.downloadUrl).expect(200); await call(bob, 'get', pack.downloadUrl).expect(404);
  await call(bob, 'get', `/api/workbench/jobs/${pack.id}`).expect(404);
  await call(bob, 'post', `/api/platform/space/${pack.id}/archive`).send({ confirm: true }).expect(404);
  assert.ok(!(await call(bob, 'get', '/api/platform/task-center/export.csv').expect(200)).text.includes(pack.id));
});

test('legacy data remains admin-only and asset symlinks cannot bypass ownership', async () => {
  const task = await createTask({ id: 'legacy-isolation-task', status: 'uploaded', sourceImages: [] });
  await call(alice, 'get', `/api/tasks/${task.id}`).expect(404);
  await call(admin, 'get', `/api/tasks/${task.id}`).expect(200);
  const root = path.join(paths.outputDir, 'symlink-isolation'); await fs.mkdir(root, { recursive: true });
  const secret = path.join(root, 'secret.txt'); await fs.writeFile(secret, 'private fixture');
  await withActor(alice, () => claimResource('job', 'owned-link'));
  const ownRoot = path.join(paths.outputDir, 'workbench', 'owned-link'); await fs.mkdir(ownRoot, { recursive: true });
  const link = path.join(ownRoot, 'junction');
  try { await fs.symlink(root, link, 'junction'); } catch (error) { if (error.code === 'EPERM') return; throw error; }
  await call(alice, 'get', '/outputs/workbench/owned-link/junction/secret.txt').expect(404);
});

test('device metadata with identical local task IDs never crosses members', async () => {
  async function device(actor) { const pair = await call(actor, 'post', '/api/platform/devices/code').send({}).expect(200); return (await request(app).post('/api/platform/devices/redeem').send({ code: pair.body.code }).expect(200)).body.deviceToken; }
  const [left, right] = await Promise.all([device(alice), device(bob)]);
  const sync = (token, title) => request(app).post('/api/platform/sync').set('Authorization', `Bearer ${token}`).send({ operations: [{ operationId: 'same-operation', baseVersion: 0, data: { id: 'same-local-task', state: 'completed', title } }] }).expect(200);
  const first = await sync(left, 'Alice private'); const second = await sync(right, 'Bob private');
  assert.equal(first.body.results[0].status, 'applied'); assert.equal(second.body.results[0].status, 'applied');
  assert.deepEqual(second.body.records.map((item) => item.data.title), ['Bob private']);
  const again = await request(app).post('/api/platform/sync').set('Authorization', `Bearer ${left}`).send({ operations: [] }).expect(200);
  assert.deepEqual(again.body.records.map((item) => item.data.title), ['Alice private']);
});

test('admin assignment is preview-bound, revokes previous access, and preserves read-only permissions', async () => {
  const upload = await call(alice, 'post', '/api/tasks/upload').attach('images', image, { filename: 'assign.png', contentType: 'image/png' }).expect(201);
  const task = upload.body.task, prefix = `/api/platform/resources/image/${task.id}`;
  await call(bob, 'post', `${prefix}/owner-preview`).send({ ownerId: bob.id }).expect(403);
  const preview = (await call(admin, 'post', `${prefix}/owner-preview`).send({ ownerId: viewer.id }).expect(200)).body;
  await call(admin, 'post', `${prefix}/owner`).send({ ownerId: viewer.id, confirm: true, approvalHash: 'wrong' }).expect(409);
  const assigned = await call(admin, 'post', `${prefix}/owner`).send({ ownerId: viewer.id, confirm: true, approvalHash: preview.approvalHash }).expect(200);
  assert.equal(assigned.body.filesDeleted, false);
  await call(viewer, 'get', `/api/tasks/${task.id}`).expect(200);
  await call(viewer, 'get', task.sourceImages[0].previewUrl).expect(200);
  await call(viewer, 'patch', `/api/tasks/${task.id}/product`).send({}).expect(403);
  await call(alice, 'get', task.sourceImages[0].previewUrl).expect(404);
  await call(alice, 'get', `/api/tasks/${task.id}`).expect(404);
  await call(admin, 'post', `${prefix}/owner`).send({ ownerId: viewer.id, confirm: true, approvalHash: preview.approvalHash }).expect(409);
});

test('legacy upload assignment registers its original file without granting unrelated files', async () => {
  await fs.mkdir(paths.uploadDir, { recursive: true });
  const file = path.join(paths.uploadDir, 'legacy-owned.png'); await fs.writeFile(file, image);
  const task = await createTask({ id: 'legacy-upload-assignment', status: 'uploaded', sourceImages: [{ id: 'original', filePath: 'uploads/legacy-owned.png', previewUrl: '/uploads/legacy-owned.png' }] });
  platformDb().prepare('DELETE FROM resource_assets WHERE resource_id=?').run(task.id);
  platformDb().prepare('DELETE FROM resource_owners WHERE resource_id=?').run(task.id); // Emulate a genuine pre-ownership installation.
  const prefix = `/api/platform/resources/image/${task.id}`;
  const preview = (await call(admin, 'post', `${prefix}/owner-preview`).send({ ownerId: alice.id }).expect(200)).body;
  assert.deepEqual(preview.affected[0].assetPaths, ['uploads/legacy-owned.png']);
  await call(admin, 'post', `${prefix}/owner`).send({ ownerId: alice.id, confirm: true, approvalHash: preview.approvalHash }).expect(200);
  await call(alice, 'get', '/uploads/legacy-owned.png').expect(200);
  await call(bob, 'get', '/uploads/legacy-owned.png').expect(404);
});

test('ownership survives workspace backup restore and sessions must be renewed', async () => {
  const upload = await call(alice, 'post', '/api/tasks/upload').attach('images', image, { filename: 'restore.png', contentType: 'image/png' }).expect(201);
  const file = path.join(paths.dataDir, 'ownership-fixture.sqlite'); await fs.writeFile(file, platformBackup());
  platformDb().prepare('DELETE FROM resource_assets').run(); platformDb().prepare('DELETE FROM resource_owners').run();
  restorePlatformBackup(file);
  await call(alice, 'get', upload.body.task.sourceImages[0].previewUrl).expect(401);
  const renewed = await request(app).post('/api/auth/login').send({ username: 'alice', password }).expect(200);
  const token = { cookie: renewed.headers['set-cookie'][0].split(';')[0], csrf: renewed.body.csrf };
  await call(token, 'get', upload.body.task.sourceImages[0].previewUrl).expect(200);
});

test('owned batch exports remain downloadable, foreign users are denied, and reassignment includes child tasks', async () => {
  const taskId = 'isolation-batch-task', batchId = 'isolation-batch';
  await withActor(alice, async () => {
    await createTask({ id: taskId, batchId, sku: 'SKU-OWNED', status: 'reviewed', sourceImages: [], generatedImages: [], productInfoConfirmed: { sku: 'SKU-OWNED', name: 'Owned product' }, targets: [{ platformId: 'amazon' }], review: { overallStatus: 'passed', items: [] } });
    await createBatchTask({ id: batchId, name: 'Owned batch', status: 'reviewed', skuTasks: [{ skuId: 'SKU-OWNED', taskId, status: 'reviewed' }] });
  });
  const csv = await call(alice, 'post', `/api/batches/${batchId}/listing-csv`).send({ confirmExport: true, platforms: ['amazon'] }).expect(201);
  await call(alice, 'get', `/${csv.body.files[0].relativePath}`).expect(200);
  await call(bob, 'get', `/${csv.body.files[0].relativePath}`).expect(404);
  const pack = await call(alice, 'post', `/api/batches/${batchId}/export-package`).send({ confirmExport: true, platforms: ['amazon'], includeReports: true }).expect(201);
  await call(alice, 'get', `/${pack.body.relativePath}`).expect(200);
  await call(bob, 'get', `/${pack.body.relativePath}`).expect(404);
  const prefix = `/api/platform/resources/batch/${batchId}`;
  const preview = (await call(admin, 'post', `${prefix}/owner-preview`).send({ ownerId: bob.id }).expect(200)).body;
  assert.equal(preview.count, 2);
  await call(admin, 'post', `${prefix}/owner`).send({ ownerId: bob.id, confirm: true, approvalHash: preview.approvalHash }).expect(200);
  await call(bob, 'get', `/api/tasks/${taskId}`).expect(200);
  await call(bob, 'get', `/${pack.body.relativePath}`).expect(200);
  await call(alice, 'get', `/${pack.body.relativePath}`).expect(404);
});

test('assignment rejects a running batch even when its queue field still says idle', async () => {
  await withActor(alice, () => createBatchTask({ id: 'running-assignment', status: 'generating', queue: { status: 'idle' }, skuTasks: [] }));
  await call(admin, 'post', '/api/platform/resources/batch/running-assignment/owner-preview').send({ ownerId: bob.id }).expect(409);
  await call(alice, 'get', '/api/batches/running-assignment').expect(200);
});

test('same-member shared source files work but cannot silently change another task file ownership', async () => {
  const file = path.join(paths.uploadDir, 'shared-owned.png'); await fs.mkdir(paths.uploadDir, { recursive: true }); await fs.writeFile(file, image);
  for (const id of ['shared-source-one', 'shared-source-two']) await withActor(alice, () => createTask({ id, status: 'uploaded', sourceImages: [{ filePath: 'uploads/shared-owned.png', previewUrl: '/uploads/shared-owned.png' }] }));
  await call(alice, 'get', '/uploads/shared-owned.png').expect(200);
  await call(admin, 'post', '/api/platform/resources/image/shared-source-two/owner-preview').send({ ownerId: bob.id }).expect(409);
  await call(admin, 'post', '/api/platform/resources/image/shared-source-one/owner-preview').send({ ownerId: bob.id }).expect(409);
  await call(bob, 'get', '/uploads/shared-owned.png').expect(404);
  await call(alice, 'get', '/api/tasks/shared-source-two').expect(200);
});

test('template previews survive refresh while foreign preview hashes cannot authorize execution', async () => {
  const zip = new AdmZip();
  zip.addFile('xl/worksheets/sheet1.xml', Buffer.from(`<worksheet><sheetData><row r="1">${['SKU', 'Title', 'Price', 'Stock', 'Main image'].map((value, index) => `<c r="${String.fromCharCode(65 + index)}1" t="inlineStr"><is><t>${value}</t></is></c>`).join('')}</row></sheetData></worksheet>`));
  const response = await call(alice, 'post', '/api/workbench/template-fills/preview').field('options', JSON.stringify({ platformId: 'amazon', records: [{ sku: 'OWNED-FILL', title: 'Owned', price: 5, stock: 2, mainImageUrl: 'https://img.example/a.png' }] })).attach('template', zip.toBuffer(), { filename: 'private-template.xlsx', contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }).expect(200);
  const id = response.body.id, payload = { confirm: true, previewHash: response.body.previewHash };
  const saved = await call(alice, 'get', `/api/workbench/jobs/${id}`).expect(200);
  assert.equal(saved.body.status, 'waiting_user');
  await call(bob, 'get', `/api/workbench/jobs/${id}`).expect(404);
  await call(bob, 'post', `/api/workbench/template-fills/${id}/execute`).send(payload).expect(404);
  const completed = await call(alice, 'post', `/api/workbench/template-fills/${id}/execute`).send(payload).expect(200);
  await call(alice, 'get', completed.body.downloadUrl).expect(200);
  await call(bob, 'get', completed.body.downloadUrl).expect(404);
});

test('support role can only read sanitized diagnostics and cannot receive business ownership', async () => {
  const member = await call(admin, 'post', '/api/platform/members').send({ username: 'support-person', password, role: 'support' }).expect(201);
  const session = await request(app).post('/api/auth/login').send({ username: 'support-person', password, agree: true, agreementVersion: AGREEMENT_VERSION }).expect(200);
  const support = { id: member.body.id, cookie: session.headers['set-cookie'][0].split(';')[0], csrf: session.body.csrf };
  const report = await call(support, 'get', '/api/platform/support/status').expect(200);
  assert.equal(report.body.scope, 'sanitized-environment-only');
  assert.equal(report.body.capabilities.readBusinessData, false);
  assert.equal(report.body.environment.databaseReady, true);
  assert.ok(!/C:\\|D:\\|localPath|filePath|password|apiKey|cookie|sourceImages|accessToken/.test(JSON.stringify(report.body)));
  for (const route of ['/api/tasks', '/api/platform/task-center', '/api/platform/records/product', '/api/platform/members', '/api/platform/shops', '/api/platform/sync-export', '/api/settings', '/api/desktop/runtime', '/api/health/full']) await call(support, 'get', route).expect(403);
  for (const route of ['/api/platform/devices/code', '/api/platform/records/preset', '/api/desktop/pause-all']) await call(support, 'post', route).send({}).expect(403);
  const upload = await call(alice, 'post', '/api/tasks/upload').attach('images', image, { filename: 'private-for-support.png', contentType: 'image/png' }).expect(201);
  await call(support, 'get', upload.body.task.sourceImages[0].previewUrl).expect(403);
  await call(admin, 'post', `/api/platform/resources/image/${upload.body.task.id}/owner-preview`).send({ ownerId: support.id }).expect(400);
  await call(support, 'get', '/api/platform/audit').expect(200);
  await call(support, 'get', '/api/platform/help').expect(200);
});

test('role downgrade to support revokes sessions and old device credentials even for previously owned tasks', async () => {
  const upload = await call(alice, 'post', '/api/tasks/upload').attach('images', image, { filename: 'before-role-change.png', contentType: 'image/png' }).expect(201);
  const pair = await call(alice, 'post', '/api/platform/devices/code').send({}).expect(200);
  const device = await request(app).post('/api/platform/devices/redeem').send({ code: pair.body.code }).expect(200);
  const pending = await call(alice, 'post', '/api/platform/devices/code').send({}).expect(200);
  await call(admin, 'patch', `/api/platform/members/${alice.id}`).send({ role: 'support' }).expect(200);
  await call(alice, 'get', upload.body.task.sourceImages[0].previewUrl).expect(401);
  const login = await request(app).post('/api/auth/login').send({ username: 'alice', password }).expect(200);
  const support = { cookie: login.headers['set-cookie'][0].split(';')[0], csrf: login.body.csrf };
  await call(support, 'get', upload.body.task.sourceImages[0].previewUrl).expect(403);
  await request(app).post('/api/platform/sync').set('Authorization', `Bearer ${device.body.deviceToken}`).send({ operations: [] }).expect(401);
  await request(app).post('/api/platform/devices/redeem').send({ code: pending.body.code }).expect(401);
  await call(admin, 'patch', `/api/platform/members/${alice.id}`).send({ role: 'operator' }).expect(200);
  await request(app).post('/api/platform/sync').set('Authorization', `Bearer ${device.body.deviceToken}`).send({ operations: [] }).expect(401);
});

test('unknown roles from a malformed backup fail closed instead of inheriting another role permissions', async () => {
  platformDb().prepare('UPDATE members SET role=? WHERE id=?').run('unknown-role', alice.id);
  await call(alice, 'get', '/api/tasks').expect(401);
  await request(app).post('/api/auth/login').send({ username: 'alice', password }).expect(403);
});

test('password changes revoke pending device pairing as well as existing device and web sessions', async () => {
  const pair = await call(alice, 'post', '/api/platform/devices/code').send({}).expect(200);
  const device = await request(app).post('/api/platform/devices/redeem').send({ code: pair.body.code }).expect(200);
  const pending = await call(alice, 'post', '/api/platform/devices/code').send({}).expect(200);
  await call(alice, 'post', '/api/auth/password').send({ oldPassword: password, newPassword: 'Changed-password-123456' }).expect(200);
  await call(alice, 'get', '/api/tasks').expect(401);
  await request(app).post('/api/platform/devices/redeem').send({ code: pending.body.code }).expect(401);
  await request(app).post('/api/platform/sync').set('Authorization', `Bearer ${device.body.deviceToken}`).send({ operations: [] }).expect(401);
  await request(app).post('/api/auth/login').send({ username: 'alice', password: 'Changed-password-123456' }).expect(200);
});
