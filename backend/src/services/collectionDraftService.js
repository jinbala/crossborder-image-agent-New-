import { randomUUID } from 'node:crypto';
import { platformDb, collectionCreationEpoch } from './platformStore.js';
import { currentActor, assertResource } from './ownershipService.js';
import { createCollectionJob, prepareCollectionInput } from './collectionJobService.js';
import { collectionRequestError } from './collectionRequestService.js';
import { beginCollectionCreation } from './workspaceLifecycle.js';

function owner(expectedActorId) {
  const actor = currentActor();
  if (actor && !['admin', 'operator'].includes(actor.role)) throw collectionRequestError('当前角色不能创建采集任务', 'COLLECTION_FORBIDDEN', 403);
  const id = actor?.id || 'local';
  if (expectedActorId !== undefined && expectedActorId !== id) throw collectionRequestError('当前登录成员已变化，请刷新页面；没有提交原成员的采集数据', 'COLLECTION_ACTOR_CHANGED');
  return id;
}
function mutationOwner(expectedActorId) {
  if (typeof expectedActorId !== 'string' || !expectedActorId) throw collectionRequestError('缺少当前成员标识，请刷新采集页面', 'COLLECTION_ACTOR_REQUIRED', 400);
  return owner(expectedActorId);
}
function slot(id) {
  const db = platformDb();
  db.prepare('INSERT OR IGNORE INTO collection_drafts(owner_id,generation) VALUES (?,?)').run(id, randomUUID());
  return db.prepare('SELECT * FROM collection_drafts WHERE owner_id=?').get(id);
}
function decode(row) {
  try {
    const value = JSON.parse(row.payload);
    if (!value || !Array.isArray(value.rows) || !value.rows.length || !value.options || typeof value.creationEpoch !== 'string') throw new Error();
    return value;
  } catch { throw collectionRequestError('采集草稿记录损坏，请检查备份或明确放弃本轮请求；未另建任务', 'COLLECTION_DRAFT_CORRUPT'); }
}
function context(row, reused = false) {
  if (!row.draft_id) return { actorId: row.owner_id, generation: row.generation, draft: null, reused };
  let unavailable = false;
  if (row.job_id) { try { assertResource('job', row.job_id); } catch { unavailable = true; } }
  // A changed owner must not expose the new owner's task state via a stale draft.
  if (unavailable) return { actorId: row.owner_id, generation: row.generation, reused, draft: { id: row.draft_id, state: 'unavailable', jobId: null } };
  let payload;
  try { payload = decode(row); } catch { return { actorId: row.owner_id, generation: row.generation, reused, draft: { id: row.draft_id, state: 'corrupt', jobId: null } }; }
  return { actorId: row.owner_id, generation: row.generation, reused, draft: {
    id: row.draft_id, state: row.job_id ? 'confirmed' : 'pending', jobId: row.job_id,
    name: payload.options.name, rowCount: payload.rows.length, sourceType: payload.source?.type,
    fileName: payload.source?.fileName || '', createdAt: row.created_at
  } };
}
export function getCollectionDraftContext(expectedActorId) {
  const release = beginCollectionCreation();
  try { return platformDb().transaction(() => context(slot(owner(expectedActorId)))).immediate(); } finally { release(); }
}
export function stageCollectionDraft(raw, { expectedActorId, generation } = {}) {
  const release = beginCollectionCreation();
  try {
    const id = mutationOwner(expectedActorId), db = platformDb();
    return db.transaction(() => {
      const current = slot(id);
      if (typeof generation !== 'string' || generation !== current.generation) throw collectionRequestError('采集页面已过期或其他页面已完成本轮，请刷新后检查任务中心；未新建任务', 'COLLECTION_DRAFT_CONTEXT_CHANGED');
      if (current.draft_id) return context(current, true);
      const input = { ...prepareCollectionInput(raw), creationEpoch: collectionCreationEpoch() };
      const payload = JSON.stringify(input);
      if (Buffer.byteLength(payload) > 16 * 1024 * 1024) throw collectionRequestError('采集草稿过大，请拆分后提交', 'COLLECTION_DRAFT_TOO_LARGE', 413);
      db.prepare('UPDATE collection_drafts SET draft_id=?,payload=?,job_id=NULL,created_at=? WHERE owner_id=?').run(randomUUID(), payload, new Date().toISOString(), id);
      return context(slot(id));
    }).immediate();
  } finally { release(); }
}
function activeDraft(id, expectedActorId) {
  const actorId = mutationOwner(expectedActorId);
  const row = platformDb().prepare('SELECT * FROM collection_drafts WHERE owner_id=? AND draft_id=?').get(actorId, id);
  if (!row) throw collectionRequestError('原采集草稿已确认、放弃或不存在，请刷新页面检查；未另建任务', 'COLLECTION_DRAFT_NOT_FOUND', 404);
  return row;
}
export async function submitCollectionDraft(id, expectedActorId, deps = {}) {
  const release = beginCollectionCreation();
  try {
    const row = activeDraft(id, expectedActorId), payload = decode(row);
    const job = await createCollectionJob({ ...payload, clientRequestId: row.draft_id }, deps);
    if (row.job_id && row.job_id !== job.id) throw collectionRequestError('草稿任务身份不一致，未覆盖原任务', 'COLLECTION_DRAFT_CONFLICT');
    platformDb().prepare('UPDATE collection_drafts SET job_id=? WHERE owner_id=? AND draft_id=?').run(job.id, row.owner_id, row.draft_id);
    return job;
  } finally { release(); }
}
export function clearCollectionDraft(id, { expectedActorId, jobId, discard = false, confirm = false } = {}) {
  const release = beginCollectionCreation();
  try {
    const actorId = mutationOwner(expectedActorId), db = platformDb();
    return db.transaction(() => {
      const row = db.prepare('SELECT * FROM collection_drafts WHERE owner_id=? AND draft_id=?').get(actorId, id);
      if (!row) return { cleared: false }; // A delayed acknowledgement must never clear a newer draft.
      if (discard) {
        if (confirm !== true) throw collectionRequestError('放弃待确认请求需要明确确认，服务器已有任务不会删除', 'COLLECTION_DRAFT_CONFIRM_REQUIRED', 400);
      } else {
        if (!row.job_id || row.job_id !== jobId) throw collectionRequestError('尚未确认取得原任务 ID，保留本轮采集草稿', 'COLLECTION_DRAFT_ACK_CONFLICT');
        assertResource('job', row.job_id);
      }
      db.prepare('UPDATE collection_drafts SET generation=?,draft_id=NULL,payload=NULL,job_id=NULL,created_at=NULL WHERE owner_id=? AND draft_id=?').run(randomUUID(), actorId, id);
      return { cleared: true, existingJobsRetained: true };
    }).immediate();
  } finally { release(); }
}
