import { randomBytes, createHash, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { platformDb, audit, meta, setMeta } from './platformStore.js';

const derive = promisify(scrypt);
export const AGREEMENT_VERSION = '2026-10-20';
export const ROLES = ['admin', 'operator', 'designer', 'viewer', 'support'];
export const fail = (message, statusCode = 400) => Object.assign(new Error(message), { statusCode });
export const tokenHash = (token) => createHash('sha256').update(String(token || '')).digest('hex');
export const randomToken = () => randomBytes(32).toString('hex');
const attempts = new Map();

export function authEnabled() { return process.env.WEB_AUTH_ENABLED !== 'false' && !process.env.LOCAL_API_TOKEN; }
export function publicMember(row) {
  return row ? { id: row.id, username: row.username, displayName: row.display_name, role: row.role, active: Boolean(row.active), createdAt: row.created_at, updatedAt: row.updated_at } : null;
}
export function initialized() { return platformDb().prepare('SELECT COUNT(*) AS n FROM members').get().n > 0; }
export function localActor() { return { id: 'local', username: 'local', displayName: '本地管理员', role: 'admin', active: true }; }

function validatePassword(password) {
  if (typeof password !== 'string' || password.length < 12 || password.length > 128) throw fail('密码需为 12—128 个字符');
}
function username(value) {
  const name = String(value || '').trim();
  if (!/^[A-Za-z0-9_.-]{3,64}$/.test(name)) throw fail('账号需为 3—64 位字母、数字、点、横线或下划线');
  return name;
}

export async function createMember(input, actor = null, bootstrap = false) {
  const name = username(input.username);
  validatePassword(input.password);
  if (bootstrap && (input.agreementVersion !== AGREEMENT_VERSION || input.agree !== true)) throw fail('请阅读并同意当前用户协议和隐私说明');
  if (!bootstrap && actor?.role !== 'admin') throw fail('仅管理员可创建团队成员', 403);
  const salt = randomBytes(16).toString('hex');
  const hash = (await derive(input.password, salt, 64)).toString('hex');
  const now = new Date().toISOString();
  const member = { id: `user-${randomBytes(12).toString('hex')}`, username: name,
    display_name: String(input.displayName || name).trim().slice(0, 80), password_hash: hash, salt,
    role: bootstrap ? 'admin' : (ROLES.includes(input.role) ? input.role : 'viewer'), active: 1,
    agreement_version: bootstrap ? AGREEMENT_VERSION : '', agreed_at: bootstrap ? now : '', created_at: now, updated_at: now };
  const db = platformDb();
  db.transaction(() => {
    if (bootstrap && initialized()) throw fail('工作空间已初始化', 409);
    if (db.prepare('SELECT id FROM members WHERE username=?').get(name)) throw fail('账号已存在', 409);
    db.prepare(`INSERT INTO members VALUES (@id,@username,@display_name,@password_hash,@salt,@role,@active,@agreement_version,@agreed_at,@created_at,@updated_at)`).run(member);
    if (bootstrap) setMeta('workspace', { name: String(input.workspaceName || '跨境运营工作空间').slice(0, 100), createdAt: now });
  })();
  audit(publicMember(member), bootstrap ? 'account.bootstrap' : 'account.create', member.id, 201, { role: member.role, agreementVersion: AGREEMENT_VERSION });
  return publicMember(member);
}

export async function login(input, key = 'local') {
  const name = String(input.username || '').trim().slice(0, 64);
  const attemptKey = `${key}:${name.toLowerCase()}`;
  const now = Date.now();
  const attempt = attempts.get(attemptKey);
  if (attempt && attempt.until > now && attempt.count >= 8) throw fail('尝试过多，请 15 分钟后重试', 429);
  if (attempts.size > 10000) for (const [id, value] of attempts) if (value.until < now) attempts.delete(id);
  if (attempts.size >= 10000 && !attempts.has(attemptKey)) throw fail('登录请求繁忙，请稍后重试', 429);
  const row = platformDb().prepare('SELECT * FROM members WHERE username=?').get(name);
  const password = typeof input.password === 'string' ? input.password.slice(0, 129) : '';
  const actual = await derive(password, row?.salt || 'fake-salt-for-unknown-member', 64);
  const expected = row ? Buffer.from(row.password_hash, 'hex') : Buffer.alloc(64);
  if (!row?.active || actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    attempts.set(attemptKey, { count: attempt && attempt.until > now ? attempt.count + 1 : 1, until: now + 15 * 60_000 });
    audit(null, 'account.login-denied', '', 401);
    throw fail('账号或密码错误', 401);
  }
  attempts.delete(attemptKey);
  if (!ROLES.includes(row.role)) throw fail('账号角色无效，请联系管理员修复', 403);
  if (row.agreement_version !== AGREEMENT_VERSION) {
    if (input.agree !== true || input.agreementVersion !== AGREEMENT_VERSION) throw fail('请阅读并同意当前用户协议和隐私说明', 403);
    platformDb().prepare('UPDATE members SET agreement_version=?,agreed_at=? WHERE id=?').run(AGREEMENT_VERSION, new Date().toISOString(), row.id);
    audit(publicMember(row), 'account.agreement-accepted', row.id, 200, { agreementVersion: AGREEMENT_VERSION });
  }
  const token = randomToken();
  const csrf = randomToken();
  const expiresAt = now + (input.remember === true ? 7 * 24 : 12) * 60 * 60_000;
  const db = platformDb();
  db.prepare('DELETE FROM sessions WHERE expires_at<?').run(now);
  db.prepare('INSERT INTO sessions VALUES (?,?,?,?,?)').run(tokenHash(token), row.id, csrf, expiresAt, new Date().toISOString());
  audit(publicMember(row), 'account.login', row.id);
  return { token, csrf, expiresAt, user: publicMember(row), workspace: meta('workspace', {}) };
}

export function getSession(token) {
  if (!token) return null;
  const row = platformDb().prepare(`SELECT members.*, sessions.csrf, sessions.expires_at FROM sessions JOIN members ON members.id=sessions.user_id WHERE sessions.token_hash=? AND sessions.expires_at>? AND members.active=1`).get(tokenHash(token), Date.now());
  return row && ROLES.includes(row.role) ? { user: publicMember(row), csrf: row.csrf, expiresAt: row.expires_at, workspace: meta('workspace', {}) } : null;
}
export function logout(token) { platformDb().prepare('DELETE FROM sessions WHERE token_hash=?').run(tokenHash(token)); }
export function listMembers() { return platformDb().prepare('SELECT * FROM members ORDER BY created_at').all().map(publicMember); }

export function updateMember(id, patch, actor) {
  const db = platformDb();
  return db.transaction(() => {
  const current = db.prepare('SELECT * FROM members WHERE id=?').get(id);
  if (!current) throw fail('成员不存在', 404);
  if (actor.role !== 'admin' && actor.id !== id) throw fail('无权修改此成员', 403);
  if (actor.role !== 'admin' && (patch.role !== undefined || patch.active !== undefined)) throw fail('无权修改角色或停用状态', 403);
  const role = patch.role === undefined ? current.role : patch.role;
  if (!ROLES.includes(role)) throw fail('无效角色');
  const active = patch.active === undefined ? Boolean(current.active) : patch.active === true;
  if (current.role === 'admin' && current.active && (role !== 'admin' || !active) && db.prepare("SELECT COUNT(*) AS n FROM members WHERE role='admin' AND active=1").get().n <= 1) throw fail('至少保留一个有效管理员', 409);
  db.prepare('UPDATE members SET display_name=?,role=?,active=?,updated_at=? WHERE id=?').run(String(patch.displayName ?? current.display_name).trim().slice(0, 80), role, Number(active), new Date().toISOString(), id);
  if (!active || current.role !== role) {
    db.prepare('DELETE FROM sessions WHERE user_id=?').run(id);
    db.prepare('DELETE FROM device_codes WHERE user_id=?').run(id);
    db.prepare('UPDATE devices SET active=0 WHERE user_id=?').run(id);
    db.prepare('DELETE FROM oauth_pending WHERE user_id=?').run(id);
    if (!active || role !== 'admin') {
      db.prepare('UPDATE erp_grants SET active=0 WHERE owner_id=?').run(id);
      db.prepare('UPDATE shop_connections SET active=0 WHERE owner_id=?').run(id);
    }
  }
  audit(actor, 'account.update', id, 200, { before: publicMember(current), after: { role, active } });
  return publicMember(db.prepare('SELECT * FROM members WHERE id=?').get(id));
  })();
}

export async function changePassword(id, oldPassword, nextPassword) {
  validatePassword(nextPassword);
  const row = platformDb().prepare('SELECT * FROM members WHERE id=?').get(id);
  if (!row) throw fail('成员不存在', 404);
  const actual = await derive(String(oldPassword || '').slice(0, 129), row.salt, 64);
  if (!timingSafeEqual(actual, Buffer.from(row.password_hash, 'hex'))) throw fail('原密码错误', 403);
  const salt = randomBytes(16).toString('hex');
  const hash = (await derive(nextPassword, salt, 64)).toString('hex');
  const db = platformDb();
  db.transaction(() => {
    db.prepare('UPDATE members SET password_hash=?,salt=?,updated_at=? WHERE id=?').run(hash, salt, new Date().toISOString(), id);
    db.prepare('DELETE FROM sessions WHERE user_id=?').run(id);
    db.prepare('UPDATE devices SET active=0 WHERE user_id=?').run(id);
    db.prepare('DELETE FROM device_codes WHERE user_id=?').run(id);
    db.prepare('DELETE FROM oauth_pending WHERE user_id=?').run(id);
  })();
  audit(publicMember(row), 'account.password-changed', id);
}
