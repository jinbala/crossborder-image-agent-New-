import { randomBytes, createHash } from 'node:crypto';
import { platformDb, privateSafe, audit } from './platformStore.js';
import { tokenHash, randomToken, fail } from './accountService.js';
import { indexTask } from './taskCenterService.js';
import { claimResource } from './ownershipService.js';

export function issueDeviceCode(actor) {
  if (!['admin', 'operator', 'designer'].includes(actor.role)) throw fail('只读成员不能绑定执行设备', 403);
  if (!platformDb().prepare('SELECT id FROM members WHERE id=? AND active=1').get(actor.id)) throw fail('请从已登录的 Web 工作空间生成设备配对码', 409);
  const code = randomBytes(8).toString('hex').toUpperCase();
  const expiresAt = Date.now() + 5 * 60_000;
  platformDb().prepare('DELETE FROM device_codes WHERE expires_at<? OR user_id=?').run(Date.now(), actor.id);
  platformDb().prepare('INSERT INTO device_codes VALUES (?,?,?)').run(tokenHash(code), actor.id, expiresAt);
  return { code, expiresAt: new Date(expiresAt).toISOString() };
}

export function redeemDeviceCode(input) {
  const db = platformDb();
  return db.transaction(() => {
    const hash = tokenHash(String(input.code || '').trim().toUpperCase());
    const row = db.prepare('SELECT device_codes.*,members.active,members.role FROM device_codes JOIN members ON members.id=device_codes.user_id WHERE code_hash=? AND expires_at>?').get(hash, Date.now());
    if (!row?.active || !['admin', 'operator', 'designer'].includes(row.role)) throw fail('设备配对码无效或已过期', 401);
    db.prepare('DELETE FROM device_codes WHERE code_hash=?').run(hash);
    const deviceToken = randomToken();
    const id = `device-${randomBytes(12).toString('hex')}`;
    const now = new Date().toISOString();
    db.prepare('INSERT INTO devices VALUES (?,?,?,?,?,?,?)').run(id, row.user_id, String(input.name || 'Windows 客户端').slice(0, 100), tokenHash(deviceToken), 1, now, now);
    audit({ id: row.user_id }, 'device.bound', id);
    return { deviceId: id, deviceToken, scope: 'task-metadata-sync' };
  })();
}

export function listDevices(actor) {
  return platformDb().prepare('SELECT id,user_id,name,active,created_at,last_seen FROM devices WHERE (?=1 OR user_id=?) ORDER BY last_seen DESC').all(Number(actor.role === 'admin'), actor.id);
}
export function revokeDevice(id, actor) {
  const device = platformDb().prepare('SELECT * FROM devices WHERE id=?').get(id);
  if (!device || (actor.role !== 'admin' && actor.id !== device.user_id)) throw fail('设备不存在', 404);
  platformDb().prepare('UPDATE devices SET active=0 WHERE id=?').run(id);
  audit(actor, 'device.revoked', id);
  return { ok: true };
}

export function safeTaskMetadata(raw) {
  if (!raw || typeof raw !== 'object' || !/^[A-Za-z0-9_-]{1,180}$/.test(raw.id || '')) throw fail('同步任务 ID 无效');
  const states = ['draft', 'queued', 'running', 'waiting_user', 'paused', 'completed', 'partial', 'failed', 'cancelled'];
  if (!states.includes(raw.state)) throw fail('同步任务状态无效');
  const result = { id: raw.id, state: raw.state, kind: String(raw.kind || '').slice(0, 60), sku: String(raw.sku || '').slice(0, 120), title: String(raw.title || raw.id).slice(0, 500),
    summary: Object.fromEntries(Object.entries(raw.summary || {}).filter(([key, value]) => /^[A-Za-z][A-Za-z0-9_]{0,60}$/.test(key) && typeof value === 'number' && Number.isFinite(value))),
    updatedAt: Number.isNaN(Date.parse(raw.updatedAt)) ? new Date().toISOString() : new Date(raw.updatedAt).toISOString() };
  return privateSafe(result);
}

export function synchronizeDevice(token, input) {
  const db = platformDb();
  const device = db.prepare(`SELECT devices.*,members.active AS member_active,members.role FROM devices JOIN members ON members.id=devices.user_id WHERE token_hash=?`).get(tokenHash(token));
  if (!device?.active || !device.member_active || !['admin', 'operator', 'designer'].includes(device.role)) throw fail('设备连接已撤销，请重新绑定', 401);
  if (!Array.isArray(input.operations) || input.operations.length > 100) throw fail('每批同步不超过 100 个操作');
  const results = [];
  db.transaction(() => {
    for (const operation of input.operations) {
      if (!/^[A-Za-z0-9_-]{1,100}$/.test(operation.operationId || '')) throw fail('同步操作 ID 无效');
      const receipt = db.prepare('SELECT result FROM sync_receipts WHERE device_id=? AND operation_id=?').get(device.id, operation.operationId);
      if (receipt) { results.push(JSON.parse(receipt.result)); continue; }
      const data = safeTaskMetadata(operation.data);
      const legacyId = `synced-${data.id}`;
      const legacy = db.prepare("SELECT id FROM platform_records WHERE id=? AND kind='synced-task' AND owner_id=?").get(legacyId, device.user_id);
      const recordId = legacy?.id || `synced-${createHash('sha256').update(device.user_id).digest('hex').slice(0, 16)}-${data.id}`;
      const row = db.prepare("SELECT * FROM platform_records WHERE id=? AND kind='synced-task'").get(recordId);
      const version = row?.version || 0;
      let result;
      if (operation.baseVersion !== version) {
        result = { operationId: operation.operationId, id: data.id, status: 'conflict', local: data,
          remote: row ? { version: row.version, data: JSON.parse(row.data) } : { version: 0, data: null } };
      } else {
        const now = new Date().toISOString();
        db.prepare(`INSERT INTO platform_records VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET version=excluded.version,data=excluded.data,updated_at=excluded.updated_at`).run(
          recordId, 'synced-task', device.user_id, version + 1, 0, JSON.stringify(data), row?.created_at || now, now);
        claimResource('job', recordId, device.user_id);
        indexTask({ id: recordId, type: 'device-task', status: data.state, name: data.title, sku: data.sku, summary: data.summary, updatedAt: now });
        db.prepare('UPDATE task_index SET href=? WHERE id=?').run('/sync', recordId);
        result = { operationId: operation.operationId, id: data.id, status: 'applied', version: version + 1 };
      }
      db.prepare('INSERT INTO sync_receipts VALUES (?,?,?)').run(device.id, operation.operationId, JSON.stringify(result));
      results.push(result);
    }
    db.prepare('UPDATE devices SET last_seen=? WHERE id=?').run(new Date().toISOString(), device.id);
  })();
  const records = db.prepare("SELECT * FROM platform_records WHERE kind='synced-task' AND owner_id=? ORDER BY updated_at DESC LIMIT 1000").all(device.user_id).map((row) => ({ id: JSON.parse(row.data).id, version: row.version, data: JSON.parse(row.data) }));
  return { results, records, deviceId: device.id, synchronizedAt: new Date().toISOString(), metadataOnly: true };
}
