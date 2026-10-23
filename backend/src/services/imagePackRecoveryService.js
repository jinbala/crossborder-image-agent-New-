import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import archiver from 'archiver';
import { paths } from './dbPaths.js';
import { transformImage, normalizeImagePackOptions } from './workbenchService.js';
import { readWorkbenchSnapshot, workbenchSnapshotDirectory, writeWorkbenchManifest, snapshotHash } from './workbenchSnapshotService.js';
import { withWorkbenchMutation, workbenchMutationBusy } from './workbenchMutationService.js';
import { beginCollectionCreation } from './workspaceLifecycle.js';
import { currentActor, assertResource, claimResource, resourceVisible } from './ownershipService.js';
import { collectionCreationEpoch, audit } from './platformStore.js';
import { indexTask } from './taskCenterService.js';
import { atomicRename } from '../utils/atomicRename.js';

const active = new Map(), hashPattern = /^[a-f0-9]{64}$/;
export const imagePackIsActive = id => active.has(id);
export function pauseRunningImagePacks() {
  let requested = 0;
  for (const [id, runtime] of active) if (!runtime.finalizing && resourceVisible('job', id)) { if (runtime.action !== 'cancel') runtime.action = 'pause'; requested++; }
  return requested;
}
const failure = (message, code = 'IMAGE_PACK_RECOVERY', statusCode = 409) => Object.assign(new Error(message), { code, statusCode });
const equal = (a, b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
const url = (id, suffix) => `/outputs/workbench/${id}/${suffix}`;
function authorize(id) {
  if (!/^pack-[A-Za-z0-9_-]{1,160}$/.test(id)) throw failure('图包任务 ID 无效', 'IMAGE_PACK_ID', 400);
  assertResource('job', id);
  if (currentActor() && !['admin', 'operator', 'designer'].includes(currentActor().role)) throw failure('当前角色不能恢复图包', 'IMAGE_PACK_ROLE', 403);
}
async function checked(directory, relative, isDirectory = false) {
  if (!/^(?:inputs|images)(?:\/[^/\\<>:"|?*\u0000-\u001f]+)?$/.test(relative) || relative.split('/').some(x => x === '.' || x === '..' || /[. ]$/.test(x))) throw failure('图包文件路径无效', 'IMAGE_PACK_PATH', 403);
  const segments = relative.split('/'); let target = directory;
  for (let i = 0; i < segments.length; i++) {
    target = path.join(target, segments[i]);
    const stat = await fs.lstat(target);
    if (stat.isSymbolicLink() || !equal(await fs.realpath(target), target) || ((i < segments.length - 1 || isDirectory) ? !stat.isDirectory() : !stat.isFile())) throw failure('图包缓存或结果是链接或路径异常，未启动处理', 'IMAGE_PACK_PATH', 403);
  }
  return target;
}
async function digest(file) {
  const hash = createHash('sha256');
  for await (const chunk of fsSync.createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}
function validate(state) {
  if (state.recoveryVersion !== 1 || state.items.length < 1 || state.items.length > 100 || !state.options || state.items.some((item, index) => item.index !== index + 1 || !['pending', 'completed', 'failed'].includes(item.status) || !hashPattern.test(item.inputHash || '') || item.inputFile !== `inputs/${String(index + 1).padStart(3, '0')}.source` || typeof item.fileName !== 'string' || !/^[^/\\\u0000-\u001f]+$/.test(item.fileName) || /[<>:"|?*]/.test(item.fileName))) throw failure('该图包没有完整的可恢复输入清单，请保留旧结果重新导入', 'IMAGE_PACK_LEGACY');
  if (new Set(state.items.map(item => item.fileName.toLowerCase())).size !== state.items.length) throw failure('图包输出文件名冲突', 'IMAGE_PACK_SCHEMA');
  if (JSON.stringify(normalizeImagePackOptions(state.options)) !== JSON.stringify(state.options) || state.items.some(item => item.fileName !== `${state.options.prefix}-${String(item.index).padStart(3, '0')}.${state.options.format === 'jpeg' ? 'jpg' : state.options.format}`)) throw failure('图包处理规则或文件命名已变化，请检查备份', 'IMAGE_PACK_SCHEMA');
  if ((state.archiveGeneration !== undefined && (!Number.isInteger(state.archiveGeneration) || state.archiveGeneration < 0 || state.archiveGeneration > 10000)) || state.items.some(item => !Number.isSafeInteger(item.inputBytes) || item.inputBytes < 0 || (item.status === 'completed' && (!hashPattern.test(item.outputHash || '') || !Number.isSafeInteger(item.output?.bytes) || item.output.bytes < 1)))) throw failure('图包图片散列或大小记录无效', 'IMAGE_PACK_SCHEMA');
}
function summarize(state) {
  const completed = state.items.filter(item => item.status === 'completed'), failed = state.items.filter(item => item.status === 'failed').length;
  state.summary = { inputCount: state.items.length, outputCount: completed.length, successCount: completed.length, failedCount: failed, skippedCount: 0, pendingCount: state.items.length - completed.length - failed, unprocessedCount: state.items.length - completed.length - failed, inputBytes: state.items.reduce((sum, item) => sum + item.inputBytes, 0), outputBytes: completed.reduce((sum, item) => sum + item.output.bytes, 0) };
  state.updatedAt = new Date().toISOString();
  state.checkpointRevision = (state.checkpointRevision || 0) + 1;
  state.recovery = { available: state.status !== 'completed', finalizePending: state.finalizePending === true };
}
async function save(state) { summarize(state); await writeWorkbenchManifest(state); indexTask(state); }
async function lockSnapshot(directory) {
  try {
    const file = path.join(directory, 'manifest-operation.lock'), stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096) return { busy: true };
    const bytes = await fs.readFile(file), record = JSON.parse(bytes);
    if (!Number.isSafeInteger(record.pid) || record.pid < 1 || !Number.isFinite(Date.parse(record.startedAt))) return { busy: true };
    try { process.kill(record.pid, 0); return { busy: true }; }
    catch (error) { if (error.code !== 'ESRCH') return { busy: true }; }
    return { busy: false, interruptedLock: true, lockHash: snapshotHash(bytes) };
  } catch (error) { if (error.code === 'ENOENT') return { busy: false }; return { busy: true }; }
}
async function scope(id, retryFailed) {
  const snapshot = await readWorkbenchSnapshot(id), state = snapshot.state, directory = await workbenchSnapshotDirectory(id);
  validate(state);
  await checked(directory, 'images', true);
  const lock = await lockSnapshot(directory), selected = state.items.filter(item => item.status === 'pending' || (retryFailed && item.status === 'failed'));
  if (selected.length) await checked(directory, 'inputs', true);
  const proofs = [];
  for (const item of state.items) {
    if (item.status === 'completed') {
      const actual = await digest(await checked(directory, `images/${item.fileName}`));
      if (actual !== item.outputHash) throw failure('已完成图片缺失或散列变化，未重复制作；请保留文件并检查备份', 'IMAGE_PACK_OUTPUT_CHANGED');
      proofs.push([item.index, 'output', actual]);
    } else if (selected.includes(item)) {
      const actual = await digest(await checked(directory, item.inputFile));
      if (actual !== item.inputHash) throw failure('待处理输入缓存已变化，请重新导入；未启动处理', 'IMAGE_PACK_INPUT_CHANGED');
      proofs.push([item.index, 'input', actual]);
    }
  }
  authorize(id); // Ownership may have changed while hashing large cached files.
  const busy = active.has(id) || workbenchMutationBusy(id) || lock.busy;
  const onlyFinalize = !selected.length && state.finalizePending === true;
  const canResume = snapshot.source === 'primary' && !busy && (selected.length > 0 || onlyFinalize);
  return { state, directory, lock, preview: { id, canResume, busy, readOnly: snapshot.source !== 'primary', remote: false, imageCount: selected.length, completedCount: state.items.filter(item => item.status === 'completed').length, retryFailed, onlyFinalize, interruptedLock: lock.interruptedLock === true,
    previewHash: snapshotHash(JSON.stringify({ id, actor: currentActor()?.id || 'local', epoch: collectionCreationEpoch(), source: snapshot.sourceHash, retryFailed, proofs, lockHash: lock.lockHash || null })) } };
}
export async function previewImagePackResume(id, { retryFailed = false } = {}) { authorize(id); return (await scope(id, retryFailed === true)).preview; }

async function publish(state, directory, execution) {
  state.finalizePending = true; await save(state);
  // Every publication gets an independent name; an old/open ZIP is never replaced.
  let generation = state.archiveGeneration || 0;
  let name = generation ? `${state.id}-r${generation}.zip` : `${state.id}.zip`;
  while (await fs.lstat(path.join(directory, name)).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; })) {
    generation++; name = `${state.id}-r${generation}.zip`;
    if (generation > 10000) throw failure('结果包版本过多，请人工归档后重试', 'IMAGE_PACK_ARCHIVE_LIMIT');
  }
  const temporary = path.join(directory, `${name}.${randomUUID()}.tmp`);
  const manifest = structuredClone(state); manifest.status = state.summary.failedCount ? 'partial' : 'completed'; manifest.finalizePending = false; manifest.recovery = { available: !!state.summary.failedCount, finalizePending: false, active: false };
  manifest.downloadUrl = url(state.id, name); manifest.archiveGeneration = generation + 1;
  manifest.updatedAt = new Date().toISOString(); manifest.checkpointRevision++;
  delete manifest.zipBytes; delete manifest.error; // Old size/interruption must not describe this successful publication.
  try {
    await execution.beforePublish?.(state);
    const verifyOutputs = async () => { for (const item of state.items.filter(item => item.status === 'completed')) if (await digest(await checked(directory, `images/${item.fileName}`)) !== item.outputHash) throw failure('已完成图片已变化，未保存结果包；请检查备份', 'IMAGE_PACK_OUTPUT_CHANGED'); };
    await verifyOutputs();
    await new Promise((resolve, reject) => {
      const output = fsSync.createWriteStream(temporary, { flags: 'wx' }), archive = archiver('zip', { zlib: { level: 9 } });
      let failed = false;
      const fail = error => { if (!failed) { failed = true; archive.abort(); output.destroy(); reject(error); } };
      output.on('error', fail); archive.on('error', fail); archive.on('warning', fail); output.on('close', () => { if (!failed) resolve(); }); archive.pipe(output);
      for (const item of state.items.filter(item => item.status === 'completed')) archive.file(path.join(directory, 'images', item.fileName), { name: `images/${item.fileName}` });
      archive.append(JSON.stringify(manifest, null, 2), { name: 'manifest.json' }); archive.finalize().catch(fail);
    });
    await verifyOutputs();
    // A published file left by a lost receipt is preserved; choose a fresh version.
    if (await fs.lstat(path.join(directory, name)).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; })) throw failure('该版本结果包已存在，请保留原包后重新预览仅打包', 'IMAGE_PACK_ARCHIVE_EXISTS');
    await atomicRename(temporary, path.join(directory, name));
    Object.assign(state, manifest, { zipBytes: (await fs.stat(path.join(directory, name))).size }); delete state.error;
    // Preserve the archive's checkpoint timestamp/revision in the final receipt.
    // Otherwise a byte-equivalent newer backup would incorrectly outrank the published archive.
    await writeWorkbenchManifest(state); indexTask(state);
    return state;
  } finally { await fs.rm(temporary, { force: true }).catch(() => {}); }
}
async function run(state, directory, retryFailed, execution = {}) {
  const runtime = { action: null }; active.set(state.id, runtime);
  try {
    state.status = 'running'; await save(state);
    for (const item of state.items) {
      if (runtime.action) break;
      if (item.status !== 'pending' && !(retryFailed && item.status === 'failed')) continue;
      const temporary = path.join(directory, 'images', `.processing-${randomUUID()}`);
      try {
        await checked(directory, 'images', true);
        const input = await checked(directory, item.inputFile);
        if (await digest(input) !== item.inputHash) throw failure('待处理输入缓存已变化', 'IMAGE_PACK_INPUT_CHANGED');
        item.attempt = (item.attempt || 0) + 1;
        const metadata = await (execution.transform || transformImage)({ path: input, originalname: item.sourceName, size: item.inputBytes }, temporary, state.options);
        const outputHash = await digest(temporary);
        await atomicRename(temporary, path.join(directory, 'images', item.fileName));
        Object.assign(item, metadata, { status: 'completed', url: url(state.id, `images/${item.fileName}`), outputHash, completedAt: new Date().toISOString() }); delete item.error;
      } catch (error) { item.status = 'failed'; item.error = { code: error.code || 'IMAGE_PACK_TRANSFORM', message: '图片处理失败，请检查图片格式、完整性与访问权限后重试' }; }
      finally { await fs.rm(temporary, { force: true }).catch(() => {}); }
      await save(state);
      await execution.afterCheckpoint?.(state, item);
    }
    if (runtime.action) { state.status = runtime.action === 'cancel' ? 'cancelled' : 'paused'; await save(state); return state; }
    runtime.finalizing = true;
    return await publish(state, directory, execution);
  } catch (error) {
    state.status = 'paused'; state.error = { code: error.code || 'IMAGE_PACK_INTERRUPTED', message: '处理已停止，恢复点已保留；请预览后继续未完成图片或仅重新打包' };
    await save(state); return state;
  } finally { active.delete(state.id); }
}
export async function createDurableImagePack(files, options, transform, execution = {}) {
  if (!Array.isArray(files) || !files.length || files.length > 100) throw failure('每次需要 1–100 张图片', 'IMAGE_PACK_INPUT', 400);
  const release = beginCollectionCreation();
  try {
    const id = `pack-${Date.now()}-${randomUUID()}`, directory = path.join(paths.outputDir, 'workbench', id);
    await fs.mkdir(path.join(directory, 'inputs'), { recursive: true }); await fs.mkdir(path.join(directory, 'images'));
    claimResource('job', id);
    await workbenchSnapshotDirectory(id);
    const state = { id, type: 'image-pack', recoveryVersion: 1, status: 'queued', name: options.name, createdAt: new Date().toISOString(), options, summary: {}, items: [], manifestUrl: url(id, 'manifest.json') };
    return await withWorkbenchMutation(id, directory, async () => {
      // All inputs are persisted before routes may clean up the multipart staging files.
      for (let index = 0; index < files.length; index++) {
        const file = files[index], inputFile = `inputs/${String(index + 1).padStart(3, '0')}.source`, target = path.join(directory, inputFile);
        await fs.copyFile(file.path, target, fsSync.constants.COPYFILE_EXCL);
        state.items.push({ index: index + 1, status: 'pending', sourceName: String(file.originalname || '').slice(0, 500), inputFile, inputHash: await digest(target), inputBytes: (await fs.stat(target)).size, fileName: `${options.prefix}-${String(index + 1).padStart(3, '0')}.${options.format === 'jpeg' ? 'jpg' : options.format}`, attempt: 0 });
      }
      await save(state);
      return run(state, directory, false, { ...execution, transform: transform || execution.transform });
    }, { allowManifestWrite: true });
  } finally { release(); }
}
export async function resumeImagePack(id, input = {}, execution = {}) {
  authorize(id);
  if (input.confirm !== true || !hashPattern.test(input.previewHash || '')) throw failure('请先预览并明确确认恢复范围', 'IMAGE_PACK_CONFIRM', 400);
  const release = beginCollectionCreation();
  try {
    const proposed = await scope(id, input.retryFailed === true);
    if (!proposed.preview.canResume || proposed.preview.previewHash !== input.previewHash) throw failure('恢复点、输入、成员或运行状态已变化，请重新预览', 'IMAGE_PACK_CHANGED');
    if (proposed.lock.interruptedLock) {
      // Only a provably exited PID may be reclaimed, and only under this approved hash.
      const lock = await lockSnapshot(proposed.directory);
      if (!lock.interruptedLock || lock.lockHash !== proposed.lock.lockHash) throw failure('任务锁已变化，请重新预览', 'IMAGE_PACK_LOCK_CHANGED');
      await fs.rename(path.join(proposed.directory, 'manifest-operation.lock'), path.join(proposed.directory, `manifest-operation.lock.interrupted-${randomUUID()}`));
    }
    return await withWorkbenchMutation(id, proposed.directory, async () => {
      const current = await scope(id, input.retryFailed === true);
      // The freshly held lock is excluded from the approval proof; check original bytes and files again.
      if (snapshotHash(JSON.stringify(current.state)) !== snapshotHash(JSON.stringify(proposed.state))) throw failure('恢复点已变化，请重新预览', 'IMAGE_PACK_CHANGED');
      audit(currentActor(), 'image-pack-resume', id, 202, { images: proposed.preview.imageCount, retryFailed: input.retryFailed === true, onlyFinalize: proposed.preview.onlyFinalize });
      return run(current.state, proposed.directory, input.retryFailed === true, execution);
    }, { allowManifestWrite: true });
  } finally { release(); }
}
export async function controlImagePack(id, input = {}) {
  authorize(id);
  if (input.confirm !== true || !['pause', 'cancel'].includes(input.action)) throw failure('请明确确认暂停或取消', 'IMAGE_PACK_CONTROL', 400);
  const runtime = active.get(id);
  if (!runtime) throw failure('图包当前不在本进程运行，请刷新后预览恢复点', 'IMAGE_PACK_NOT_RUNNING');
  if (runtime.finalizing) throw failure('图包正在保存结果包，无法再暂停；请等待保存完成', 'IMAGE_PACK_FINALIZING');
  if (runtime.action !== 'cancel') runtime.action = input.action;
  return { id, requested: runtime.action, settling: true };
}
