// Local simulator only. No URL, credential, network client or live adapter is accepted here.
import { createHash, randomBytes } from 'node:crypto';
import { setImmediate } from 'node:timers/promises';
import { platformDb, audit } from './platformStore.js';
import { workbenchJobDetail } from './workbenchService.js';
import { fail } from './accountService.js';
import { indexTask } from './taskCenterService.js';

const active = new Map();
const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function load(id, actor) {
  const row = platformDb().prepare("SELECT * FROM platform_records WHERE id=? AND kind='commerce-sandbox'").get(id);
  if (!row || (actor.role !== 'admin' && row.owner_id !== actor.id)) throw fail('沙箱任务不存在', 404);
  return { ...JSON.parse(row.data), version: row.version };
}
function save(job, actor) {
  const now = new Date().toISOString();
  job.updatedAt = now;
  const { version, ...data } = job;
  platformDb().prepare(`INSERT INTO platform_records VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data,version=version+1,updated_at=excluded.updated_at`)
    .run(job.id, 'commerce-sandbox', actor.id, 1, 0, JSON.stringify(data), job.createdAt, now);
  indexTask({ ...job, type: 'commerce-sandbox', status: job.state });
  return load(job.id, actor);
}
function summarize(job) {
  job.summary = Object.fromEntries(['success', 'failed', 'skipped', 'pending'].map((status) => [`${status}Count`, job.items.filter((item) => item.status === status).length]));
  job.summary.inputCount = job.items.length;
  job.summary.unprocessedCount = job.summary.pendingCount;
}
export function getCommerceSandbox(id, actor) { return load(id, actor); }
export async function createCommerceSandbox(input, actor) {
  if (input.mode !== 'local-sandbox' || input.confirm !== true) throw fail('必须明确选择本地模拟沙箱；真实店铺写入保持关闭');
  if (Object.keys(input).some((key) => /url|token|credential|endpoint|live/i.test(key))) throw fail('本地沙箱不接受远程地址或凭据');
  const source = await workbenchJobDetail(input.sourceId, { pageSize: 100 });
  if (!['listing-dry-run', 'pricing-preview'].includes(source.type)) throw fail('请先生成刊登或调价预览');
  const entries = [...source.entries];
  for (let page = 2; page <= source.pagination.totalPages; page++) entries.push(...(await workbenchJobDetail(input.sourceId, { page, pageSize: 100 })).entries);
  if (new Set(entries.map((item) => item.sku)).size !== entries.length) throw fail('存在重复 SKU，请在预览中消除重复后创建沙箱');
  const id = `sandbox-${randomBytes(12).toString('hex')}`, kind = source.type === 'pricing-preview' ? 'pricing' : 'listing';
  const items = entries.map((item, index) => ({ id: `${id}-${index}`, sku: item.sku, status: item.status === 'blocked' ? 'skipped' : 'pending',
    reason: item.status === 'blocked' ? '源预检未通过，不执行' : null, attempt: 0,
    before: kind === 'pricing' ? { price: item.originalPrice } : null,
    after: kind === 'pricing' ? { price: item.newPrice } : { title: item.title, price: item.price, stock: item.stock, mainImageRef: item.mainImageRef } }));
  const failures = Array.isArray(input.failOnceSkus) ? input.failOnceSkus.map(String).slice(0, 100) : [];
  const job = { id, kind, mode: 'local-sandbox', liveWritesEnabled: false, name: `本地沙箱：${source.name}`, sourceId: source.id, currency: source.currency || null,
    state: 'waiting_user', items, failOnceSkus: failures, createdAt: new Date().toISOString() };
  job.approvalHash = hash({ sourceId: job.sourceId, kind, items: items.map(({ sku, before, after }) => ({ sku, before, after })) });
  summarize(job); const saved = save(job, actor); audit(actor, 'sandbox.create', id, 201, { sourceId: source.id, kind, liveWrites: false }); return saved;
}
export async function runCommerceSandbox(id, input, actor, execution = {}) {
  let job = load(id, actor);
  if (input.confirm !== true || input.approvalHash !== job.approvalHash) throw fail('请确认当前差异和审批散列，不能复用其他预览的批准');
  if (active.has(id)) throw fail('沙箱任务正在执行', 409);
  const control = { stop: null }; active.set(id, control);
  try {
    if (input.retryFailed === true) for (const item of job.items) if (item.status === 'failed') item.status = 'pending';
    job.state = 'running'; job = save(job, actor);
    for (const item of job.items) {
      if (control.stop) break;
      if (item.status !== 'pending') continue;
      // Simulated store commit and idempotency receipt share the same SQLite transaction.
      platformDb().transaction(() => {
        const receiptId = `receipt-${item.id}`, receipt = platformDb().prepare("SELECT id FROM platform_records WHERE id=? AND kind='sandbox-receipt'").get(receiptId);
        item.attempt++;
        if (receipt) { item.status = 'success'; item.receiptId = receiptId; item.reason = null; }
        else if (job.failOnceSkus.includes(item.sku) && item.attempt === 1) { item.status = 'failed'; item.reason = 'SIMULATED_TRANSIENT_ERROR：模拟失败，可单独重试'; }
        else {
          const now = new Date().toISOString(), storeId = `sandbox-store-${hash([job.id, item.sku])}`;
          platformDb().prepare('INSERT OR REPLACE INTO platform_records VALUES (?,?,?,?,?,?,?,?)').run(storeId, 'sandbox-store', actor.id, 1, 0, JSON.stringify({ sku: item.sku, ...item.after, simulated: true }), now, now);
          platformDb().prepare('INSERT INTO platform_records VALUES (?,?,?,?,?,?,?,?)').run(receiptId, 'sandbox-receipt', actor.id, 1, 0, JSON.stringify({ jobId: id, sku: item.sku, approvalHash: job.approvalHash }), now, now);
          item.status = 'success'; item.receiptId = receiptId; item.reason = null;
        }
        summarize(job); save(job, actor); audit(actor, 'sandbox.item', item.id, item.status === 'success' ? 200 : 503, { sku: item.sku, attempt: item.attempt, simulated: true });
      })();
      if (execution.afterItem) await execution.afterItem({ jobId: id, item });
      await setImmediate();
    }
    job.state = control.stop || (job.summary.failedCount ? (job.summary.successCount ? 'partial' : 'failed') : 'completed');
    summarize(job); return save(job, actor);
  } catch (error) {
    job.state = 'paused'; summarize(job); save(job, actor); throw error;
  } finally { active.delete(id); }
}
export function stopCommerceSandbox(id, input, actor) {
  const job = load(id, actor);
  if (!['pause', 'cancel'].includes(input.action) || input.confirm !== true) throw fail('请确认暂停或取消沙箱任务');
  const state = input.action === 'cancel' ? 'cancelled' : 'paused';
  if (active.has(id)) { active.get(id).stop = state; return { requested: true, state, boundary: 'item' }; }
  job.state = state; summarize(job); return save(job, actor);
}
