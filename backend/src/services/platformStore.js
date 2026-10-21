import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { paths } from './dbPaths.js';
import { assertNoCollectionCreation } from './workspaceLifecycle.js';

let connection;
export function platformDb() {
  if (connection) return connection;
  fs.mkdirSync(paths.dataDir, { recursive: true });
  connection = new Database(path.join(paths.dataDir, 'platform.sqlite'));
  connection.pragma('journal_mode = WAL');
  connection.pragma('foreign_keys = ON');
  connection.exec(`
    CREATE TABLE IF NOT EXISTS platform_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS members (
      id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE COLLATE NOCASE,
      display_name TEXT NOT NULL, password_hash TEXT NOT NULL, salt TEXT NOT NULL,
      role TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1,
      agreement_version TEXT NOT NULL, agreed_at TEXT NOT NULL,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES members(id),
      csrf TEXT NOT NULL, expires_at INTEGER NOT NULL, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS audit_events (
      seq INTEGER PRIMARY KEY AUTOINCREMENT, actor_id TEXT, actor_name TEXT,
      action TEXT NOT NULL, target TEXT, status INTEGER, details TEXT, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS platform_records (
      id TEXT PRIMARY KEY, kind TEXT NOT NULL, owner_id TEXT NOT NULL,
      version INTEGER NOT NULL, deleted INTEGER NOT NULL DEFAULT 0,
      data TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS records_kind_updated ON platform_records(kind, deleted, updated_at DESC);
    CREATE TABLE IF NOT EXISTS record_revisions (record_id TEXT NOT NULL, version INTEGER NOT NULL, data TEXT NOT NULL, actor_id TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(record_id,version));
    CREATE TABLE IF NOT EXISTS task_index (
      id TEXT PRIMARY KEY, kind TEXT NOT NULL, state TEXT NOT NULL,
      sku TEXT, title TEXT, href TEXT, summary TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS task_index_state_updated ON task_index(state, updated_at DESC);
    CREATE TABLE IF NOT EXISTS space_archives (task_id TEXT PRIMARY KEY, actor_id TEXT NOT NULL, archived_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS resource_owners (kind TEXT NOT NULL,resource_id TEXT NOT NULL,owner_id TEXT NOT NULL,created_at TEXT NOT NULL,PRIMARY KEY(kind,resource_id));
    CREATE INDEX IF NOT EXISTS resource_owner_lookup ON resource_owners(owner_id,resource_id);
    CREATE TABLE IF NOT EXISTS resource_assets (asset_path TEXT PRIMARY KEY,kind TEXT NOT NULL,resource_id TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS collection_requests (
      owner_id TEXT NOT NULL, request_hash TEXT NOT NULL, payload_hash TEXT NOT NULL,
      job_id TEXT NOT NULL UNIQUE, state TEXT NOT NULL CHECK(state IN ('prepared','ready')),
      initial_manifest TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(owner_id,request_hash)
    );
    CREATE TABLE IF NOT EXISTS collection_drafts (
      owner_id TEXT PRIMARY KEY, generation TEXT NOT NULL, draft_id TEXT UNIQUE,
      payload TEXT, job_id TEXT, created_at TEXT
    );
    CREATE TABLE IF NOT EXISTS acceptance_workspaces (
      owner_id TEXT PRIMARY KEY, generation TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 0,
      payload TEXT, request_id TEXT, request_hash TEXT, updated_at TEXT
    );
    CREATE TABLE IF NOT EXISTS device_codes (
      code_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, expires_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS devices (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES members(id), name TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE, active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL, last_seen TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sync_receipts (
      device_id TEXT NOT NULL, operation_id TEXT NOT NULL, result TEXT NOT NULL,
      PRIMARY KEY(device_id, operation_id)
    );
    CREATE TABLE IF NOT EXISTS oauth_pending (state_hash TEXT PRIMARY KEY,user_id TEXT NOT NULL,provider TEXT NOT NULL,verifier TEXT NOT NULL,label TEXT NOT NULL,expires_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS shop_connections (id TEXT PRIMARY KEY,owner_id TEXT NOT NULL,provider TEXT NOT NULL,label TEXT NOT NULL,encrypted_token TEXT NOT NULL,active INTEGER NOT NULL,created_at TEXT NOT NULL,expires_at INTEGER);
    CREATE TABLE IF NOT EXISTS erp_grants (id TEXT PRIMARY KEY,owner_id TEXT NOT NULL,name TEXT NOT NULL,token_hash TEXT NOT NULL UNIQUE,scopes TEXT NOT NULL,active INTEGER NOT NULL,expires_at INTEGER NOT NULL,created_at TEXT NOT NULL,last_used TEXT);
  `);
  return connection;
}

const backupTables = ['platform_meta', 'members', 'sessions', 'audit_events', 'platform_records', 'record_revisions', 'task_index', 'space_archives', 'resource_owners', 'resource_assets', 'device_codes', 'devices', 'sync_receipts', 'oauth_pending', 'shop_connections', 'erp_grants', 'collection_requests', 'collection_drafts', 'acceptance_workspaces'];
export function platformBackup() { return platformDb().serialize(); }
export function restorePlatformBackup(sourcePath) {
  assertNoCollectionCreation();
  const stat = fs.statSync(sourcePath);
  if (!stat.isFile() || stat.size > 256 * 1024 * 1024) throw new Error('工作空间备份大小无效');
  const source = new Database(sourcePath, { readonly: true, fileMustExist: true });
  try {
    if (source.pragma('quick_check', { simple: true }) !== 'ok') throw new Error('工作空间备份完整性检查失败');
    const target = platformDb();
    const tables = new Set(source.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((row) => row.name));
    if (!['members', 'platform_records', 'platform_meta'].every((name) => tables.has(name))) throw new Error('不是有效的工作空间备份');
    const imported = backupTables.filter((table) => tables.has(table)).map((table) => {
      const columns = target.prepare(`PRAGMA table_info(${table})`).all().map((column) => column.name);
      const count = source.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
      if (count > 250000) throw new Error('工作空间备份记录数超出安全限制');
      return { table, columns, rows: source.prepare(`SELECT ${columns.join(',')} FROM ${table}`).all() };
    });
    target.transaction(() => {
      for (const table of [...backupTables].reverse()) target.prepare(`DELETE FROM ${table}`).run();
      for (const { table, columns, rows } of imported) {
        const statement = target.prepare(`INSERT INTO ${table} (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`);
        for (const row of rows) statement.run(...columns.map((column) => row[column]));
      }
      for (const table of ['sessions', 'device_codes', 'oauth_pending']) target.prepare(`DELETE FROM ${table}`).run();
      for (const table of ['devices', 'erp_grants', 'shop_connections']) target.prepare(`UPDATE ${table} SET active=0`).run();
      setMeta('core-index-dirty', true);
      setMeta('legacy-index-generation', null); // Cancel any in-flight pre-restore scan before it can publish stale rows.
      setMeta('collection-creation-epoch', randomUUID()); // Missing pre-restore requests must not silently create replacements.
      target.prepare('UPDATE collection_drafts SET generation=?').run(randomUUID()); // In-flight pre-restore form submissions cannot create a new draft.
      for (const row of target.prepare('SELECT owner_id FROM acceptance_workspaces').all()) target.prepare('UPDATE acceptance_workspaces SET generation=?,request_id=NULL,request_hash=NULL WHERE owner_id=?').run(randomUUID(), row.owner_id);
    })();
    return { restored: true, sessionsRevoked: true, deviceAndShopGrantsDisabled: true };
  } finally { source.close(); }
}

export function meta(key, fallback = null) {
  const value = platformDb().prepare('SELECT value FROM platform_meta WHERE key=?').get(key)?.value;
  return value === undefined ? fallback : JSON.parse(value);
}
export function setMeta(key, value) {
  platformDb().prepare('INSERT INTO platform_meta(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, JSON.stringify(value));
}
export function collectionCreationEpoch() {
  return platformDb().transaction(() => {
    let epoch = meta('collection-creation-epoch');
    if (!epoch) { epoch = randomUUID(); setMeta('collection-creation-epoch', epoch); }
    return epoch;
  }).immediate();
}

export function pageOptions(query = {}) {
  return { page: Math.max(1, Math.floor(Number(query.page) || 1)), pageSize: Math.max(1, Math.min(100, Math.floor(Number(query.pageSize) || 30))) };
}

export function privateSafe(value) {
  if (typeof value === 'string') return value
    .replace(/\b(?:Bearer|Basic)\s+[^\s,;"']+/gi, '[凭据已隐藏]')
    .replace(/(?<![A-Za-z0-9])[A-Z]:[\\/][^"'<>\r\n|;]*/gi, '[本地路径]')
    .replace(/\/(?:Users|home|tmp|var|mnt)\/[^\s"'<>]+/g, '[本地路径]')
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[邮箱]')
    .replace(/\b1[3-9]\d{9}\b/g, '[手机号]');
  if (Array.isArray(value)) return value.map(privateSafe);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !/password|cookie|authorization|token|secret|api.?key|local.?path|file.?path|root.?dir|folder.?path/i.test(key))
    .map(([key, item]) => [key, privateSafe(item)]));
  return value;
}

export function audit(actor, action, target = '', status = 200, details = {}) {
  const db = platformDb();
  db.prepare('INSERT INTO audit_events(actor_id,actor_name,action,target,status,details,created_at) VALUES (?,?,?,?,?,?,?)').run(
    actor?.id || 'local', actor?.displayName || '本地工作空间', action, privateSafe(String(target).slice(0, 300)), status,
    JSON.stringify(privateSafe(details)), new Date().toISOString());
  // Bounded retention prevents a busy workstation from growing logs indefinitely.
  db.prepare('DELETE FROM audit_events WHERE seq < (SELECT MAX(seq)-100000 FROM audit_events)').run();
}

export function listAudit(query = {}) {
  const { page, pageSize } = pageOptions(query);
  const search = String(query.q || '').slice(0, 100);
  const where = 'WHERE (?=\'\' OR action LIKE ? OR target LIKE ? OR actor_name LIKE ?) AND (?=\'\' OR actor_id=?)';
  const args = [search, `%${search}%`, `%${search}%`, `%${search}%`, query.actorId || '', query.actorId || ''];
  const total = platformDb().prepare(`SELECT COUNT(*) AS n FROM audit_events ${where}`).get(...args).n;
  const records = platformDb().prepare(`SELECT * FROM audit_events ${where} ORDER BY seq DESC LIMIT ? OFFSET ?`).all(...args, pageSize, (page - 1) * pageSize)
    .map((row) => ({ ...row, details: JSON.parse(row.details) }));
  return { records, pagination: { page, pageSize, total, totalPages: Math.max(1, Math.ceil(total / pageSize)) } };
}
