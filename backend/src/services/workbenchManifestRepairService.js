import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { readWorkbenchSnapshot, snapshotHash, workbenchSnapshotDirectory } from './workbenchSnapshotService.js';
import { withWorkbenchMutation, workbenchMutationBusy } from './workbenchMutationService.js';
import { currentActor, assertResource } from './ownershipService.js';
import { collectionCreationEpoch, audit } from './platformStore.js';
import { indexTask } from './taskCenterService.js';
import { atomicRename } from '../utils/atomicRename.js';

const supported = /^(?:pack|collect|studio|listing|pricing|template-fill)-[A-Za-z0-9_-]+$/;
const failure = (message, code, statusCode = 409) => Object.assign(new Error(message), { code, statusCode });
function authorize(id) {
  if (typeof id !== 'string' || !supported.test(id) || id.startsWith('collect-job-')) throw failure('该类型请使用原任务的恢复入口', 'WORKBENCH_REPAIR_TYPE', 400);
  assertResource('job', id);
  const actor = currentActor();
  if (actor && !['admin', 'operator'].includes(actor.role)) throw failure('当前角色不能修复此任务清单', 'WORKBENCH_REPAIR_ROLE', 403);
}
function preview(id, snapshot, busy = workbenchMutationBusy(id)) {
  return { id, canRepair: snapshot.source !== 'primary' && !busy, busy, source: snapshot.source, sourceName: snapshot.sourceName,
    sourceHash: snapshot.sourceHash, fileBytes: snapshot.bytes.length, onlyManifest: true, imageCount: 0, remote: false,
    previewHash: snapshotHash(JSON.stringify({ id, actor: currentActor()?.id || 'local', epoch: collectionCreationEpoch(), primaryHash: snapshot.primaryHash, sourceHash: snapshot.sourceHash, source: snapshot.sourceName })) };
}
export async function previewWorkbenchManifestRepair(id) {
  authorize(id);
  const snapshot = await readWorkbenchSnapshot(id), directory = await workbenchSnapshotDirectory(id);
  const locked = await fs.lstat(path.join(directory, 'manifest-operation.lock')).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; });
  return preview(id, snapshot, locked || workbenchMutationBusy(id));
}
export async function repairWorkbenchManifest(id, input = {}, execution = {}) {
  authorize(id);
  if (input.confirm !== true || !/^[a-f0-9]{64}$/.test(input.previewHash || '') || !/^[a-f0-9]{64}$/.test(input.sourceHash || '')) throw failure('请先预览并明确确认仅修复主清单', 'WORKBENCH_REPAIR_CONFIRM', 400);
  const directory = await workbenchSnapshotDirectory(id);
  return withWorkbenchMutation(id, directory, async () => {
    const snapshot = await readWorkbenchSnapshot(id), approved = preview(id, snapshot, false);
    if (snapshot.source === 'primary' && snapshot.sourceHash === input.sourceHash) return { id, repaired: false, alreadyCurrent: true };
    const changed = () => failure('主清单或恢复来源已变化，请重新预览确认；未重新执行任务', 'WORKBENCH_REPAIR_CHANGED');
    if (!approved.canRepair || approved.previewHash !== input.previewHash || approved.sourceHash !== input.sourceHash) throw changed();
    const temporary = path.join(directory, `manifest.json.repair-${randomUUID()}.tmp`);
    try {
      audit(currentActor(), 'workbench-manifest-repair-prepare', id, 202, { sourceHash: approved.sourceHash, previousHash: snapshot.primaryHash, source: snapshot.source });
      await fs.writeFile(temporary, snapshot.bytes, { flag: 'wx' });
      await execution.beforeCommit?.();
      if (preview(id, await readWorkbenchSnapshot(id), false).previewHash !== approved.previewHash) throw changed();
      const preservedDamaged = snapshot.primaryBytes === null ? null : `manifest.json.damaged-${Date.now()}-${randomUUID()}`;
      if (preservedDamaged) await fs.writeFile(path.join(directory, preservedDamaged), snapshot.primaryBytes, { flag: 'wx' });
      await atomicRename(temporary, path.join(directory, 'manifest.json'));
      indexTask(snapshot.state);
      audit(currentActor(), 'workbench-manifest-repair-complete', id, 200, { sourceHash: snapshot.sourceHash, preservedDamaged, imagesProcessed: 0 });
      return { id, repaired: true, preservedDamaged, sourceHash: snapshot.sourceHash, imagesProcessed: 0 };
    } finally { await fs.rm(temporary, { force: true }).catch(() => {}); }
  });
}
