import fs from 'node:fs/promises';
import path from 'node:path';
import AdmZip from 'adm-zip';
import zipUtils from 'adm-zip/util/index.js';
import { createHash } from 'node:crypto';
import { paths } from './dbPaths.js';
import { assertResource } from './ownershipService.js';

const ROOT = path.join(paths.outputDir, 'workbench');
const MAX_MANIFEST = 128 * 1024 * 1024;
const fail = (message, code = 'SKU_STATE_INVALID', statusCode = 409) => Object.assign(new Error(message), { code, statusCode });
const samePath = (a, b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
export const skuStateHash = bytes => createHash('sha256').update(bytes).digest('hex');
export const checkpointRevision = state => Number.isSafeInteger(state?.checkpointRevision) && state.checkpointRevision >= 0 ? state.checkpointRevision : 0;

export async function skuPackDirectory(id) {
  if (!/^sku-pack-[A-Za-z0-9_-]+$/.test(id)) throw fail('图包任务 ID 无效', 'SKU_STATE_ID', 400);
  assertResource('job', id); // Check ownership before probing any files.
  const directory = path.join(ROOT, id);
  let stat, real, root;
  try { stat = await fs.lstat(directory); real = await fs.realpath(directory); root = await fs.realpath(ROOT); }
  catch (error) { throw fail(error.code === 'ENOENT' ? '任务目录不存在，请检查备份' : '任务目录无法读取，请检查权限', 'SKU_STATE_DIRECTORY', error.code === 'ENOENT' ? 404 : 403); }
  if (!stat.isDirectory() || stat.isSymbolicLink() || !samePath(real, path.join(root, id))) throw fail('图包目录越界或为链接，未读取恢复点', 'SKU_STATE_PATH', 403);
  return directory;
}

async function safeFile(directory, name, maxBytes) {
  try {
    const file = path.join(directory, name), stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || !samePath(await fs.realpath(file), path.join(await fs.realpath(directory), name))) throw fail('清单或结果包不是任务目录中的普通文件', 'SKU_STATE_PATH', 403);
    if (maxBytes !== undefined && stat.size > maxBytes) throw fail('清单超过读取上限，请人工检查备份', 'SKU_STATE_SIZE');
    return await fs.readFile(file);
  } catch (error) {
    if (error.code === 'ENOENT' || String(error.code || '').startsWith('SKU_')) throw error;
    throw fail('任务文件无法读取，请检查权限或占用；未尝试越权路径', 'SKU_STATE_FILE', 403);
  }
}

function parseState(bytes, id) {
  const state = JSON.parse(bytes.toString('utf8'));
  if (!state || state.id !== id || state.type !== 'sku-pack') throw fail('图包清单身份不匹配，未尝试其他任务的恢复点', 'SKU_STATE_IDENTITY');
  if (!Array.isArray(state.skuResults) || state.skuResults.some(group => !group || !Array.isArray(group.items)) || !state.summary || typeof state.summary !== 'object' || Array.isArray(state.summary)) throw fail('图包清单结构无效，请检查备份', 'SKU_STATE_SCHEMA');
  if ((state.downloadUrl && (typeof state.downloadUrl !== 'string' || !new RegExp(`^/outputs/workbench/${id}/${id}(?:-archive-\\d+-[A-Za-z0-9_-]+)?\\.zip$`).test(state.downloadUrl))) || (state.manifestUrl && state.manifestUrl !== `/outputs/workbench/${id}/manifest.json`)) throw fail('图包清单中的下载路径无效，未打开外部地址', 'SKU_STATE_PATH', 403);
  return state;
}

export async function publishedArchives(directory, id) {
  const version = new RegExp(`^${id}-archive-(\\d+)-[A-Za-z0-9_-]+\\.zip$`);
  return (await fs.readdir(directory)).flatMap(name => {
    if (name === `${id}.zip`) return [{ name, generation: 0 }];
    const match = name.match(version), generation = Number(match?.[1]);
    return match && Number.isSafeInteger(generation) ? [{ name, generation }] : [];
  }).sort((a, b) => b.generation - a.generation || b.name.localeCompare(a.name));
}

function newerCheckpoint(candidate, archived) {
  if (checkpointRevision(candidate) || checkpointRevision(archived)) return checkpointRevision(candidate) > checkpointRevision(archived);
  const a = Date.parse(candidate.updatedAt), b = Date.parse(archived.updatedAt);
  return Number.isFinite(a) && Number.isFinite(b) && a > b;
}

export async function readSkuPackSnapshot(id) {
  const directory = await skuPackDirectory(id);
  let primaryBytes = null, reason;
  try {
    primaryBytes = await safeFile(directory, 'manifest.json', MAX_MANIFEST);
    const state = parseState(primaryBytes, id);
    return { state, bytes: primaryBytes, source: 'primary', sourceName: 'manifest.json', sourceHash: skuStateHash(primaryBytes), primaryHash: skuStateHash(primaryBytes), primaryBytes };
  } catch (error) {
    if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
    reason = error.code === 'ENOENT' ? 'missing' : 'invalid-json';
  }
  const latest = (await publishedArchives(directory, id))[0];
  let chosen;
  if (latest) {
    try {
      const archive = new AdmZip(await safeFile(directory, latest.name));
      const matches = archive.getEntries().filter(entry => entry.entryName === 'manifest.json');
      const entry = matches[0];
      if (matches.length !== 1 || !entry || entry.isDirectory || entry.header.size > MAX_MANIFEST || entry.header.compressedSize > MAX_MANIFEST || entry.header.encrypted) throw fail('结果包清单无效');
      const bytes = await new Promise((resolve, reject) => entry.getDataAsync((data, error) => error ? reject(error) : resolve(data)));
      if (bytes.length > MAX_MANIFEST || bytes.length !== entry.header.size || zipUtils.crc32(bytes) !== entry.header.crc) throw fail('结果包清单大小或校验值无效');
      chosen = { state: parseState(bytes, id), bytes, source: 'archive', sourceName: latest.name, archiveGeneration: latest.generation };
    } catch (error) {
      if (error.code === 'SKU_STATE_PATH') throw error;
      throw fail('最新结果包损坏或不可读取，请检查该包和备份；未回退旧版本或启动处理', 'SKU_ARCHIVE_INVALID');
    }
  }
  try {
    const bytes = await safeFile(directory, 'manifest.json.backup', MAX_MANIFEST), state = parseState(bytes, id);
    if (!chosen || newerCheckpoint(state, chosen.state)) chosen = { state, bytes, source: 'backup', sourceName: 'manifest.json.backup' };
  } catch (error) {
    if (error.code === 'SKU_STATE_PATH' || error.code === 'SKU_STATE_IDENTITY' || error.code === 'SKU_STATE_FILE') throw error;
    if (!chosen) throw fail('主清单和可用恢复点均缺失或损坏，请保留输出并检查备份；未启动处理', 'SKU_STATE_UNAVAILABLE');
  }
  return { ...chosen, reason, primaryBytes, primaryHash: primaryBytes ? skuStateHash(primaryBytes) : null, sourceHash: skuStateHash(chosen.bytes) };
}

export async function readSkuPackState(id) { return (await readSkuPackSnapshot(id)).state; }
