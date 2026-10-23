import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { platformDb, setMeta, meta } from '../src/services/platformStore.js';
import { paths } from '../src/services/db.js';
import { indexTask, listTaskCenter, waitForLegacyIndex, legacyIndexStatus, rebuildLegacyIndex } from '../src/services/taskCenterService.js';
import { withActor } from '../src/services/ownershipService.js';
import AdmZip from 'adm-zip';
import { normalizeCollectionOptions, normalizeCollectionRows } from '../src/services/collectionJobService.js';
import { getDesktopRuntime } from '../src/services/desktopRuntimeService.js';
import { randomUUID } from 'node:crypto';
const directories = [];
afterEach(async () => { await waitForLegacyIndex(); for (const directory of directories.splice(0)) await fs.rm(directory, { recursive: true, force: true }); });
async function manifest(id, data) {
  const folder = path.join(paths.outputDir, 'workbench', id); directories.push(folder); await fs.mkdir(folder, { recursive: true });
  await fs.writeFile(path.join(folder, 'manifest.json'), typeof data === 'string' ? data : JSON.stringify(data)); return folder;
}
test('legacy index migrates in background, continues past invalid files and never overwrites newer task state', async () => {
  setMeta('task-index-migrated', false); setMeta('legacy-index-generation', null);
  for (let index = 0; index < 80; index++) { const id = `collect-job-legacy-${index}`; await manifest(id, { id, type: 'collection-job', status: 'paused', createdAt: '2026-10-01T00:00:00Z' }); }
  await manifest('collect-job-legacy-broken', '{broken');
  await manifest('collect-job-legacy-wrong-id', { id: 'steal-another-id', type: 'collection-job' });
  indexTask({ id: 'collect-job-legacy-0', type: 'collection-job', status: 'completed', updatedAt: '2026-10-20T00:00:00Z' });
  indexTask({ id: 'collect-job-legacy-1', type: 'collection-job', status: 'completed', updatedAt: '2026-10-01T00:00:00Z' });
  const start = performance.now();
  const first = await listTaskCenter({ pageSize: 10 });
  assert.ok(performance.now() - start < 2000); assert.equal(first.indexStatus.status, 'running');
  await waitForLegacyIndex();
  assert.equal(legacyIndexStatus().status, 'completed'); assert.ok(legacyIndexStatus().failed >= 2);
  assert.equal(platformDb().prepare('SELECT state FROM task_index WHERE id=?').get('collect-job-legacy-0').state, 'completed');
  assert.equal(platformDb().prepare('SELECT state FROM task_index WHERE id=?').get('collect-job-legacy-1').state, 'completed');
  assert.ok(!platformDb().prepare('SELECT id FROM task_index WHERE id=?').get('steal-another-id'));
  assert.equal(platformDb().prepare('SELECT COUNT(*) AS n FROM task_index WHERE id LIKE ?').get('collect-job-legacy-%').n, 80);
  const privateStatus = await withActor({ id: 'operator', role: 'operator' }, async () => legacyIndexStatus());
  assert.equal(privateStatus.total, null); assert.equal(privateStatus.failed, 0);
  await fs.writeFile(path.join(paths.outputDir, 'workbench', 'collect-job-legacy-broken', 'manifest.json'), JSON.stringify({ id: 'collect-job-legacy-broken', type: 'collection-job', status: 'paused' }));
  await rebuildLegacyIndex(); await waitForLegacyIndex();
  assert.ok(platformDb().prepare('SELECT id FROM task_index WHERE id=?').get('collect-job-legacy-broken'));
});
test('resetting the scan generation cancels old work before it can publish stale rows', async () => {
  setMeta('task-index-migrated', false); setMeta('legacy-index-generation', null);
  await manifest('collect-job-generation-cancel', { id: 'collect-job-generation-cancel', type: 'collection-job', status: 'paused' });
  await listTaskCenter();
  const old = meta('legacy-index-generation'); setMeta('legacy-index-generation', 'restore-generation');
  await waitForLegacyIndex();
  assert.notEqual(old, meta('legacy-index-generation'));
  assert.ok(!platformDb().prepare('SELECT id FROM task_index WHERE id=?').get('collect-job-generation-cancel'));
});

async function recoverable(prefix = 'collect-job-', type = 'collection-job', field = 'items') {
  const id = `${prefix}recover-${randomUUID()}`, state = { id, type, status: 'paused', summary: {},
    createdAt: '2026-10-23T00:00:00Z', updatedAt: '2026-10-23T00:00:00Z', [field]: [] };
  if (type === 'collection-job') { state.options = normalizeCollectionOptions(); state.items = normalizeCollectionRows([{ sku: 'RECOVER', imageUrls: ['https://example.com/a.png'] }]); }
  if (type === 'sku-pack') state.skuResults = [{ sku: 'RECOVER', items: [] }];
  const directory = await manifest(id, '{interrupted');
  const backup = path.join(directory, type === 'collection-job' ? 'manifest.backup.json' : 'manifest.json.backup');
  await fs.writeFile(backup, JSON.stringify(state));
  return { id, state, directory, backup, main: path.join(directory, 'manifest.json') };
}
async function scan() { await rebuildLegacyIndex(); await waitForLegacyIndex(); }
function row(id) { return platformDb().prepare('SELECT * FROM task_index WHERE id=?').get(id); }

for (const [prefix, type, field] of [['collect-job-', 'collection-job', 'items'], ['sku-pack-', 'sku-pack', 'skuResults'], ['pack-', 'image-pack', 'items'], ['collect-', 'collection-plan', 'items'], ['studio-', 'studio', 'items'], ['listing-', 'listing-dry-run', 'rows'], ['pricing-', 'pricing-preview', 'items'], ['template-fill-', 'template-fill', 'changes']]) {
  test(`legacy ${type} index discovers damaged primary from valid backup without changing any file`, async () => {
    const fixture = await recoverable(prefix, type, field), before = await fs.readFile(fixture.backup), stat = await fs.stat(fixture.backup), names = await fs.readdir(fixture.directory);
    await scan();
    assert.equal(row(fixture.id)?.kind, type);
    assert.deepEqual(JSON.parse(row(fixture.id).summary).manifestRecovery, { source: 'backup', sourceName: path.basename(fixture.backup), readOnly: true, primaryUnchanged: true });
    assert.equal(await fs.readFile(fixture.main, 'utf8'), '{interrupted'); assert.deepEqual(await fs.readFile(fixture.backup), before);
    assert.equal((await fs.stat(fixture.backup)).mtimeMs, stat.mtimeMs); assert.deepEqual(await fs.readdir(fixture.directory), names);
    assert.ok(legacyIndexStatus().recovered >= 1);
    if (type === 'collection-job') assert.equal((await getDesktopRuntime()).recovery.find(item => item.id === fixture.id)?.manifestRecovery?.readOnly, true);
  });
}

test('missing primary can index published archive, but corrupt published archive does not silently use backup', async () => {
  const a = await recoverable(), b = await recoverable();
  await fs.unlink(a.main); await fs.unlink(a.backup);
  const zip = new AdmZip(); zip.addFile('manifest.json', Buffer.from(JSON.stringify(a.state)));
  const archive = path.join(a.directory, `${a.id}.zip`); await fs.writeFile(archive, zip.toBuffer());
  const original = await fs.readFile(archive);
  await fs.writeFile(path.join(b.directory, `${b.id}.zip`), 'broken archive');
  await scan(); assert.equal(JSON.parse(row(a.id).summary).manifestRecovery.source, 'archive'); assert.equal(row(b.id), undefined);
  assert.deepEqual(await fs.readFile(archive), original); await assert.rejects(fs.stat(a.main), { code: 'ENOENT' });
});

test('recovery indexing never changes owners or bypasses member-filtered query results', async () => {
  const a = await recoverable(), b = await recoverable();
  const db = platformDb(), owner = db.prepare('INSERT OR REPLACE INTO resource_owners VALUES (?,?,?,?)');
  owner.run('job', a.id, 'recover-operator-a', new Date().toISOString()); owner.run('job', b.id, 'recover-operator-b', new Date().toISOString());
  await withActor({ id: 'recover-operator-a', role: 'operator' }, scan);
  const result = await withActor({ id: 'recover-operator-a', role: 'operator' }, () => listTaskCenter({ q: 'recover-', pageSize: 100 }));
  assert.deepEqual(result.records.map(item => item.id), [a.id]); assert.equal(result.indexStatus.recovered, 0);
  assert.equal(db.prepare('SELECT owner_id FROM resource_owners WHERE resource_id=?').get(b.id).owner_id, 'recover-operator-b');
  assert.ok(row(b.id));
});

test('wrong primary identity and mismatched recovery identity remain unindexed', async () => {
  const a = await recoverable(), b = await recoverable();
  await fs.writeFile(a.main, JSON.stringify({ ...a.state, id: 'other-task' }));
  await fs.writeFile(b.backup, JSON.stringify({ ...b.state, id: 'other-task' }));
  await scan(); assert.equal(row(a.id), undefined); assert.equal(row(b.id), undefined);
});

test('newer live task index is not overwritten by an older recovery snapshot', async () => {
  const fixture = await recoverable();
  indexTask({ ...fixture.state, status: 'completed', updatedAt: '2026-10-24T00:00:00Z' });
  await scan(); assert.equal(row(fixture.id).state, 'completed'); assert.equal(JSON.parse(row(fixture.id).summary).manifestRecovery, undefined);
});

test('same checkpoint refreshes only recovery display metadata and clears it after explicit file repair', async () => {
  const fixture = await recoverable(); indexTask(fixture.state);
  await scan(); const before = row(fixture.id);
  assert.equal(JSON.parse(before.summary).manifestRecovery.source, 'backup');
  await fs.writeFile(fixture.main, JSON.stringify(fixture.state)); await scan();
  const after = row(fixture.id); assert.equal(after.state, before.state); assert.equal(after.updated_at, before.updated_at); assert.equal(after.title, before.title);
  assert.equal(JSON.parse(after.summary).manifestRecovery, undefined);
});

test('root enumeration permission failure is reported as failed, never an empty completed migration', async (context) => {
  await recoverable();
  const root = path.join(paths.outputDir, 'workbench'), original = fs.readdir;
  const mock = context.mock.method(fs, 'readdir', async (...args) => { if (args[0] === root) throw Object.assign(new Error('fixture denied'), { code: 'EACCES' }); return original(...args); });
  try { await scan(); assert.equal(legacyIndexStatus().status, 'failed'); assert.equal(meta('task-index-migrated'), false); }
  finally { mock.mock.restore(); }
});
