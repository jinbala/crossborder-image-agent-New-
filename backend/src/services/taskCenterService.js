import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { setImmediate as yieldEventLoop } from 'node:timers/promises';
import { platformDb, pageOptions, meta, setMeta, privateSafe } from './platformStore.js';
import { paths, readDb } from './db.js';
import { claimResource, ownerSql, currentActor, restrictedActor } from './ownershipService.js';

export function normalizedState(status) {
  if (['completed_with_errors', 'partialSuccess', 'partial_failed'].includes(status)) return 'partial';
  if (['uploaded', 'new', 'created'].includes(status)) return 'draft';
  if (['recognized', 'confirmed', 'rules_selected', 'planned', 'waiting_confirm'].includes(status)) return 'waiting_user';
  if (['pending', 'waiting'].includes(status)) return 'queued';
  if (['generated', 'reviewed', 'exported', 'succeeded'].includes(status)) return 'completed';
  if (['recognizing', 'generating', 'reviewing', 'processing'].includes(status)) return 'running';
  return ['draft', 'queued', 'running', 'waiting_user', 'paused', 'completed', 'partial', 'failed', 'cancelled'].includes(status) ? status : 'draft';
}

export function indexTask(record, kind = record.type || 'image', { registerOwner = true, preferNewer = false } = {}) {
  if (!record?.id) return;
  const db = platformDb();
  if (registerOwner && currentActor()) claimResource(['image', 'batch'].includes(kind) ? kind : 'job', record.id);
  const state = normalizedState(record.queue?.status && record.queue.status !== 'idle' ? record.queue.status : record.status);
  const sku = record.productInfoConfirmed?.sku || record.productInfo?.sku || record.sku || '';
  const title = record.name || record.productInfoConfirmed?.name || record.productInfo?.name || record.options?.name || sku || record.id;
  const href = kind === 'batch' ? `/batches/${encodeURIComponent(record.id)}` : kind === 'image' ? `/tasks/${encodeURIComponent(record.id)}/product`
    : kind === 'collection-job' ? `/workbench/collection?jobId=${encodeURIComponent(record.id)}` : kind === 'commerce-sandbox' ? `/commerce-sandbox/${encodeURIComponent(record.id)}` : `/results/${encodeURIComponent(record.id)}`;
  const exportedPath = String(record.exportFile?.filePath || '').replaceAll('\\', '/');
  const summary = { ...(record.summary || {}), parentBatchId: record.batchId || null, downloadUrl: record.downloadUrl || (/^outputs\//.test(exportedPath) ? `/${exportedPath}` : null), sourceState: record.status,
    imageCount: record.generatedImages?.length || record.sourceImages?.length || 0,
    thumbnail: record.generatedImages?.[0]?.previewUrl || record.sourceImages?.[0]?.previewUrl || record.items?.[0]?.images?.[0]?.url || record.items?.find((item) => item.url)?.url || (record.skuResults?.[0]?.items?.find((item) => item.outputFile) ? `/outputs/workbench/${record.id}/package/${record.skuResults[0].items.find((item) => item.outputFile).outputFile.split('/').map(encodeURIComponent).join('/')}` : null) };
  db.prepare(`INSERT INTO task_index VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET kind=excluded.kind,state=excluded.state,sku=excluded.sku,title=excluded.title,href=excluded.href,summary=excluded.summary,updated_at=excluded.updated_at WHERE ?=0 OR excluded.updated_at>task_index.updated_at`).run(
    record.id, kind, state, String(sku), String(title).slice(0, 500), href, JSON.stringify(summary), record.createdAt || new Date().toISOString(), record.updatedAt || record.createdAt || new Date().toISOString(), Number(preferNewer));
}

let migration;
export function legacyIndexStatus() {
  const status = meta('legacy-index-status', { status: meta('task-index-migrated', false) ? 'completed' : 'pending', processed: 0, total: null, failed: 0 });
  return restrictedActor() ? { status: status.status, processed: 0, total: null, failed: 0 } : status;
}
export function waitForLegacyIndex() { return migration?.promise || Promise.resolve(); }
function startLegacyIndex() {
  if (migration && meta('legacy-index-generation') === migration.generation) return;
  const generation = randomUUID(), run = { generation, promise: null };
  migration = run;
  setMeta('legacy-index-generation', generation);
  setMeta('legacy-index-status', { status: 'running', processed: 0, total: null, failed: 0 });
  run.promise = (async () => {
    const root = path.join(paths.outputDir, 'workbench');
    const entries = (await fs.readdir(root, { withFileTypes: true }).catch(() => [])).filter((entry) => entry.isDirectory() && !/^sku-pack-.*-part-\d+$/.test(entry.name));
    const canonicalRoot = await fs.realpath(root).catch(() => null);
    let processed = 0, failed = 0;
    for (let offset = 0; offset < entries.length; offset += 16) {
      const records = await Promise.all(entries.slice(offset, offset + 16).map(async (entry) => {
        try {
          const file = await fs.realpath(path.join(root, entry.name, 'manifest.json'));
          const relative = path.relative(canonicalRoot, file);
          if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('OUTSIDE_WORKSPACE');
          const stat = await fs.stat(file); if (!stat.isFile() || stat.size > 128 * 1024 * 1024) throw new Error('MANIFEST_TOO_LARGE');
          const record = JSON.parse(await fs.readFile(file, 'utf8'));
          if (record.id !== entry.name || !/^[A-Za-z0-9_-]{1,220}$/.test(record.id)) throw new Error('MANIFEST_ID_MISMATCH');
          if (typeof record.type !== 'string' || !/^[a-z][a-z0-9-]{0,60}$/.test(record.type)) throw new Error('MANIFEST_TYPE_INVALID');
          if (typeof record.createdAt !== 'string' || Number.isNaN(Date.parse(record.createdAt))) record.createdAt = stat.mtime.toISOString();
          if (typeof record.updatedAt !== 'string' || Number.isNaN(Date.parse(record.updatedAt))) record.updatedAt = record.createdAt;
          return record;
        } catch { return null; }
      }));
      if (meta('legacy-index-generation') !== generation) return;
      platformDb().transaction(() => {
        for (const record of records) {
          if (!record) { failed++; continue; }
          try { indexTask(record, undefined, { registerOwner: false, preferNewer: true }); }
          catch (error) { if (String(error.code || '').startsWith('SQLITE_')) throw error; failed++; }
        }
        processed += records.length;
        setMeta('legacy-index-status', { status: 'running', processed, total: entries.length, failed });
      })();
      await yieldEventLoop();
    }
    if (meta('legacy-index-generation') !== generation) return;
    setMeta('task-index-migrated', true);
    setMeta('legacy-index-status', { status: 'completed', processed, total: entries.length, failed });
  })().catch(() => {
    if (meta('legacy-index-generation') === generation) setMeta('legacy-index-status', { ...meta('legacy-index-status', {}), status: 'failed', message: '旧任务索引未完成，请检查工作目录权限后由管理员重新扫描；原文件未修改。' });
  }).finally(() => { if (migration === run) migration = null; });
}
export async function rebuildLegacyIndex() {
  if (migration && meta('legacy-index-generation') === migration.generation) return { started: false, indexStatus: legacyIndexStatus() };
  setMeta('task-index-migrated', false);
  await refreshTaskIndex();
  return { started: true, indexStatus: legacyIndexStatus(), sourceFilesModified: false };
}
export async function refreshTaskIndex() {
  const revision = meta('core-index-revision', 0);
  if (meta('core-index-dirty', true) || meta('core-index-applied', -1) !== revision || meta('task-index-schema', 0) !== 2) {
    const core = await readDb();
    platformDb().transaction(() => {
      for (const task of core.tasks) indexTask(task, 'image', { registerOwner: false });
      for (const batch of core.batchTasks) indexTask(batch, 'batch', { registerOwner: false });
      platformDb().prepare("DELETE FROM task_index WHERE kind IN ('image','batch') AND id NOT IN (SELECT value FROM json_each(?))").run(JSON.stringify([...core.tasks, ...core.batchTasks].map((item) => item.id)));
      setMeta('core-index-dirty', false);
      setMeta('core-index-applied', revision);
      setMeta('task-index-schema', 2);
    })();
  }
  if (!meta('task-index-migrated', false)) startLegacyIndex();
}

export async function listTaskCenter(query = {}) {
  await refreshTaskIndex();
  const { page, pageSize } = pageOptions(query);
  const state = String(query.state || '');
  const kind = String(query.kind || '');
  const q = String(query.q || '').slice(0, 100);
  const sku = String(query.sku || '').slice(0, 120);
  const since = Number.isFinite(Date.parse(query.since)) ? new Date(query.since).toISOString() : '';
  const until = /^\d{4}-\d{2}-\d{2}$/.test(query.until || '') && Number.isFinite(Date.parse(query.until)) ? new Date(`${query.until}T23:59:59.999Z`).toISOString() : '';
  const scope = ownerSql();
  const clause = "WHERE (?='' OR state=?) AND (?='' OR kind=?) AND (?='' OR title LIKE ? OR sku LIKE ? OR id LIKE ?) AND (?='' OR created_at>=?) AND (?='' OR created_at<=?) AND (?='' OR sku=? COLLATE NOCASE)" + (query.hideArchived === true ? ' AND id NOT IN (SELECT task_id FROM space_archives)' : '') + ` AND ${scope.clause}`;
  const args = [state, state, kind, kind, q, `%${q}%`, `%${q}%`, `%${q}%`, since, since, until, until, sku, sku, ...scope.args];
  const db = platformDb();
  const total = db.prepare(`SELECT COUNT(*) AS n FROM task_index ${clause}`).get(...args).n;
  const records = db.prepare(`SELECT * FROM task_index ${clause} ORDER BY updated_at DESC, id LIMIT ? OFFSET ?`).all(...args, pageSize, (page - 1) * pageSize).map((row) => ({ ...row, summary: JSON.parse(row.summary) }));
  const counts = Object.fromEntries(db.prepare(`SELECT state,COUNT(*) AS n FROM task_index WHERE ${scope.clause} GROUP BY state`).all(...scope.args).map((row) => [row.state, row.n]));
  return { records, counts, indexStatus: legacyIndexStatus(), pagination: { page, pageSize, total, totalPages: Math.max(1, Math.ceil(total / pageSize)) } };
}

export async function taskMetadata() {
  await refreshTaskIndex();
  const scope = ownerSql();
  return platformDb().prepare(`SELECT * FROM task_index WHERE kind!='device-task' AND ${scope.clause} ORDER BY updated_at DESC LIMIT 10000`).all(...scope.args).map((row) => privateSafe({
    id: row.id, kind: row.kind, state: row.state, sku: row.sku, title: row.title,
    summary: Object.fromEntries(Object.entries(JSON.parse(row.summary)).filter(([, value]) => typeof value === 'number')),
    updatedAt: row.updated_at
  }));
}
