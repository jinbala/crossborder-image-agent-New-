import { getProviderConfigSummary } from '../config/env.js';
import { getUserSettingsRecord, setUserSettingsRecord } from './db.js';
import { getSqliteDbPath, getStorageDriver } from '../storage/index.js';

export const DEFAULT_USER_SETTINGS = {
  version: 'v4.3',
  updatedAt: null,
  defaults: {
    workflowTemplateId: null,
    platforms: [
      {
        platformId: 'amazon',
        site: 'US',
        language: 'English',
        categoryId: 'electronics_storage'
      }
    ],
    recognitionMode: 'balanced',
    batchConcurrency: 2,
    reviewMode: 'mock',
    generationMode: 'mock'
  },
  providers: {
    visionProvider: 'gemini',
    imageProvider: 'mock',
    backgroundProvider: 'openai',
    reviewProvider: 'mock',
    mattingProvider: 'sharp'
  },
  importScan: {
    enabled: false,
    rootDir: '',
    maxDepth: 2,
    maxSku: 200
  },
  cost: {
    currency: 'USD',
    vision: {},
    image: {},
    review: {},
    matting: {}
  },
  safety: {
    requireHumanConfirmation: true,
    preventAutoRealGeneration: true,
    preventAutoRealReview: false,
    showMockWarnings: true,
    showApiCostWarnings: true
  },
  ui: {
    defaultBatchView: 'guide',
    collapseAdvancedByDefault: true,
    showDebugPanels: false
  },
  sqliteTrial: {
    enabled: false,
    startedAt: null,
    lastVerifiedAt: null,
    status: 'not_started',
    jsonBackupCreated: false,
    sqlitePath: 'backend/data/app.sqlite',
    schemaVersion: 2,
    lastMigrationReport: null,
    lastVerificationReport: null,
    lastTrialCheckAt: null,
    lastTrialCheckStatus: null,
    lastTrialCheckReport: null,
    trialChecklist: [],
    notes: []
  }
};

const SENSITIVE_KEY_PATTERN = /(api[_-]?key|secret|token|password|credential)/i;

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function nowIso() {
  return new Date().toISOString();
}

function bool(value, fallback) {
  if (typeof value === 'boolean') return value;
  return fallback;
}

function number(value, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function string(value, fallback = '') {
  return typeof value === 'string' ? value : fallback;
}

function sanitizeCostBucket(bucket = {}) {
  if (!bucket || typeof bucket !== 'object' || Array.isArray(bucket)) return {};
  return Object.fromEntries(Object.entries(bucket)
    .filter(([key]) => !SENSITIVE_KEY_PATTERN.test(key))
    .map(([key, value]) => {
      if (typeof value === 'number' || typeof value === 'string') {
        return [key, number(value, 0)];
      }
      if (value && typeof value === 'object') {
        return [key, { perCall: number(value.perCall, 0), note: string(value.note, '') }];
      }
      return [key, 0];
    }));
}

function normalizePlatforms(platforms) {
  const source = Array.isArray(platforms) && platforms.length
    ? platforms
    : DEFAULT_USER_SETTINGS.defaults.platforms;
  return source
    .filter((item) => item && typeof item === 'object' && !SENSITIVE_KEY_PATTERN.test(Object.keys(item).join(' ')))
    .map((item) => ({
      platformId: string(item.platformId, 'amazon'),
      site: string(item.site, 'US'),
      language: string(item.language, 'English'),
      categoryId: string(item.categoryId, 'electronics_storage')
    }));
}

function normalizeSettings(input = {}) {
  const base = clone(DEFAULT_USER_SETTINGS);
  const settings = input && typeof input === 'object' ? input : {};
  return {
    version: 'v4.3',
    updatedAt: settings.updatedAt || base.updatedAt,
    defaults: {
      workflowTemplateId: settings.defaults?.workflowTemplateId || null,
      platforms: normalizePlatforms(settings.defaults?.platforms),
      recognitionMode: string(settings.defaults?.recognitionMode, base.defaults.recognitionMode),
      batchConcurrency: number(settings.defaults?.batchConcurrency, base.defaults.batchConcurrency, { min: 1, max: 16 }),
      reviewMode: string(settings.defaults?.reviewMode, base.defaults.reviewMode),
      generationMode: string(settings.defaults?.generationMode, base.defaults.generationMode)
    },
    providers: {
      visionProvider: string(settings.providers?.visionProvider, base.providers.visionProvider),
      imageProvider: string(settings.providers?.imageProvider, base.providers.imageProvider),
      backgroundProvider: string(settings.providers?.backgroundProvider, base.providers.backgroundProvider),
      reviewProvider: string(settings.providers?.reviewProvider, base.providers.reviewProvider),
      mattingProvider: string(settings.providers?.mattingProvider, base.providers.mattingProvider)
    },
    importScan: {
      enabled: bool(settings.importScan?.enabled, base.importScan.enabled),
      rootDir: string(settings.importScan?.rootDir, base.importScan.rootDir),
      maxDepth: number(settings.importScan?.maxDepth, base.importScan.maxDepth, { min: 1, max: 10 }),
      maxSku: number(settings.importScan?.maxSku, base.importScan.maxSku, { min: 1, max: 1000 })
    },
    cost: {
      currency: string(settings.cost?.currency, base.cost.currency),
      vision: sanitizeCostBucket(settings.cost?.vision),
      image: sanitizeCostBucket(settings.cost?.image),
      review: sanitizeCostBucket(settings.cost?.review),
      matting: sanitizeCostBucket(settings.cost?.matting)
    },
    safety: {
      requireHumanConfirmation: bool(settings.safety?.requireHumanConfirmation, base.safety.requireHumanConfirmation),
      preventAutoRealGeneration: bool(settings.safety?.preventAutoRealGeneration, base.safety.preventAutoRealGeneration),
      preventAutoRealReview: bool(settings.safety?.preventAutoRealReview, base.safety.preventAutoRealReview),
      showMockWarnings: bool(settings.safety?.showMockWarnings, base.safety.showMockWarnings),
      showApiCostWarnings: bool(settings.safety?.showApiCostWarnings, base.safety.showApiCostWarnings)
    },
    ui: {
      defaultBatchView: string(settings.ui?.defaultBatchView, base.ui.defaultBatchView),
      collapseAdvancedByDefault: bool(settings.ui?.collapseAdvancedByDefault, base.ui.collapseAdvancedByDefault),
      showDebugPanels: bool(settings.ui?.showDebugPanels, base.ui.showDebugPanels)
    },
    sqliteTrial: {
      enabled: bool(settings.sqliteTrial?.enabled, base.sqliteTrial.enabled),
      startedAt: settings.sqliteTrial?.startedAt || base.sqliteTrial.startedAt,
      lastVerifiedAt: settings.sqliteTrial?.lastVerifiedAt || base.sqliteTrial.lastVerifiedAt,
      status: string(settings.sqliteTrial?.status, base.sqliteTrial.status),
      jsonBackupCreated: bool(settings.sqliteTrial?.jsonBackupCreated, base.sqliteTrial.jsonBackupCreated),
      sqlitePath: string(settings.sqliteTrial?.sqlitePath, process.env.SQLITE_DB_PATH || base.sqliteTrial.sqlitePath),
      schemaVersion: number(settings.sqliteTrial?.schemaVersion, base.sqliteTrial.schemaVersion, { min: 0, max: 999 }),
      lastMigrationReport: settings.sqliteTrial?.lastMigrationReport || null,
      lastVerificationReport: settings.sqliteTrial?.lastVerificationReport || null,
      lastTrialCheckAt: settings.sqliteTrial?.lastTrialCheckAt || null,
      lastTrialCheckStatus: settings.sqliteTrial?.lastTrialCheckStatus || null,
      lastTrialCheckReport: settings.sqliteTrial?.lastTrialCheckReport || null,
      trialChecklist: Array.isArray(settings.sqliteTrial?.trialChecklist)
        ? settings.sqliteTrial.trialChecklist.slice(0, 50)
        : [],
      notes: Array.isArray(settings.sqliteTrial?.notes)
        ? settings.sqliteTrial.notes.filter((note) => typeof note === 'string').slice(-20)
        : []
    }
  };
}

function deepMerge(base, patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return base;
  const next = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (SENSITIVE_KEY_PATTERN.test(key)) continue;
    if (value && typeof value === 'object' && !Array.isArray(value) && base[key] && typeof base[key] === 'object' && !Array.isArray(base[key])) {
      next[key] = deepMerge(base[key], value);
    } else {
      next[key] = value;
    }
  }
  return next;
}

export function sanitizeSettingsInput(input) {
  if (!input || typeof input !== 'object') return {};
  const clean = Array.isArray(input) ? [] : {};
  for (const [key, value] of Object.entries(input)) {
    if (SENSITIVE_KEY_PATTERN.test(key)) continue;
    if (value && typeof value === 'object') {
      clean[key] = sanitizeSettingsInput(value);
    } else {
      clean[key] = value;
    }
  }
  return clean;
}

export async function getUserSettings() {
  const record = await getUserSettingsRecord();
  const normalized = normalizeSettings(record || DEFAULT_USER_SETTINGS);
  if (!record) {
    normalized.updatedAt = nowIso();
    await setUserSettingsRecord(normalized);
  }
  return normalized;
}

export async function updateUserSettings(partialSettings = {}) {
  const current = await getUserSettings();
  const sanitized = sanitizeSettingsInput(partialSettings);
  const merged = normalizeSettings(deepMerge(current, sanitized));
  merged.updatedAt = nowIso();
  await setUserSettingsRecord(merged);
  return merged;
}

export async function resetUserSettings() {
  const defaults = normalizeSettings(DEFAULT_USER_SETTINGS);
  defaults.updatedAt = nowIso();
  await setUserSettingsRecord(defaults);
  return defaults;
}

function keyAvailableFor(provider, envSummary) {
  if (!provider || provider === 'mock' || provider === 'sharp') return true;
  if (provider === 'gemini') return envSummary.hasGeminiKey;
  if (provider === 'openai') return envSummary.hasOpenAIKey;
  if (provider === 'qwen') return envSummary.hasQwenKey;
  if (provider === 'external') return Boolean(process.env.MATTING_API_KEY && process.env.MATTING_BASE_URL);
  return true;
}

export async function getEffectiveSettings() {
  const userSettings = await getUserSettings();
  const providerSummary = getProviderConfigSummary();
  const envSummary = {
    hasGeminiKey: Boolean(providerSummary.hasGeminiKey),
    hasOpenAIKey: Boolean(providerSummary.hasOpenAIKey),
    hasQwenKey: Boolean(providerSummary.hasQwenKey),
    imageProvider: process.env.IMAGE_PROVIDER || providerSummary.selectedImageProvider || 'mock',
    backgroundProvider: process.env.BACKGROUND_PROVIDER || providerSummary.selectedBackgroundProvider || 'mock',
    reviewProvider: process.env.REVIEW_PROVIDER || providerSummary.selectedReviewProvider || 'mock',
    mattingProvider: process.env.MATTING_PROVIDER || providerSummary.selectedMattingProvider || 'sharp',
    storageDriver: getStorageDriver(),
    sqliteDbPath: getSqliteDbPath(),
    sqliteAutoMigrate: ['1', 'true', 'yes', 'on'].includes(String(process.env.SQLITE_AUTO_MIGRATE || 'false').toLowerCase()),
    importScanEnabled: ['1', 'true', 'yes', 'on'].includes(String(process.env.IMPORT_SCAN_ENABLED || userSettings.importScan.enabled || 'false').toLowerCase()),
    importRootConfigured: Boolean(process.env.IMPORT_ROOT_DIR || userSettings.importScan.rootDir)
  };
  const warnings = [];
  const providerChecks = [
    ['Vision Provider', userSettings.providers.visionProvider],
    ['Background Provider', userSettings.providers.backgroundProvider],
    ['Review Provider', userSettings.providers.reviewProvider],
    ['Matting Provider', userSettings.providers.mattingProvider]
  ];
  for (const [label, provider] of providerChecks) {
    if (!keyAvailableFor(provider, envSummary)) {
      warnings.push({
        code: 'MISSING_PROVIDER_KEY',
        message: `${label} 选择了 ${provider}，但当前 .env 中未检测到对应 API Key 或配置。`,
        provider
      });
    }
  }
  if (userSettings.importScan.enabled && !userSettings.importScan.rootDir && !process.env.IMPORT_ROOT_DIR) {
    warnings.push({ code: 'IMPORT_ROOT_MISSING', message: '导入扫描已开启，但尚未配置 IMPORT_ROOT_DIR 或设置中心导入目录。' });
  }
  if (userSettings.providers.imageProvider === 'real' && userSettings.safety.preventAutoRealGeneration) {
    warnings.push({ code: 'REAL_GENERATION_GUARDED', message: '已选择真实生图偏好，但安全设置仍会阻止自动真实生成。' });
  }
  return {
    userSettings,
    envSummary,
    warnings
  };
}
