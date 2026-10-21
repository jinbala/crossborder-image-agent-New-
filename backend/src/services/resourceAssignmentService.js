import { createHash } from 'node:crypto';
import { platformDb, audit } from './platformStore.js';
import { readDb } from './db.js';
import { listMaterialRecords } from './workbenchMaterialService.js';
import { getRecord } from './platformRecordService.js';
import { fail } from './accountService.js';
import { assetKey, grantAsset } from './ownershipService.js';

const kinds = new Set(['image', 'batch', 'job', 'material', 'workflow', 'record']);
export async function assignmentPreview(kind, id, input, actor) {
  if (actor.role !== 'admin') throw fail('仅管理员可以分配记录', 403);
  if (!kinds.has(kind) || !/^[A-Za-z0-9_-]{1,220}$/.test(id)) throw fail('记录类型或 ID 无效');
  const target = platformDb().prepare('SELECT id,display_name,role FROM members WHERE id=? AND active=1').get(input.ownerId);
  if (!target) throw fail('请选择有效的已启用成员');
  if (target.role === 'support') throw fail('技术支持仅可读取脱敏诊断，不能接收业务记录');
  let source, core, affected = [{ kind, id }];
  if (['image', 'batch', 'workflow'].includes(kind)) {
    core = await readDb();
    source = (kind === 'image' ? core.tasks : kind === 'batch' ? core.batchTasks : core.workflowTemplates || []).find((item) => item.id === id);
    if (kind === 'batch' && source) affected.push(...(source.skuTasks || []).map((item) => ({ kind: 'image', id: item.taskId })).filter((item) => item.id));
  } else if (kind === 'material') source = (await listMaterialRecords({ includeArchived: true })).records.find((item) => item.id === id);
  else if (kind === 'record') { source = getRecord(id); if (source && !['product', 'preset', 'conversation', 'pricing-rule'].includes(source.kind)) source = null; }
  else source = platformDb().prepare('SELECT * FROM task_index WHERE id=?').get(id);
  if (!source) throw fail('记录不存在，请先从任务中心或对应列表复制 ID', 404);
  const running = new Set(['running', 'recognizing', 'generating', 'reviewing', 'processing']);
  if ([source.queue?.status, source.status, source.state].some((state) => running.has(state))) throw fail('请先暂停并等待当前条目完成，再调整成员归属', 409);
  const transferSet = new Set(affected.map((item) => `${item.kind}:${item.id}`));
  affected = [...new Map(affected.map((item) => [`${item.kind}:${item.id}`, item])).values()].map((item) => {
    const task = item.kind === 'image' ? core?.tasks.find((task) => task.id === item.id) : null;
    const assetPaths = task ? [...new Set((task.sourceImages || [task.originalImage].filter(Boolean)).flatMap((image) => ['filePath', 'url', 'previewUrl'].map((field) => assetKey(image[field]))).filter(Boolean))] : [];
    if (assetPaths.some((key) => {
      const grant = platformDb().prepare('SELECT kind,resource_id FROM resource_assets WHERE asset_path=?').get(key);
      return grant && !transferSet.has(`${grant.kind}:${grant.resource_id}`);
    })) throw fail('该任务有与其他记录共用的源文件，请先重新导入独立副本后再分配；不会改变现有归属', 409);
    if (assetPaths.length && core.tasks.some((other) => !transferSet.has(`image:${other.id}`) && (other.sourceImages || [other.originalImage].filter(Boolean)).some((image) => ['filePath', 'url', 'previewUrl'].some((field) => assetPaths.includes(assetKey(image[field])))))) throw fail('其他任务仍引用同一源文件，请先导入独立副本，或将相关子任务放在同一批量中一并分配', 409);
    if (task && ['recognizing', 'generating', 'reviewing', 'processing'].includes(task.status)) throw fail('批量任务仍有子任务正在执行，请先暂停后再分配', 409);
    return { ...item, assetPaths, beforeOwnerId: kind === 'record' ? source.ownerId : platformDb().prepare('SELECT owner_id FROM resource_owners WHERE kind=? AND resource_id=?').get(item.kind, item.id)?.owner_id || null };
  });
  const preview = { kind, id, target: { id: target.id, name: target.display_name, role: target.role }, affected, count: affected.length,
    sourceVersion: source.version || source.updatedAt || source.updated_at || source.createdAt || null,
    effects: '仅变更访问归属，不移动或删除文件。原成员失去访问权限；批量任务包含其子任务。管理员仍保留访问权。' };
  return { ...preview, approvalHash: createHash('sha256').update(JSON.stringify(preview)).digest('hex') };
}
export async function assignResource(kind, id, input, actor) {
  if (input.confirm !== true) throw fail('请先预览成员归属变化并确认');
  const preview = await assignmentPreview(kind, id, input, actor);
  if (input.approvalHash !== preview.approvalHash) throw fail('归属或记录已变化，请重新预览', 409);
  const db = platformDb();
  db.transaction(() => {
    for (const item of preview.affected) {
      if (kind === 'record') {
        if (!db.prepare('UPDATE platform_records SET owner_id=?,version=version+1,updated_at=? WHERE id=? AND owner_id=?').run(input.ownerId, new Date().toISOString(), id, item.beforeOwnerId).changes) throw fail('归属已变化，请重新预览', 409);
      } else {
        const owner = db.prepare('SELECT owner_id FROM resource_owners WHERE kind=? AND resource_id=?').get(item.kind, item.id)?.owner_id || null;
        if (owner !== item.beforeOwnerId) throw fail('归属已变化，请重新预览', 409);
        db.prepare('INSERT INTO resource_owners VALUES (?,?,?,?) ON CONFLICT(kind,resource_id) DO UPDATE SET owner_id=excluded.owner_id').run(item.kind, item.id, input.ownerId, new Date().toISOString());
        if (item.kind === 'image' || item.kind === 'batch') db.prepare('INSERT OR IGNORE INTO resource_assets VALUES (?,?,?)').run(`outputs/${item.id}`, item.kind, item.id);
        if (item.kind === 'job') db.prepare('INSERT OR IGNORE INTO resource_assets VALUES (?,?,?)').run(`outputs/workbench/${item.id}`, item.kind, item.id);
        for (const key of item.assetPaths) grantAsset(key, item.kind, item.id);
      }
    }
    audit(actor, 'resource.owner-assigned', id, 200, { kind, targetId: input.ownerId, count: preview.count, beforeOwners: preview.affected.map((item) => item.beforeOwnerId) });
  })();
  return { assigned: true, count: preview.count, ownerId: input.ownerId, filesMoved: false, filesDeleted: false };
}
