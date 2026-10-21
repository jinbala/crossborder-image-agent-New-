import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { platformDb, setMeta, meta } from '../src/services/platformStore.js';
import { paths } from '../src/services/db.js';
import { indexTask, listTaskCenter, waitForLegacyIndex, legacyIndexStatus, rebuildLegacyIndex } from '../src/services/taskCenterService.js';
import { withActor } from '../src/services/ownershipService.js';
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
