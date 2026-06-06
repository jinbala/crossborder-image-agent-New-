import { nanoid } from 'nanoid';
import {
  createWorkflowTemplate,
  deleteWorkflowTemplate as deleteUserWorkflowTemplate,
  getBatchTask,
  listWorkflowTemplates,
  updateBatchTask,
  updateWorkflowTemplate
} from './db.js';
import { defaultBatchQueue } from './batchTaskService.js';
import { normalizeTargets } from './targetService.js';

const nowIso = () => new Date().toISOString();

const SYSTEM_TEMPLATE_CREATED_AT = '2026-05-30T00:00:00.000Z';

function target(platformId, site = 'US', language = 'English', categoryId = 'general') {
  return { platformId, site, language, categoryId };
}

export const SYSTEM_WORKFLOW_TEMPLATES = [
  {
    id: 'mock_preview_all_platforms',
    name: '全平台 mock 预览',
    description: '用于纯流程测试：mock 识别、mock 生图、mock 审核，覆盖 Amazon、Temu、Noon。',
    categoryId: 'general',
    tags: ['mock', 'preview', 'all-platforms'],
    isSystemTemplate: true,
    createdAt: SYSTEM_TEMPLATE_CREATED_AT,
    updatedAt: SYSTEM_TEMPLATE_CREATED_AT,
    defaultTargets: [target('amazon'), target('temu'), target('noon', 'UAE')],
    providers: {
      visionProvider: 'mock',
      imageProvider: 'mock',
      backgroundProvider: 'mock',
      reviewProvider: 'mock'
    },
    recognition: { mode: 'balanced', maxImages: 15 },
    generation: { defaultMode: 'mock', allowRealLifestyle: false, realMode: 'auto' },
    review: { defaultMode: 'mock' },
    queue: { concurrency: 2, autoRetryEnabled: false, maxRetryPerJob: 1, retryableFilter: 'retryable' },
    export: { includeAllPlatforms: true, includeAnalytics: true },
    safety: { requireHumanConfirmation: true, preventAutoRealGeneration: true, preventAutoRealReview: false }
  },
  {
    id: 'hard_drive_multi_platform_balanced',
    name: '移动硬盘多平台 balanced',
    description: '适合移动硬盘/外置 SSD：Gemini balanced 真实识别，多平台方案，生成和审核仍默认 mock。',
    categoryId: 'electronics_storage',
    tags: ['hard-drive', 'electronics', 'balanced'],
    isSystemTemplate: true,
    createdAt: SYSTEM_TEMPLATE_CREATED_AT,
    updatedAt: SYSTEM_TEMPLATE_CREATED_AT,
    defaultTargets: [
      target('amazon', 'US', 'English', 'electronics_storage'),
      target('temu', 'US', 'English', 'electronics_storage'),
      target('noon', 'UAE', 'English', 'electronics_storage'),
      target('ozon', 'RU', 'Russian', 'electronics_storage'),
      target('rakuten', 'JP', 'Japanese', 'electronics_storage')
    ],
    providers: {
      visionProvider: 'gemini',
      imageProvider: 'mock',
      backgroundProvider: 'mock',
      reviewProvider: 'mock'
    },
    recognition: { mode: 'balanced', maxImages: 15 },
    generation: { defaultMode: 'mock', allowRealLifestyle: false, realMode: 'auto' },
    review: { defaultMode: 'mock' },
    queue: { concurrency: 2, autoRetryEnabled: false, maxRetryPerJob: 1, retryableFilter: 'retryable' },
    export: { includeAllPlatforms: true, includeAnalytics: true },
    safety: { requireHumanConfirmation: true, preventAutoRealGeneration: true, preventAutoRealReview: false }
  },
  {
    id: 'low_cost_batch',
    name: '低成本批量模式',
    description: '尽量使用 mock 与低并发，适合批量导入、方案排版和导出流程验证。',
    categoryId: 'general',
    tags: ['low-cost', 'batch'],
    isSystemTemplate: true,
    createdAt: SYSTEM_TEMPLATE_CREATED_AT,
    updatedAt: SYSTEM_TEMPLATE_CREATED_AT,
    defaultTargets: [target('amazon'), target('temu')],
    providers: {
      visionProvider: 'mock',
      imageProvider: 'mock',
      backgroundProvider: 'mock',
      reviewProvider: 'mock'
    },
    recognition: { mode: 'fast', maxImages: 8 },
    generation: { defaultMode: 'mock', allowRealLifestyle: false, realMode: 'auto' },
    review: { defaultMode: 'mock' },
    queue: { concurrency: 2, autoRetryEnabled: false, maxRetryPerJob: 1, retryableFilter: 'retryable' },
    export: { includeAllPlatforms: true, includeAnalytics: true },
    safety: { requireHumanConfirmation: true, preventAutoRealGeneration: true, preventAutoRealReview: true }
  },
  {
    id: 'real_lifestyle_test',
    name: '真实场景图测试',
    description: '用于测试 lifestyle_image 真实背景生成链路。模板只给建议，不自动启动真实生成。',
    categoryId: 'electronics_storage',
    tags: ['real-image', 'lifestyle', 'openai'],
    isSystemTemplate: true,
    createdAt: SYSTEM_TEMPLATE_CREATED_AT,
    updatedAt: SYSTEM_TEMPLATE_CREATED_AT,
    defaultTargets: [target('amazon', 'US', 'English', 'electronics_storage')],
    providers: {
      visionProvider: 'gemini',
      imageProvider: 'real',
      backgroundProvider: 'openai',
      reviewProvider: 'mock'
    },
    recognition: { mode: 'balanced', maxImages: 15 },
    generation: { defaultMode: 'mock', allowRealLifestyle: true, realMode: 'auto' },
    review: { defaultMode: 'mock' },
    queue: { concurrency: 1, autoRetryEnabled: false, maxRetryPerJob: 1, retryableFilter: 'retryable' },
    export: { includeAllPlatforms: true, includeAnalytics: true },
    safety: { requireHumanConfirmation: true, preventAutoRealGeneration: false, preventAutoRealReview: false }
  },
  {
    id: 'real_review_check',
    name: '真实审核检查',
    description: '用于测试真实视觉审核，生成仍默认 mock，审核可选择 Gemini real review。',
    categoryId: 'electronics_storage',
    tags: ['review', 'gemini', 'compliance'],
    isSystemTemplate: true,
    createdAt: SYSTEM_TEMPLATE_CREATED_AT,
    updatedAt: SYSTEM_TEMPLATE_CREATED_AT,
    defaultTargets: [target('amazon', 'US', 'English', 'electronics_storage'), target('noon', 'UAE', 'English', 'electronics_storage')],
    providers: {
      visionProvider: 'gemini',
      imageProvider: 'mock',
      backgroundProvider: 'mock',
      reviewProvider: 'gemini'
    },
    recognition: { mode: 'balanced', maxImages: 15 },
    generation: { defaultMode: 'mock', allowRealLifestyle: false, realMode: 'auto' },
    review: { defaultMode: 'real' },
    queue: { concurrency: 1, autoRetryEnabled: false, maxRetryPerJob: 1, retryableFilter: 'retryable' },
    export: { includeAllPlatforms: true, includeAnalytics: true },
    safety: { requireHumanConfirmation: true, preventAutoRealGeneration: true, preventAutoRealReview: false }
  },
  {
    id: 'real_api_small_batch_test',
    name: '真实 API 小批量测试',
    description: '用于 1-2 个 SKU 的真实识别、真实生图、真实审核实用性测试；平台上传仍保持 dry-run，不会真实上传。',
    categoryId: 'electronics_storage',
    tags: ['real-test', 'small-batch', 'dry-run-upload'],
    isSystemTemplate: true,
    createdAt: SYSTEM_TEMPLATE_CREATED_AT,
    updatedAt: SYSTEM_TEMPLATE_CREATED_AT,
    defaultTargets: [
      target('amazon', 'US', 'English', 'electronics_storage'),
      target('temu', 'US', 'English', 'electronics_storage')
    ],
    modes: {
      recognition: 'real',
      imageGeneration: 'real-test',
      review: 'real',
      upload: 'dry-run'
    },
    providers: {
      visionProvider: process.env.VISION_PROVIDER || 'gemini',
      imageProvider: 'real',
      backgroundProvider: process.env.BACKGROUND_PROVIDER || 'openai',
      reviewProvider: process.env.REVIEW_PROVIDER || 'gemini'
    },
    recognition: { mode: 'real', maxImages: 15 },
    generation: { defaultMode: 'real-test', allowRealLifestyle: true, realMode: 'auto', maxImageAutoFix: 2 },
    review: { defaultMode: 'real' },
    queue: { concurrency: 1, autoRetryEnabled: false, maxRetryPerJob: 1, retryableFilter: 'retryable', maxImageAutoFix: 2 },
    export: { includeAllPlatforms: true, includeAnalytics: true },
    safety: {
      requireHumanConfirmation: true,
      preventAutoRealGeneration: false,
      preventAutoRealReview: false,
      preventRealUpload: true,
      uploadMode: 'dry-run'
    }
  }
];

const PROVIDER_KEY_ENV = {
  gemini: 'GEMINI_API_KEY',
  openai: 'OPENAI_API_KEY',
  qwen: 'QWEN_API_KEY'
};

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function normalizeQueue(queue = {}) {
  const concurrency = Number(queue.concurrency || 2);
  return {
    concurrency: Number.isFinite(concurrency) && concurrency > 0 ? concurrency : 2,
    autoRetryEnabled: Boolean(queue.autoRetryEnabled),
    maxRetryPerJob: Number.isFinite(Number(queue.maxRetryPerJob)) ? Number(queue.maxRetryPerJob) : 1,
    retryableFilter: queue.retryableFilter || 'retryable'
  };
}

function stripSecrets(value) {
  if (Array.isArray(value)) return value.map(stripSecrets);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !/(api.?key|secret|token|password)/i.test(key))
      .map(([key, item]) => [key, stripSecrets(item)])
  );
}

function normalizeTemplateData(data = {}, { isSystemTemplate = false, id } = {}) {
  const safe = stripSecrets(data);
  const timestamp = nowIso();
  return {
    id: id || safe.id || `workflow-template-${nanoid(10)}`,
    name: safe.name || '未命名工作流模板',
    description: safe.description || '',
    categoryId: safe.categoryId || safe.defaultTargets?.[0]?.categoryId || 'general',
    tags: Array.isArray(safe.tags) ? safe.tags : [],
    isSystemTemplate,
    createdAt: safe.createdAt || timestamp,
    updatedAt: timestamp,
    defaultTargets: Array.isArray(safe.defaultTargets) ? safe.defaultTargets : [],
    providers: {
      visionProvider: safe.providers?.visionProvider || 'mock',
      imageProvider: safe.providers?.imageProvider || 'mock',
      backgroundProvider: safe.providers?.backgroundProvider || 'mock',
      reviewProvider: safe.providers?.reviewProvider || 'mock'
    },
    modes: {
      recognition: safe.modes?.recognition || (safe.providers?.visionProvider && safe.providers.visionProvider !== 'mock' ? 'real' : 'mock'),
      imageGeneration: safe.modes?.imageGeneration || safe.generation?.defaultMode || 'mock',
      review: safe.modes?.review || safe.review?.defaultMode || 'mock',
      upload: 'dry-run'
    },
    recognition: {
      mode: safe.recognition?.mode || 'balanced',
      maxImages: Number(safe.recognition?.maxImages || 15)
    },
    generation: {
      defaultMode: safe.generation?.defaultMode || 'mock',
      allowRealLifestyle: Boolean(safe.generation?.allowRealLifestyle),
      realMode: safe.generation?.realMode || 'auto'
    },
    review: {
      defaultMode: safe.review?.defaultMode || 'mock'
    },
    queue: normalizeQueue(safe.queue),
    export: {
      includeAllPlatforms: safe.export?.includeAllPlatforms !== false,
      includeAnalytics: safe.export?.includeAnalytics !== false
    },
    safety: {
      requireHumanConfirmation: safe.safety?.requireHumanConfirmation !== false,
      preventAutoRealGeneration: safe.safety?.preventAutoRealGeneration !== false,
      preventAutoRealReview: Boolean(safe.safety?.preventAutoRealReview),
      preventRealUpload: safe.safety?.preventRealUpload !== false,
      uploadMode: 'dry-run'
    }
  };
}

function findSystemTemplate(templateId) {
  return SYSTEM_WORKFLOW_TEMPLATES.find((template) => template.id === templateId) || null;
}

function providerKeyWarnings(template) {
  const providers = template.providers || {};
  const checks = [
    { label: 'Vision Provider', provider: providers.visionProvider },
    { label: 'Background Provider', provider: providers.backgroundProvider },
    { label: 'Review Provider', provider: providers.reviewProvider }
  ];
  const warnings = [];
  const seen = new Set();
  for (const check of checks) {
    if (!check.provider || check.provider === 'mock') continue;
    const envName = PROVIDER_KEY_ENV[check.provider];
    if (!envName || seen.has(`${check.label}-${envName}`)) continue;
    seen.add(`${check.label}-${envName}`);
    if (!process.env[envName]) {
      warnings.push({
        code: 'PROVIDER_KEY_MISSING',
        provider: check.provider,
        envName,
        message: `模板建议使用 ${check.provider}，但当前未检测到 ${envName}。`
      });
    }
  }
  return warnings;
}

export async function listTemplates() {
  const userTemplates = await listWorkflowTemplates();
  return [...SYSTEM_WORKFLOW_TEMPLATES.map(clone), ...userTemplates.map(clone)];
}

export async function getTemplate(templateId) {
  const systemTemplate = findSystemTemplate(templateId);
  if (systemTemplate) return clone(systemTemplate);
  const userTemplates = await listWorkflowTemplates();
  return clone(userTemplates.find((template) => template.id === templateId) || null);
}

export async function createUserTemplate(data) {
  const template = normalizeTemplateData(data, { isSystemTemplate: false });
  return createWorkflowTemplate(template);
}

export async function updateUserTemplate(templateId, data) {
  if (findSystemTemplate(templateId)) {
    const error = new Error('System workflow templates cannot be edited directly');
    error.statusCode = 403;
    throw error;
  }
  return updateWorkflowTemplate(templateId, (current) => normalizeTemplateData({ ...current, ...data, id: templateId, createdAt: current.createdAt }, { isSystemTemplate: false, id: templateId }));
}

export async function deleteUserTemplate(templateId) {
  if (findSystemTemplate(templateId)) {
    const error = new Error('System workflow templates cannot be deleted');
    error.statusCode = 403;
    throw error;
  }
  return deleteUserWorkflowTemplate(templateId);
}

export async function cloneTemplate(templateId) {
  const source = await getTemplate(templateId);
  if (!source) {
    const error = new Error('Workflow template not found');
    error.statusCode = 404;
    throw error;
  }
  return createUserTemplate({
    ...source,
    id: undefined,
    name: `${source.name} Copy`,
    isSystemTemplate: false,
    createdAt: undefined,
    updatedAt: undefined
  });
}

export async function applyTemplateToBatch({ batchId, templateId }) {
  const batch = await getBatchTask(batchId);
  if (!batch) {
    const error = new Error('Batch task not found');
    error.statusCode = 404;
    throw error;
  }
  const template = await getTemplate(templateId);
  if (!template) {
    const error = new Error('Workflow template not found');
    error.statusCode = 404;
    throw error;
  }
  const normalizedTargets = normalizeTargets(template.defaultTargets || [], {
    productInfo: { category: template.categoryId },
    fallbackTask: { platformId: 'amazon', language: 'English', categoryId: template.categoryId }
  });
  const warnings = providerKeyWarnings(template);
  const appliedAt = nowIso();
  const templateSnapshot = {
    ...clone(template),
    defaultTargets: normalizedTargets,
    appliedAt
  };
  const batchTask = await updateBatchTask(batchId, (current) => ({
    defaultTargets: normalizedTargets,
    workflowTemplateSnapshot: templateSnapshot,
    workflowTemplateWarnings: warnings,
    queue: {
      ...defaultBatchQueue(),
      ...(current.queue || {}),
      concurrency: normalizeQueue(template.queue).concurrency,
      status: current.queue?.status || 'idle'
    },
    executionLogs: [
      ...(current.executionLogs || []),
      {
        id: `log-${nanoid(8)}`,
        timestamp: appliedAt,
        level: warnings.length ? 'warn' : 'info',
        action: 'apply-template',
        skuId: null,
        taskId: null,
        message: `已应用工作流模板：${template.name}`,
        warnings
      }
    ].slice(-500)
  }));
  return { batchTask, templateSnapshot, warnings };
}

export function summarizeTemplate(template = {}) {
  return {
    id: template.id,
    name: template.name,
    description: template.description,
    isSystemTemplate: Boolean(template.isSystemTemplate),
    categoryId: template.categoryId,
    targetCount: template.defaultTargets?.length || 0,
    providers: template.providers || {},
    queue: template.queue || {},
    generation: template.generation || {},
    review: template.review || {}
  };
}
