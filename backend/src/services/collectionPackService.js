import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { nanoid } from 'nanoid';
import sharp from 'sharp';
import { paths } from './dbPaths.js';
import { getCollectionJob } from './collectionJobService.js';
import { createSkuPack, normalizeSkuPackOptions } from './skuPackService.js';
import { platformDb, collectionCreationEpoch } from './platformStore.js';
import { currentActor, assertResource, claimResource } from './ownershipService.js';
import { fingerprintCollectionRequest as fingerprint } from './collectionRequestService.js';
import { beginCollectionCreation } from './workspaceLifecycle.js';

const inflight = new Map();
const fail = (message, code = 'COLLECTION_PACK_INVALID', statusCode = 409) => Object.assign(new Error(message), { code, statusCode });
const contained = (root, file) => { const relative = path.relative(root, file); return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative); };
const root = path.join(paths.outputDir, 'workbench');
const safeId = id => { if (typeof id !== 'string' || !/^collect-job-[A-Za-z0-9_-]+$/.test(id)) throw fail('采集任务 ID 无效', 'COLLECTION_PACK_INVALID', 400); return id; };
const actorId = () => currentActor()?.id || 'local';

async function sourceDirectory(id) {
  assertResource('job', id); safeId(id);
  const workspace = await fs.realpath(paths.rootDir);
  const directory = path.join(root, id);
  for (const candidate of [root, directory, path.join(directory, 'images')]) {
    const stat = await fs.lstat(candidate).catch(() => null);
    if (!stat?.isDirectory() || stat.isSymbolicLink() || !contained(workspace, await fs.realpath(candidate))) throw fail('采集图片目录缺失或越界，请核对原任务', 'COLLECTION_PACK_PATH');
  }
  for (const name of ['manifest.json', 'manifest.backup.json']) {
    const stat = await fs.lstat(path.join(directory, name)).catch(() => null);
    if (stat && (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16 * 1024 * 1024)) throw fail('采集清单路径或大小无效', 'COLLECTION_PACK_PATH');
  }
  return directory;
}

async function inspectSource(id) {
  const epoch = collectionCreationEpoch(), directory = await sourceDirectory(id);
  const job = await getCollectionJob(id);
  if (job.id !== id || job.type !== 'collection-job' || !Array.isArray(job.items)) throw fail('采集清单身份无效');
  const images = job.items.flatMap(item => (item.images || []).filter(image => image.status === 'success').map(image => ({ item, image })));
  if (!images.length) throw fail('任务没有已下载图片，请先完成回传或下载');
  if (images.length > 300) throw fail('单次图包最多 300 张，请下载 ZIP 后拆分文件夹处理；未截断或自动丢弃图片', 'COLLECTION_PACK_LIMIT', 400);
  const inputs = [], seen = new Set(); let bytes = 0;
  for (const { item, image } of images) {
    const relative = image.file;
    if (typeof relative !== 'string' || !relative || /[\\:\u0000-\u001f]/.test(relative) || path.posix.isAbsolute(relative) || relative.split('/').some(part => !part || part === '.' || part === '..')) throw fail('图片相对路径无效', 'COLLECTION_PACK_PATH');
    const key = relative.toLowerCase();
    if (seen.has(key)) throw fail('来源图片路径重复，请核对原任务', 'COLLECTION_PACK_PATH');
    seen.add(key);
    const file = path.join(directory, 'images', ...relative.split('/'));
    let parent = path.join(directory, 'images');
    for (const part of relative.split('/')) {
      parent = path.join(parent, part);
      const stat = await fs.lstat(parent).catch(() => null);
      if (!stat || stat.isSymbolicLink() || !contained(path.join(directory, 'images'), await fs.realpath(parent))) throw fail('图片缺失或路径越界，请重新检查采集结果', 'COLLECTION_PACK_PATH');
    }
    const stat = await fs.stat(file);
    if (!stat.isFile() || stat.size < 1 || stat.size > 15 * 1024 * 1024) throw fail('图片为空或超过单张 15MB 图包限制', 'COLLECTION_PACK_LIMIT', 400);
    bytes += stat.size;
    if (bytes > 500 * 1024 * 1024) throw fail('图片总大小超过 500MB，请拆分处理', 'COLLECTION_PACK_LIMIT', 400);
    const buffer = await fs.readFile(file);
    const sha256 = createHash('sha256').update(buffer).digest('hex');
    if (image.sha256 && image.sha256 !== sha256) throw fail('图片散列与采集清单不符，请重新检查来源', 'COLLECTION_SOURCE_CHANGED');
    try {
      const metadata = await sharp(buffer, { failOn: 'warning' }).metadata();
      if (!['jpeg', 'png', 'webp'].includes(metadata.format)) throw new Error('unsupported');
      await sharp(buffer, { failOn: 'warning' }).stats();
    } catch { throw fail('来源含损坏或不支持的图片；图包仅接受 JPG、PNG、WebP，请下载原包人工检查', 'COLLECTION_PACK_IMAGE'); }
    inputs.push({ itemId: item.id, sku: item.sku, title: item.title || '', relativePath: relative, sha256, size: stat.size, path: file });
  }
  assertResource('job', id);
  if (epoch !== collectionCreationEpoch()) throw fail('工作空间已变化，请重新预检', 'COLLECTION_PACK_CHANGED');
  const source = { type: 'collection-job', jobId: id, name: job.name, status: job.status, updatedAt: job.updatedAt, images: inputs.map(({ path: _path, ...image }) => image) };
  const previewHash = fingerprint({ epoch, actorId: actorId(), source });
  return { job, source, inputs, previewHash, epoch, bytes };
}

export async function previewCollectionPack(jobId) {
  const data = await inspectSource(jobId);
  return {
    jobId, name: data.job.name, status: data.job.status, previewHash: data.previewHash,
    imageCount: data.inputs.length, skuCount: new Set(data.inputs.map(image => image.relativePath.split('/')[0])).size, bytes: data.bytes,
    partial: Boolean(data.job.summary?.pendingCount || data.job.summary?.failedCount || data.job.summary?.warningCount || data.job.summary?.imageFailedCount),
    images: data.source.images,
    metadata: Object.fromEntries(data.inputs.map(image => [image.relativePath.split('/')[0], { title: image.title }]))
  };
}

export async function createCollectionPack(jobId, raw = {}, deps = {}) {
  safeId(jobId); assertResource('job', jobId);
  if (currentActor() && !['admin', 'operator', 'designer'].includes(currentActor().role)) throw fail('当前角色不能创建图包', 'COLLECTION_PACK_FORBIDDEN', 403);
  if (raw.confirm !== true || typeof raw.previewHash !== 'string' || !/^[a-f0-9]{64}$/.test(raw.previewHash)) throw fail('请先预检并明确确认生成图包', 'COLLECTION_PACK_CONFIRM', 400);
  const options = normalizeSkuPackOptions(raw.options);
  if (options.matteImages && ['external', 'image2'].includes(options.mattingProvider) && raw.options?.confirmPaidMatting !== true) throw fail('外部抠图需要本次任务的明确费用确认', 'COLLECTION_PACK_CONFIRM', 400);
  const owner = actorId(), payloadHash = fingerprint({ pipeline: 1, jobId, previewHash: raw.previewHash, options, confirmPartial: raw.confirmPartial === true });
  const release = beginCollectionCreation();
  try {
    async function savedResult(record) {
      if (!/^sku-pack-[A-Za-z0-9_-]+$/.test(record.job_id || '')) throw fail('原图包回执身份无效', 'COLLECTION_PACK_RECEIPT');
      assertResource('job', record.job_id);
      const missing = () => {
        // Legacy receipts without a stage are treated as already published.
        // Never rerun possibly billable work because its result was removed.
        if (JSON.parse(record.source_json)._transferStatus !== 'prepared') throw fail('原图包结果缺失，请从任务中心检查备份；不会自动重新处理或计费', 'COLLECTION_PACK_FILES_MISSING');
        return null;
      };
      const directory = path.join(root, record.job_id), workspace = await fs.realpath(paths.rootDir);
      const stat = await fs.lstat(directory).catch(error => { if (error.code !== 'ENOENT') throw error; return null; });
      if (!stat) return missing();
      if (!stat.isDirectory() || stat.isSymbolicLink() || !contained(workspace, await fs.realpath(directory))) throw fail('原图包目录越界', 'COLLECTION_PACK_RECEIPT');
      const file = path.join(directory, 'manifest.json'), fileStat = await fs.lstat(file).catch(error => { if (error.code !== 'ENOENT') throw error; return null; });
      if (!fileStat) return missing();
      if (!fileStat.isFile() || fileStat.isSymbolicLink() || fileStat.size > 16 * 1024 * 1024) throw fail('原图包清单路径无效', 'COLLECTION_PACK_RECEIPT');
      const saved = await fs.readFile(file, 'utf8').then(JSON.parse).catch(() => { throw fail('原图包清单损坏，请从任务中心检查；不会另建图包', 'COLLECTION_PACK_RECEIPT'); });
      if (saved && (saved.id !== record.job_id || saved.type !== 'sku-pack' || saved.source?.jobId !== jobId || saved.source?.previewHash !== raw.previewHash)) throw fail('原图包回执不一致，请检查任务中心', 'COLLECTION_PACK_RECEIPT');
      return saved ? { ...saved, transfer: { replayed: true, sourceJobId: jobId } } : null;
    }
    let receipt = platformDb().prepare('SELECT * FROM collection_pack_transfers WHERE owner_id=? AND payload_hash=?').get(owner, payloadHash);
    if (receipt) {
      assertResource('job', receipt.job_id);
      if (inflight.has(receipt.job_id)) { const result = await inflight.get(receipt.job_id); assertResource('job', receipt.job_id); return result; }
      const saved = await savedResult(receipt);
      if (saved) return saved;
    }
    const data = await inspectSource(jobId);
    if (data.previewHash !== raw.previewHash) throw fail('来源图片或工作空间已变化，请重新预检；未创建新图包', 'COLLECTION_SOURCE_CHANGED');
    const partial = Boolean(data.job.summary?.pendingCount || data.job.summary?.failedCount || data.job.summary?.warningCount || data.job.summary?.imageFailedCount);
    if (partial && raw.confirmPartial !== true) throw fail('采集尚未全部成功，请明确确认仅处理已收到的图片', 'COLLECTION_PACK_PARTIAL', 400);
    receipt = platformDb().transaction(() => {
      const existing = platformDb().prepare('SELECT * FROM collection_pack_transfers WHERE owner_id=? AND payload_hash=?').get(owner, payloadHash);
      if (existing) { assertResource('job', existing.job_id); return existing; }
      const id = `sku-pack-${Date.now()}-${nanoid(8)}`, source = { ...data.source, previewHash: data.previewHash, _transferStatus: 'prepared' };
      claimResource('job', id);
      platformDb().prepare('INSERT INTO collection_pack_transfers VALUES (?,?,?,?,?,?)').run(owner, payloadHash, jobId, id, JSON.stringify(source), new Date().toISOString());
      return { job_id: id, source_json: JSON.stringify(source) };
    }).immediate();
    if (!inflight.has(receipt.job_id)) {
      // Another caller may have completed while this caller checked the source.
      // Recheck the durable result after reservation, not only at request entry.
      const saved = await savedResult(receipt);
      if (saved) return saved;
    }
    if (!inflight.has(receipt.job_id)) {
      const pending = (async () => {
        if (deps.beforeCopy) await deps.beforeCopy(data);
        assertResource('job', jobId); assertResource('job', receipt.job_id);
        const { _transferStatus, ...source } = JSON.parse(receipt.source_json);
        const result = await createSkuPack(data.inputs.map(image => ({ path: image.path, originalname: path.basename(image.relativePath), size: image.size })), data.inputs.map(image => image.relativePath), options, { ...(deps.execution || {}), preparedId: receipt.job_id, source, inputHashes: data.inputs.map(image => image.sha256), afterPrepared: async info => {
          platformDb().prepare("UPDATE collection_pack_transfers SET source_json=json_set(source_json,'$._transferStatus','published') WHERE job_id=?").run(receipt.job_id);
          if (deps.execution?.afterPrepared) await deps.execution.afterPrepared(info);
        } });
        return { ...result, transfer: { replayed: false, sourceJobId: jobId } };
      })();
      inflight.set(receipt.job_id, pending);
      pending.finally(() => { if (inflight.get(receipt.job_id) === pending) inflight.delete(receipt.job_id); }).catch(() => {});
    }
    const result = await inflight.get(receipt.job_id);
    assertResource('job', receipt.job_id);
    return result;
  } finally { release(); }
}
