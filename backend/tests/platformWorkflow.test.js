import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import app from '../src/app.js';
import { platformDb } from '../src/services/platformStore.js';
import { AGREEMENT_VERSION } from '../src/services/accountService.js';
import { indexTask, listTaskCenter } from '../src/services/taskCenterService.js';
import sharp from 'sharp';
import fs from 'node:fs/promises';
import path from 'node:path';
import { paths } from '../src/services/dbPaths.js';
import { beginShopAuthorization, finishShopAuthorization, decryptCredential, revokeShop } from '../src/services/authorizationService.js';
import { createTask } from '../src/services/db.js';

beforeEach(() => {
  if (!process.env.CROSSBORDER_DATA_ROOT) throw new Error('Use npm test for isolated tests');
  const db = platformDb();
  for (const table of ['oauth_pending', 'shop_connections', 'erp_grants', 'record_revisions', 'sync_receipts', 'device_codes', 'devices', 'sessions', 'members', 'audit_events', 'platform_records', 'platform_meta', 'space_archives', 'task_index']) db.prepare(`DELETE FROM ${table}`).run();
});

async function bootstrap() {
  await request(app).post('/api/auth/bootstrap').send({ username: 'owner', password: 'A-strong-password-123', agree: true, agreementVersion: AGREEMENT_VERSION, workspaceName: 'Test workspace' }).expect(201);
  const response = await request(app).post('/api/auth/login').send({ username: 'owner', password: 'A-strong-password-123' }).expect(200);
  return { cookie: response.headers['set-cookie'][0].split(';')[0], csrf: response.body.csrf, user: response.body.user };
}
function authed(method, url, auth) { return request(app)[method](url).set('Cookie', auth.cookie).set('X-CSRF-Token', auth.csrf); }

test('version-specific notices include global announcements and bundled help is available', async () => {
  for (const appVersion of ['', '0.7.0', '0.8.0']) await request(app).post('/api/platform/records/notice').send({ data: { title: `Version ${appVersion}`, content: 'Help', appVersion } }).expect(201);
  const result = await request(app).get('/api/platform/records/notice?appVersion=0.7.0').expect(200);
  assert.deepEqual(result.body.records.map((item) => item.data.appVersion).sort(), ['', '0.7.0']);
  await request(app).post('/api/platform/records/notice').send({ data: { title: 'bad', appVersion: 'bad' } }).expect(400);
  const help = await request(app).get('/api/platform/help').expect(200);
  assert.match(help.headers['content-type'], /text\/plain/); assert.ok(help.text.length > 100);
});

test('web workflow: bootstrap, login, create product, view audit, logout and expire session', async () => {
  process.env.WEB_AUTH_ENABLED = 'true';
  try {
    await request(app).get('/api/tasks').expect(401);
    await request(app).post('/api/auth/bootstrap').send({ username: 'owner', password: 'A-strong-password-123' }).expect(400);
    const auth = await bootstrap();
    assert.equal(auth.user.role, 'admin');
    await request(app).post('/api/auth/bootstrap').send({ username: 'another', password: 'A-strong-password-123', agree: true, agreementVersion: AGREEMENT_VERSION }).expect(409);
    await request(app).post('/api/platform/records/product').set('Cookie', auth.cookie).send({ data: { sku: 'NO-CSRF', title: 'No csrf' } }).expect(403);
    const product = await authed('post', '/api/platform/records/product', auth).send({ data: { sku: 'SKU-001', title: 'Test product' } }).expect(201);
    await authed('patch', `/api/platform/records/product/${product.body.id}`, auth).send({ baseVersion: 0, data: { sku: 'SKU-001', title: 'stale' } }).expect(409);
    const updated = await authed('patch', `/api/platform/records/product/${product.body.id}`, auth).send({ baseVersion: product.body.version, data: { sku: 'SKU-001', title: 'Edited' } }).expect(200);
    assert.equal(updated.body.version, 2);
    const records = await authed('get', '/api/platform/records/product', auth).expect(200);
    assert.equal(records.body.records[0].data.title, 'Edited');
    const audit = await authed('get', '/api/platform/audit', auth).expect(200);
    assert.ok(audit.body.records.some((row) => row.action === 'account.login'));
    assert.equal(JSON.stringify(audit.body).includes('A-strong-password-123'), false);
    await authed('post', '/api/auth/logout', auth).send({}).expect(200);
    await authed('get', '/api/platform/records/product', auth).expect(401);
    const again = await request(app).post('/api/auth/login').send({ username: 'owner', password: 'A-strong-password-123' }).expect(200);
    platformDb().prepare('UPDATE sessions SET expires_at=0').run();
    await request(app).get('/api/tasks').set('Cookie', again.headers['set-cookie'][0].split(';')[0]).expect(401);
  } finally { process.env.WEB_AUTH_ENABLED = 'false'; }
});

test('roles enforce business writes, first-login agreement and last-admin preservation', async () => {
  process.env.WEB_AUTH_ENABLED = 'true';
  try {
    const auth = await bootstrap();
    await authed('patch', `/api/platform/members/${auth.user.id}`, auth).send({ role: 'viewer' }).expect(409);
    for (const role of ['operator', 'designer', 'viewer']) {
      await authed('post', '/api/platform/members', auth).send({ username: role, password: 'Member-password-123', role }).expect(201);
      await request(app).post('/api/auth/login').send({ username: role, password: 'Member-password-123' }).expect(403);
      const response = await request(app).post('/api/auth/login').send({ username: role, password: 'Member-password-123', agree: true, agreementVersion: AGREEMENT_VERSION }).expect(200);
      const member = { cookie: response.headers['set-cookie'][0].split(';')[0], csrf: response.body.csrf };
      await authed('get', '/api/platform/task-center', member).expect(200);
      await authed('get', '/api/settings/providers/status', member).expect(200);
      await authed('get', '/api/settings/effective', member).expect(200);
      await authed('get', '/api/settings', member).expect(403);
      await authed('post', '/api/platform/members', member).send({}).expect(403);
      await authed('post', '/api/platform/records/notice', member).send({ data: { title: 'not allowed' } }).expect(403);
      await authed('post', '/api/workbench/pricing-previews', member).send({}).expect(role === 'operator' ? 400 : 403);
      await authed('post', '/api/platform/records/product', member).send({ data: { sku: role, title: 'Product' } }).expect(role === 'operator' ? 201 : 403);
    }
    assert.ok(platformDb().prepare("SELECT COUNT(*) AS n FROM audit_events WHERE action='account.agreement-accepted'").get().n >= 3);
  } finally { process.env.WEB_AUTH_ENABLED = 'false'; }
});

test('task index supports 10000 records with stable filtered pagination', async () => {
  platformDb().transaction(() => {
    for (let i = 0; i < 10000; i++) indexTask({ id: `collect-job-index-${i}`, type: 'collection-job', name: `Product ${i}`, status: i % 2 ? 'paused' : 'completed', createdAt: new Date().toISOString() });
  })();
  const started = performance.now();
  const result = await listTaskCenter({ page: 2, pageSize: 50, state: 'paused' });
  assert.equal(result.records.length, 50);
  assert.equal(result.pagination.total, 5000);
  assert.ok(result.records.every((row) => row.state === 'paused'));
  assert.ok(performance.now() - started < 2000);
});

test('device pairing, idempotent metadata synchronization, conflict and revocation', async () => {
  process.env.WEB_AUTH_ENABLED = 'true';
  try {
    const auth = await bootstrap();
    const pair = await authed('post', '/api/platform/devices/code', auth).send({}).expect(200);
    const device = await request(app).post('/api/platform/devices/redeem').send({ code: pair.body.code }).expect(200);
    await request(app).post('/api/platform/devices/redeem').send({ code: pair.body.code }).expect(401);
    const sync = (operations) => request(app).post('/api/platform/sync').set('Authorization', `Bearer ${device.body.deviceToken}`).send({ operations });
    const data = { id: 'local-task-1', state: 'completed', title: 'Product', sku: 'SKU-1', summary: { outputCount: 2, localPath: 'C:\\private\\pic.jpg' }, cookie: 'private-cookie', updatedAt: '2026-10-20T01:00:00Z' };
    const op = { operationId: 'operation-1', baseVersion: 0, data };
    const first = await sync([op]).expect(200);
    assert.equal(first.body.results[0].version, 1);
    assert.equal(JSON.stringify(first.body).includes('private'), false);
    const replay = await sync([op]).expect(200);
    assert.equal(replay.body.results[0].version, 1);
    const conflict = await sync([{ ...op, operationId: 'operation-2', data: { ...data, title: 'Other device' } }]).expect(200);
    assert.equal(conflict.body.results[0].status, 'conflict');
    assert.equal(conflict.body.results[0].remote.version, 1);
    await sync([{ ...op, operationId: 'operation-3', baseVersion: 1 }]).expect(200);
    await authed('post', `/api/platform/devices/${device.body.deviceId}/revoke`, auth).send({}).expect(200);
    await sync([]).expect(401);
  } finally { process.env.WEB_AUTH_ENABLED = 'false'; }
});

test('studio plans, versioned templates, POD rendering and non-destructive batch failures', async () => {
  const plan = await request(app).post('/api/platform/studio/plan').send({ messages: [{ role: 'user', content: '运动裤 POD 印花图片' }] }).expect(200);
  assert.equal(plan.body.plan.mode, 'pod'); assert.equal(plan.body.paidGeneration, false);
  const preset = await request(app).post('/api/platform/records/preset').send({ data: { name: 'POD template', parameters: plan.body.plan.parameters } }).expect(201);
  await request(app).patch(`/api/platform/records/preset/${preset.body.id}`).send({ baseVersion: 1, data: { name: 'Updated POD template', parameters: plan.body.plan.parameters } }).expect(200);
  const history = await request(app).get(`/api/platform/record-history/${preset.body.id}`).expect(200);
  assert.deepEqual(history.body.records.map((item) => item.version), [2, 1]);
  const image = await sharp({ create: { width: 60, height: 40, channels: 4, background: '#ff0000' } }).png().toBuffer();
  await request(app).post('/api/platform/studio/render').field('options', JSON.stringify({ mode: 'pod' })).attach('images', image, { filename: 'print.png', contentType: 'image/png' }).expect(400);
  const rendered = await request(app).post('/api/platform/studio/render').field('options', JSON.stringify({ mode: 'pod', width: 320, height: 400, format: 'png', confirm: true }))
    .attach('images', image, { filename: '印花.png', contentType: 'image/png' }).attach('images', Buffer.from('bad image'), { filename: 'bad.png', contentType: 'image/png' }).expect(201);
  assert.equal(rendered.body.summary.successCount, 1); assert.equal(rendered.body.summary.failedCount, 1);
  assert.equal(rendered.body.status, 'partial');
  const output = await fs.readFile(path.join(paths.rootDir, rendered.body.items[0].url));
  const metadata = await sharp(output).metadata(); assert.equal(metadata.width, 320); assert.equal(metadata.height, 400); assert.equal(metadata.hasAlpha, true);
  await request(app).get(rendered.body.downloadUrl).expect(200);
  const zip = await fs.readFile(path.join(paths.rootDir, rendered.body.downloadUrl)); assert.equal(zip.subarray(0, 2).toString(), 'PK');
});

test('pricing rule import/export preserves currency, version, rounding and scope', async () => {
  const rule = { name: 'EUR campaign', formatVersion: 1, currency: 'EUR', scope: 'EU-', rounding: 'ending99', rules: [{ type: 'percent', value: -10 }] };
  await request(app).post('/api/platform/records/pricing-rule/import').send({ formatVersion: 1, records: [{ data: rule }, { data: { ...rule, currency: 'badcurrency' } }] }).expect(200).then((res) => { assert.equal(res.body.successCount, 1); assert.equal(res.body.failedCount, 1); });
  const exported = await request(app).get('/api/platform/records/pricing-rule/export').expect(200);
  assert.deepEqual(exported.body.records[0].data, rule);
  const preview = await request(app).post('/api/workbench/pricing-previews').send({ ...rule, items: [{ sku: 'EU-01', price: 10 }, { sku: 'US-02', price: 10 }] }).expect(201);
  assert.equal(preview.body.currency, 'EUR'); assert.equal(preview.body.items[0].newPrice, 9.99); assert.equal(preview.body.items[1].newPrice, null);
});

test('official OAuth framework verifies state and PKCE, encrypts credentials and tracks remote revocation', async () => {
  process.env.WEB_CREDENTIAL_KEY = '12'.repeat(32);
  process.env.SHOP_OAUTH_PROVIDERS = JSON.stringify([{ id: 'official-sandbox', name: 'Fixture only', clientId: 'test-client', clientSecret: 'test-client-secret', authorizationUrl: 'https://official.example/authorize', tokenUrl: 'https://official.example/token', revocationUrl: 'https://official.example/revoke', redirectUri: 'https://workbench.example/api/platform/shops/callback', scopes: ['read:products'] }]);
  const actor = { id: 'local', role: 'admin' };
  try {
    const started = beginShopAuthorization({ provider: 'official-sandbox', confirm: true }, actor);
    const authorization = new URL(started.authorizationUrl);
    assert.equal(authorization.searchParams.get('code_challenge_method'), 'S256');
    await assert.rejects(finishShopAuthorization({ state: 'invalid', code: 'code' }, actor), /过期/);
    let verifier;
    const finish = await finishShopAuthorization({ state: authorization.searchParams.get('state'), code: 'sandbox-code' }, actor, async (_url, options) => {
      verifier = new URLSearchParams(options.body).get('code_verifier');
      return Response.json({ access_token: 'test-sensitive-token', refresh_token: 'test-refresh-token', expires_in: 3600 });
    });
    assert.ok(verifier.length >= 43);
    const stored = platformDb().prepare('SELECT encrypted_token FROM shop_connections WHERE id=?').get(finish.id).encrypted_token;
    assert.equal(stored.includes('test-sensitive-token'), false);
    assert.equal(decryptCredential(stored).access_token, 'test-sensitive-token');
    await assert.rejects(finishShopAuthorization({ state: authorization.searchParams.get('state'), code: 'replay' }, actor), /过期/);
    const revoked = await revokeShop(finish.id, actor, async () => new Response('', { status: 200 }));
    assert.equal(revoked.remoteRevoked, true);
    assert.equal(platformDb().prepare('SELECT encrypted_token FROM shop_connections WHERE id=?').get(finish.id).encrypted_token, '');
  } finally { delete process.env.WEB_CREDENTIAL_KEY; delete process.env.SHOP_OAUTH_PROVIDERS; }
});

test('ERP grants are scoped, expiring, revocable, audit logged and never stored as plaintext', async () => {
  const grant = await request(app).post('/api/platform/erp-grants').send({ name: 'ERP', days: 1, scopes: ['tasks:read'], confirm: true }).expect(201);
  const token = grant.body.token;
  assert.equal(JSON.stringify(platformDb().prepare('SELECT * FROM erp_grants').all()).includes(token), false);
  await request(app).get('/api/platform/erp/v1/tasks').set('Authorization', `Bearer ${token}`).expect(200);
  await request(app).get('/api/platform/erp/v1/products').set('Authorization', `Bearer ${token}`).expect(403);
  const listed = await request(app).get('/api/platform/erp-grants').expect(200); assert.equal(JSON.stringify(listed.body).includes(token), false);
  platformDb().prepare('UPDATE erp_grants SET expires_at=0').run();
  await request(app).get('/api/platform/erp/v1/tasks').set('Authorization', `Bearer ${token}`).expect(403);
  await request(app).post(`/api/platform/erp-grants/${grant.body.id}/revoke`).send({ confirm: true }).expect(200);
  assert.equal(platformDb().prepare("SELECT COUNT(*) AS n FROM audit_events WHERE action='erp.read'").get().n, 1);
});

test('product SKU links resolve exact materials, source and export records without fuzzy SKU collisions', async () => {
  const product = await request(app).post('/api/platform/records/product').send({ data: { sku: 'LINK-001', title: 'Linked product', sourcePlatform: 'temu', sourceUrl: 'https://www.temu.com/example.html' } }).expect(201);
  await request(app).post('/api/platform/records/product').send({ data: { sku: 'link-001', title: 'Duplicate' } }).expect(409);
  await request(app).post('/api/workbench/materials/import').send({ records: [{ sku: 'LINK-001', platformId: 'temu', materialId: 'main-1', materialType: 'main' }, { sku: 'LINK-001-OTHER', platformId: 'temu', materialId: 'wrong-material', materialType: 'main' }] }).expect(201);
  indexTask({ id: 'test-export-link', sku: 'LINK-001', status: 'exported', exportFile: { filePath: 'outputs/test/export.zip' } }, 'image');
  const links = await request(app).get(`/api/platform/products/${product.body.id}/links`).expect(200);
  assert.equal(links.body.materials.records.length, 1); assert.equal(links.body.materials.records[0].materialId, 'main-1');
  assert.equal(links.body.source.platform, 'temu');
});

test('workspace snapshot restores products and account data while revoking sessions and ERP grants', async () => {
  await bootstrap();
  const product = await request(app).post('/api/platform/records/product').send({ data: { sku: 'RESTORE-001', title: 'Before backup' } }).expect(201);
  await request(app).post('/api/platform/erp-grants').send({ scopes: ['tasks:read'], days: 1, confirm: true }).expect(201);
  const snapshot = await request(app).post('/api/snapshots').send({ includeUploads: false, includeOutputs: false, includeDocs: false }).expect(201);
  await request(app).patch(`/api/platform/records/product/${product.body.id}`).send({ baseVersion: 1, data: { sku: 'RESTORE-001', title: 'Changed after backup' } }).expect(200);
  const payload = { confirm: true, restoreDb: false, restoreUploads: false, restoreOutputs: false, restorePlatformDb: true };
  await request(app).post(`/api/snapshots/${snapshot.body.snapshot.snapshotId}/restore`).send(payload).expect(400);
  await request(app).post(`/api/snapshots/${snapshot.body.snapshot.snapshotId}/restore`).send({ ...payload, confirmRevokeAuthorizations: true }).expect((res) => assert.equal(res.status, 200, JSON.stringify(res.body)));
  const products = await request(app).get('/api/platform/records/product').expect(200);
  assert.equal(products.body.records[0].data.title, 'Before backup');
  assert.equal(platformDb().prepare('SELECT COUNT(*) AS n FROM sessions').get().n, 0);
  assert.equal(platformDb().prepare('SELECT COUNT(*) AS n FROM erp_grants WHERE active=1').get().n, 0);
});

test('matting adoption is task scoped and preserves source image', async () => {
  const id = 'adopt-test-task', sourceFile = path.join(paths.uploadDir, 'adopt-source.png');
  const output = path.join(paths.outputDir, id, 'matting-test', 'result.png');
  await fs.mkdir(path.dirname(output), { recursive: true });
  const image = await sharp({ create: { width: 16, height: 20, channels: 4, background: '#ff0000' } }).png().toBuffer();
  await fs.writeFile(sourceFile, image); await fs.writeFile(output, image);
  await createTask({ id, status: 'uploaded', sourceImages: [{ id: 'source-1', filePath: sourceFile }] });
  const input = { taskId: id, imageId: 'source-1', provider: 'sharp', url: `/outputs/${id}/matting-test/result.png`, confirm: true };
  await request(app).post('/api/matting/adopt').send({ ...input, url: '/outputs/another-task/matting-test/result.png' }).expect(400);
  const adopted = await request(app).post('/api/matting/adopt').send(input).expect(200);
  assert.equal(adopted.body.selection.originalPreserved, true); assert.equal(adopted.body.selection.sha256.length, 64);
  assert.deepEqual(await fs.readFile(sourceFile), image);
});
