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

async function request(path, options = {}) {
  const headers = options.body instanceof FormData
    ? options.headers
    : { 'Content-Type': 'application/json', ...options.headers };

  const response = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers
  });

  if (!response.ok) {
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

    throw new Error(message);
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
  const concurrency = Number(safeValue.concurrency);
  if (Number.isFinite(concurrency) && concurrency > 0) payload.concurrency = concurrency;
  if (safeValue.filter) payload.filter = String(safeValue.filter);
  return payload;
}

export const api = {
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
  recognize: (taskId) => request(`/tasks/${taskId}/recognize`, { method: 'POST' }),
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
  previewMatting: (taskId, planId, sourceImageId) => request(`/tasks/${taskId}/plans/${planId}/matting-preview`, {
    method: 'POST',
    body: JSON.stringify(sourceImageId ? { sourceImageId } : {})
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
      includeMockImages: String(normalized.includeMockImages)
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
  batchRecognize: (batchId) => request(`/batches/${batchId}/recognize`, { method: 'POST' }),
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
  resumeBatchQueue: (batchId) => request(`/batches/${batchId}/queue/resume`, { method: 'POST' }),
  cancelBatchQueue: (batchId) => request(`/batches/${batchId}/queue/cancel`, { method: 'POST' }),
  retryFailedBatchQueue: (batchId, options = {}) => request(`/batches/${batchId}/queue/retry-failed`, {
    method: 'POST',
    body: JSON.stringify(normalizeBatchQueueOptions(options))
  }),
  getBatchLogs: (batchId) => request(`/batches/${batchId}/logs`),
  batchExportUrl: (batchId) => `${API_BASE}/batches/${batchId}/export`
};
