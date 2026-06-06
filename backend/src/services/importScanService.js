import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { listImportedFolders } from './db.js';
import { importBatchSkuFolders } from './batchTaskService.js';
import { applyTemplateToBatch } from './workflowTemplateService.js';

const DEFAULT_ALLOWED_EXTENSIONS = ['jpg', 'jpeg', 'png', 'webp'];
const MAX_IMAGE_COUNT = 15;
const MAX_IMAGE_SIZE = 10 * 1024 * 1024;
const MAX_SKU_TOTAL_SIZE = 100 * 1024 * 1024;

function normalizeExt(ext) {
  return String(ext || '').replace(/^\./, '').trim().toLowerCase();
}

function parseAllowedExtensions() {
  const configured = String(process.env.IMPORT_SCAN_ALLOWED_EXTENSIONS || '')
    .split(',')
    .map(normalizeExt)
    .filter(Boolean);
  return configured.length ? configured : DEFAULT_ALLOWED_EXTENSIONS;
}

function numberEnv(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function boolEnv(name, fallback = false) {
  const value = process.env[name];
  if (value == null || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

function canonical(filePath) {
  return path.resolve(filePath);
}

function keyPath(filePath) {
  return canonical(filePath).toLowerCase();
}

function isSameOrChild(child, parent) {
  const childKey = keyPath(child);
  const parentKey = keyPath(parent);
  return childKey === parentKey || childKey.startsWith(`${parentKey}${path.sep.toLowerCase()}`);
}

function isDangerousRoot(rootDir) {
  if (!rootDir) return true;
  const resolved = canonical(rootDir);
  const parsed = path.parse(resolved);
  if (resolved === parsed.root) return true;
  if (keyPath(resolved) === keyPath(os.homedir())) return true;
  const systemRoot = process.env.SystemRoot || 'C:\\Windows';
  if (systemRoot && isSameOrChild(resolved, systemRoot)) return true;
  return false;
}

function createHttpError(code, message, statusCode = 400, details = {}) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.payload = { code, message, details };
  return error;
}

export function getImportScanConfig() {
  const rootDir = process.env.IMPORT_ROOT_DIR ? canonical(process.env.IMPORT_ROOT_DIR) : '';
  const enabled = boolEnv('IMPORT_SCAN_ENABLED', false);
  const maxDepth = numberEnv('IMPORT_SCAN_MAX_DEPTH', 2);
  const maxSku = numberEnv('IMPORT_SCAN_MAX_SKU', 200);
  const allowedExtensions = parseAllowedExtensions();
  return {
    enabled,
    rootDir,
    maxDepth,
    maxSku,
    allowedExtensions,
    validRoot: Boolean(rootDir) && !isDangerousRoot(rootDir)
  };
}

export function getImportScanStatus() {
  const config = getImportScanConfig();
  return {
    enabled: config.enabled,
    rootDir: config.rootDir,
    maxDepth: config.maxDepth,
    maxSku: config.maxSku,
    allowedExtensions: config.allowedExtensions,
    validRoot: config.validRoot,
    message: !config.enabled
      ? '扫描功能未开启，请设置 IMPORT_SCAN_ENABLED=true。'
      : !config.rootDir
        ? 'IMPORT_ROOT_DIR 未配置。'
        : !config.validRoot
          ? 'IMPORT_ROOT_DIR 指向危险目录，请改为专用导入目录。'
          : '扫描功能已开启。'
  };
}

async function assertScanReady() {
  const config = getImportScanConfig();
  if (!config.enabled) {
    throw createHttpError('IMPORT_SCAN_DISABLED', '扫描功能未开启，请设置 IMPORT_SCAN_ENABLED=true。');
  }
  if (!config.rootDir) {
    throw createHttpError('IMPORT_ROOT_DIR_MISSING', 'IMPORT_ROOT_DIR 未配置，无法扫描导入目录。');
  }
  if (!config.validRoot) {
    throw createHttpError('DANGEROUS_IMPORT_ROOT', 'IMPORT_ROOT_DIR 指向危险目录，请改为专用导入目录。');
  }
  try {
    const stat = await fs.stat(config.rootDir);
    if (!stat.isDirectory()) {
      throw createHttpError('IMPORT_ROOT_NOT_DIRECTORY', 'IMPORT_ROOT_DIR 必须是目录。');
    }
  } catch (err) {
    if (err.payload) throw err;
    throw createHttpError('IMPORT_ROOT_NOT_FOUND', 'IMPORT_ROOT_DIR 不存在或不可访问。');
  }
  return config;
}

function resolveRequestedRoot(config, requestedRoot) {
  if (!requestedRoot) return config.rootDir;
  const resolved = path.isAbsolute(requestedRoot)
    ? canonical(requestedRoot)
    : canonical(path.join(config.rootDir, requestedRoot));
  if (!isSameOrChild(resolved, config.rootDir)) {
    throw createHttpError('IMPORT_PATH_OUTSIDE_ROOT', '扫描路径必须位于 IMPORT_ROOT_DIR 之下。');
  }
  if (isDangerousRoot(resolved)) {
    throw createHttpError('DANGEROUS_SCAN_PATH', '扫描路径指向危险目录。');
  }
  return resolved;
}

async function safeStat(filePath) {
  try {
    return await fs.stat(filePath);
  } catch {
    return null;
  }
}

function buildImportedIndex(importedFolders = []) {
  const map = new Map();
  for (const record of importedFolders) {
    if (record?.folderPath) map.set(keyPath(record.folderPath), record);
  }
  return map;
}

function statusSummary(candidates) {
  return {
    totalFolders: candidates.length,
    newCount: candidates.filter((item) => item.status === 'new').length,
    importedCount: candidates.filter((item) => item.status === 'imported').length,
    invalidCount: candidates.filter((item) => ['invalid', 'too_many_images', 'too_large'].includes(item.status)).length,
    emptyCount: candidates.filter((item) => item.status === 'empty').length,
    totalImages: candidates.reduce((sum, item) => sum + (item.imageCount || 0), 0)
  };
}

export async function scanSkuFolder(folderPath, options = {}) {
  const allowedExtensions = options.allowedExtensions || parseAllowedExtensions();
  const importedIndex = options.importedIndex || buildImportedIndex(await listImportedFolders());
  const resolved = canonical(folderPath);
  const folderName = path.basename(resolved);
  const candidate = {
    folderName,
    folderPath: resolved,
    skuId: folderName,
    displayName: folderName,
    imageCount: 0,
    totalSize: 0,
    images: [],
    status: 'new',
    warnings: [],
    errors: [],
    existingBatchId: null,
    existingTaskId: null
  };

  const folderStat = await safeStat(resolved);
  if (!folderStat?.isDirectory()) {
    return {
      ...candidate,
      status: 'invalid',
      errors: [{ code: 'NOT_DIRECTORY', message: '候选路径不是目录。' }]
    };
  }

  const importedRecord = importedIndex.get(keyPath(resolved));
  if (importedRecord) {
    candidate.status = 'imported';
    candidate.existingBatchId = importedRecord.batchId || null;
    candidate.existingTaskId = importedRecord.taskIds?.[0] || null;
  }

  const entries = await fs.readdir(resolved, { withFileTypes: true });
  const sortedFiles = entries.filter((entry) => entry.isFile()).sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of sortedFiles) {
    const ext = normalizeExt(path.extname(entry.name));
    const filePath = path.join(resolved, entry.name);
    const stat = await safeStat(filePath);
    if (!allowedExtensions.includes(ext)) {
      candidate.warnings.push({ code: 'NON_IMAGE_FILE_SKIPPED', message: `已忽略非图片文件：${entry.name}` });
      continue;
    }
    const size = stat?.size || 0;
    candidate.images.push({ fileName: entry.name, size, ext });
    candidate.totalSize += size;
    if (size > MAX_IMAGE_SIZE) {
      candidate.errors.push({ code: 'IMAGE_TOO_LARGE', message: `${entry.name} 超过 10MB。` });
    }
  }
  candidate.imageCount = candidate.images.length;

  if (candidate.status !== 'imported') {
    if (!candidate.imageCount) {
      candidate.status = 'empty';
    } else if (candidate.imageCount > MAX_IMAGE_COUNT) {
      candidate.status = 'too_many_images';
      candidate.errors.push({ code: 'TOO_MANY_IMAGES', message: '最多只能上传 15 张商品图片。' });
    } else if (candidate.totalSize > MAX_SKU_TOTAL_SIZE || candidate.errors.some((error) => error.code === 'IMAGE_TOO_LARGE')) {
      candidate.status = 'too_large';
      if (candidate.totalSize > MAX_SKU_TOTAL_SIZE) {
        candidate.errors.push({ code: 'SKU_TOTAL_TOO_LARGE', message: '单个 SKU 图片总大小不能超过 100MB。' });
      }
    }
  }

  if (candidate.status === 'imported' && candidate.imageCount > 0) {
    candidate.warnings.push({ code: 'ALREADY_IMPORTED', message: '该文件夹已导入。如图片有变化，本阶段不会自动覆盖。' });
  }

  return candidate;
}

async function collectCandidateFolders(rootDir, maxDepth, maxSku) {
  const folders = [];
  async function walk(current, depth) {
    if (folders.length >= maxSku || depth > maxDepth) return;
    const entries = await fs.readdir(current, { withFileTypes: true });
    const directories = entries.filter((entry) => entry.isDirectory()).sort((a, b) => a.name.localeCompare(b.name));
    const hasFiles = entries.some((entry) => entry.isFile());
    if (depth > 0 && (hasFiles || directories.length === 0)) {
      folders.push({ folderName: path.basename(current), folderPath: current });
      return;
    }
    for (const directory of directories) {
      await walk(path.join(current, directory.name), depth + 1);
      if (folders.length >= maxSku) break;
    }
  }
  await walk(rootDir, 0);
  return folders;
}

export async function scanImportRoot({ rootDir } = {}) {
  const config = await assertScanReady();
  const scanRoot = resolveRequestedRoot(config, rootDir);
  const importedIndex = buildImportedIndex(await listImportedFolders());
  const skuFolders = await collectCandidateFolders(scanRoot, config.maxDepth, config.maxSku);
  const candidates = [];
  for (const folder of skuFolders) {
    candidates.push(await scanSkuFolder(folder.folderPath, {
      allowedExtensions: config.allowedExtensions,
      importedIndex
    }));
  }
  return {
    rootDir: scanRoot,
    scannedAt: new Date().toISOString(),
    candidates,
    summary: statusSummary(candidates)
  };
}

export async function importScannedFolders({ folderPaths = [], batchName, defaultTargets = [], templateId = null } = {}) {
  const config = await assertScanReady();
  if (!Array.isArray(folderPaths) || folderPaths.length === 0) {
    throw createHttpError('NO_IMPORT_FOLDERS', '请选择至少一个 new 状态的 SKU 文件夹。');
  }
  const importedIndex = buildImportedIndex(await listImportedFolders());
  const selectedFolders = [];
  const skippedCandidates = [];
  for (const folderPath of folderPaths) {
    const resolved = resolveRequestedRoot(config, folderPath);
    const candidate = await scanSkuFolder(resolved, {
      allowedExtensions: config.allowedExtensions,
      importedIndex
    });
    if (candidate.status !== 'new') {
      skippedCandidates.push({
        ...candidate,
        reason: `仅允许导入 new 状态，当前状态为 ${candidate.status}。`
      });
      continue;
    }
    selectedFolders.push({
      folderName: candidate.folderName,
      folderPath: candidate.folderPath
    });
  }
  if (!selectedFolders.length) {
    return {
      batchTask: null,
      createdTasks: [],
      skippedCandidates
    };
  }
  const result = await importBatchSkuFolders({
    skuFolders: selectedFolders,
    name: batchName || `扫描导入 ${new Date().toLocaleString('zh-CN')}`,
    defaultTargets,
    sourceType: 'import_scan',
    folderPath: config.rootDir
  });
  if (templateId && result.batchTask?.id) {
    const templateResult = await applyTemplateToBatch({ batchId: result.batchTask.id, templateId });
    return {
      ...result,
      batchTask: templateResult.batchTask,
      templateSnapshot: templateResult.templateSnapshot,
      templateWarnings: templateResult.warnings,
      skippedCandidates
    };
  }
  return {
    ...result,
    skippedCandidates
  };
}
