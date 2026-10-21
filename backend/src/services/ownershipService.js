import { AsyncLocalStorage } from 'node:async_hooks';
import fs from 'node:fs/promises';
import path from 'node:path';
import { platformDb } from './platformStore.js';
import { paths } from './dbPaths.js';

const context = new AsyncLocalStorage();
export const currentActor = () => context.getStore() || null;
export const withActor = (actor, fn) => context.run(actor, fn);
export const restrictedActor = (actor = currentActor()) => actor && actor.role !== 'admin' ? actor : null;
const missing = () => Object.assign(new Error('记录不存在或当前成员无权访问'), { statusCode: 404 });

export function resourceVisible(kind, id, actor = currentActor()) {
  if (actor?.role === 'support') return false;
  const restricted = restrictedActor(actor);
  return !restricted || platformDb().prepare('SELECT 1 FROM resource_owners WHERE kind=? AND resource_id=? AND owner_id=?').get(kind, String(id), restricted.id) !== undefined;
}
export function assertResource(kind, id, actor = currentActor()) {
  if (!resourceVisible(kind, id, actor)) throw missing();
}
export function assetKey(value) {
  if (typeof value !== 'string' || !value || value.includes('\0')) return null;
  let relative = value.replaceAll('\\', '/');
  if (/^https?:/i.test(relative)) return null;
  if (path.isAbsolute(value) && !/^\/(?:uploads|outputs)\//.test(relative)) relative = path.relative(paths.rootDir, value).replaceAll('\\', '/');
  relative = relative.replace(/^\//, '');
  if (!/^(uploads|outputs)\//.test(relative) || relative.split('/').some((part) => part === '..' || part === '.')) return null;
  return relative;
}
export function grantAsset(value, kind, id) {
  const key = assetKey(value); if (!key) return;
  const existing = platformDb().prepare('SELECT * FROM resource_assets WHERE asset_path=?').get(key);
  if (existing && (existing.kind !== kind || existing.resource_id !== id)) {
    const previousOwner = platformDb().prepare('SELECT owner_id FROM resource_owners WHERE kind=? AND resource_id=?').get(existing.kind, existing.resource_id)?.owner_id;
    const nextOwner = platformDb().prepare('SELECT owner_id FROM resource_owners WHERE kind=? AND resource_id=?').get(kind, id)?.owner_id;
    if (previousOwner && previousOwner === nextOwner) return; // Existing same-member fixtures/resources may legitimately reuse a source file.
    throw Object.assign(new Error('文件仍由另一个记录持有，请先导入独立副本后再分配；原文件未修改'), { statusCode: 409 });
  }
  platformDb().prepare('INSERT OR IGNORE INTO resource_assets VALUES (?,?,?)').run(key, kind, id);
}
export function claimResource(kind, id, ownerId = currentActor()?.id || 'local') {
  const existing = platformDb().prepare('SELECT owner_id FROM resource_owners WHERE kind=? AND resource_id=?').get(kind, id);
  if (existing) { assertResource(kind, id); return; }
  if (restrictedActor() && ownerId !== currentActor().id) throw missing();
  platformDb().prepare('INSERT INTO resource_owners VALUES (?,?,?,?)').run(kind, id, ownerId, new Date().toISOString());
  if (kind === 'image' || kind === 'batch') grantAsset(`outputs/${id}`, kind, id);
  if (kind === 'job') grantAsset(`outputs/workbench/${id}`, kind, id);
}
export function registerTaskAssets(task) {
  claimResource('image', task.id);
  // Only backend-created source descriptors are eligible, never arbitrary product text.
  for (const image of task.sourceImages || [task.originalImage].filter(Boolean)) for (const field of ['filePath', 'url', 'previewUrl']) grantAsset(image[field], 'image', task.id);
}
export function ownerSql(idExpression = 'id', actor = currentActor()) {
  if (actor?.role === 'support') return { clause: '0=1', args: [] };
  const restricted = restrictedActor(actor);
  return restricted ? { clause: `${idExpression} IN (SELECT resource_id FROM resource_owners WHERE owner_id=?)`, args: [restricted.id] } : { clause: '1=1', args: [] };
}
export async function assertAssetRequest(requestPath) {
  if (!restrictedActor()) return;
  let decoded; try { decoded = decodeURIComponent(requestPath); } catch { throw missing(); }
  const key = assetKey(decoded); if (!key) throw missing();
  const absolute = await fs.realpath(path.join(paths.rootDir, key)).catch(() => null);
  if (!absolute) throw missing();
  const root = await fs.realpath(paths.rootDir);
  const relative = path.relative(root, absolute).replaceAll('\\', '/');
  const canonical = assetKey(relative); if (!canonical) throw missing();
  let current = canonical;
  while (current && current !== '.') {
    const grant = platformDb().prepare('SELECT kind,resource_id FROM resource_assets WHERE asset_path=?').get(current);
    if (grant) { assertResource(grant.kind, grant.resource_id); return; }
    const parent = path.posix.dirname(current); if (parent === current) break; current = parent;
  }
  throw missing();
}
