export const SQLITE_SCHEMA_VERSION = 2;

export const EMPTY_DB = {
  tasks: [],
  batchTasks: [],
  importedFolders: [],
  workflowTemplates: [],
  userSettings: null
};

export const CREATE_SCHEMA_SQL = [
  `CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY,
    status TEXT,
    sku TEXT,
    created_at TEXT,
    updated_at TEXT,
    data_json TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS batch_tasks (
    id TEXT PRIMARY KEY,
    status TEXT,
    name TEXT,
    created_at TEXT,
    updated_at TEXT,
    data_json TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS user_settings (
    id TEXT PRIMARY KEY,
    updated_at TEXT,
    data_json TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS workflow_templates (
    id TEXT PRIMARY KEY,
    type TEXT,
    name TEXT,
    updated_at TEXT,
    data_json TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS imported_folders (
    folder_path TEXT PRIMARY KEY,
    imported_at TEXT,
    data_json TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS app_meta (
    key TEXT PRIMARY KEY,
    value TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS batch_sku_index (
    batch_id TEXT NOT NULL,
    task_id TEXT NOT NULL,
    sku_id TEXT,
    folder_name TEXT,
    status TEXT,
    current_step TEXT,
    queue_status TEXT,
    last_error_code TEXT,
    last_error_category TEXT,
    retryable INTEGER,
    requires_user_action INTEGER,
    updated_at TEXT,
    PRIMARY KEY (batch_id, task_id)
  )`,
  `CREATE TABLE IF NOT EXISTS batch_queue_index (
    batch_id TEXT PRIMARY KEY,
    queue_status TEXT,
    action TEXT,
    concurrency INTEGER,
    pending_jobs INTEGER,
    running_jobs INTEGER,
    completed_jobs INTEGER,
    failed_jobs INTEGER,
    skipped_jobs INTEGER,
    locked INTEGER,
    locked_at TEXT,
    updated_at TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS batch_analytics_index (
    batch_id TEXT PRIMARY KEY,
    total_sku INTEGER,
    completed_sku INTEGER,
    failed_sku INTEGER,
    waiting_confirm_sku INTEGER,
    total_images INTEGER,
    real_generated_count INTEGER,
    mock_preview_count INTEGER,
    high_risk_count INTEGER,
    medium_risk_count INTEGER,
    low_risk_count INTEGER,
    estimated_cost REAL,
    updated_at TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS provider_usage_index (
    id TEXT PRIMARY KEY,
    batch_id TEXT,
    task_id TEXT,
    provider_type TEXT,
    provider TEXT,
    model TEXT,
    action TEXT,
    call_count INTEGER,
    total_duration_ms INTEGER,
    estimated_cost REAL,
    updated_at TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS review_risk_index (
    id TEXT PRIMARY KEY,
    batch_id TEXT,
    task_id TEXT,
    image_id TEXT,
    plan_id TEXT,
    platform_id TEXT,
    image_type TEXT,
    risk_level TEXT,
    pass INTEGER,
    issue_count INTEGER,
    high_issue_count INTEGER,
    medium_issue_count INTEGER,
    low_issue_count INTEGER,
    updated_at TEXT
  )`
];

export const REQUIRED_SQLITE_TABLES = [
  'tasks',
  'batch_tasks',
  'user_settings',
  'workflow_templates',
  'imported_folders',
  'app_meta',
  'batch_sku_index',
  'batch_queue_index',
  'batch_analytics_index',
  'provider_usage_index',
  'review_risk_index'
];

export const SQLITE_INDEX_TABLES = [
  'batch_sku_index',
  'batch_queue_index',
  'batch_analytics_index',
  'provider_usage_index',
  'review_risk_index'
];

export function normalizeDbShape(db = {}) {
  return {
    tasks: Array.isArray(db.tasks) ? db.tasks : [],
    batchTasks: Array.isArray(db.batchTasks) ? db.batchTasks : [],
    importedFolders: Array.isArray(db.importedFolders) ? db.importedFolders : [],
    workflowTemplates: Array.isArray(db.workflowTemplates) ? db.workflowTemplates : [],
    userSettings: db.userSettings && typeof db.userSettings === 'object' ? db.userSettings : null
  };
}
