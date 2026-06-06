import { getStorageStatus } from './storageTrialService.js';
import { listSnapshots } from './snapshotService.js';
import { listBatchTasks, listTasks } from './db.js';
import { getUserSettings, updateUserSettings } from './userSettingsService.js';

const CHECKLIST_DEFINITIONS = [
  ['snapshot_created', '已创建项目快照'],
  ['preflight_done', '已执行迁移前检查'],
  ['sqlite_exists', 'app.sqlite 已存在'],
  ['migration_done', '已完成 JSON 到 SQLite 迁移'],
  ['schema_v2', 'SQLite schemaVersion 为 2'],
  ['verification_done', '已完成 SQLite 验证'],
  ['index_ready', '已确认 SQLite v2 索引正常'],
  ['env_sqlite_enabled', '.env 已设置 STORAGE_DRIVER=sqlite'],
  ['backend_restarted', '后端已按 SQLite 配置重启'],
  ['health_sqlite_healthy', 'HealthPage 显示 SQLite healthy'],
  ['single_sku_mock_flow', '单 SKU mock 流程跑通'],
  ['batch_mock_flow', '批量 1-2 个 SKU mock 流程跑通'],
  ['batch_analytics_ok', 'Batch Analytics 正常'],
  ['snapshot_after_trial', 'SQLite 模式下能创建快照'],
  ['export_zip_ok', 'SQLite 模式下导出 ZIP 正常'],
  ['json_rollback_documented', 'JSON 回退步骤已记录']
];

function nowIso() {
  return new Date().toISOString();
}

function item(definition, status = 'not_started', message = '', details = {}) {
  return {
    id: definition[0],
    title: definition[1],
    status,
    message,
    details
  };
}

function hasGeneratedTask(task = {}) {
  return Array.isArray(task.generatedImages) && task.generatedImages.length > 0;
}

function hasExportedTask(task = {}) {
  return task.status === 'exported' || task.exportedAt || task.exportMeta || task.exportedPackage;
}

function summarizeStatus(items) {
  if (items.some((entry) => entry.status === 'failed')) return 'failed';
  if (items.some((entry) => entry.status === 'warning')) return 'warning';
  if (items.every((entry) => entry.status === 'completed')) return 'healthy';
  return 'running';
}

function recommend(items, storageStatus) {
  const byId = Object.fromEntries(items.map((entry) => [entry.id, entry]));
  if (byId.sqlite_exists?.status === 'failed') return { code: 'MIGRATE_SQLITE', message: '请先在 StoragePage 执行迁移，生成 app.sqlite。' };
  if (byId.schema_v2?.status === 'failed') return { code: 'UPGRADE_OR_REBUILD_SQLITE', message: 'SQLite schemaVersion 不是 2，请重新迁移或重建 schema。' };
  if (byId.index_ready?.status === 'failed') return { code: 'REBUILD_INDEXES', message: 'SQLite 索引表缺失或异常，请先重建索引。' };
  if (byId.verification_done?.status !== 'completed') return { code: 'VERIFY_SQLITE', message: '请先执行 SQLite 验证。' };
  if (storageStatus.storageDriver !== 'sqlite') return { code: 'SWITCH_ENV_MANUALLY', message: 'SQLite 已准备好后，请手动设置 STORAGE_DRIVER=sqlite 并重启后端。' };
  if (byId.single_sku_mock_flow?.status !== 'completed') return { code: 'RUN_SINGLE_SKU_MOCK', message: '请用 1 个 SKU 跑一遍 mock 流程。' };
  if (byId.batch_mock_flow?.status !== 'completed') return { code: 'RUN_SMALL_BATCH_MOCK', message: '请用 1 个 batch、1-2 个 SKU 跑一遍 mock 流程。' };
  return { code: 'CONTINUE_SQLITE_TRIAL', message: 'SQLite 小批量试运行条件良好，可继续观察。' };
}

export function getSqliteTrialChecklist() {
  return {
    version: 'v4.9',
    items: CHECKLIST_DEFINITIONS.map((definition) => item(definition)),
    rollbackEnv: 'STORAGE_DRIVER=json',
    note: 'Checklist is advisory and never calls real AI.'
  };
}

export async function runSqliteTrialChecklist() {
  const checkedAt = nowIso();
  const storageStatus = await getStorageStatus();
  const settings = await getUserSettings();
  const snapshots = await listSnapshots().catch(() => []);
  const tasks = await listTasks().catch(() => []);
  const batches = await listBatchTasks().catch(() => []);
  const sqliteExists = storageStatus.sqliteDbExists;
  const schemaV2 = Number(storageStatus.schemaVersion || 0) === 2;
  const indexReady = Boolean(storageStatus.indexTablesReady);
  const sqliteVerified = storageStatus.sqliteTrial?.status === 'ready' || storageStatus.sqliteTrial?.lastVerificationReport?.success === true;
  const sqliteMode = storageStatus.storageDriver === 'sqlite';
  const generatedTasks = tasks.filter(hasGeneratedTask);
  const exportedTasks = tasks.filter(hasExportedTask);
  const generatedBatches = batches.filter((batch) => ['generated', 'reviewed', 'completed', 'exported'].includes(batch.status) || (batch.summary?.totalImages || 0) > 0);
  const analyticsBatches = batches.filter((batch) => batch.analytics);

  const definitions = Object.fromEntries(CHECKLIST_DEFINITIONS.map((definition) => [definition[0], definition]));
  const items = [
    item(definitions.snapshot_created, snapshots.length ? 'completed' : 'warning', snapshots.length ? '已发现项目快照。' : '建议先创建项目快照。', { snapshotCount: snapshots.length }),
    item(definitions.preflight_done, storageStatus.sqliteTrial?.lastMigrationReport ? 'completed' : 'warning', storageStatus.sqliteTrial?.lastMigrationReport ? '迁移报告存在，说明已做过迁移准备。' : '建议先执行迁移前检查。'),
    item(definitions.sqlite_exists, sqliteExists ? 'completed' : 'failed', sqliteExists ? 'app.sqlite 存在。' : '未发现 app.sqlite，请先迁移。', { sqlitePath: storageStatus.sqlitePath }),
    item(definitions.migration_done, sqliteExists ? 'completed' : 'failed', sqliteExists ? 'app.sqlite 存在，迁移产物可读取。' : '未发现 app.sqlite，请先迁移。', { sqlitePath: storageStatus.sqlitePath }),
    item(definitions.schema_v2, schemaV2 ? 'completed' : 'failed', schemaV2 ? 'SQLite schemaVersion=2。' : 'SQLite schemaVersion 不是 2，请重新迁移或升级。', { schemaVersion: storageStatus.schemaVersion }),
    item(definitions.verification_done, sqliteVerified ? 'completed' : 'warning', sqliteVerified ? 'SQLite 已验证通过。' : '尚未发现通过的 SQLite 验证报告。', { lastVerifiedAt: storageStatus.sqliteTrial?.lastVerifiedAt }),
    item(definitions.index_ready, indexReady ? 'completed' : 'failed', indexReady ? 'SQLite v2 索引表正常。' : 'SQLite v2 索引表缺失或未准备好。', { indexCounts: storageStatus.indexCounts }),
    item(definitions.env_sqlite_enabled, sqliteMode ? 'completed' : 'warning', sqliteMode ? '当前后端正在 SQLite 模式运行。' : '当前仍是 JSON 模式，需要手动切换 .env。', { storageDriver: storageStatus.storageDriver }),
    item(definitions.backend_restarted, sqliteMode ? 'completed' : 'warning', sqliteMode ? '后端已以 SQLite 配置运行。' : '切换 .env 后需要重启后端。'),
    item(definitions.health_sqlite_healthy, sqliteMode && schemaV2 && indexReady ? 'completed' : (sqliteExists ? 'warning' : 'failed'), sqliteMode && schemaV2 && indexReady ? 'SQLite 健康状态良好。' : '请打开 HealthPage 查看 SQLite 健康状态。', { schemaVersion: storageStatus.schemaVersion }),
    item(definitions.single_sku_mock_flow, generatedTasks.length ? 'completed' : 'warning', generatedTasks.length ? '发现已生成图片的单 SKU task。' : '建议用 1 个 SKU 跑一遍 mock 流程。', { generatedTaskCount: generatedTasks.length }),
    item(definitions.batch_mock_flow, generatedBatches.length ? 'completed' : 'warning', generatedBatches.length ? '发现已生成图片的 batch。' : '建议用 1 个小 batch 跑一遍 mock 流程。', { generatedBatchCount: generatedBatches.length }),
    item(definitions.batch_analytics_ok, analyticsBatches.length ? 'completed' : 'warning', analyticsBatches.length ? '发现 batch analytics。' : '建议刷新 Batch Analytics。', { analyticsBatchCount: analyticsBatches.length }),
    item(definitions.snapshot_after_trial, sqliteMode && snapshots.length ? 'completed' : 'warning', sqliteMode && snapshots.length ? 'SQLite 模式下存在快照记录。' : '切换 SQLite 后建议再创建一次快照。'),
    item(definitions.export_zip_ok, exportedTasks.length ? 'completed' : 'warning', exportedTasks.length ? '发现导出过的 task。' : '建议在 SQLite 模式下导出一次 ZIP 验证。', { exportedTaskCount: exportedTasks.length }),
    item(definitions.json_rollback_documented, 'completed', '回退方式：设置 STORAGE_DRIVER=json 并重启后端。')
  ];

  const status = summarizeStatus(items);
  const report = {
    checklistVersion: 'v4.9',
    checkedAt,
    storageDriver: storageStatus.storageDriver,
    sqlitePath: storageStatus.sqlitePath,
    schemaVersion: storageStatus.schemaVersion,
    overallStatus: status,
    items,
    recommendedAction: recommend(items, storageStatus),
    counts: {
      tasks: tasks.length,
      batches: batches.length,
      snapshots: snapshots.length,
      generatedTasks: generatedTasks.length,
      generatedBatches: generatedBatches.length,
      analyticsBatches: analyticsBatches.length
    },
    rollback: {
      env: 'STORAGE_DRIVER=json',
      message: '如果 SQLite 试运行异常，请改回 STORAGE_DRIVER=json 并重启后端。'
    },
    safety: {
      callsRealAI: false,
      includesApiKeys: false
    },
    warnings: storageStatus.warnings || []
  };
  return recordSqliteTrialResult(report, settings);
}

export async function recordSqliteTrialResult(result, existingSettings = null) {
  const sanitized = JSON.parse(JSON.stringify(result || {}));
  const settings = existingSettings || await getUserSettings();
  const updated = await updateUserSettings({
    sqliteTrial: {
      ...(settings.sqliteTrial || {}),
      lastTrialCheckAt: sanitized.checkedAt || nowIso(),
      lastTrialCheckStatus: sanitized.overallStatus || 'unknown',
      lastTrialCheckReport: sanitized,
      trialChecklist: sanitized.items || []
    }
  });
  return {
    ...sanitized,
    sqliteTrial: updated.sqliteTrial
  };
}
