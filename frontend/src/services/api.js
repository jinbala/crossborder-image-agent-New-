import { normalizeReviewOptions } from '../utils/reviewMode.js';
import {
  normalizeImportBatchFolderPayload,
  normalizeImportScanPayload,
  normalizeImportScannedFoldersPayload
} from '../utils/importScan.js';
import { normalizeCleanupPayload } from '../utils/cleanup.js';
import { normalizeStressTestPayload } from '../utils/stressTest.js';
import { normalizeMattingPayload } from '../utils/matting.js';
import { normalizeExportPackageOptions } from '../utils/exportPackage.js';
import { normalizeListingExportOptions } from '../utils/listingExport.js';
import { normalizeUploadReadinessOptions } from '../utils/uploadReadiness.js';

const API_BASE = import.meta.env?.VITE_API_BASE_URL || '/api';
export const ASSET_BASE = import.meta.env?.VITE_ASSET_BASE_URL || '';
let sessionCsrf = null;
export function setSessionCsrf(value) { sessionCsrf = value || null; }

async function request(path, options = {}) {
  const headers = { ...(options.body instanceof FormData ? {} : { 'Content-Type': 'application/json' }),
    ...(sessionCsrf ? { 'X-CSRF-Token': sessionCsrf } : {}), ...options.headers };

  const response = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers
  });

  if (!response.ok) {
    if (response.status === 401 && typeof window !== 'undefined') window.dispatchEvent(new Event('workbench-session-expired'));
    let message = '请求失败';
    try {
      const body = await response.json();
      message = body.error || message;
    } catch {
      message = response.statusText || message;
    }

    if (typeof message === 'object' && message?.message) {
      message = `${message.code ? `${message.code}: ` : ''}${message.message}`;
    }

    if (response.status === 409 && /requires task status/i.test(message)) {
      message = `当前步骤暂时不能执行，请先完成前置流程。${message}`;
    }

    throw Object.assign(new Error(message), { status: response.status });
  }

  return response.json();
}

function normalizeBatchQueueOptions(input = {}) {
  const safeValue = input && typeof input === 'object' && !('currentTarget' in input) && !('nativeEvent' in input)
    ? input
    : {};
  const action = ['recognize', 'prepare', 'plan', 'generate', 'review'].includes(safeValue.action)
    ? safeValue.action
    : 'recognize';
  const mode = ['mock', 'real', 'real-test'].includes(safeValue.mode) ? safeValue.mode : 'mock';
  const payload = { action, mode };
  if (safeValue.confirmPaidApi === true) payload.confirmPaidApi = true;
  const concurrency = Number(safeValue.concurrency);
  if (Number.isFinite(concurrency) && concurrency > 0) payload.concurrency = concurrency;
  if (safeValue.filter) payload.filter = String(safeValue.filter);
  return payload;
}

export const api = {
  getAcceptanceWorkspace: (actorId) => request(`/final-acceptance/workspace?expectedActorId=${encodeURIComponent(actorId)}`),
  saveAcceptanceWorkspace: (payload) => request('/final-acceptance/workspace', { method: 'POST', body: JSON.stringify(payload) }),
  validateAcceptanceWorkspace: (document, expectedActorId) => request('/final-acceptance/workspace/validate', { method: 'POST', body: JSON.stringify({ document, expectedActorId }) }),
  resetAcceptanceWorkspace: (payload) => request('/final-acceptance/workspace/reset', { method: 'POST', body: JSON.stringify(payload) }),
  getAuthorizationStatus: () => request('/platform/authorizations/status'),
  listShops: () => request('/platform/shops'),
  authorizeShop: (payload) => request('/platform/shops/authorize', { method: 'POST', body: JSON.stringify(payload) }),
  revokeShop: (id) => request(`/platform/shops/${encodeURIComponent(id)}/revoke`, { method: 'POST', body: JSON.stringify({ confirm: true }) }),
  listErpGrants: () => request('/platform/erp-grants'),
  createErpGrant: (payload) => request('/platform/erp-grants', { method: 'POST', body: JSON.stringify(payload) }),
  revokeErpGrant: (id) => request(`/platform/erp-grants/${encodeURIComponent(id)}/revoke`, { method: 'POST', body: JSON.stringify({ confirm: true }) }),
  planCreativeBrief: (payload) => request('/platform/studio/plan', { method: 'POST', body: JSON.stringify(payload) }),
  recordHistory: (id) => request(`/platform/record-history/${encodeURIComponent(id)}`),
  renderStudio: (files, background, options) => {
    const body = new FormData(); Array.from(files).forEach((file) => body.append('images', file));
    if (background) body.append('background', background); body.append('options', JSON.stringify(options));
    return request('/platform/studio/render', { method: 'POST', body });
  },
  listDevices: () => request('/platform/devices'),
  createDeviceCode: () => request('/platform/devices/code', { method: 'POST' }),
  revokeDevice: (id) => request(`/platform/devices/${encodeURIComponent(id)}/revoke`, { method: 'POST' }),
  getSession: () => request('/auth/session'),
  getAgreement: () => request('/auth/agreement'),
  bootstrapAccount: (payload) => request('/auth/bootstrap', { method: 'POST', body: JSON.stringify(payload) }),
  login: (payload) => request('/auth/login', { method: 'POST', body: JSON.stringify(payload) }),
  logout: () => request('/auth/logout', { method: 'POST' }),
  changePassword: (payload) => request('/auth/password', { method: 'POST', body: JSON.stringify(payload) }),
  getWorkspace: () => request('/platform/workspace'),
  getWorkbenchJobDetail: (id, page = 1) => request(`/workbench/jobs/${encodeURIComponent(id)}?page=${page}&pageSize=30`),
  skuPackManifestUrl: id => `${API_BASE}/workbench/sku-packs/${encodeURIComponent(id)}/manifest`,
  workbenchManifestUrl: id => `${API_BASE}/workbench/jobs/${encodeURIComponent(id)}/manifest`,
  previewSkuManifestRepair: id => request(`/workbench/sku-packs/${encodeURIComponent(id)}/manifest-repair-preview`),
  previewWorkbenchManifestRepair: id => request(`/workbench/jobs/${encodeURIComponent(id)}/manifest-repair-preview`),
  repairWorkbenchManifest: (id, payload) => request(`/workbench/jobs/${encodeURIComponent(id)}/repair-manifest`, { method: 'POST', body: JSON.stringify(payload) }),
  repairSkuManifest: (id, payload) => request(`/workbench/sku-packs/${encodeURIComponent(id)}/repair-manifest`, { method: 'POST', body: JSON.stringify(payload) }),
    resumeSkuPack: (id, payload) => request(`/workbench/sku-packs/${encodeURIComponent(id)}/resume`, { method: 'POST', body: JSON.stringify(payload) }),
    previewSkuPackResume: (id, retryFailed = false) => request(`/workbench/sku-packs/${encodeURIComponent(id)}/resume-preview?retryFailed=${retryFailed === true}`),
    previewImagePackResume: (id, retryFailed = false) => request(`/workbench/image-packs/${encodeURIComponent(id)}/resume-preview?retryFailed=${retryFailed === true}`),
    resumeImagePack: (id, payload) => request(`/workbench/image-packs/${encodeURIComponent(id)}/resume`, { method: 'POST', body: JSON.stringify(payload) }),
    controlImagePack: (id, payload) => request(`/workbench/image-packs/${encodeURIComponent(id)}/control`, { method: 'POST', body: JSON.stringify(payload) }),
  createCommerceSandbox: (sourceId) => request('/platform/commerce-sandbox', { method: 'POST', body: JSON.stringify({ sourceId, mode: 'local-sandbox', confirm: true }) }),
  getCommerceSandbox: (id) => request(`/platform/commerce-sandbox/${encodeURIComponent(id)}`),
  runCommerceSandbox: (id, payload) => request(`/platform/commerce-sandbox/${encodeURIComponent(id)}/run`, { method: 'POST', body: JSON.stringify(payload) }),
  stopCommerceSandbox: (id, action) => request(`/platform/commerce-sandbox/${encodeURIComponent(id)}/stop`, { method: 'POST', body: JSON.stringify({ action, confirm: true }) }),
  getProductLinks: (id, page = 1) => request(`/platform/products/${encodeURIComponent(id)}/links?page=${page}`),
  listMembers: () => request('/platform/members'),
  createMember: (payload) => request('/platform/members', { method: 'POST', body: JSON.stringify(payload) }),
  updateMember: (id, payload) => request(`/platform/members/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(payload) }),
  listAudit: (query = {}) => request(`/platform/audit?${new URLSearchParams(query)}`),
  listTaskCenter: (query = {}) => request(`/platform/task-center?${new URLSearchParams(query)}`),
  taskCenterCsvUrl: (query = {}) => `${API_BASE}/platform/task-center/export.csv?${new URLSearchParams(query)}`,
  taskCenterAction: (id, payload) => request(`/platform/task-center/${encodeURIComponent(id)}/actions`, { method: 'POST', body: JSON.stringify(payload) }),
  getSupportStatus: () => request('/platform/support/status'),
  rebuildLegacyIndex: () => request('/platform/task-index/rebuild', { method: 'POST', body: JSON.stringify({ confirm: true }) }),
  previewResourceOwner: (kind, id, ownerId) => request(`/platform/resources/${encodeURIComponent(kind)}/${encodeURIComponent(id)}/owner-preview`, { method: 'POST', body: JSON.stringify({ ownerId }) }),
  assignResourceOwner: (kind, id, payload) => request(`/platform/resources/${encodeURIComponent(kind)}/${encodeURIComponent(id)}/owner`, { method: 'POST', body: JSON.stringify(payload) }),
  listPlatformRecords: (kind, query = {}) => request(`/platform/records/${encodeURIComponent(kind)}?${new URLSearchParams(query)}`),
  savePlatformRecord: (kind, payload, id) => request(`/platform/records/${encodeURIComponent(kind)}${id ? `/${encodeURIComponent(id)}` : ''}`, { method: id ? 'PATCH' : 'POST', body: JSON.stringify(payload) }),
  archivePlatformRecord: (id, payload) => request(`/platform/record-actions/${encodeURIComponent(id)}/archive`, { method: 'POST', body: JSON.stringify(payload) }),
  importPlatformRecords: (kind, payload) => request(`/platform/records/${encodeURIComponent(kind)}/import`, { method: 'POST', body: JSON.stringify(payload) }),
  platformExportUrl: (kind) => `${API_BASE}/platform/records/${encodeURIComponent(kind)}/export`,
  importProductsFromTasks: (payload = {}) => request('/platform/products/import-tasks', { method: 'POST', body: JSON.stringify(payload) }),
  listPersonalSpace: (query = {}) => request(`/platform/space?${new URLSearchParams(query)}`),
  archiveSpace: (id, restore = false) => request(`/platform/space/${encodeURIComponent(id)}/archive`, { method: 'POST', body: JSON.stringify({ confirm: true, restore }) }),
  getDesktopRuntime: (query = {}, options = {}) => request(`/desktop/runtime?${new URLSearchParams(query)}`, { signal: options.signal }),
  pauseAllQueues: () => request('/desktop/pause-all', { method: 'POST' }),
  createExtensionPairingCode: () => request('/desktop/pairing-code', { method: 'POST' }),
  listTasks: () => request('/tasks'),
  listPlatformRules: () => request('/tasks/platform-rules'),
  listRulePlatforms: () => request('/rules/platforms'),
  listRuleCategories: () => request('/rules/categories'),
  getEffectiveRules: ({ platformId = 'amazon', categoryId = 'generic_ecommerce' } = {}) => request(`/rules/effective?platformId=${encodeURIComponent(platformId)}&categoryId=${encodeURIComponent(categoryId || 'generic_ecommerce')}`),
  getProviderConfig: () => request('/tasks/provider-config'),
  getProviderStatus: () => request('/settings/providers/status'),
  getTask: (taskId) => request(`/tasks/${taskId}`),
  getTemplateAudit: (taskId) => request(`/tasks/${taskId}/template-audit`),
  getAutoFixPlan: (taskId) => request(`/tasks/${taskId}/auto-fix-plan`),
  executeAutoFixPlan: (taskId, payload = {}) => request(`/tasks/${taskId}/auto-fix-plan/execute`, {
    method: 'POST',
    body: JSON.stringify({
      approvedActionIds: Array.isArray(payload.approvedActionIds) ? payload.approvedActionIds : [],
      confirmExecute: payload.confirmExecute === true,
      confirmSave: payload.confirmSave === true,
      persist: payload.persist === true,
      mode: payload.mode || 'textLayoutOnly'
    })
  }),
  uploadImages: (files) => {
    const formData = new FormData();
    Array.from(files).forEach((file) => formData.append('images', file));
    return request('/tasks/upload', { method: 'POST', body: formData });
  },
  uploadImage: (file) => api.uploadImages([file]),
  recognize: (taskId, approval = {}) => request(`/tasks/${taskId}/recognize`, { method: 'POST', body: JSON.stringify({ confirmPaidApi: approval.confirmPaidApi === true }) }),
  saveProduct: (taskId, productInfo) => request(`/tasks/${taskId}/product`, {
    method: 'PATCH',
    body: JSON.stringify({ productInfo })
  }),
  savePlatform: (taskId, selection) => request(`/tasks/${taskId}/platforms`, {
    method: 'POST',
    body: JSON.stringify(selection)
  }),
  createPlans: (taskId) => request(`/tasks/${taskId}/image-plans`, { method: 'POST' }),
  updateImagePlan: (taskId, planId, patch) => request(`/tasks/${taskId}/image-plans/${planId}`, {
    method: 'PATCH',
    body: JSON.stringify(patch)
  }),
  updatePlan: (taskId, planId, patch) => request(`/tasks/${taskId}/plans/${planId}`, {
    method: 'POST',
    body: JSON.stringify(patch)
  }),
  updatePlanReference: (taskId, planId, sourceImageId) => request(`/tasks/${taskId}/plans/${planId}/reference`, {
    method: 'POST',
    body: JSON.stringify({ sourceImageId })
  }),
  previewMatting: (taskId, planId, sourceImageId, approval = {}) => request(`/tasks/${taskId}/plans/${planId}/matting-preview`, {
    method: 'POST',
    body: JSON.stringify({ ...(sourceImageId ? { sourceImageId } : {}), confirmPaidApi: approval.confirmPaidApi === true })
  }),
  updateTextLayout: (taskId, planId, textLayoutOverride) => request(`/tasks/${taskId}/plans/${planId}/text-layout`, {
    method: 'POST',
    body: JSON.stringify({ textLayoutOverride })
  }),
  restoreTextLayout: (taskId, planId) => request(`/tasks/${taskId}/plans/${planId}/text-layout`, { method: 'DELETE' }),
  generateImages: (taskId) => request(`/tasks/${taskId}/generate`, { method: 'POST' }),
  regenerateImage: (taskId, planId, options = {}) => request(`/tasks/${taskId}/generate/${planId}`, {
    method: 'POST',
    body: JSON.stringify(options)
  }),
  review: (taskId, options = {}) => request(`/tasks/${taskId}/review`, {
    method: 'POST',
    body: JSON.stringify(normalizeReviewOptions(options))
  }),
  exportUrl: (taskId, targetId) => `${API_BASE}/tasks/${taskId}/export${targetId ? `?targetId=${encodeURIComponent(targetId)}` : ''}`,
  listBatches: () => request('/batches'),
  getBatch: (batchId) => request(`/batches/${batchId}`),
  cancelBatch: (batchId, payload = {}) => request(`/batches/${batchId}/cancel`, {
    method: 'POST',
    body: JSON.stringify({ confirm: payload.confirm === true })
  }),
  deleteBatch: (batchId, payload = {}) => request(`/batches/${batchId}`, {
    method: 'DELETE',
    body: JSON.stringify({ confirm: payload.confirm === true })
  }),
  resetBatchImportState: (batchId, payload = {}) => request(`/batches/${batchId}/reset-import`, {
    method: 'POST',
    body: JSON.stringify({ confirm: payload.confirm === true })
  }),
  getBatchAnalytics: (batchId) => request(`/batches/${batchId}/analytics`),
  getBatchReviewReport: (batchId) => request(`/batches/${batchId}/review-report`),
  getBatchStability: (batchId) => request(`/batches/${batchId}/stability`),
  getBatchResumePlan: (batchId) => request(`/batches/${batchId}/resume-plan`),
  getExportPackagePreview: (batchId, options = {}) => {
    const normalized = normalizeExportPackageOptions(options);
    const params = new URLSearchParams({
      platforms: normalized.platforms.join(','),
      includeReports: String(normalized.includeReports),
      includeMockImages: String(normalized.includeMockImages),
      includeRealSamples: String(normalized.includeRealSamples)
    });
    return request(`/batches/${batchId}/export-package/preview?${params.toString()}`);
  },
  createExportPackage: (batchId, options = {}) => request(`/batches/${batchId}/export-package`, {
    method: 'POST',
    body: JSON.stringify(normalizeExportPackageOptions(options))
  }),
  getListingCsvPreview: (batchId, options = {}) => {
    const normalized = normalizeListingExportOptions(options);
    const params = new URLSearchParams({
      platforms: normalized.platforms.join(','),
      includeMockImages: String(normalized.includeMockImages),
      includeRealSamples: String(normalized.includeRealSamples)
    });
    return request(`/batches/${batchId}/listing-csv/preview?${params.toString()}`);
  },
  createListingCsvExport: (batchId, options = {}) => request(`/batches/${batchId}/listing-csv`, {
    method: 'POST',
    body: JSON.stringify(normalizeListingExportOptions(options))
  }),
  getUploadReadinessPreview: (batchId, options = {}) => {
    const normalized = normalizeUploadReadinessOptions(options);
    const params = new URLSearchParams({
      platforms: normalized.platforms.join(',')
    });
    return request(`/batches/${batchId}/upload-readiness/preview?${params.toString()}`);
  },
  postUploadReadinessPreview: (batchId, payload = {}) => request(`/batches/${batchId}/upload-readiness/preview`, {
    method: 'POST',
    body: JSON.stringify({
      platforms: normalizeUploadReadinessOptions(payload).platforms,
      packageId: payload.packageId || '',
      listingCsvId: payload.listingCsvId || '',
      confirmDryRun: payload.confirmDryRun === true,
      sandboxConfig: payload.sandboxConfig || {}
    })
  }),
  previewUploadPayload: (batchId, payload = {}) => request(`/batches/${batchId}/upload-payload/preview`, {
    method: 'POST',
    body: JSON.stringify({
      platforms: normalizeUploadReadinessOptions(payload).platforms,
      packageId: payload.packageId || '',
      confirmDryRun: payload.confirmDryRun === true
    })
  }),
  simulateUploadSandbox: (batchId, payload = {}) => request(`/batches/${batchId}/upload-sandbox/simulate`, {
    method: 'POST',
    body: JSON.stringify({
      platforms: normalizeUploadReadinessOptions(payload).platforms,
      packageId: payload.packageId || '',
      confirmSandboxSubmit: payload.confirmSandboxSubmit === true
    })
  }),
  getSkuRetryPlan: (batchId, taskId) => request(`/batches/${batchId}/tasks/${taskId}/retry-plan`),
  executeSkuRetry: (batchId, taskId, payload = {}) => request(`/batches/${batchId}/tasks/${taskId}/retry`, {
    method: 'POST',
    body: JSON.stringify({
      retryStep: payload.retryStep,
      confirmRetry: payload.confirmRetry === true,
      mode: payload.mode || 'mockOnly',
      confirmPaidApi: payload.confirmPaidApi === true
    })
  }),
  refreshBatchAnalytics: (batchId) => request(`/batches/${batchId}/analytics/refresh`, { method: 'POST' }),
  getBatchAnalyticsSummary: () => request('/batches/analytics/summary'),
  getUploadCredentialStatus: () => request('/upload/credentials/status'),
  getUploadSafetyReport: () => request('/upload/safety-report'),
  getFinalAcceptanceTemplate: (options = {}) => {
    const params = new URLSearchParams();
    if (options.version) params.set('version', options.version);
    if (options.targetSkuCount) params.set('targetSkuCount', String(options.targetSkuCount));
    if (options.multiBatch !== undefined) params.set('multiBatch', String(options.multiBatch === true));
    const query = params.toString();
    return request(`/final-acceptance/template${query ? `?${query}` : ''}`);
  },
  getFinalAcceptanceReport: (options = {}) => {
    const params = new URLSearchParams();
    if (options.version) params.set('version', options.version);
    if (options.targetSkuCount) params.set('targetSkuCount', String(options.targetSkuCount));
    if (options.multiBatch !== undefined) params.set('multiBatch', String(options.multiBatch === true));
    const query = params.toString();
    return request(`/final-acceptance/report${query ? `?${query}` : ''}`);
  },
  exportFinalAcceptanceReport: (payload = {}) => request('/final-acceptance/export', {
    method: 'POST',
    body: JSON.stringify(payload)
  }),
  runRealApiAcceptance: (payload = {}) => request('/final-acceptance/real-api/run', {
    method: 'POST',
    body: JSON.stringify({
      taskId: payload.taskId,
      enableVision: payload.enableVision !== false,
      imageTypes: Array.isArray(payload.imageTypes) ? payload.imageTypes.slice(0, 3) : ['main_image'],
      enableReview: payload.enableReview === true,
      maxRealApiCalls: payload.maxRealApiCalls || 3,
      provider: payload.provider || 'openai',
      mattingProvider: 'sharp',
      confirmRealApi: payload.confirmRealApi === true,
      confirmPaidApi: payload.confirmPaidApi === true,
      confirmNoPlatformUpload: payload.confirmNoPlatformUpload === true
    })
  }),
  getRealApiAcceptanceReport: (taskId) => request(`/final-acceptance/real-api/${encodeURIComponent(taskId)}/report`),
  exportRealApiAcceptanceReport: (payload = {}) => request('/final-acceptance/real-api/export', {
    method: 'POST',
    body: JSON.stringify(payload)
  }),
  batchAnalyticsExportUrl: (batchId) => `${API_BASE}/batches/${batchId}/analytics/export`,
  getBatchSop: (batchId) => request(`/batches/${batchId}/sop`),
  batchSopDownloadUrl: (batchId) => `${API_BASE}/batches/${batchId}/sop/download`,
  generalSopDownloadUrl: () => `${API_BASE}/sop/general`,
  getGeneralSop: () => request('/sop/general?format=json'),
  getSettings: () => request('/settings'),
  updateSettings: (payload) => request('/settings', {
    method: 'PUT',
    body: JSON.stringify(payload)
  }),
  resetSettings: () => request('/settings/reset', { method: 'POST' }),
  getEffectiveSettings: () => request('/settings/effective'),
  getFullHealth: () => request('/health/full'),
  getProviderHealth: () => request('/health/providers'),
  getStorageHealth: () => request('/health/storage'),
  getDatabaseHealth: () => request('/health/database'),
  getStorageStatus: () => request('/storage/status'),
  getCleanupSummary: () => request('/cleanup/summary'),
  previewCleanup: (payload = {}) => request('/cleanup/preview', {
    method: 'POST',
    body: JSON.stringify(normalizeCleanupPayload(payload))
  }),
  runCleanup: (payload = {}) => request('/cleanup/run', {
    method: 'POST',
    body: JSON.stringify(normalizeCleanupPayload(payload))
  }),
  getStressTestConfig: () => request('/stress-test/config'),
  runStressTest: (payload = {}) => request('/stress-test/run', {
    method: 'POST',
    body: JSON.stringify(normalizeStressTestPayload(payload))
  }),
  getStressTest: (stressTestId) => request(`/stress-test/${stressTestId}`),
  getStressTestReport: (stressTestId) => request(`/stress-test/${stressTestId}/report`),
  runSingleImageGeneration: (payload = {}) => request('/generate/single-image', {
    method: 'POST',
    body: JSON.stringify({
      taskId: payload.taskId,
      planId: payload.planId,
      imageType: payload.imageType,
      provider: payload.provider || 'openai',
      realMode: payload.realMode || 'auto',
      mattingProvider: payload.mattingProvider || 'sharp',
      confirmReal: payload.confirmReal === true
    })
  }),
  getSingleImageGenerationReport: (taskId) => request(`/generate/${taskId}/report`),
  runThreeSampleGeneration: (payload = {}) => request('/generate/three-sample', {
    method: 'POST',
    body: JSON.stringify({
      taskId: payload.taskId,
      samples: Array.isArray(payload.samples) ? payload.samples.slice(0, 3).map((sample, index) => ({
        sampleId: sample.sampleId || `sample-${index + 1}`,
        imageType: sample.imageType,
        imageId: sample.imageId,
        planId: sample.planId
      })) : [],
      mattingProvider: payload.mattingProvider || 'sharp',
      generationProvider: payload.generationProvider || payload.provider || 'openai',
      provider: payload.provider || 'openai',
      realMode: payload.realMode || 'auto',
      confirmPaidApi: payload.confirmPaidApi === true
    })
  }),
  getThreeSampleGenerationReport: (taskId) => request(`/generate/${taskId}/three-sample-report`),
  getMattingConfig: () => request('/matting/config'),
  adoptMatting: (payload) => request('/matting/adopt', { method: 'POST', body: JSON.stringify({ ...payload, confirm: true }) }),
  runMatting: (payload = {}) => request('/matting/run', {
    method: 'POST',
    body: JSON.stringify(normalizeMattingPayload(payload))
  }),
  compareMatting: (payload = {}) => request('/matting/compare', {
    method: 'POST',
    body: JSON.stringify(normalizeMattingPayload(payload))
  }),
  preflightSqlite: () => request('/storage/preflight-sqlite', { method: 'POST' }),
  migrateToSqlite: (payload = {}) => request('/storage/migrate-to-sqlite', {
    method: 'POST',
    body: JSON.stringify(payload)
  }),
  verifySqlite: () => request('/storage/verify-sqlite', { method: 'POST' }),
  rebuildSqliteIndexes: () => request('/storage/rebuild-sqlite-indexes', { method: 'POST' }),
  getSqliteTrialChecklist: () => request('/storage/trial-checklist'),
  runSqliteTrialCheck: () => request('/storage/run-trial-check', { method: 'POST' }),
  listSnapshots: () => request('/snapshots'),
  createSnapshot: (payload = {}) => request('/snapshots', {
    method: 'POST',
    body: JSON.stringify(payload)
  }),
  getSnapshot: (snapshotId) => request(`/snapshots/${snapshotId}`),
  deleteSnapshot: (snapshotId, confirm = false) => request(`/snapshots/${snapshotId}`, {
    method: 'DELETE',
    body: JSON.stringify({ confirm })
  }),
  restoreSnapshot: (snapshotId, payload = {}) => request(`/snapshots/${snapshotId}/restore`, {
    method: 'POST',
    body: JSON.stringify(payload)
  }),
  snapshotDownloadUrl: (snapshotId) => `${API_BASE}/snapshots/${snapshotId}/download`,
  importBatchFolder: (payload) => request('/batches/import-folder', {
    method: 'POST',
    body: JSON.stringify(normalizeImportBatchFolderPayload(payload))
  }),
  listWorkflowTemplates: () => request('/workflow-templates'),
  getWorkflowTemplate: (templateId) => request(`/workflow-templates/${templateId}`),
  createWorkflowTemplate: (payload) => request('/workflow-templates', {
    method: 'POST',
    body: JSON.stringify(payload)
  }),
  updateWorkflowTemplate: (templateId, payload) => request(`/workflow-templates/${templateId}`, {
    method: 'PUT',
    body: JSON.stringify(payload)
  }),
  deleteWorkflowTemplate: (templateId) => request(`/workflow-templates/${templateId}`, { method: 'DELETE' }),
  cloneWorkflowTemplate: (templateId) => request(`/workflow-templates/${templateId}/clone`, { method: 'POST' }),
  applyBatchTemplate: (batchId, templateId) => request(`/batches/${batchId}/apply-template`, {
    method: 'POST',
    body: JSON.stringify({ templateId })
  }),
  getImportScanStatus: () => request('/import-scan/status'),
  scanImportRoot: (payload = {}) => request('/import-scan/scan', {
    method: 'POST',
    body: JSON.stringify(normalizeImportScanPayload(payload))
  }),
  importScannedFolders: (payload) => request('/import-scan/import', {
    method: 'POST',
    body: JSON.stringify(normalizeImportScannedFoldersPayload(payload))
  }),
  batchRecognize: (batchId, approval = {}) => request(`/batches/${batchId}/recognize`, { method: 'POST', body: JSON.stringify({ confirmPaidApi: approval.confirmPaidApi === true }) }),
  batchApplyTargets: (batchId, defaultTargets) => request(`/batches/${batchId}/apply-targets`, {
    method: 'POST',
    body: JSON.stringify({ defaultTargets })
  }),
  batchPlan: (batchId) => request(`/batches/${batchId}/plan`, { method: 'POST' }),
  batchGenerate: (batchId, options = {}) => request(`/batches/${batchId}/generate`, {
    method: 'POST',
    body: JSON.stringify(options)
  }),
  batchReview: (batchId, options = {}) => request(`/batches/${batchId}/review`, {
    method: 'POST',
    body: JSON.stringify(normalizeReviewOptions(options))
  }),
  startBatchQueue: (batchId, options = {}) => request(`/batches/${batchId}/queue/start`, {
    method: 'POST',
    body: JSON.stringify(normalizeBatchQueueOptions(options))
  }),
  pauseBatchQueue: (batchId) => request(`/batches/${batchId}/queue/pause`, { method: 'POST' }),
  resumeBatchQueue: (batchId, approval = {}) => request(`/batches/${batchId}/queue/resume`, { method: 'POST', body: JSON.stringify({ confirmPaidApi: approval.confirmPaidApi === true }) }),
  cancelBatchQueue: (batchId) => request(`/batches/${batchId}/queue/cancel`, { method: 'POST' }),
  retryFailedBatchQueue: (batchId, options = {}) => request(`/batches/${batchId}/queue/retry-failed`, {
    method: 'POST',
    body: JSON.stringify(normalizeBatchQueueOptions(options))
  }),
  getBatchLogs: (batchId) => request(`/batches/${batchId}/logs`),
  batchExportUrl: (batchId) => `${API_BASE}/batches/${batchId}/export`,
  getWorkbenchOverview: () => request('/workbench/overview'),
  listWorkbenchJobs: () => request('/workbench/jobs'),
  getCollectionDraft: () => request('/workbench/collection-drafts'),
  stageCollectionRows: (rows, options, context) => request('/workbench/collection-drafts/rows', {
    method: 'POST', body: JSON.stringify({ rows, options, expectedActorId: context.actorId, generation: context.generation })
  }),
  stageCollectionSheet: (file, options, context) => {
    const body = new FormData(); body.append('sheet', file); body.append('options', JSON.stringify(options));
    body.append('expectedActorId', context.actorId); body.append('generation', context.generation);
    return request('/workbench/collection-drafts/sheet', { method: 'POST', body });
  },
  submitCollectionDraft: (id, actorId) => request(`/workbench/collection-drafts/${encodeURIComponent(id)}/submit`, {
    method: 'POST', body: JSON.stringify({ expectedActorId: actorId })
  }),
  acknowledgeCollectionDraft: (id, actorId, jobId) => request(`/workbench/collection-drafts/${encodeURIComponent(id)}/ack`, {
    method: 'POST', body: JSON.stringify({ expectedActorId: actorId, jobId })
  }),
  discardCollectionDraft: (id, actorId) => request(`/workbench/collection-drafts/${encodeURIComponent(id)}/discard`, {
    method: 'POST', body: JSON.stringify({ expectedActorId: actorId, confirm: true })
  }),
  createCollectionPlan: (payload = {}) => request('/workbench/collection-plans', {
    method: 'POST',
    body: JSON.stringify(payload)
  }),
  createCollectionJob: (file, options = {}) => {
    const formData = new FormData();
    formData.append('sheet', file);
    formData.append('options', JSON.stringify(options));
    return request('/workbench/collection-jobs', { method: 'POST', body: formData });
  },
  createCollectionJobFromRows: (rows, options = {}) => request('/workbench/collection-jobs/rows', {
    method: 'POST',
    body: JSON.stringify({ rows, options })
  }),
  getCollectionJob: (jobId) => request(`/workbench/collection-jobs/${encodeURIComponent(jobId)}`),
  previewCollectionManifestRepair: id => request(`/workbench/collection-jobs/${encodeURIComponent(id)}/manifest-repair-preview`),
  repairCollectionManifest: (id, payload) => request(`/workbench/collection-jobs/${encodeURIComponent(id)}/repair-manifest`, { method: 'POST', body: JSON.stringify(payload) }),
  previewCollectionPack: (jobId) => request(`/workbench/collection-jobs/${encodeURIComponent(jobId)}/sku-pack-preview`),
  createCollectionPack: (jobId, payload) => request(`/workbench/collection-jobs/${encodeURIComponent(jobId)}/sku-pack`, { method: 'POST', body: JSON.stringify(payload) }),
  runCollectionJob: (jobId, options = {}) => request(`/workbench/collection-jobs/${encodeURIComponent(jobId)}/run`, {
    method: 'POST',
    body: JSON.stringify(options)
  }),
  createListingDryRun: (payload = {}) => request('/workbench/listing-dry-runs', {
    method: 'POST',
    body: JSON.stringify(payload)
  }),
  createPricingPreview: (payload = {}) => request('/workbench/pricing-previews', {
    method: 'POST',
    body: JSON.stringify(payload)
  }),
  listMaterialRecords: (filters = {}) => {
    const params = new URLSearchParams();
    Object.entries(filters).forEach(([key, value]) => { if (value) params.set(key, value); });
    return request(`/workbench/materials${params.size ? `?${params.toString()}` : ''}`);
  },
  importMaterialRecords: (records) => request('/workbench/materials/import', {
    method: 'POST',
    body: JSON.stringify({ records })
  }),
  updateMaterialRecord: (recordId, patch) => request(`/workbench/materials/${encodeURIComponent(recordId)}`, {
    method: 'PATCH',
    body: JSON.stringify(patch)
  }),
  archiveMaterialRecord: (recordId, restore = false) => request(`/workbench/materials/${encodeURIComponent(recordId)}${restore ? '/restore' : ''}`, {
    method: restore ? 'POST' : 'DELETE', body: JSON.stringify({ confirm: true })
  }),
  materialRecordsExportUrl: (filters = {}) => {
    const params = new URLSearchParams();
    Object.entries(filters).forEach(([key, value]) => { if (value) params.set(key, value); });
    return `${API_BASE}/workbench/materials/export.csv${params.size ? `?${params.toString()}` : ''}`;
  },
  inspectWorkbookTemplate: (file, platformId = 'temu') => {
    const formData = new FormData();
    formData.append('template', file);
    formData.append('platformId', platformId);
    return request('/workbench/template-inspections', { method: 'POST', body: formData });
  },
  previewWorkbookFill: (file, options = {}) => {
    const formData = new FormData();
    formData.append('template', file);
    formData.append('options', JSON.stringify(options));
    return request('/workbench/template-fills/preview', { method: 'POST', body: formData });
  },
  executeWorkbookFill: (fillId, payload) => request(`/workbench/template-fills/${encodeURIComponent(fillId)}/execute`, { method: 'POST', body: JSON.stringify(payload) }),
  createImagePack: (files, options = {}) => {
    const formData = new FormData();
    Array.from(files || []).forEach((file) => formData.append('images', file));
    Object.entries(options).forEach(([key, value]) => formData.append(key, String(value)));
    return request('/workbench/image-packs', { method: 'POST', body: formData });
  },
  createSkuPack: (files, options = {}) => {
    const selectedFiles = Array.from(files || []);
    const formData = new FormData();
    selectedFiles.forEach((file) => formData.append('images', file));
    formData.append('relativePaths', JSON.stringify(selectedFiles.map((file) => file.webkitRelativePath || file.name)));
    formData.append('options', JSON.stringify(options));
    return request('/workbench/sku-packs', { method: 'POST', body: formData });
  },
  importSkuMetadata: (file) => {
    const formData = new FormData();
    formData.append('sheet', file);
    return request('/workbench/sku-metadata-imports', { method: 'POST', body: formData });
  }
};
