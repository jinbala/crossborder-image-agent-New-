import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import archiver from 'archiver';
import AdmZip from 'adm-zip';
import { nanoid } from 'nanoid';
import { paths, readDb, writeDb } from './db.js';
import { getSqliteDbPath, getStorageDriver } from '../storage/index.js';
import { SqliteStore } from '../storage/sqliteStore.js';

const SNAPSHOT_ROOT = 'snapshot';
const SNAPSHOT_METADATA = `${SNAPSHOT_ROOT}/snapshot-metadata.json`;
const APP_VERSION = 'v4.4';
const ENV_RESTORE_MESSAGE = '.env was not restored for security. Please configure it manually.';

export const backupsDir = path.join(paths.rootDir, 'backups');

function nowIso() {
  return new Date().toISOString();
}

function timestampSlug(date = new Date()) {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, '');
}

function normalizeOptions(options = {}) {
  return {
    includeUploads: options.includeUploads !== false,
    includeOutputs: options.includeOutputs !== false,
    includeDocs: options.includeDocs !== false,
    note: typeof options.note === 'string' ? options.note : ''
  };
}

async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function assertInside(parent, child) {
  const relative = path.relative(parent, child);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    const error = new Error('Unsafe path outside project root');
    error.statusCode = 400;
    throw error;
  }
}

export function assertValidSnapshotId(snapshotId) {
  if (!/^snapshot-[A-Za-z0-9._-]+$/.test(String(snapshotId || ''))) {
    const error = new Error('Invalid snapshotId');
    error.statusCode = 400;
    throw error;
  }
}

async function ensureBackupsDir() {
  await fs.mkdir(backupsDir, { recursive: true });
}

function snapshotPath(snapshotId) {
  assertValidSnapshotId(snapshotId);
  const zipPath = path.join(backupsDir, `${snapshotId}.zip`);
  assertInside(backupsDir, zipPath);
  return zipPath;
}

async function countFilesAndSize(dirPath) {
  const summary = { count: 0, totalSize: 0 };
  if (!(await pathExists(dirPath))) return summary;
  const entries = await fs.readdir(dirPath, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      const nested = await countFilesAndSize(fullPath);
      summary.count += nested.count;
      summary.totalSize += nested.totalSize;
    } else if (entry.isFile()) {
      const stat = await fs.stat(fullPath);
      summary.count += 1;
      summary.totalSize += stat.size;
    }
  }
  return summary;
}

async function dbSummary() {
  const db = await readDb();
  return {
    taskCount: db.tasks.length,
    batchTaskCount: db.batchTasks.length,
    workflowTemplateCount: db.workflowTemplates.length,
    userSettingsExists: Boolean(db.userSettings),
    importedFolderCount: db.importedFolders.length
  };
}

async function buildMetadata({ snapshotId, createdAt, options }) {
  const uploads = await countFilesAndSize(paths.uploadDir);
  const outputs = await countFilesAndSize(paths.outputDir);
  const docs = await countFilesAndSize(path.join(paths.rootDir, 'docs'));
  const totalSize =
    (options.includeUploads ? uploads.totalSize : 0) +
    (options.includeOutputs ? outputs.totalSize : 0) +
    (options.includeDocs ? docs.totalSize : 0) +
    ((await pathExists(paths.dbPath)) ? (await fs.stat(paths.dbPath)).size : 0);
  const sqliteExists = await pathExists(getSqliteDbPath());
  let sqliteSchemaVersion = null;
  let sqliteIndexIncluded = false;
  if (sqliteExists) {
    const sqliteStore = new SqliteStore({ dbPath: getSqliteDbPath() });
    try {
      const db = sqliteStore.getDatabase();
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((row) => row.name);
      sqliteIndexIncluded = ['batch_sku_index', 'batch_queue_index', 'batch_analytics_index', 'provider_usage_index', 'review_risk_index']
        .every((table) => tables.includes(table));
      if (tables.includes('app_meta')) {
        sqliteSchemaVersion = Number(db.prepare('SELECT value FROM app_meta WHERE key = ?').get('schemaVersion')?.value || 0);
      }
    } catch {
      sqliteSchemaVersion = null;
    } finally {
      sqliteStore.close();
    }
  }
  return {
    snapshotId,
    createdAt,
    appVersion: APP_VERSION,
    dbSummary: await dbSummary(),
    fileSummary: {
      uploadsCount: options.includeUploads ? uploads.count : 0,
      outputsCount: options.includeOutputs ? outputs.count : 0,
      docsCount: options.includeDocs ? docs.count : 0,
      totalSize
    },
    includeOptions: {
      includeUploads: options.includeUploads,
      includeOutputs: options.includeOutputs,
      includeDocs: options.includeDocs
    },
    safety: {
      envIncluded: false,
      apiKeysIncluded: false,
      nodeModulesIncluded: false
    },
    storage: {
      storageDriver: getStorageDriver(),
      jsonIncluded: await pathExists(paths.dbPath),
      sqliteIncluded: sqliteExists,
      sqliteSchemaVersion,
      sqliteIndexIncluded,
      sqlitePath: getSqliteDbPath()
    },
    notes: options.note ? [options.note] : []
  };
}

function addFileIfExists(archive, absolutePath, zipName) {
  if (fsSync.existsSync(absolutePath)) archive.file(absolutePath, { name: zipName });
}

function addDirectoryIfExists(archive, absolutePath, zipName) {
  if (fsSync.existsSync(absolutePath)) archive.directory(absolutePath, zipName);
}

export async function createSnapshot(optionsInput = {}) {
  await ensureBackupsDir();
  const options = normalizeOptions(optionsInput);
  const snapshotId = optionsInput.snapshotId || `snapshot-${timestampSlug()}-${nanoid(6)}`;
  assertValidSnapshotId(snapshotId);
  const createdAt = nowIso();
  const zipPath = snapshotPath(snapshotId);
  const metadata = await buildMetadata({ snapshotId, createdAt, options });

  await new Promise((resolve, reject) => {
    const output = fsSync.createWriteStream(zipPath);
    const archive = archiver('zip', { zlib: { level: 9 } });
    output.on('close', resolve);
    archive.on('error', reject);
    archive.pipe(output);

    addFileIfExists(archive, paths.dbPath, `${SNAPSHOT_ROOT}/db.json`);
    addFileIfExists(archive, getSqliteDbPath(), `${SNAPSHOT_ROOT}/app.sqlite`);
    if (options.includeUploads) addDirectoryIfExists(archive, paths.uploadDir, `${SNAPSHOT_ROOT}/uploads`);
    if (options.includeOutputs) addDirectoryIfExists(archive, paths.outputDir, `${SNAPSHOT_ROOT}/outputs`);
    if (options.includeDocs) addDirectoryIfExists(archive, path.join(paths.rootDir, 'docs'), `${SNAPSHOT_ROOT}/docs`);
    addFileIfExists(archive, path.join(paths.rootDir, 'README.md'), `${SNAPSHOT_ROOT}/README.md`);
    addFileIfExists(archive, path.join(paths.rootDir, '.env.example'), `${SNAPSHOT_ROOT}/.env.example`);
    archive.append(JSON.stringify(metadata, null, 2), { name: SNAPSHOT_METADATA });
    archive.finalize();
  });

  const stat = await fs.stat(zipPath);
  return {
    snapshotId,
    fileName: path.basename(zipPath),
    filePath: zipPath,
    size: stat.size,
    createdAt,
    metadata
  };
}

function readSnapshotMetadata(zipPath) {
  const zip = new AdmZip(zipPath);
  const entry = zip.getEntry(SNAPSHOT_METADATA);
  if (!entry) return null;
  return JSON.parse(entry.getData().toString('utf8'));
}

export async function listSnapshots() {
  await ensureBackupsDir();
  const entries = await fs.readdir(backupsDir, { withFileTypes: true });
  const snapshots = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.zip')) continue;
    const filePath = path.join(backupsDir, entry.name);
    let metadata = null;
    try {
      metadata = readSnapshotMetadata(filePath);
    } catch {
      metadata = null;
    }
    const stat = await fs.stat(filePath);
    const snapshotId = metadata?.snapshotId || entry.name.replace(/\.zip$/i, '');
    snapshots.push({
      snapshotId,
      fileName: entry.name,
      filePath,
      size: stat.size,
      createdAt: metadata?.createdAt || stat.birthtime.toISOString(),
      metadata
    });
  }
  return snapshots.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

export async function getSnapshot(snapshotId) {
  const filePath = snapshotPath(snapshotId);
  if (!(await pathExists(filePath))) {
    const error = new Error('Snapshot not found');
    error.statusCode = 404;
    throw error;
  }
  const stat = await fs.stat(filePath);
  return {
    snapshotId,
    fileName: path.basename(filePath),
    filePath,
    size: stat.size,
    createdAt: stat.birthtime.toISOString(),
    metadata: readSnapshotMetadata(filePath)
  };
}

export async function deleteSnapshot(snapshotId, { confirm = false } = {}) {
  if (!confirm) {
    const error = new Error('deleteSnapshot requires confirm=true');
    error.statusCode = 400;
    throw error;
  }
  const snapshot = await getSnapshot(snapshotId);
  await fs.rm(snapshot.filePath, { force: true });
  return { deleted: true, snapshotId };
}

export async function validateSnapshot(snapshotIdOrPath) {
  const filePath = String(snapshotIdOrPath || '').endsWith('.zip')
    ? path.resolve(snapshotIdOrPath)
    : snapshotPath(snapshotIdOrPath);
  assertInside(backupsDir, filePath);
  if (!(await pathExists(filePath))) {
    const error = new Error('Snapshot not found');
    error.statusCode = 404;
    throw error;
  }
  const zip = new AdmZip(filePath);
  const entries = zip.getEntries();
  for (const entry of entries) {
    const name = entry.entryName.replaceAll('\\', '/');
    if (name.startsWith('/') || name.includes('../') || !name.startsWith(`${SNAPSHOT_ROOT}/`)) {
      const error = new Error('Snapshot contains unsafe paths');
      error.statusCode = 400;
      throw error;
    }
    if (name.includes('.env') && !name.endsWith('.env.example')) {
      const error = new Error('Snapshot contains forbidden env file');
      error.statusCode = 400;
      throw error;
    }
  }
  const metadata = readSnapshotMetadata(filePath);
  if (!metadata?.snapshotId || !metadata?.safety || metadata.safety.envIncluded !== false) {
    const error = new Error('Snapshot metadata is missing or unsafe');
    error.statusCode = 400;
    throw error;
  }
  return { filePath, metadata };
}

async function copyIfExists(source, target) {
  if (!(await pathExists(source))) return false;
  await fs.rm(target, { recursive: true, force: true });
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.cp(source, target, { recursive: true });
  return true;
}

export async function restoreSnapshot(snapshotId, optionsInput = {}) {
  const options = {
    restoreDb: optionsInput.restoreDb !== false,
    restoreJsonDb: optionsInput.restoreJsonDb !== false,
    restoreSqliteDb: optionsInput.restoreSqliteDb === true,
    restoreUploads: optionsInput.restoreUploads !== false,
    restoreOutputs: optionsInput.restoreOutputs !== false,
    restoreDocs: optionsInput.restoreDocs === true,
    createBackupBeforeRestore: optionsInput.createBackupBeforeRestore !== false,
    confirm: optionsInput.confirm === true
  };
  if (!options.confirm) {
    const error = new Error('restoreSnapshot requires confirm=true');
    error.statusCode = 400;
    throw error;
  }
  const { filePath, metadata } = await validateSnapshot(snapshotId);
  let preRestoreSnapshot = null;
  if (options.createBackupBeforeRestore) {
    preRestoreSnapshot = await createSnapshot({
      includeUploads: true,
      includeOutputs: true,
      includeDocs: false,
      note: `pre-restore backup before restoring ${snapshotId}`
    });
  }
  const extractDir = path.join(backupsDir, `.restore-${snapshotId}-${nanoid(6)}`);
  assertInside(backupsDir, extractDir);
  await fs.rm(extractDir, { recursive: true, force: true });
  await fs.mkdir(extractDir, { recursive: true });
  try {
    const zip = new AdmZip(filePath);
    zip.extractAllTo(extractDir, true);
    const snapshotRoot = path.join(extractDir, SNAPSHOT_ROOT);
    const restored = {
      db: false,
      sqlite: false,
      uploads: false,
      outputs: false,
      docs: false
    };
    if (options.restoreDb && options.restoreJsonDb) {
      const dbSource = path.join(snapshotRoot, 'db.json');
      if (!(await pathExists(dbSource))) throw Object.assign(new Error('Snapshot db.json is missing'), { statusCode: 400 });
      const raw = await fs.readFile(dbSource, 'utf8');
      await writeDb(JSON.parse(raw));
      restored.db = true;
    }
    if (options.restoreSqliteDb) {
      const sqliteSource = path.join(snapshotRoot, 'app.sqlite');
      if (!(await pathExists(sqliteSource))) throw Object.assign(new Error('Snapshot app.sqlite is missing'), { statusCode: 400 });
      await fs.mkdir(path.dirname(getSqliteDbPath()), { recursive: true });
      await fs.copyFile(sqliteSource, getSqliteDbPath());
      restored.sqlite = true;
    }
    if (options.restoreUploads) restored.uploads = await copyIfExists(path.join(snapshotRoot, 'uploads'), paths.uploadDir);
    if (options.restoreOutputs) restored.outputs = await copyIfExists(path.join(snapshotRoot, 'outputs'), paths.outputDir);
    if (options.restoreDocs) restored.docs = await copyIfExists(path.join(snapshotRoot, 'docs'), path.join(paths.rootDir, 'docs'));
    return {
      snapshotId,
      restoredAt: nowIso(),
      restored,
      skipped: {
        env: true,
        message: ENV_RESTORE_MESSAGE
      },
      warnings: [ENV_RESTORE_MESSAGE],
      preRestoreSnapshotId: preRestoreSnapshot?.snapshotId || null,
      metadata
    };
  } finally {
    await fs.rm(extractDir, { recursive: true, force: true });
  }
}
