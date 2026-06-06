import fs from 'node:fs/promises';
import path from 'node:path';
import { paths } from './db.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const SOURCE_EXTENSIONS = new Set(['.js', '.jsx', '.ts', '.tsx', '.css', '.html']);
const PROTECTED_FILE_NAMES = new Set([
  '.env',
  'app.sqlite',
  'db.json',
  'package.json',
  'package-lock.json',
  'README.md'
]);
const PROTECTED_DIR_PARTS = new Set([
  'node_modules',
  'src',
  'tests',
  'docs'
]);

const GROUPS = {
  uploads: {
    root: 'uploads',
    label: 'uploads 上传文件',
    summaryOnly: true,
    riskLevel: 'risky',
    deletable: false,
    reason: 'uploads 可能仍被任务或 batch 引用，第一版只统计不清理。'
  },
  outputs: {
    root: 'outputs',
    label: 'outputs 输出文件',
    summaryOnly: true,
    riskLevel: 'caution',
    deletable: false,
    reason: 'outputs 是生成结果目录，请按具体清理类型预览后再处理。'
  },
  backups: {
    root: 'backups',
    label: 'backups 快照备份',
    summaryOnly: true,
    riskLevel: 'caution',
    deletable: false,
    reason: 'backups 是项目快照目录，请按旧备份分组谨慎清理。'
  },
  visionTmp: {
    root: '.vision-tmp',
    label: '临时视觉文件 .vision-tmp',
    riskLevel: 'safe',
    deletable: true,
    reason: '运行过程中产生的临时视觉文件，超过时间阈值后可清理。'
  },
  testResults: {
    root: path.join('backend', 'test-results'),
    label: '测试结果 backend/test-results',
    riskLevel: 'safe',
    deletable: true,
    reason: '测试运行产物，超过时间阈值后可清理。'
  },
  oldOutputs: {
    root: 'outputs',
    label: '旧输出 outputs',
    riskLevel: 'caution',
    deletable: true,
    reason: '旧输出可能用于复查，确认不再需要后可清理。',
    match: (file) => !file.relativePath.toLowerCase().endsWith('.zip')
  },
  exportZips: {
    root: 'outputs',
    label: '旧导出 ZIP',
    riskLevel: 'caution',
    deletable: true,
    reason: '旧导出 ZIP 可重新导出，确认不再需要后可清理。',
    match: (file) => file.relativePath.toLowerCase().endsWith('.zip'),
    countInTotal: false
  },
  oldBackups: {
    root: 'backups',
    label: '旧备份 backups',
    riskLevel: 'caution',
    deletable: true,
    reason: '旧快照用于回滚，清理前请确认已有更新快照。',
    match: (file) => file.relativePath.toLowerCase().endsWith('.zip')
  },
  tempMatting: {
    root: 'outputs',
    label: '临时抠图文件',
    riskLevel: 'safe',
    deletable: true,
    reason: '临时抠图中间产物，超过时间阈值后可清理。',
    match: (file) => /(^|[\\/])(matting|subject|mask)[^\\/]*\.(png|webp|jpg|jpeg)$/i.test(file.relativePath),
    countInTotal: false
  },
  oldMockImages: {
    root: 'outputs',
    label: '旧 mock 图片',
    riskLevel: 'caution',
    deletable: true,
    reason: '旧 mock 预览图可重新生成，确认不再需要后可清理。',
    match: (file) => /mock/i.test(file.relativePath) && /\.(png|jpg|jpeg|webp)$/i.test(file.relativePath),
    countInTotal: false
  },
  orphanUploads: {
    root: 'uploads',
    label: '孤儿 uploads',
    riskLevel: 'risky',
    deletable: false,
    reason: '当前版本无法精确确认 uploads 是否仍被任务引用，默认不自动删除。'
  }
};

const PREVIEW_GROUPS = ['visionTmp', 'testResults', 'oldOutputs', 'oldBackups', 'exportZips', 'tempMatting', 'oldMockImages', 'orphanUploads'];
const SUMMARY_GROUPS = ['uploads', 'outputs', 'backups', 'visionTmp', 'testResults', 'exportZips', 'tempMatting', 'oldMockImages', 'orphanUploads'];

function normalizeProjectRoot(projectRoot = paths.rootDir) {
  return path.resolve(projectRoot);
}

function resolveInsideProject(projectRoot, relativePath) {
  const root = normalizeProjectRoot(projectRoot);
  const resolved = path.resolve(root, relativePath);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    const error = new Error('路径越界，已拒绝。');
    error.code = 'PATH_TRAVERSAL';
    throw error;
  }
  return resolved;
}

function toRelative(projectRoot, filePath) {
  return path.relative(projectRoot, filePath).split(path.sep).join('/');
}

function normalizeOlderThanDays(value) {
  const days = Number(value);
  if (!Number.isFinite(days) || days < 0) return 30;
  return Math.floor(days);
}

function normalizeGroups(groups) {
  if (!Array.isArray(groups) || groups.length === 0) return PREVIEW_GROUPS;
  return [...new Set(groups.map(String))].filter((groupName) => PREVIEW_GROUPS.includes(groupName));
}

function isProtected(relativePath) {
  const normalized = relativePath.split(/[\\/]+/).filter(Boolean);
  const baseName = normalized.at(-1) || '';
  if (baseName === '.env' || baseName.startsWith('.env.')) return true;
  if (PROTECTED_FILE_NAMES.has(baseName)) return true;
  if (normalized.some((part, index) => PROTECTED_DIR_PARTS.has(part) && index < normalized.length - 1)) return true;
  if (SOURCE_EXTENSIONS.has(path.extname(baseName).toLowerCase())) return true;
  if (/\.bat$/i.test(baseName)) return true;
  return false;
}

async function listFiles(dirPath, projectRoot) {
  let entries = [];
  try {
    entries = await fs.readdir(dirPath, { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }

  const files = [];
  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      files.push(...await listFiles(fullPath, projectRoot));
    } else if (entry.isFile()) {
      const stat = await fs.stat(fullPath);
      files.push({
        absolutePath: fullPath,
        relativePath: toRelative(projectRoot, fullPath),
        sizeBytes: stat.size,
        modifiedAt: stat.mtime.toISOString(),
        modifiedMs: stat.mtime.getTime()
      });
    }
  }
  return files;
}

async function collectGroup(groupName, { projectRoot, olderThanDays = null } = {}) {
  const config = GROUPS[groupName];
  if (!config) return null;
  const root = normalizeProjectRoot(projectRoot);
  const groupRoot = resolveInsideProject(root, config.root);
  const cutoffMs = olderThanDays === null ? null : Date.now() - normalizeOlderThanDays(olderThanDays) * DAY_MS;
  const rawFiles = await listFiles(groupRoot, root);
  const filtered = rawFiles
    .filter((file) => cutoffMs === null || file.modifiedMs < cutoffMs)
    .filter((file) => !config.match || config.match(file));
  const files = filtered.map((file) => {
    const protectedFile = isProtected(file.relativePath);
    const deletable = Boolean(config.deletable) && !protectedFile;
    return {
      relativePath: file.relativePath,
      sizeBytes: file.sizeBytes,
      modifiedAt: file.modifiedAt,
      riskLevel: protectedFile ? 'risky' : config.riskLevel,
      reason: protectedFile ? '受保护文件或源码文件，禁止清理。' : config.reason,
      deletable
    };
  }).sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  const bytes = files.reduce((sum, file) => sum + file.sizeBytes, 0);
  return {
    groupName,
    groupLabel: config.label,
    bytes,
    fileCount: files.length,
    files
  };
}

function summarizeGroups(groups, totalGroups = groups) {
  return {
    totalBytes: totalGroups.reduce((sum, group) => sum + group.bytes, 0),
    totalFiles: totalGroups.reduce((sum, group) => sum + group.fileCount, 0),
    groups
  };
}

export async function getCleanupSummary({ projectRoot = paths.rootDir } = {}) {
  const groups = [];
  for (const groupName of SUMMARY_GROUPS) {
    const group = await collectGroup(groupName, { projectRoot, olderThanDays: null });
    if (group) groups.push(group);
  }
  return summarizeGroups(groups, groups.filter((group) => GROUPS[group.groupName]?.countInTotal !== false));
}

export async function previewCleanup(payload = {}, { projectRoot = paths.rootDir } = {}) {
  const olderThanDays = normalizeOlderThanDays(payload.olderThanDays);
  const groupNames = normalizeGroups(payload.groups);
  const groups = [];
  for (const groupName of groupNames) {
    const group = await collectGroup(groupName, { projectRoot, olderThanDays });
    if (group) groups.push(group);
  }
  return {
    olderThanDays,
    ...summarizeGroups(groups)
  };
}

export async function runCleanup(payload = {}, { projectRoot = paths.rootDir, removeFile = fs.rm } = {}) {
  if (payload.confirm !== true) {
    const error = new Error('必须传入 confirm=true 才能执行清理。');
    error.statusCode = 400;
    throw error;
  }

  const preview = await previewCleanup(payload, { projectRoot });
  const deleted = [];
  const skipped = [];
  const errors = [];
  let deletedBytes = 0;
  const root = normalizeProjectRoot(projectRoot);
  const seenRelativePaths = new Set();

  for (const group of preview.groups) {
    for (const file of group.files) {
      if (seenRelativePaths.has(file.relativePath)) continue;
      seenRelativePaths.add(file.relativePath);
      if (!file.deletable) {
        skipped.push(file);
        continue;
      }
      try {
        const filePath = resolveInsideProject(root, file.relativePath);
        await removeFile(filePath, { force: true });
        deleted.push(file);
        deletedBytes += file.sizeBytes;
      } catch (err) {
        errors.push({
          relativePath: file.relativePath,
          message: err.message
        });
      }
    }
  }

  return {
    deletedFiles: deleted.length,
    deletedBytes,
    skippedFiles: skipped.length,
    errors,
    completedAt: new Date().toISOString()
  };
}

export const cleanupGroups = GROUPS;
