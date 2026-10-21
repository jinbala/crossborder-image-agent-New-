import { randomBytes } from 'node:crypto';
import { platformDb, pageOptions, audit } from './platformStore.js';
import { fail } from './accountService.js';
import { restrictedActor, assertResource } from './ownershipService.js';

export const RECORD_KINDS = ['product', 'preset', 'conversation', 'notice', 'pricing-rule'];
function decoded(row) {
  return row ? { id: row.id, kind: row.kind, ownerId: row.owner_id, version: row.version,
    archived: Boolean(row.deleted), data: JSON.parse(row.data), createdAt: row.created_at, updatedAt: row.updated_at } : null;
}
export function getRecord(id) {
  const record = decoded(platformDb().prepare('SELECT * FROM platform_records WHERE id=?').get(id));
  const actor = restrictedActor();
  return record && actor && record.kind !== 'notice' && (actor.role === 'support' || record.ownerId !== actor.id) ? null : record;
}

export function listRecords(kind, query = {}, actor) {
  if (actor.role === 'support' && kind !== 'notice') throw fail('技术支持仅可读取诊断和公告', 403);
  if (!RECORD_KINDS.includes(kind)) throw fail('记录类型不存在', 404);
  const { page, pageSize } = pageOptions(query);
  const q = String(query.q || '').slice(0, 100);
  const archived = query.includeArchived === 'true';
  const owner = kind !== 'notice' && actor.role !== 'admin' ? actor.id : '';
  const appVersion = kind === 'notice' ? String(query.appVersion || '').slice(0, 40) : '';
  const clause = "WHERE kind=? AND (?=1 OR deleted=0) AND (?='' OR data LIKE ?) AND (?='' OR owner_id=?) AND (?='' OR coalesce(json_extract(data,'$.appVersion'),'') IN ('',?))";
  const args = [kind, Number(archived), q, `%${q}%`, owner, owner, appVersion, appVersion];
  const db = platformDb();
  const total = db.prepare(`SELECT COUNT(*) AS n FROM platform_records ${clause}`).get(...args).n;
  const records = db.prepare(`SELECT * FROM platform_records ${clause} ORDER BY updated_at DESC,id LIMIT ? OFFSET ?`).all(...args, pageSize, (page - 1) * pageSize).map(decoded);
  return { records, pagination: { page, pageSize, total, totalPages: Math.max(1, Math.ceil(total / pageSize)) } };
}

function writable(kind, actor, existing) {
  if (!RECORD_KINDS.includes(kind)) throw fail('此记录不可通过通用接口修改', 403);
  if (['viewer', 'support'].includes(actor.role)) throw fail('只读成员不能修改数据', 403);
  if (kind === 'notice' && actor.role !== 'admin') throw fail('仅管理员可发布公告', 403);
  if (kind === 'product' && !['admin', 'operator'].includes(actor.role)) throw fail('仅运营和管理员可维护商品', 403);
  if (existing && kind !== 'notice' && actor.role !== 'admin' && existing.ownerId !== actor.id) throw fail('不能修改其他成员的私有记录', 403);
}
function validate(kind, data) {
  if (!data || typeof data !== 'object' || Array.isArray(data) || JSON.stringify(data).length > 256000) throw fail('记录格式或大小无效');
  if (kind === 'product' && (!String(data.sku || '').trim() || !String(data.title || data.name || '').trim())) throw fail('商品必须填写 SKU 和标题');
  if (kind === 'product') {
    for (const [key, min] of [['price', 0.01], ['stock', 0]]) if (data[key] !== undefined && data[key] !== '' && (!Number.isFinite(Number(data[key])) || Number(data[key]) < min)) throw fail(`${key === 'price' ? '价格' : '库存'}格式无效`);
    if (data.sourceUrl) { let url; try { url = new URL(data.sourceUrl); } catch { throw fail('来源链接无效'); } if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw fail('来源链接必须为不含凭据的 HTTP(S) 地址'); }
  }
  if (['preset', 'notice', 'pricing-rule'].includes(kind) && !String(data.name || data.title || '').trim()) throw fail('请填写名称或标题');
  if (kind === 'notice' && data.appVersion && !/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(data.appVersion)) throw fail('公告版本请填写如 0.7.0，留空表示所有版本');
  if (kind === 'pricing-rule') {
    if (!/^[A-Z]{3}$/.test(data.currency || '')) throw fail('请使用三位币种代码');
    if (!Array.isArray(data.rules) || !data.rules.length || data.rules.length > 10 || data.rules.some((rule) => !['percent', 'fixed'].includes(rule.type) || !Number.isFinite(Number(rule.value)) || Math.abs(Number(rule.value)) > (rule.type === 'percent' ? 100 : 1000000))) throw fail('调价规则格式无效：需要 1–10 条规则，百分比不超过 ±100%');
    if (!['cent', 'integer', 'ending99'].includes(data.rounding || 'cent')) throw fail('舍入规则无效');
  }
}

export function saveRecord(kind, input, actor, id = null) {
  if (!RECORD_KINDS.includes(kind)) throw fail('记录类型不存在', 404);
  const db = platformDb();
  return db.transaction(() => {
    const existing = id ? getRecord(id) : null;
    if (id && (!existing || existing.kind !== kind)) throw fail('记录不存在', 404);
    writable(kind, actor, existing);
    validate(kind, input.data);
    if (kind === 'product' && input.data.taskId) assertResource('image', input.data.taskId);
    if (kind === 'product' && db.prepare("SELECT id FROM platform_records WHERE kind='product' AND deleted=0 AND id!=? AND owner_id=? AND trim(json_extract(data,'$.sku'))=? COLLATE NOCASE").get(id || '', existing?.ownerId || actor.id, String(input.data.sku).trim())) throw fail('SKU 已存在，请编辑已有商品', 409);
    if (existing && input.baseVersion !== existing.version) throw fail('记录已由其他操作修改，请刷新后合并', 409);
    const recordId = id || `${kind}-${randomBytes(12).toString('hex')}`;
    const now = new Date().toISOString();
    const version = (existing?.version || 0) + 1;
    db.prepare(`INSERT INTO platform_records VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET version=excluded.version,deleted=excluded.deleted,data=excluded.data,updated_at=excluded.updated_at`).run(
      recordId, kind, existing?.ownerId || actor.id, version, existing?.archived ? 1 : 0, JSON.stringify(input.data), existing?.createdAt || now, now);
    db.prepare('INSERT INTO record_revisions VALUES (?,?,?,?,?)').run(recordId, version, JSON.stringify(input.data), actor.id, now);
    audit(actor, `${kind}.${existing ? 'update' : 'create'}`, recordId, 200, { beforeVersion: existing?.version || 0, afterVersion: version });
    return getRecord(recordId);
  })();
}

export function archiveRecord(id, input, actor) {
  const db = platformDb();
  return db.transaction(() => {
    const existing = getRecord(id);
    if (!existing) throw fail('记录不存在', 404);
    writable(existing.kind, actor, existing);
    if (input.confirm !== true) throw fail('请确认归档或恢复');
    if (input.baseVersion !== existing.version) throw fail('记录已变化，请刷新', 409);
    db.prepare('UPDATE platform_records SET deleted=?,version=version+1,updated_at=? WHERE id=?').run(input.restore === true ? 0 : 1, new Date().toISOString(), id);
    audit(actor, `${existing.kind}.${input.restore ? 'restore' : 'archive'}`, id);
    return getRecord(id);
  })();
}
