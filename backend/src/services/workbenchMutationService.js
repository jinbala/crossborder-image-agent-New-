import fs from 'node:fs/promises';
import path from 'node:path';
import { AsyncLocalStorage } from 'node:async_hooks';
import { beginCollectionCreation } from './workspaceLifecycle.js';

const context = new AsyncLocalStorage(), active = new Set();
export const workbenchMutationBusy = id => active.has(id);

// Fail closed on an existing lock, including an interrupted process's lock.
// Do not guess that a stale-looking file is safe to remove.
export async function withWorkbenchMutation(id, directory, operation, { allowManifestWrite = false, manifestWrite = false } = {}) {
  const parent = context.getStore();
  if (manifestWrite && parent?.allowManifestWrite && parent.id === id && parent.directory === directory && parent.active) return operation();
  const releaseWorkspace = beginCollectionCreation();
  const lock = path.join(directory, 'manifest-operation.lock');
  let handle, owner;
  try {
    try { handle = await fs.open(lock, 'wx'); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      throw Object.assign(new Error('本任务正在写入，或保留了中断锁；请等待操作完成，保留文件并检查恢复记录'), { statusCode: 409, code: 'WORKBENCH_STATE_BUSY' });
    }
    owner = { id, directory, active: true, allowManifestWrite };
    active.add(id);
    await handle.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
    return await context.run(owner, operation);
  } finally {
    if (owner) { owner.active = false; active.delete(id); }
    try { if (handle) { try { await handle.close(); } finally { await fs.unlink(lock); } } }
    finally { releaseWorkspace(); }
  }
}
