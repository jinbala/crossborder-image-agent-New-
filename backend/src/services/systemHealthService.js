import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getProviderConfigSummary } from '../config/env.js';
import { listBatchTasks, paths } from './db.js';
import { backupsDir, listSnapshots } from './snapshotService.js';
import { getSqliteDbPath, getStorageDriver } from '../storage/index.js';
import { REQUIRED_SQLITE_TABLES, SQLITE_INDEX_TABLES, SQLITE_SCHEMA_VERSION } from '../storage/schema.js';
import { SqliteStore } from '../storage/sqliteStore.js';
import { getStorageStatus, SQLITE_MODE_JSON_NOT_SYNCED_WARNING } from './storageTrialService.js';

const STATUS_WEIGHT = { healthy: 0, warning: 1, error: 2 };
const SENSITIVE_PATTERN = /(api[_-]?key|secret|token|password|credential)/i;
const ONE_GB = 1024 * 1024 * 1024;

function nowIso() {
  return new Date().toISOString();
}

function boolEnv(name, fallback = false) {
  const value = process.env[name];
  if (value === undefined) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

function numberEnv(name, fallback) {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function bytes(value) {
  if (!Number.isFinite(value)) return 'unknown';
  if (value >= ONE_GB) return `${(value / ONE_GB).toFixed(2)}GB`;
  if (value >= 1024 * 1024) return `${(value / 1024 / 1024).toFixed(2)}MB`;
  if (value >= 1024) return `${(value / 1024).toFixed(2)}KB`;
  return `${value}B`;
}

function makeCheck({
  id,
  title,
  category,
  status = 'healthy',
  message = '',
  details = {},
  fixSuggestion = '',
  docsHint = ''
}) {
  return {
    id,
    title,
    category,
    status,
    message,
    details: sanitizeDetails(details),
    fixSuggestion,
    docsHint
  };
}

function hasMigrationConsistencyFailure(report = {}) {
  return [report.countsMatch, report.samplesMatch]
    .filter((value) => value && typeof value === 'object')
    .some((value) => Object.values(value).some((matched) => matched === false));
}

export function sanitizeDetails(value) {
  if (Array.isArray(value)) return value.map(sanitizeDetails);
  if (!value || typeof value !== 'object') {
    if (typeof value === 'string' && SENSITIVE_PATTERN.test(value)) return '[redacted]';
    return value;
  }
  const clean = {};
  for (const [key, nested] of Object.entries(value)) {
    if (SENSITIVE_PATTERN.test(key)) continue;
    clean[key] = sanitizeDetails(nested);
  }
  return clean;
}

function summarize(checks) {
  return checks.reduce((summary, check) => {
    if (check.status === 'error') summary.errorCount += 1;
    else if (check.status === 'warning') summary.warningCount += 1;
    else summary.healthyCount += 1;
    return summary;
  }, { healthyCount: 0, warningCount: 0, errorCount: 0 });
}

export function buildHealthResult(checks) {
  const summary = summarize(checks);
  const overallStatus = summary.errorCount > 0
    ? 'error'
    : summary.warningCount > 0
      ? 'warning'
      : 'healthy';
  return {
    checkedAt: nowIso(),
    overallStatus,
    summary,
    checks: [...checks].sort((a, b) => STATUS_WEIGHT[b.status] - STATUS_WEIGHT[a.status])
  };
}

async function pathExists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function directorySize(dirPath) {
  let totalSize = 0;
  let count = 0;
  if (!(await pathExists(dirPath))) return { totalSize, count };
  let entries = [];
  try {
    entries = await fs.readdir(dirPath, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return { totalSize, count };
    throw error;
  }
  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      const nested = await directorySize(fullPath);
      totalSize += nested.totalSize;
      count += nested.count;
    } else if (entry.isFile()) {
      let stat;
      try {
        stat = await fs.stat(fullPath);
      } catch (error) {
        if (error.code === 'ENOENT') continue;
        throw error;
      }
      totalSize += stat.size;
      count += 1;
    }
  }
  return { totalSize, count };
}

async function writableDirectoryCheck({ id, title, dirPath, create = false }) {
  try {
    if (create) await fs.mkdir(dirPath, { recursive: true });
    const stat = await fs.stat(dirPath);
    if (!stat.isDirectory()) {
      return makeCheck({
        id,
        title,
        category: 'storage',
        status: 'error',
        message: '路径存在但不是目录。',
        details: { path: dirPath },
        fixSuggestion: '请删除同名文件，并创建为目录。'
      });
    }
    const testPath = path.join(dirPath, `.health-write-${process.pid}-${Date.now()}.tmp`);
    await fs.writeFile(testPath, 'ok');
    await fs.rm(testPath, { force: true });
    return makeCheck({
      id,
      title,
      category: 'storage',
      status: 'healthy',
      message: '目录存在且可写。',
      details: { path: dirPath }
    });
  } catch (err) {
    return makeCheck({
      id,
      title,
      category: 'storage',
      status: 'error',
      message: '目录不存在或不可写。',
      details: { path: dirPath, errorCode: err.code || 'UNKNOWN' },
      fixSuggestion: '请检查目录权限，或以当前用户重新创建该目录。'
    });
  }
}

export async function checkEnvironment() {
  const summary = getProviderConfigSummary();
  return [
    makeCheck({
      id: 'env-basic',
      title: '基础环境变量',
      category: 'env',
      status: 'healthy',
      message: '基础环境变量已完成脱敏读取。',
      details: {
        NODE_ENV: process.env.NODE_ENV || 'development',
        PORT: process.env.PORT || '4000',
        AI_PROVIDER: process.env.AI_PROVIDER || 'mock',
        VISION_PROVIDER: process.env.VISION_PROVIDER || process.env.AI_PROVIDER || 'mock',
        IMAGE_PROVIDER: process.env.IMAGE_PROVIDER || process.env.AI_PROVIDER || 'mock',
        BACKGROUND_PROVIDER: process.env.BACKGROUND_PROVIDER || 'mock',
        REVIEW_PROVIDER: process.env.REVIEW_PROVIDER || 'mock',
        MATTING_PROVIDER: process.env.MATTING_PROVIDER || 'sharp',
        STORAGE_DRIVER: getStorageDriver(),
        SQLITE_DB_PATH: getSqliteDbPath(),
        SQLITE_AUTO_MIGRATE: process.env.SQLITE_AUTO_MIGRATE || 'false',
        selectedVisionProvider: summary.selectedVisionProvider,
        selectedImageProvider: summary.selectedImageProvider,
        selectedBackgroundProvider: summary.selectedBackgroundProvider,
        selectedReviewProvider: summary.selectedReviewProvider,
        selectedMattingProvider: summary.selectedMattingProvider
      }
    })
  ];
}

export async function checkProviderConfig() {
  const summary = getProviderConfigSummary();
  const selectedVision = summary.selectedVisionProvider;
  const selectedImage = summary.selectedImageProvider;
  const selectedBackground = summary.selectedBackgroundProvider;
  const selectedReview = summary.selectedReviewProvider;
  const selectedMatting = summary.selectedMattingProvider || 'sharp';
  const checks = [
    makeCheck({
      id: 'provider-key-status',
      title: 'Provider 密钥状态',
      category: 'provider',
      status: 'healthy',
      message: '仅显示是否已配置密钥，不显示任何真实值。',
      details: {
        hasGeminiCredential: Boolean(summary.hasGeminiKey),
        hasOpenAICredential: Boolean(summary.hasOpenAIKey),
        hasQwenCredential: Boolean(summary.hasQwenKey),
        hasMattingCredential: Boolean(process.env.MATTING_API_KEY),
        hasMattingEndpoint: Boolean(process.env.MATTING_BASE_URL)
      }
    })
  ];

  if (selectedVision === 'gemini' && !summary.hasGeminiKey) {
    checks.push(makeCheck({
      id: 'provider-vision-gemini-key',
      title: 'Gemini 识别配置',
      category: 'provider',
      status: 'warning',
      message: '当前选择 Gemini 识别，但未检测到 Gemini 密钥。',
      details: { selectedVisionProvider: selectedVision },
      fixSuggestion: '请在本地 .env 中配置 Gemini 密钥，或把 VISION_PROVIDER 改回 mock。'
    }));
  }
  if (selectedVision === 'openai' && !summary.hasOpenAIKey) {
    checks.push(makeCheck({
      id: 'provider-vision-openai-key',
      title: 'OpenAI 识别配置',
      category: 'provider',
      status: 'warning',
      message: '当前选择 OpenAI 识别，但未检测到 OpenAI 密钥。',
      details: { selectedVisionProvider: selectedVision },
      fixSuggestion: '请在本地 .env 中配置 OpenAI 密钥，或切换到 mock。'
    }));
  }
  if (selectedVision === 'qwen' && !summary.hasQwenKey) {
    checks.push(makeCheck({
      id: 'provider-vision-qwen-key',
      title: 'Qwen 识别配置',
      category: 'provider',
      status: 'warning',
      message: '当前选择 Qwen 识别，但未检测到 Qwen 密钥。',
      details: { selectedVisionProvider: selectedVision },
      fixSuggestion: '请在本地 .env 中配置 Qwen 密钥，或切换到 mock。'
    }));
  }
  if (selectedImage === 'real' && selectedBackground === 'openai' && !summary.hasOpenAIKey) {
    checks.push(makeCheck({
      id: 'provider-background-openai-key',
      title: 'OpenAI 真实背景生成配置',
      category: 'provider',
      status: 'error',
      message: '当前开启真实背景生成并选择 OpenAI，但未检测到 OpenAI 密钥。',
      details: { selectedImageProvider: selectedImage, selectedBackgroundProvider: selectedBackground },
      fixSuggestion: '请配置 OpenAI 密钥，或把 IMAGE_PROVIDER / BACKGROUND_PROVIDER 改为 mock。'
    }));
  }
  if (selectedReview === 'gemini' && !summary.hasGeminiKey) {
    checks.push(makeCheck({
      id: 'provider-review-gemini-key',
      title: 'Gemini 审核配置',
      category: 'provider',
      status: 'warning',
      message: '当前选择 Gemini 审核，但未检测到 Gemini 密钥。',
      details: { selectedReviewProvider: selectedReview },
      fixSuggestion: '请配置 Gemini 密钥，或把 REVIEW_PROVIDER 改为 mock。'
    }));
  }
  if (selectedReview === 'openai' && !summary.hasOpenAIKey) {
    checks.push(makeCheck({
      id: 'provider-review-openai-key',
      title: 'OpenAI 审核配置',
      category: 'provider',
      status: 'warning',
      message: '当前选择 OpenAI 审核，但未检测到 OpenAI 密钥。',
      details: { selectedReviewProvider: selectedReview },
      fixSuggestion: '请配置 OpenAI 密钥，或把 REVIEW_PROVIDER 改为 mock。'
    }));
  }
  if (selectedReview === 'qwen' && !summary.hasQwenKey) {
    checks.push(makeCheck({
      id: 'provider-review-qwen-key',
      title: 'Qwen 审核配置',
      category: 'provider',
      status: 'warning',
      message: '当前选择 Qwen 审核，但未检测到 Qwen 密钥。',
      details: { selectedReviewProvider: selectedReview },
      fixSuggestion: '请配置 Qwen 密钥，或把 REVIEW_PROVIDER 改为 mock。'
    }));
  }
  if (selectedMatting === 'external' && (!process.env.MATTING_API_KEY || !process.env.MATTING_BASE_URL)) {
    checks.push(makeCheck({
      id: 'provider-matting-external-config',
      title: '第三方抠图配置',
      category: 'provider',
      status: 'error',
      message: '当前选择 external 抠图，但未检测到完整第三方抠图配置。',
      details: {
        selectedMattingProvider: selectedMatting,
        hasMattingCredential: Boolean(process.env.MATTING_API_KEY),
        hasMattingEndpoint: Boolean(process.env.MATTING_BASE_URL)
      },
      fixSuggestion: '请补齐第三方抠图密钥和接口地址，或改用 MATTING_PROVIDER=sharp。'
    }));
  }

  if (checks.length === 1) {
    checks.push(makeCheck({
      id: 'provider-config-consistent',
      title: 'Provider 配置一致性',
      category: 'provider',
      status: 'healthy',
      message: '当前 provider 配置没有发现缺失依赖。',
      details: { selectedVision, selectedImage, selectedBackground, selectedReview, selectedMatting }
    }));
  }

  return checks;
}

export async function checkStoragePaths({ pathOverrides = {} } = {}) {
  const uploadDir = pathOverrides.uploadDir || paths.uploadDir;
  const outputDir = pathOverrides.outputDir || paths.outputDir;
  const backupDir = pathOverrides.backupsDir || backupsDir;
  const docsDir = pathOverrides.docsDir || path.join(paths.rootDir, 'docs');
  const envExamplePath = pathOverrides.envExamplePath || path.join(paths.rootDir, '.env.example');
  const dbPath = pathOverrides.dbPath || paths.dbPath;
  const checks = [
    await writableDirectoryCheck({ id: 'storage-uploads', title: 'uploads 原图目录', dirPath: uploadDir, create: true }),
    await writableDirectoryCheck({ id: 'storage-outputs', title: 'outputs 生成图目录', dirPath: outputDir, create: true }),
    await writableDirectoryCheck({ id: 'storage-backups', title: 'backups 快照目录', dirPath: backupDir, create: true })
  ];

  checks.push(makeCheck({
    id: 'storage-docs',
    title: 'docs 文档目录',
    category: 'storage',
    status: (await pathExists(docsDir)) ? 'healthy' : 'warning',
    message: (await pathExists(docsDir)) ? 'docs 目录存在。' : 'docs 目录不存在，报告和说明文档可能缺失。',
    details: { path: docsDir },
    fixSuggestion: '如需报告模板和说明文档，请恢复 docs 目录。'
  }));
  checks.push(makeCheck({
    id: 'storage-db-path',
    title: 'db.json 路径',
    category: 'storage',
    status: (await pathExists(dbPath)) ? 'healthy' : 'error',
    message: (await pathExists(dbPath)) ? '本地数据库文件存在。' : '本地数据库文件不存在。',
    details: { path: dbPath },
    fixSuggestion: '请启动后端让系统自动初始化，或从快照恢复 db.json。'
  }));
  checks.push(makeCheck({
    id: 'storage-env-example',
    title: '.env.example',
    category: 'storage',
    status: (await pathExists(envExamplePath)) ? 'healthy' : 'warning',
    message: (await pathExists(envExamplePath)) ? '.env.example 存在。' : '.env.example 缺失，环境变量示例不可用。',
    details: { path: envExamplePath },
    fixSuggestion: '请恢复 .env.example，方便后续配置 provider。'
  }));

  return checks;
}

export async function checkDatabaseHealth({ dbPathOverride, dataDirOverride } = {}) {
  if (!dbPathOverride && getStorageDriver() === 'sqlite') {
    return checkSqliteDatabaseHealth();
  }
  const dbPath = dbPathOverride || paths.dbPath;
  const dataDir = dataDirOverride || paths.dataDir;
  const checks = [
    makeCheck({
      id: 'database-storage-driver',
      title: '当前存储模式',
      category: 'database',
      status: 'healthy',
      message: '当前后端配置为 JSON 存储模式。',
      details: { storageDriver: 'json', dbPath }
    })
  ];
  let parsed = null;
  try {
    const raw = await fs.readFile(dbPath, 'utf8');
    checks.push(makeCheck({
      id: 'database-readable',
      title: 'db.json 可读取',
      category: 'database',
      status: 'healthy',
      message: 'db.json 可以读取。',
      details: { path: dbPath, size: raw.length }
    }));
    try {
      parsed = JSON.parse(raw);
      checks.push(makeCheck({
        id: 'database-json-valid',
        title: 'db.json JSON 合法性',
        category: 'database',
        status: 'healthy',
        message: 'db.json 是合法 JSON。'
      }));
    } catch (err) {
      checks.push(makeCheck({
        id: 'database-json-valid',
        title: 'db.json JSON 合法性',
        category: 'database',
        status: 'error',
        message: 'db.json 不是合法 JSON。',
        details: { errorMessage: err.message },
        fixSuggestion: '请从 backups 快照恢复，或手动修复 JSON 格式。'
      }));
      return checks;
    }
  } catch (err) {
    checks.push(makeCheck({
      id: 'database-readable',
      title: 'db.json 可读取',
      category: 'database',
      status: 'error',
      message: 'db.json 无法读取。',
      details: { path: dbPath, errorCode: err.code || 'UNKNOWN' },
      fixSuggestion: '请检查 backend/data/db.json 是否存在和权限是否正常。'
    }));
    return checks;
  }

  const requiredFields = ['tasks', 'batchTasks', 'importedFolders', 'workflowTemplates'];
  const missingFields = requiredFields.filter((field) => !Array.isArray(parsed[field]));
  if (!parsed.userSettings || typeof parsed.userSettings !== 'object') missingFields.push('userSettings');
  checks.push(makeCheck({
    id: 'database-schema-fields',
    title: 'db.json 关键字段',
    category: 'database',
    status: missingFields.length ? 'warning' : 'healthy',
    message: missingFields.length ? 'db.json 缺少部分关键字段，系统会尝试兼容，但建议修复。' : 'db.json 关键字段完整。',
    details: { missingFields },
    fixSuggestion: '可通过设置中心重置偏好，或从健康快照恢复完整 db。'
  }));

  try {
    await fs.mkdir(dataDir, { recursive: true });
    const tempPath = path.join(dataDir, `.health-atomic-write-${process.pid}-${Date.now()}.tmp`);
    await fs.writeFile(tempPath, JSON.stringify({ ok: true }));
    await fs.rm(tempPath, { force: true });
    checks.push(makeCheck({
      id: 'database-atomic-write',
      title: '数据库目录写入测试',
      category: 'database',
      status: 'healthy',
      message: '数据库目录可以写入临时文件，不会修改真实 db.json。',
      details: { dataDir }
    }));
  } catch (err) {
    checks.push(makeCheck({
      id: 'database-atomic-write',
      title: '数据库目录写入测试',
      category: 'database',
      status: 'error',
      message: '数据库目录无法写入临时文件。',
      details: { dataDir, errorCode: err.code || 'UNKNOWN' },
      fixSuggestion: '请检查 backend/data 目录权限。'
    }));
  }

  if (!dbPathOverride) {
    try {
      const storageStatus = await getStorageStatus();
      if (storageStatus.sqliteTrial?.status === 'ready' && storageStatus.sqliteDbExists && storageStatus.indexTablesReady) {
        checks.push(makeCheck({
          id: 'database-sqlite-ready-trial',
          title: 'SQLite 试运行状态',
          category: 'database',
          status: 'warning',
          message: 'SQLite 已验证通过，当前仍在 JSON 模式。可在 .env 手动切换后重启后端。',
          details: {
            storageDriver: storageStatus.storageDriver,
            sqlitePath: storageStatus.sqlitePath,
            schemaVersion: storageStatus.schemaVersion,
            sqliteTrialStatus: storageStatus.sqliteTrial.status,
            lastVerifiedAt: storageStatus.sqliteTrial.lastVerifiedAt
          },
          fixSuggestion: '如需试运行 SQLite，请手动设置 STORAGE_DRIVER=sqlite，确认 SQLITE_DB_PATH 后重启后端。'
        }));
      }
    } catch {
      // SQLite trial status is auxiliary; keep JSON health available.
    }
  }

  return checks;
}

export async function checkSqliteDatabaseHealth({ sqliteDbPathOverride } = {}) {
  const sqliteDbPath = sqliteDbPathOverride || getSqliteDbPath();
  const checks = [
    makeCheck({
      id: 'database-storage-driver',
      title: '当前存储模式',
      category: 'database',
      status: 'healthy',
      message: '当前后端配置为 SQLite 存储模式。',
      details: {
        storageDriver: 'sqlite',
        sqliteDbPath,
        autoMigrate: boolEnv('SQLITE_AUTO_MIGRATE', false)
      }
    })
  ];
  if (!(await pathExists(sqliteDbPath))) {
    checks.push(makeCheck({
      id: 'database-sqlite-file',
      title: 'SQLite 数据库文件',
      category: 'database',
      status: 'error',
      message: 'STORAGE_DRIVER=sqlite，但 SQLite 文件不存在。',
      details: { sqliteDbPath },
      fixSuggestion: '请先运行 cd backend && node scripts/migrateJsonToSqlite.js，然后重启后端。'
    }));
    return checks;
  }
  const store = new SqliteStore({ dbPath: sqliteDbPath });
  try {
    const db = store.getDatabase();
    const tableNames = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((row) => row.name);
    const versionRow = tableNames.includes('app_meta')
      ? db.prepare('SELECT value FROM app_meta WHERE key = ?').get('schemaVersion')
      : null;
    const schema = { schemaVersion: Number(versionRow?.value || 0), tableNames };
    const missingTables = REQUIRED_SQLITE_TABLES.filter((table) => !schema.tableNames.includes(table));
    const missingIndexTables = SQLITE_INDEX_TABLES.filter((table) => !schema.tableNames.includes(table));
    const schemaReady = schema.schemaVersion === SQLITE_SCHEMA_VERSION && missingTables.length === 0;
    checks.push(makeCheck({
      id: 'database-sqlite-file',
      title: 'SQLite 数据库文件',
      category: 'database',
      status: 'healthy',
      message: 'SQLite 数据库文件存在且可打开。',
      details: { sqliteDbPath }
    }));
    checks.push(makeCheck({
      id: 'database-sqlite-schema',
      title: 'SQLite schema',
      category: 'database',
      status: schemaReady ? 'healthy' : 'error',
      message: missingTables.length
        ? 'SQLite 缺少必要表。'
        : schema.schemaVersion === SQLITE_SCHEMA_VERSION
          ? `SQLite schemaVersion=${schema.schemaVersion}，必要表存在。`
          : `SQLite schemaVersion=${schema.schemaVersion}，需要 schemaVersion=${SQLITE_SCHEMA_VERSION}。`,
      details: { schemaVersion: schema.schemaVersion, missingTables },
      fixSuggestion: schemaReady ? '' : '请重新运行迁移脚本或从快照恢复 SQLite 文件。'
    }));
    checks.push(makeCheck({
      id: 'database-sqlite-index-tables',
      title: 'SQLite v2 索引表',
      category: 'database',
      status: missingIndexTables.length ? 'warning' : 'healthy',
      message: missingIndexTables.length ? 'SQLite v2 索引表缺失或不完整。' : 'SQLite v2 索引表存在。',
      details: { missingIndexTables },
      fixSuggestion: missingIndexTables.length ? '请运行 cd backend && node scripts/rebuildSqliteIndexes.js --sqlite。' : ''
    }));
    if (!missingIndexTables.length) {
      const indexCounts = {
        batchSkuIndex: db.prepare('SELECT COUNT(*) AS count FROM batch_sku_index').get().count,
        batchQueueIndex: db.prepare('SELECT COUNT(*) AS count FROM batch_queue_index').get().count,
        batchAnalyticsIndex: db.prepare('SELECT COUNT(*) AS count FROM batch_analytics_index').get().count,
        providerUsageIndex: db.prepare('SELECT COUNT(*) AS count FROM provider_usage_index').get().count,
        reviewRiskIndex: db.prepare('SELECT COUNT(*) AS count FROM review_risk_index').get().count
      };
      const lastIndexUpdatedAt = [
        'batch_sku_index',
        'batch_queue_index',
        'batch_analytics_index',
        'provider_usage_index',
        'review_risk_index'
      ].map((table) => db.prepare(`SELECT MAX(updated_at) AS updated_at FROM ${table}`).get().updated_at)
        .filter(Boolean)
        .sort()
        .at(-1) || null;
      const batchCount = schema.tableNames.includes('batch_tasks')
        ? db.prepare('SELECT COUNT(*) AS count FROM batch_tasks').get().count
        : 0;
      const indexMismatch = batchCount > 0 && indexCounts.batchQueueIndex !== batchCount;
      checks.push(makeCheck({
        id: 'database-sqlite-index-counts',
        title: 'SQLite 索引行数',
        category: 'database',
        status: indexMismatch ? 'warning' : 'healthy',
        message: 'SQLite 索引表行数已读取。',
        details: { ...indexCounts, batchCount, lastIndexUpdatedAt },
        fixSuggestion: indexMismatch ? '索引数量和主数据不一致，请运行 rebuildSqliteIndexes。' : ''
      }));
    }
    try {
      const taskCount = schema.tableNames.includes('tasks')
        ? db.prepare('SELECT COUNT(*) AS count FROM tasks').get().count
        : 0;
      const batchCount = schema.tableNames.includes('batch_tasks')
        ? db.prepare('SELECT COUNT(*) AS count FROM batch_tasks').get().count
        : 0;
      checks.push(makeCheck({
        id: 'database-sqlite-readable-data',
        title: 'SQLite 任务和 batch 读取',
        category: 'database',
        status: 'healthy',
        message: 'SQLite 任务和 batch 可读取。',
        details: { taskCount, batchCount }
      }));
    } catch (err) {
      checks.push(makeCheck({
        id: 'database-sqlite-readable-data',
        title: 'SQLite 任务和 batch 读取',
        category: 'database',
        status: 'error',
        message: 'SQLite 任务或 batch 无法读取。',
        details: { errorCode: err.code || 'UNKNOWN', errorMessage: err.message },
        fixSuggestion: '请检查 SQLite 表结构或从快照恢复 SQLite 文件。'
      }));
    }
    try {
      const storageStatus = await getStorageStatus();
      const jsonNotSyncedWarning = storageStatus.warnings?.some((warning) => warning.code === 'SQLITE_MODE_JSON_NOT_SYNCED');
      const failedByMigrationConsistency = storageStatus.storageDriver === 'sqlite'
        && storageStatus.sqliteTrial?.status === 'failed'
        && hasMigrationConsistencyFailure(storageStatus.sqliteTrial?.lastVerificationReport);
      const useJsonNotSyncedMessage = jsonNotSyncedWarning || failedByMigrationConsistency;
      checks.push(makeCheck({
        id: 'database-sqlite-trial-status',
        title: 'SQLite 试运行记录',
        category: 'database',
        status: storageStatus.sqliteTrial?.status === 'failed' ? 'warning' : 'healthy',
        message: storageStatus.sqliteTrial?.status === 'failed'
          ? useJsonNotSyncedMessage
            ? SQLITE_MODE_JSON_NOT_SYNCED_WARNING
            : '最近一次 SQLite 验证失败，请检查 SQLite 运行态。'
          : 'SQLite 试运行记录可读取。',
        details: {
          sqliteTrialStatus: storageStatus.sqliteTrial?.status,
          lastVerifiedAt: storageStatus.sqliteTrial?.lastVerifiedAt,
          sqlitePath: storageStatus.sqlitePath,
          warnings: storageStatus.warnings || []
        },
        fixSuggestion: storageStatus.sqliteTrial?.status === 'failed'
          ? useJsonNotSyncedMessage
            ? ''
            : '请检查 SQLite schema、索引表和读写状态。'
          : ''
      }));
    } catch {
      // Keep database health focused on primary SQLite checks.
    }
    try {
      db.prepare('CREATE TEMP TABLE IF NOT EXISTS health_write_test (ok INTEGER)').run();
      db.prepare('DROP TABLE IF EXISTS health_write_test').run();
      checks.push(makeCheck({
        id: 'database-sqlite-writable',
        title: 'SQLite 写入测试',
        category: 'database',
        status: 'healthy',
        message: 'SQLite 可读写。'
      }));
    } catch (err) {
      checks.push(makeCheck({
        id: 'database-sqlite-writable',
        title: 'SQLite 写入测试',
        category: 'database',
        status: 'error',
        message: 'SQLite 无法写入。',
        details: { errorCode: err.code || 'UNKNOWN', errorMessage: err.message },
        fixSuggestion: '请检查 backend/data 目录权限或 SQLite 文件锁。'
      }));
    }
  } catch (err) {
    checks.push(makeCheck({
      id: 'database-sqlite-open',
      title: 'SQLite 打开状态',
      category: 'database',
      status: 'error',
      message: 'SQLite 数据库无法打开或初始化。',
      details: { errorMessage: err.message },
      fixSuggestion: '请检查 SQLITE_DB_PATH，或重新运行迁移脚本。'
    }));
  } finally {
    store.close();
  }
  return checks;
}

export async function checkSnapshotHealth() {
  try {
    const snapshots = await listSnapshots();
    const latest = snapshots[0] || null;
    const oversized = snapshots.filter((snapshot) => snapshot.size > ONE_GB);
    const preRestore = snapshots.filter((snapshot) => (
      Array.isArray(snapshot.metadata?.notes) &&
      snapshot.metadata.notes.some((note) => /pre-restore/i.test(note))
    ));
    return [
      makeCheck({
        id: 'snapshot-directory',
        title: '快照目录',
        category: 'snapshot',
        status: 'healthy',
        message: 'backups 快照目录可访问。',
        details: { backupsDir }
      }),
      makeCheck({
        id: 'snapshot-summary',
        title: '快照概览',
        category: 'snapshot',
        status: snapshots.length ? 'healthy' : 'warning',
        message: snapshots.length ? `当前共有 ${snapshots.length} 个快照。` : '当前还没有任何项目快照。',
        details: {
          count: snapshots.length,
          latestSnapshotAt: latest?.createdAt || null,
          oversizedCount: oversized.length,
          preRestoreCount: preRestore.length
        },
        fixSuggestion: snapshots.length ? '' : '建议在真实运营前手动创建一次快照。'
      })
    ];
  } catch (err) {
    return [makeCheck({
      id: 'snapshot-health',
      title: '快照检查',
      category: 'snapshot',
      status: 'error',
      message: '快照目录或快照文件无法读取。',
      details: { errorMessage: err.message },
      fixSuggestion: '请检查 backups 目录权限，或删除损坏的快照文件。'
    })];
  }
}

function isDangerousImportRoot(rootDir) {
  if (!rootDir) return false;
  if (String(rootDir).includes('..')) return true;
  const resolved = path.resolve(rootDir);
  const parsed = path.parse(resolved);
  if (resolved === parsed.root) return true;
  const home = os.homedir();
  if (home && path.resolve(home) === resolved) return true;
  const systemRoot = process.env.SystemRoot || process.env.WINDIR;
  if (systemRoot && resolved.toLowerCase().startsWith(path.resolve(systemRoot).toLowerCase())) return true;
  return false;
}

export async function checkImportScanHealth() {
  const enabled = boolEnv('IMPORT_SCAN_ENABLED', false);
  const rootDir = process.env.IMPORT_ROOT_DIR || '';
  const checks = [
    makeCheck({
      id: 'import-scan-config',
      title: '导入扫描开关',
      category: 'import',
      status: enabled ? 'healthy' : 'warning',
      message: enabled ? '导入目录扫描已开启。' : '导入目录扫描未开启。',
      details: {
        enabled,
        rootConfigured: Boolean(rootDir),
        maxDepth: numberEnv('IMPORT_SCAN_MAX_DEPTH', 2),
        maxSku: numberEnv('IMPORT_SCAN_MAX_SKU', 200),
        allowedExtensions: process.env.IMPORT_SCAN_ALLOWED_EXTENSIONS || 'jpg,jpeg,png,webp'
      },
      fixSuggestion: enabled ? '' : '如需使用扫描导入，请在 .env 或设置中心启用扫描并配置安全导入目录。'
    })
  ];
  if (!enabled) return checks;
  if (!rootDir) {
    checks.push(makeCheck({
      id: 'import-root-configured',
      title: '导入根目录',
      category: 'import',
      status: 'error',
      message: '扫描已开启，但导入根目录未配置。',
      details: {},
      fixSuggestion: '请配置 IMPORT_ROOT_DIR，且不要指向系统目录。'
    }));
    return checks;
  }
  if (isDangerousImportRoot(rootDir)) {
    checks.push(makeCheck({
      id: 'import-root-safe',
      title: '导入根目录安全性',
      category: 'import',
      status: 'error',
      message: '导入根目录看起来不安全，可能指向系统目录或包含路径穿越。',
      details: { rootDir: path.resolve(rootDir) },
      fixSuggestion: '请改成专用的本地商品图导入目录，例如 D:\\imports\\crossborder。'
    }));
    return checks;
  }
  try {
    const stat = await fs.stat(rootDir);
    checks.push(makeCheck({
      id: 'import-root-readable',
      title: '导入根目录可读性',
      category: 'import',
      status: stat.isDirectory() ? 'healthy' : 'error',
      message: stat.isDirectory() ? '导入根目录存在且可读取。' : '导入根目录不是目录。',
      details: { rootDir: path.resolve(rootDir) },
      fixSuggestion: stat.isDirectory() ? '' : '请配置一个真实目录作为导入根目录。'
    }));
  } catch (err) {
    checks.push(makeCheck({
      id: 'import-root-readable',
      title: '导入根目录可读性',
      category: 'import',
      status: 'error',
      message: '导入根目录不存在或不可读取。',
      details: { rootDir: path.resolve(rootDir), errorCode: err.code || 'UNKNOWN' },
      fixSuggestion: '请创建该目录，或在设置中心更新导入目录。'
    }));
  }
  return checks;
}

export async function checkBatchQueueHealth() {
  try {
    const batches = await listBatchTasks();
    const now = Date.now();
    const runningLocks = [];
    const expiredLocks = [];
    const longPaused = [];
    let failedSku = 0;
    let retryableFailedSku = 0;
    for (const batch of batches) {
      const lock = batch.locks || {};
      if (lock.isRunning) {
        const expired = lock.expiresAt && new Date(lock.expiresAt).getTime() < now;
        (expired ? expiredLocks : runningLocks).push({ batchId: batch.id, action: batch.queue?.action || null, expiresAt: lock.expiresAt || null });
      }
      if (batch.queue?.status === 'paused' && batch.queue?.pausedAt && now - new Date(batch.queue.pausedAt).getTime() > 60 * 60 * 1000) {
        longPaused.push({ batchId: batch.id, pausedAt: batch.queue.pausedAt });
      }
      for (const sku of batch.skuTasks || []) {
        if (sku.status === 'failed' || sku.queueStatus === 'failed') {
          failedSku += 1;
          if (sku.retryable) retryableFailedSku += 1;
        }
      }
    }
    return [
      makeCheck({
        id: 'queue-running-lock',
        title: '批量队列运行锁',
        category: 'queue',
        status: runningLocks.length ? 'warning' : 'healthy',
        message: runningLocks.length ? `当前有 ${runningLocks.length} 个 batch 正在运行或持有锁。` : '没有发现正在运行的批量队列锁。',
        details: { runningLocks },
        fixSuggestion: '如果页面长时间停在 running，请等待任务完成，或在 BatchPage 检查队列日志。'
      }),
      makeCheck({
        id: 'queue-expired-lock',
        title: '批量队列过期锁',
        category: 'queue',
        status: expiredLocks.length ? 'warning' : 'healthy',
        message: expiredLocks.length ? `发现 ${expiredLocks.length} 个过期队列锁。` : '没有发现过期队列锁。',
        details: { expiredLocks },
        fixSuggestion: '进入对应 BatchPage 后重新启动队列，系统会接管过期锁。'
      }),
      makeCheck({
        id: 'queue-paused-long',
        title: '长期暂停队列',
        category: 'queue',
        status: longPaused.length ? 'warning' : 'healthy',
        message: longPaused.length ? `发现 ${longPaused.length} 个长时间暂停的队列。` : '没有发现长时间暂停队列。',
        details: { longPaused },
        fixSuggestion: '请恢复、取消或导出当前批量任务状态。'
      }),
      makeCheck({
        id: 'queue-failure-summary',
        title: '批量 SKU 失败概览',
        category: 'queue',
        status: failedSku > 10 ? 'warning' : 'healthy',
        message: failedSku ? `当前共有 ${failedSku} 个失败 SKU，其中 ${retryableFailedSku} 个可重试。` : '没有发现失败 SKU。',
        details: { failedSku, retryableFailedSku },
        fixSuggestion: failedSku ? '请在 BatchPage 的失败原因分析中查看是否可重试或需要人工处理。' : ''
      })
    ];
  } catch (err) {
    return [makeCheck({
      id: 'queue-health',
      title: '批量队列检查',
      category: 'queue',
      status: 'error',
      message: '无法读取批量队列状态。',
      details: { errorMessage: err.message },
      fixSuggestion: '请检查 db.json 是否可读，或从快照恢复。'
    })];
  }
}

export async function checkDiskUsage() {
  const checks = [];
  try {
    if (typeof fs.statfs === 'function') {
      const stat = await fs.statfs(paths.rootDir);
      const freeBytes = stat.bavail * stat.bsize;
      checks.push(makeCheck({
        id: 'disk-free-space',
        title: '项目磁盘剩余空间',
        category: 'storage',
        status: freeBytes < 2 * ONE_GB ? 'warning' : 'healthy',
        message: `项目所在磁盘剩余空间约 ${bytes(freeBytes)}。`,
        details: { freeBytes },
        fixSuggestion: freeBytes < 2 * ONE_GB ? '请清理 outputs、backups 或迁移项目到空间更充足的磁盘。' : ''
      }));
    }
  } catch (err) {
    checks.push(makeCheck({
      id: 'disk-free-space',
      title: '项目磁盘剩余空间',
      category: 'storage',
      status: 'warning',
      message: '当前 Node 环境无法读取磁盘剩余空间。',
      details: { errorCode: err.code || 'UNKNOWN' }
    }));
  }

  const dirs = [
    ['disk-uploads-size', 'uploads 目录大小', paths.uploadDir],
    ['disk-outputs-size', 'outputs 目录大小', paths.outputDir],
    ['disk-backups-size', 'backups 目录大小', backupsDir],
    ['disk-vision-tmp-size', '.vision-tmp 目录大小', path.join(paths.rootDir, '.vision-tmp')]
  ];
  for (const [id, title, dirPath] of dirs) {
    const size = await directorySize(dirPath);
    checks.push(makeCheck({
      id,
      title,
      category: 'storage',
      status: size.totalSize > 5 * ONE_GB ? 'warning' : 'healthy',
      message: `${title}：${bytes(size.totalSize)}，文件数 ${size.count}。`,
      details: { path: dirPath, totalSize: size.totalSize, fileCount: size.count },
      fixSuggestion: size.totalSize > 5 * ONE_GB ? '目录较大，请按需清理历史输出或快照。' : ''
    }));
  }
  return checks;
}

export async function checkFrontendBackendUrls() {
  return [
    makeCheck({
      id: 'network-backend-url',
      title: '后端访问地址',
      category: 'network',
      status: 'healthy',
      message: `后端健康检查地址应为 http://localhost:${process.env.PORT || 4000}/api/health。`,
      details: { port: process.env.PORT || '4000' }
    }),
    makeCheck({
      id: 'network-frontend-url',
      title: '前端访问地址',
      category: 'network',
      status: 'healthy',
      message: '前端开发地址应为 http://localhost:5173/。',
      details: { frontendUrl: 'http://localhost:5173/' }
    })
  ];
}

export async function checkSecurity() {
  const gitignorePath = path.join(paths.rootDir, '.gitignore');
  const readmePath = path.join(paths.rootDir, 'README.md');
  let gitignore = '';
  let readme = '';
  try {
    gitignore = await fs.readFile(gitignorePath, 'utf8');
  } catch {}
  try {
    readme = await fs.readFile(readmePath, 'utf8');
  } catch {}
  const backupsIgnored = /(^|\n)backups\/?(\n|$)/.test(gitignore);
  const envIgnored = /(^|\n)\.env(\n|$)/.test(gitignore);
  const nodeModulesIgnored = /node_modules/.test(gitignore);
  const readmeWarnsKeys = /API Key|密钥|\.env/i.test(readme);
  return [
    makeCheck({
      id: 'security-gitignore',
      title: '敏感和大目录 Git 忽略',
      category: 'security',
      status: backupsIgnored && envIgnored && nodeModulesIgnored ? 'healthy' : 'warning',
      message: backupsIgnored && envIgnored && nodeModulesIgnored ? '关键本地目录已配置 Git 忽略。' : '部分本地目录或敏感配置未在 .gitignore 中明确忽略。',
      details: { backupsIgnored, envIgnored, nodeModulesIgnored },
      fixSuggestion: '请确认 .env、node_modules、backups 不会提交到代码仓库。'
    }),
    makeCheck({
      id: 'security-readme-warning',
      title: 'README 安全提醒',
      category: 'security',
      status: readmeWarnsKeys ? 'healthy' : 'warning',
      message: readmeWarnsKeys ? 'README 中包含密钥和 .env 安全提醒。' : 'README 中缺少明显的密钥安全提醒。',
      details: { readmePath },
      fixSuggestion: '请在 README 中提醒不要上传 .env 或真实密钥。'
    })
  ];
}

export async function runSystemHealthCheck() {
  const groups = await Promise.all([
    checkEnvironment(),
    checkProviderConfig(),
    checkStoragePaths(),
    checkDatabaseHealth(),
    checkSnapshotHealth(),
    checkImportScanHealth(),
    checkBatchQueueHealth(),
    checkDiskUsage(),
    checkFrontendBackendUrls(),
    checkSecurity()
  ]);
  return buildHealthResult(groups.flat());
}

function markdownEscape(value) {
  return String(value ?? '').replace(/\|/g, '\\|');
}

function safeDetailsForMarkdown(details = {}) {
  const clean = sanitizeDetails(details);
  return JSON.stringify(clean, null, 2)
    .replace(/"[^"]*(api[_-]?key|secret|token|password|credential)[^"]*"\s*:\s*"[^"]*",?/gi, '')
    .replace(/(api[_-]?key|secret|token|password|credential)/gi, '[redacted]');
}

export function renderHealthReportMarkdown(healthResult) {
  const result = {
    ...healthResult,
    checks: (healthResult.checks || []).map((check) => ({
      ...check,
      details: sanitizeDetails(check.details || {})
    }))
  };
  const lines = [
    '# CrossBorder Image Agent 系统健康检查报告',
    '',
    `- 检查时间：${result.checkedAt || nowIso()}`,
    `- 总体状态：${result.overallStatus || 'unknown'}`,
    `- 错误数：${result.summary?.errorCount || 0}`,
    `- 警告数：${result.summary?.warningCount || 0}`,
    ''
  ];
  const labels = {
    env: '基础环境',
    provider: 'Provider 配置',
    storage: '存储目录',
    database: '数据库',
    snapshot: '快照',
    queue: '批量队列',
    import: '导入扫描',
    network: '前后端地址',
    security: '安全'
  };
  for (const category of Object.keys(labels)) {
    const checks = result.checks.filter((check) => check.category === category);
    if (!checks.length) continue;
    lines.push(`## ${labels[category]}`, '');
    lines.push('| 状态 | 检查项 | 说明 | 修复建议 |');
    lines.push('|---|---|---|---|');
    for (const check of checks) {
      lines.push(`| ${markdownEscape(check.status)} | ${markdownEscape(check.title)} | ${markdownEscape(check.message)} | ${markdownEscape(check.fixSuggestion || '')} |`);
    }
    lines.push('');
  }
  const problemChecks = result.checks.filter((check) => check.status !== 'healthy');
  lines.push('## 修复建议', '');
  if (!problemChecks.length) {
    lines.push('- 当前没有需要处理的错误或警告。');
  } else {
    for (const check of problemChecks) {
      lines.push(`- [${check.status}] ${check.title}：${check.fixSuggestion || check.message}`);
    }
  }
  lines.push('');
  lines.push('## 脱敏详情', '');
  for (const check of result.checks) {
    if (!check.details || !Object.keys(check.details).length) continue;
    lines.push(`### ${check.title}`);
    lines.push('```json');
    lines.push(safeDetailsForMarkdown(check.details));
    lines.push('```');
  }
  return lines.join('\n');
}

export async function getScopedHealth(scope) {
  if (scope === 'providers') {
    return buildHealthResult([...(await checkEnvironment()), ...(await checkProviderConfig())]);
  }
  if (scope === 'storage') {
    return buildHealthResult([...(await checkStoragePaths()), ...(await checkDiskUsage()), ...(await checkSnapshotHealth())]);
  }
  if (scope === 'database') {
    return buildHealthResult(await checkDatabaseHealth());
  }
  return runSystemHealthCheck();
}
