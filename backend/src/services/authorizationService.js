import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { platformDb, audit, privateSafe } from './platformStore.js';
import { fail, randomToken, tokenHash } from './accountService.js';

function credentialKey() { const raw = process.env.WEB_CREDENTIAL_KEY || ''; if (!/^[0-9a-f]{64}$/i.test(raw)) throw fail('未配置 32 字节凭据加密密钥，禁止存储店铺凭据', 503); return Buffer.from(raw, 'hex'); }
export function encryptCredential(value) {
  const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', credentialKey(), iv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64');
}
export function decryptCredential(value) {
  const bytes = Buffer.from(value, 'base64'), decipher = createDecipheriv('aes-256-gcm', credentialKey(), bytes.subarray(0, 12)); decipher.setAuthTag(bytes.subarray(12, 28));
  return JSON.parse(Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString('utf8'));
}
function httpsUrl(value) { const url = new URL(value); if (url.protocol !== 'https:' || url.username || url.password || url.hash) throw fail('官方授权端点必须使用 HTTPS'); return url; }
function providers() {
  let records; try { records = JSON.parse(process.env.SHOP_OAUTH_PROVIDERS || '[]'); } catch { throw fail('服务端授权配置 JSON 无效', 503); }
  if (!Array.isArray(records) || records.length > 20) throw fail('服务端授权配置无效', 503);
  return records.map((item) => {
    if (!/^[a-z0-9_-]{1,40}$/.test(item.id) || !item.clientId || !item.clientSecret || !Array.isArray(item.scopes) || item.scopes.some((scope) => !/^[A-Za-z0-9_.:-]{1,120}$/.test(scope))) throw fail('官方 OAuth 配置不完整', 503);
    for (const key of ['authorizationUrl', 'tokenUrl', 'redirectUri']) httpsUrl(item[key]);
    if (item.revocationUrl) httpsUrl(item.revocationUrl);
    return item;
  });
}
export function authorizationStatus() {
  let encrypted = false; try { credentialKey(); encrypted = true; } catch { /* No insecure fallback. */ }
  return { providers: providers().map((item) => ({ id: item.id, name: item.name || item.id, scopes: item.scopes, configured: encrypted, revocationSupported: Boolean(item.revocationUrl) })), encryptedStorageAvailable: encrypted, liveWritesEnabled: false, erpScopes: ['tasks:read', 'products:read'] };
}
export function beginShopAuthorization(input, actor) {
  if (actor.role !== 'admin') throw fail('仅管理员可授权店铺', 403);
  if (input.confirm !== true) throw fail('请确认跳转平台官方授权并保存授权凭据');
  credentialKey();
  const provider = providers().find((item) => item.id === input.provider);
  if (!provider) throw fail('此平台尚未配置官方授权应用', 503);
  const state = randomToken(), verifier = randomBytes(32).toString('base64url');
  const db = platformDb();
  db.prepare('DELETE FROM oauth_pending WHERE expires_at<? OR user_id=?').run(Date.now(), actor.id);
  db.prepare('INSERT INTO oauth_pending VALUES (?,?,?,?,?,?)').run(tokenHash(state), actor.id, provider.id, encryptCredential(verifier), String(input.label || provider.name || provider.id).slice(0, 100), Date.now() + 10 * 60_000);
  const url = httpsUrl(provider.authorizationUrl);
  for (const [key, value] of Object.entries({ response_type: 'code', client_id: provider.clientId, redirect_uri: provider.redirectUri, scope: provider.scopes.join(' '), state, code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256' })) url.searchParams.set(key, value);
  audit(actor, 'shop.authorization-start', provider.id);
  return { authorizationUrl: url.toString(), expiresIn: 600 };
}
async function tokenRequest(url, parameters, fetchImpl) {
  const response = await fetchImpl(httpsUrl(url), { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(20000), headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(parameters).toString() });
  if (!response.ok) throw fail('平台授权接口拒绝请求，请检查应用配置或在平台重新授权', 502);
  const text = await response.text(); if (text.length > 65536) throw fail('授权响应超出限制', 502);
  try { return text ? JSON.parse(text) : {}; } catch { throw fail('平台授权响应不是有效 JSON', 502); }
}
export async function finishShopAuthorization(input, actor, fetchImpl = fetch) {
  if (actor.role !== 'admin') throw fail('仅管理员可完成授权', 403);
  const db = platformDb(), hash = tokenHash(input.state);
  const pending = db.prepare('SELECT * FROM oauth_pending WHERE state_hash=? AND user_id=? AND expires_at>?').get(hash, actor.id, Date.now());
  if (!pending) throw fail('授权请求已过期、已使用或不属于当前账号', 403);
  db.prepare('DELETE FROM oauth_pending WHERE state_hash=?').run(hash);
  if (input.error || typeof input.code !== 'string' || input.code.length > 4096 || !input.code) throw fail('平台授权已取消或返回码无效');
  const provider = providers().find((item) => item.id === pending.provider);
  if (!provider) throw fail('官方应用配置已移除', 409);
  const result = await tokenRequest(provider.tokenUrl, { grant_type: 'authorization_code', code: input.code, redirect_uri: provider.redirectUri, client_id: provider.clientId, client_secret: provider.clientSecret, code_verifier: decryptCredential(pending.verifier) }, fetchImpl);
  if (typeof result.access_token !== 'string' || !result.access_token || result.access_token.length > 16000) throw fail('平台未返回有效令牌，未记录授权成功', 502);
  const id = `shop-${randomBytes(12).toString('hex')}`, now = new Date().toISOString();
  const expiry = Number(result.expires_in);
  db.prepare('INSERT INTO shop_connections VALUES (?,?,?,?,?,?,?,?)').run(id, actor.id, provider.id, pending.label, encryptCredential(result), 1, now, Number.isFinite(expiry) && expiry > 0 ? Date.now() + Math.min(expiry, 366 * 86400) * 1000 : null);
  audit(actor, 'shop.authorized', id, 201, { provider: provider.id }); return { id, provider: provider.id, label: pending.label, active: true, liveWritesEnabled: false };
}
export function listShopConnections(actor) {
  if (actor.role !== 'admin') throw fail('仅管理员可查看店铺授权', 403);
  return platformDb().prepare('SELECT id,provider,label,active,created_at,expires_at FROM shop_connections ORDER BY created_at DESC').all();
}
export async function revokeShop(id, actor, fetchImpl = fetch) {
  if (actor.role !== 'admin') throw fail('仅管理员可撤销授权', 403);
  const db = platformDb(), row = db.prepare('SELECT * FROM shop_connections WHERE id=?').get(id);
  if (!row) throw fail('授权不存在', 404);
  // Local access is always stopped first, even when remote revocation is unavailable.
  db.prepare('UPDATE shop_connections SET active=0 WHERE id=?').run(id);
  const provider = providers().find((item) => item.id === row.provider);
  let remoteRevoked = false;
  if (row.encrypted_token && provider?.revocationUrl) {
    try {
      const token = decryptCredential(row.encrypted_token);
      await tokenRequest(provider.revocationUrl, { token: token.refresh_token || token.access_token, token_type_hint: token.refresh_token ? 'refresh_token' : 'access_token', client_id: provider.clientId, client_secret: provider.clientSecret }, fetchImpl);
      remoteRevoked = true;
    } catch { /* Keep encrypted token only to allow an explicit retry. */ }
  }
  if (remoteRevoked) db.prepare("UPDATE shop_connections SET encrypted_token='' WHERE id=?").run(id);
  audit(actor, 'shop.revoked', id, 200, { remoteRevoked });
  return { locallyRevoked: true, remoteRevoked, message: remoteRevoked ? '本地与平台授权均已撤销' : '本地授权已停用；平台撤销未确认，请到官方应用授权页移除，或重试撤销' };
}
export function createErpGrant(input, actor) {
  if (actor.role !== 'admin') throw fail('仅管理员可创建 ERP 授权', 403);
  if (input.confirm !== true) throw fail('请确认将选定摘要字段开放给持有授权码的 ERP');
  if (!Array.isArray(input.scopes) || !input.scopes.length || input.scopes.some((scope) => !['tasks:read', 'products:read'].includes(scope))) throw fail('ERP 只支持任务/商品摘要只读权限');
  const days = Number(input.days || 30); if (!Number.isInteger(days) || days < 1 || days > 90) throw fail('授权有效期为 1–90 天');
  const token = randomToken(), id = `erp-${randomBytes(12).toString('hex')}`, expiresAt = Date.now() + days * 86400_000;
  platformDb().prepare('INSERT INTO erp_grants VALUES (?,?,?,?,?,?,?,?,?)').run(id, actor.id, String(input.name || 'ERP').slice(0, 100), tokenHash(token), JSON.stringify([...new Set(input.scopes)]), 1, expiresAt, new Date().toISOString(), null);
  audit(actor, 'erp.created', id, 201, { scopes: input.scopes, expiresAt });
  return { id, token, expiresAt, warning: '授权码仅显示一次；只在授权 ERP 中保存，不写入本应用前端存储。' };
}
export function listErpGrants(actor) {
  if (actor.role !== 'admin') throw fail('仅管理员可查看 ERP 授权', 403);
  return platformDb().prepare('SELECT id,name,scopes,active,expires_at,created_at,last_used FROM erp_grants ORDER BY created_at DESC').all().map((row) => ({ ...row, scopes: JSON.parse(row.scopes) }));
}
export function revokeErpGrant(id, actor) {
  if (actor.role !== 'admin') throw fail('仅管理员可撤销 ERP 授权', 403);
  if (!platformDb().prepare('UPDATE erp_grants SET active=0 WHERE id=?').run(id).changes) throw fail('授权不存在', 404);
  audit(actor, 'erp.revoked', id); return { ok: true };
}
export function authorizeErp(token, scope) {
  const db = platformDb(), row = db.prepare('SELECT * FROM erp_grants WHERE token_hash=? AND active=1 AND expires_at>?').get(tokenHash(token), Date.now());
  if (!row || !JSON.parse(row.scopes).includes(scope)) throw fail('ERP 授权无效、已过期或无此权限', 403);
  if (row.owner_id !== 'local' && !db.prepare("SELECT id FROM members WHERE id=? AND active=1 AND role='admin'").get(row.owner_id)) throw fail('授权人已停用或不再具有管理员权限', 403);
  db.prepare('UPDATE erp_grants SET last_used=? WHERE id=?').run(new Date().toISOString(), row.id);
  audit({ id: row.owner_id, displayName: `ERP:${row.name}` }, 'erp.read', scope);
  return row;
}
export function erpProducts(query) {
  const page = Math.max(1, Math.floor(Number(query.page) || 1)), pageSize = Math.min(100, Math.max(1, Math.floor(Number(query.pageSize) || 30)));
  const db = platformDb(), total = db.prepare("SELECT COUNT(*) AS n FROM platform_records WHERE kind='product' AND deleted=0").get().n;
  return { page, pageSize, total, records: db.prepare("SELECT id,version,data,updated_at FROM platform_records WHERE kind='product' AND deleted=0 ORDER BY updated_at DESC,id LIMIT ? OFFSET ?").all(pageSize, (page - 1) * pageSize).map((row) => {
    const product = JSON.parse(row.data); return privateSafe({ id: row.id, version: row.version, sku: product.sku, title: product.title, price: product.price, currency: product.currency, stock: product.stock, updatedAt: row.updated_at });
  }) };
}
