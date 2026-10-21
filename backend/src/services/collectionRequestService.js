import { createHash } from 'node:crypto';
import { platformDb, collectionCreationEpoch } from './platformStore.js';
import { currentActor, claimResource, assertResource } from './ownershipService.js';

export const collectionRequestError = (message, code, statusCode = 409) => Object.assign(new Error(message), { code, statusCode });
export function fingerprintCollectionRequest(value) {
  function canonical(item) {
    if (Array.isArray(item)) return `[${item.map(canonical).join(',')}]`;
    if (item && typeof item === 'object') return `{${Object.keys(item).sort().map((key) => `${JSON.stringify(key)}:${canonical(item[key])}`).join(',')}}`;
    return JSON.stringify(item);
  }
  return createHash('sha256').update(canonical(JSON.parse(JSON.stringify(value)))).digest('hex');
}
export function reserveCollectionRequest(requestId, expectedEpoch, payloadHash, makeManifest) {
  if (typeof requestId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{15,127}$/.test(requestId)) throw collectionRequestError('采集请求标识无效，必须是 16–128 位字母、数字、横线或下划线', 'INVALID_REQUEST_ID', 400);
  if (typeof expectedEpoch !== 'string' || !/^[a-f0-9-]{36}$/i.test(expectedEpoch)) throw collectionRequestError('缺少有效的工作空间创建标识，请先检测连接后重试', 'INVALID_CREATION_EPOCH', 400);
  const actor = currentActor();
  if (actor && !['admin', 'operator'].includes(actor.role)) throw collectionRequestError('当前角色不能创建采集任务', 'COLLECTION_FORBIDDEN', 403);
  const owner = actor?.id || 'local', requestHash = createHash('sha256').update(requestId).digest('hex');
  const db = platformDb();
  return db.transaction(() => {
    const existing = db.prepare('SELECT * FROM collection_requests WHERE owner_id=? AND request_hash=?').get(owner, requestHash);
    if (existing) {
      assertResource('job', existing.job_id);
      if (existing.payload_hash !== payloadHash) throw collectionRequestError('同一采集请求的商品或规则已变化；原任务未修改，请先找回原回传，或明确开始新的采集轮次', 'COLLECTION_REQUEST_CONFLICT');
      return { ...existing, created: false };
    }
    if (expectedEpoch !== collectionCreationEpoch()) throw collectionRequestError('工作空间已恢复备份或连接目标已变化，原请求未确认；请检查任务中心后明确开始新轮次，未另建任务', 'COLLECTION_WORKSPACE_CHANGED');
    const manifest = makeManifest();
    manifest.creationFingerprint = payloadHash;
    const initial = JSON.stringify(manifest);
    if (Buffer.byteLength(initial) > 16 * 1024 * 1024) throw collectionRequestError('采集请求过大，请拆分为小批次后重试', 'COLLECTION_REQUEST_TOO_LARGE', 413);
    claimResource('job', manifest.id, owner);
    db.prepare('INSERT INTO collection_requests VALUES (?,?,?,?,?,?,?)').run(owner, requestHash, payloadHash, manifest.id, 'prepared', initial, manifest.createdAt);
    return { owner_id: owner, request_hash: requestHash, payload_hash: payloadHash, job_id: manifest.id, state: 'prepared', initial_manifest: initial, created_at: manifest.createdAt, created: true };
  }).immediate();
}
export function collectionRequestRecord(reservation) {
  const row = platformDb().prepare('SELECT * FROM collection_requests WHERE owner_id=? AND request_hash=?').get(reservation.owner_id, reservation.request_hash);
  if (!row || row.job_id !== reservation.job_id || row.payload_hash !== reservation.payload_hash) throw collectionRequestError('采集请求记录已变化，请检查工作空间恢复记录；不会另建任务', 'COLLECTION_REQUEST_CHANGED');
  assertResource('job', row.job_id);
  return row;
}
export function finishCollectionRequest(reservation) {
  collectionRequestRecord(reservation);
  // The request hash and job identity remain durable; duplicate business payload is no longer needed.
  platformDb().prepare("UPDATE collection_requests SET state='ready',initial_manifest='' WHERE owner_id=? AND request_hash=?").run(reservation.owner_id, reservation.request_hash);
}
