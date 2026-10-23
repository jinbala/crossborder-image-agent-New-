import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import AdmZip from 'adm-zip';
import zipUtils from 'adm-zip/util/index.js';
import { paths } from './dbPaths.js';
import { assertResource } from './ownershipService.js';
import { atomicRename } from '../utils/atomicRename.js';

const ROOT = path.join(paths.outputDir, 'workbench');
const LIMIT = 128 * 1024 * 1024;
const TYPES = new Map([
  ['collect-job-', ['collection-job', 'items']], ['collect-', ['collection-plan', 'items']],
  ['pack-', ['image-pack', 'items']], ['studio-', ['studio', 'items']],
  ['listing-', ['listing-dry-run', 'rows']], ['pricing-', ['pricing-preview', 'items']],
  ['template-fill-', ['template-fill', 'changes']]
]);
const failure = (message, code, statusCode = 409) => Object.assign(new Error(message), { code, statusCode });
const samePath = (a, b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
export const snapshotHash = bytes => createHash('sha256').update(bytes).digest('hex');

function profile(id) {
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,180}$/.test(id)) throw failure('任务 ID 无效', 'WORKBENCH_STATE_ID', 400);
  for (const [prefix, definition] of TYPES) if (id.startsWith(prefix) && id.length > prefix.length) return definition;
  throw failure('该任务类型尚不支持清单快照，请从原任务入口检查备份', 'WORKBENCH_STATE_TYPE', 400);
}

async function directoryFor(id, checkOwner = true) {
  profile(id);
  if (checkOwner) assertResource('job', id);
  try {
    const directory = path.join(ROOT, id), stat = await fs.lstat(directory);
    const workspace = await fs.realpath(paths.rootDir), output = await fs.realpath(paths.outputDir), root = await fs.realpath(ROOT);
    const relative = path.relative(workspace, output);
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative) || !samePath(root, path.join(output, 'workbench')) || !stat.isDirectory() || stat.isSymbolicLink() || !samePath(await fs.realpath(directory), path.join(root, id))) throw failure('任务目录为链接或超出工作空间，未读取恢复点', 'WORKBENCH_STATE_PATH', 403);
    return directory;
  } catch (error) {
    if (error.code?.startsWith('WORKBENCH_')) throw error;
    throw failure(error.code === 'ENOENT' ? '任务目录不存在，请保留输出并检查备份' : '任务目录无法读取，请检查权限', 'WORKBENCH_STATE_DIRECTORY', error.code === 'ENOENT' ? 404 : 403);
  }
}

async function readFile(directory, name, limit = LIMIT) {
  try {
    const file = path.join(directory, name), stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || !samePath(await fs.realpath(file), path.join(await fs.realpath(directory), name))) throw failure('任务清单或结果包不是本任务的普通文件', 'WORKBENCH_STATE_PATH', 403);
    if (stat.size > limit) throw failure('任务清单超过读取上限，请人工检查备份', 'WORKBENCH_STATE_SIZE');
    const chunks = []; let length = 0;
    const handle = await fs.open(file, 'r');
    try {
      for await (const chunk of handle.createReadStream({ autoClose: false })) {
        length += chunk.length;
        if (length > limit) throw failure('任务清单超过读取上限，请人工检查备份', 'WORKBENCH_STATE_SIZE');
        chunks.push(chunk);
      }
      return Buffer.concat(chunks, length);
    } finally { await handle.close(); }
  } catch (error) {
    if (error.code === 'ENOENT' || error.code?.startsWith('WORKBENCH_')) throw error;
    throw failure('任务文件无法读取，请检查权限或占用；原文件未修改', 'WORKBENCH_STATE_FILE', 403);
  }
}

function parse(bytes, id) {
  const state = JSON.parse(bytes.toString('utf8')), [type, field] = profile(id);
  if (!state || state.id !== id || state.type !== type) throw failure('任务清单身份不匹配，未读取其他任务的恢复点', 'WORKBENCH_STATE_IDENTITY');
  if (!Array.isArray(state[field]) || state[field].some(item => !item || typeof item !== 'object' || Array.isArray(item)) || !state.summary || typeof state.summary !== 'object' || Array.isArray(state.summary)) throw failure('任务清单结构无效，请检查备份', 'WORKBENCH_STATE_SCHEMA');
  // Only active download links are constrained here. Business/source URLs remain literal data.
  for (const key of ['downloadUrl', 'manifestUrl', 'backupUrl', 'diffUrl']) {
    if (state[key] == null) continue;
    if (typeof state[key] !== 'string' || !state[key].startsWith(`/outputs/workbench/${id}/`)) throw failure('任务下载路径无效，未打开外部地址', 'WORKBENCH_STATE_PATH', 403);
    let suffix;
    try { suffix = decodeURIComponent(state[key].slice(`/outputs/workbench/${id}/`.length)); } catch { suffix = ''; }
    if (!suffix || suffix.split('/').some(part => !part || part === '.' || part === '..') || /[\\\u0000-\u001f?#:%]/.test(suffix)) throw failure('任务下载路径无效，未打开外部地址', 'WORKBENCH_STATE_PATH', 403);
  }
  return state;
}

const newer = (candidate, previous) => {
  const a = Number(candidate.checkpointRevision), b = Number(previous.checkpointRevision);
  if (Number.isSafeInteger(a) && a >= 0 && Number.isSafeInteger(b) && b >= 0 && (a || b)) return a > b;
  return Number.isFinite(Date.parse(candidate.updatedAt)) && Date.parse(candidate.updatedAt) > Date.parse(previous.updatedAt);
};

export function snapshotReadNotice(snapshot) {
  return snapshot.source === 'primary' ? undefined : { source: snapshot.source, sourceName: snapshot.sourceName, sourceHash: snapshot.sourceHash, reason: snapshot.reason, readOnly: true, primaryUnchanged: true, canRepair: false };
}

export async function readWorkbenchSnapshot(id) {
  const directory = await directoryFor(id);
  let reason;
  try {
    const bytes = await readFile(directory, 'manifest.json'), state = parse(bytes, id);
    return { state, bytes, source: 'primary', sourceName: 'manifest.json', sourceHash: snapshotHash(bytes) };
  } catch (error) {
    if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
    reason = error.code === 'ENOENT' ? 'missing' : 'invalid-json';
  }
  let chosen;
  // Inspect only this task's published ZIP, never a guessed/older/temporary package.
  const archiveName = `${id}.zip`;
  try {
    const zip = new AdmZip(await readFile(directory, archiveName, Infinity));
    const matches = zip.getEntries().filter(entry => entry.entryName === 'manifest.json'), entry = matches[0];
    if (matches.length !== 1 || entry.isDirectory || entry.header.encrypted || entry.header.size > LIMIT || entry.header.compressedSize > LIMIT) throw failure('结果包清单无效', 'WORKBENCH_ARCHIVE_INVALID');
    const bytes = await new Promise((resolve, reject) => entry.getDataAsync((data, error) => error ? reject(error) : resolve(data)));
    if (bytes.length > LIMIT || bytes.length !== entry.header.size || zipUtils.crc32(bytes) !== entry.header.crc) throw failure('结果包清单大小或校验值无效', 'WORKBENCH_ARCHIVE_INVALID');
    chosen = { state: parse(bytes, id), bytes, source: 'archive', sourceName: archiveName };
  } catch (error) {
    if (error.code === 'WORKBENCH_STATE_PATH' || error.code === 'WORKBENCH_STATE_IDENTITY' || error.code === 'WORKBENCH_STATE_FILE') throw error;
    if (error.code !== 'ENOENT') throw failure('已发布结果包损坏或不可读取，请检查该包和备份；未回退旧状态或启动处理', 'WORKBENCH_ARCHIVE_INVALID');
  }
  try {
    const name = id.startsWith('collect-job-') ? 'manifest.backup.json' : 'manifest.json.backup';
    const bytes = await readFile(directory, name), state = parse(bytes, id);
    if (!chosen || newer(state, chosen.state)) chosen = { state, bytes, source: 'backup', sourceName: name };
  } catch (error) {
    if (['WORKBENCH_STATE_PATH', 'WORKBENCH_STATE_FILE', 'WORKBENCH_STATE_IDENTITY'].includes(error.code)) throw error;
    if (!chosen) throw failure('主清单和可用恢复点均缺失或损坏，请保留输出并检查备份；未启动处理', 'WORKBENCH_STATE_UNAVAILABLE');
  }
  return { ...chosen, reason, sourceHash: snapshotHash(chosen.bytes) };
}

// Producers call this only after their explicitly requested operation, never on a read.
// Both files are complete atomic snapshots; a crash between the two retains a valid previous backup.
export async function writeWorkbenchManifest(state) {
  const bytes = Buffer.from(`${JSON.stringify(state, null, 2)}\n`);
  if (bytes.length > LIMIT) throw failure('任务清单超过保存上限，未覆盖原文件', 'WORKBENCH_STATE_SIZE');
  parse(bytes, state.id);
  const directory = await directoryFor(state.id, false), suffix = randomUUID();
  const names = ['manifest.json', 'manifest.json.backup'];
  for (const name of names) {
    try { await readFile(directory, name); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  for (const name of names) {
    const temporary = path.join(directory, `${name}.${suffix}.tmp`);
    try { await fs.writeFile(temporary, bytes, { flag: 'wx' }); await atomicRename(temporary, path.join(directory, name)); }
    finally { await fs.rm(temporary, { force: true }).catch(() => {}); }
  }
}
