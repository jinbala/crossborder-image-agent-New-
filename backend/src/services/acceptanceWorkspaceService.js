import { createHash, randomUUID } from 'node:crypto';
import { platformDb } from './platformStore.js';
import { assertResource, currentActor } from './ownershipService.js';
import { beginCollectionCreation } from './workspaceLifecycle.js';

const fail = (message, code, statusCode = 409) => Object.assign(new Error(message), { code, statusCode });
const editableRoles = new Set(['admin', 'operator', 'designer']);
function actor(expectedActorId, mutation = false) {
  const value = currentActor() || { id: 'local', role: 'admin' };
  if (!['admin', 'operator', 'designer', 'viewer'].includes(value.role)) throw fail('当前角色不能读取验收报告', 'ACCEPTANCE_FORBIDDEN', 403);
  if (mutation && !editableRoles.has(value.role)) throw fail('当前角色不能保存验收报告', 'ACCEPTANCE_FORBIDDEN', 403);
  if ((mutation || expectedActorId !== undefined) && expectedActorId !== value.id) throw fail('当前成员已变化，请重新打开验收页面；原报告未覆盖', 'ACCEPTANCE_ACTOR_CHANGED');
  return value;
}
function slot(ownerId) {
  const db = platformDb();
  db.prepare('INSERT OR IGNORE INTO acceptance_workspaces(owner_id,generation) VALUES (?,?)').run(ownerId, randomUUID());
  return db.prepare('SELECT * FROM acceptance_workspaces WHERE owner_id=?').get(ownerId);
}
const forbiddenKey = /^(?:__proto__|constructor|prototype|token|confirmRealApi|confirmPaidApi|confirmNoPlatformUpload)$|password|cookie|authorization|access.?token|refresh.?token|api.?key|secret/i;
export function normalizeAcceptanceDocument(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw fail('验收文档格式无效', 'ACCEPTANCE_INVALID', 400);
  let count = 0;
  function clean(value, depth = 0) {
    if (++count > 80000 || depth > 24) throw fail('验收文档过大或嵌套过深，请拆分导出', 'ACCEPTANCE_TOO_LARGE', 413);
    if (value === null || typeof value === 'boolean' || typeof value === 'string') return value;
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    if (Array.isArray(value)) return value.map(item => clean(item, depth + 1));
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([key]) => !forbiddenKey.test(key)).map(([key, item]) => [key, clean(item, depth + 1)]));
    throw fail('验收文档包含不支持的数据', 'ACCEPTANCE_INVALID', 400);
  }
  const result = Object.fromEntries(['report', 'realApiReport', 'issueForm', 'realApiForm'].map(key => [key, clean(raw[key] ?? null)]));
  if (Buffer.byteLength(JSON.stringify(result)) > 1024 * 1024) throw fail('验收文档超过 1MB，请拆分导出', 'ACCEPTANCE_TOO_LARGE', 413);
  return result;
}
function assertReferences(value) {
  if (!value || typeof value !== 'object') return;
  for (const [key, item] of Object.entries(value)) {
    if (['taskId', 'relatedTaskId', 'batchId', 'relatedBatchId'].includes(key) && typeof item === 'string' && item.trim()) assertResource(/batch/i.test(key) ? 'batch' : 'image', item);
    if (['taskIds', 'batchIds'].includes(key) && Array.isArray(item)) for (const id of item) if (typeof id === 'string' && id.trim()) assertResource(key === 'batchIds' ? 'batch' : 'image', id);
    if (item && typeof item === 'object') assertReferences(item);
  }
}
function decode(row) {
  if (!row.payload) return null;
  try { return normalizeAcceptanceDocument(JSON.parse(row.payload)); }
  catch { throw fail('保存的验收报告损坏，请检查备份；未覆盖原记录', 'ACCEPTANCE_CORRUPT'); }
}
function context(row, user) {
  let document = null, unavailable = false, corrupt = false;
  try { document = decode(row); if (document) assertReferences(document); }
  catch (error) { if (error.code === 'ACCEPTANCE_CORRUPT') corrupt = true; else if (error.statusCode === 404) unavailable = true; else throw error; }
  return { actorId: user.id, editable: editableRoles.has(user.role), generation: row.generation, revision: row.revision, lastRequestId: row.request_id, updatedAt: row.updated_at, document: unavailable || corrupt ? null : document, unavailable, corrupt };
}
function guarded(operation) { const release = beginCollectionCreation(); try { return operation(); } finally { release(); } }
export function getAcceptanceWorkspace(expectedActorId) {
  return guarded(() => { const user = actor(expectedActorId); return context(slot(user.id), user); });
}
export function validateAcceptanceWorkspace(raw, expectedActorId) {
  return guarded(() => { actor(expectedActorId, true); const document = normalizeAcceptanceDocument(raw); assertReferences(document); return { document }; });
}
export function saveAcceptanceWorkspace(body = {}) {
  return guarded(() => {
    const user = actor(body.expectedActorId, true), db = platformDb();
    const document = normalizeAcceptanceDocument(body.document); assertReferences(document);
    if (!/^[A-Za-z0-9_-]{12,100}$/.test(body.requestId || '') || !Number.isSafeInteger(body.revision) || body.revision < 0) throw fail('缺少有效的报告版本或保存请求标识', 'ACCEPTANCE_INVALID', 400);
    const payload = JSON.stringify(document), hash = createHash('sha256').update(payload).digest('hex');
    return db.transaction(() => {
      const current = slot(user.id);
      if (current.generation !== body.generation) throw fail('工作空间已恢复或报告上下文已改变，请重新读取；没有覆盖报告', 'ACCEPTANCE_CONTEXT_CHANGED');
      if (current.request_id === body.requestId) {
        if (current.request_hash !== hash) throw fail('保存请求标识已用于不同内容，请重新读取报告', 'ACCEPTANCE_REQUEST_CONFLICT');
        return { ...context(current, user), replayed: true };
      }
      if (current.revision !== body.revision) throw fail('其他页面已保存更新，请导出本页修改再重新读取；没有覆盖服务器报告', 'ACCEPTANCE_REVISION_CONFLICT');
      const previous = context(current, user);
      if (previous.unavailable || previous.corrupt) throw fail('原报告不可读取，请先明确重置验收工作区；未覆盖原记录', 'ACCEPTANCE_UNAVAILABLE');
      db.prepare('UPDATE acceptance_workspaces SET revision=revision+1,payload=?,request_id=?,request_hash=?,updated_at=? WHERE owner_id=?').run(payload, body.requestId, hash, new Date().toISOString(), user.id);
      return context(slot(user.id), user);
    }).immediate();
  });
}
export function resetAcceptanceWorkspace(body = {}) {
  return guarded(() => {
    const user = actor(body.expectedActorId, true), db = platformDb();
    if (body.confirm !== true) throw fail('重置验收工作区需要明确确认，原业务任务和导出文件不会删除', 'ACCEPTANCE_CONFIRM_REQUIRED', 400);
    return db.transaction(() => {
      const current = slot(user.id);
      if (body.generation !== current.generation || body.revision !== current.revision) throw fail('报告版本已变化，请重新读取后确认重置', 'ACCEPTANCE_REVISION_CONFLICT');
      db.prepare('UPDATE acceptance_workspaces SET generation=?,revision=0,payload=NULL,request_id=NULL,request_hash=NULL,updated_at=? WHERE owner_id=?').run(randomUUID(), new Date().toISOString(), user.id);
      return context(slot(user.id), user);
    }).immediate();
  });
}
