// Single-service workspace barrier: a restore must not race durable collection creation.
let creating = 0, restoring = false;
const busy = () => Object.assign(new Error('工作空间正在创建采集任务或恢复备份，请等待完成后使用相同请求重试'), { statusCode: 409, code: 'WORKSPACE_BUSY' });
export function beginCollectionCreation() {
  if (restoring) throw busy();
  creating++;
  let released = false;
  return () => { if (!released) { creating--; released = true; } };
}
export function assertNoCollectionCreation() { if (creating) throw busy(); }
export function beginWorkspaceRestore() {
  if (restoring || creating) throw busy();
  restoring = true;
  let released = false;
  return () => { if (!released) { restoring = false; released = true; } };
}
