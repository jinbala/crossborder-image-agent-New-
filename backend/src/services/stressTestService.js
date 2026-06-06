import fs from 'node:fs/promises';
import path from 'node:path';
import { nanoid } from 'nanoid';
import { getBatchTask, getTask, listBatchTasks, paths } from './db.js';
import { getVisionProvider } from '../providers/vision/index.js';
import { getProviderCallCost } from '../config/providerCostConfig.js';

const DEFAULT_REPORT_DIR = path.join(paths.dataDir, 'stress-tests');
const STEP_KEYS = ['importScan', 'recognition', 'productConfirmWait', 'planGeneration', 'imageGeneration', 'review', 'export', 'total'];

export const STRESS_TEST_MODES = [
  {
    id: 'mockOnly',
    label: 'mockOnly：全链路 Mock 压测',
    enabled: true,
    costWarning: '不调用真实 Provider，不产生 AI 费用。'
  },
  {
    id: 'realVisionMockGenerate',
    label: 'realVisionMockGenerate：真实识别 + Mock 生成',
    enabled: true,
    costWarning: '此模式会调用真实商品识别 Provider，可能产生 API 成本。图片生成和审核仍使用 mock，不会调用真实生图。'
  },
  {
    id: 'optionalRealReview',
    label: 'optionalRealReview：真实识别 + Mock 生成 + 真实审核',
    enabled: false,
    costWarning: '本阶段不会调用真实 Provider，也不会产生真实审核费用。'
  }
];

function nowIso() {
  return new Date().toISOString();
}

function normalizePositiveInt(value, fallback, max = 100) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(Math.floor(parsed), max);
}

function normalizePayload(payload = {}) {
  return {
    mode: payload.mode || 'mockOnly',
    skuCount: normalizePositiveInt(payload.skuCount, 3),
    concurrency: normalizePositiveInt(payload.concurrency, 1, 2),
    exportZip: Boolean(payload.exportZip),
    batchId: payload.batchId ? String(payload.batchId) : null
  };
}

function providerUnavailableError() {
  const error = new Error('真实识别 Provider 未配置或不可用，请先检查 Provider 设置。');
  error.statusCode = 400;
  return error;
}

function getReportDir(options = {}) {
  return path.resolve(options.reportDir || DEFAULT_REPORT_DIR);
}

function assertSafeReportId(stressTestId) {
  const value = String(stressTestId || '');
  if (!/^stress-[a-zA-Z0-9_-]+$/.test(value)) {
    const error = new Error('Invalid stressTestId');
    error.statusCode = 400;
    throw error;
  }
  return value;
}

function reportPath(stressTestId, options = {}) {
  const reportDir = getReportDir(options);
  const safeId = assertSafeReportId(stressTestId);
  const resolved = path.resolve(reportDir, `${safeId}.json`);
  const relative = path.relative(reportDir, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    const error = new Error('Invalid stress test report path');
    error.statusCode = 400;
    throw error;
  }
  return resolved;
}

async function loadBatch(input, options = {}) {
  if (input.batchId) {
    if (options.batchReader) return options.batchReader(input.batchId);
    return getBatchTask(input.batchId);
  }
  if (options.listBatchesReader) {
    const batches = await options.listBatchesReader();
    return batches?.[0] || null;
  }
  if (options.batchReader) return options.batchReader();
  const batches = await listBatchTasks();
  return batches?.[0] || null;
}

async function loadTaskForSku(sku, options = {}) {
  if (!sku?.taskId) return null;
  if (options.taskReader) return options.taskReader(sku.taskId);
  return getTask(sku.taskId);
}

function createVisionProvider(options = {}) {
  try {
    const provider = options.visionProviderFactory
      ? options.visionProviderFactory()
      : getVisionProvider();
    if (!provider || typeof provider.recognize !== 'function' || provider.provider === 'mock') {
      throw providerUnavailableError();
    }
    return provider;
  } catch (err) {
    if (err?.message === '真实识别 Provider 未配置或不可用，请先检查 Provider 设置。') throw err;
    throw providerUnavailableError();
  }
}

function emptyStepDurations() {
  return Object.fromEntries(STEP_KEYS.map((key) => [key, {
    totalMs: 0,
    minMs: 0,
    maxMs: 0,
    avgMs: 0,
    count: 0,
    skipped: key === 'productConfirmWait' || key === 'export'
  }]));
}

function addDuration(bucket, ms) {
  bucket.totalMs += ms;
  bucket.count += 1;
  bucket.minMs = bucket.count === 1 ? ms : Math.min(bucket.minMs, ms);
  bucket.maxMs = Math.max(bucket.maxMs, ms);
  bucket.avgMs = Math.round(bucket.totalMs / bucket.count);
}

function successfulStepDurations(index, exportZip) {
  const offset = index + 1;
  return {
    importScan: 2,
    recognition: 8 + offset,
    productConfirmWait: 0,
    planGeneration: 4 + offset,
    imageGeneration: 12 + offset * 2,
    review: 5 + offset,
    export: exportZip ? 3 + offset : 0
  };
}

function buildSuccessfulSkuResult(sku, index, input) {
  const durations = successfulStepDurations(index, input.exportZip);
  const totalDuration = Object.values(durations).reduce((sum, value) => sum + value, 0);
  return {
    skuId: sku.skuId || sku.id || `SKU-${index + 1}`,
    skuName: sku.displayName || sku.folderName || sku.skuId || `SKU-${index + 1}`,
    taskId: sku.taskId || null,
    status: 'completed',
    currentStep: input.exportZip ? 'export' : 'review',
    startedAt: nowIso(),
    completedAt: nowIso(),
    durationMs: totalDuration,
    failedStep: null,
    errorMessage: '',
    retryCount: 0,
    generatedImageCount: 2,
    reviewedImageCount: 2,
    exportedFileCount: input.exportZip ? 1 : 0,
    recognitionStatus: input.mode === 'mockOnly' ? 'mock' : 'success',
    recognitionDurationMs: durations.recognition,
    recognitionProvider: input.mode === 'mockOnly' ? 'Mock Vision' : '',
    recognitionModel: input.mode === 'mockOnly' ? 'mock-only' : '',
    recognitionError: '',
    recognizedFieldCount: 0,
    confirmedFieldCount: 0,
    riskyFieldCount: 0,
    conflictFieldCount: 0,
    stepDurations: durations
  };
}

function buildFailedSkuResult(sku, index) {
  const message = sku.error?.message || sku.error || 'SKU 当前不可用于 mockOnly 压测';
  return {
    skuId: sku.skuId || sku.id || `SKU-${index + 1}`,
    skuName: sku.displayName || sku.folderName || sku.skuId || `SKU-${index + 1}`,
    taskId: sku.taskId || null,
    status: 'failed',
    currentStep: sku.currentStep || 'import',
    startedAt: nowIso(),
    completedAt: nowIso(),
    durationMs: 1,
    failedStep: 'importScan',
    errorMessage: String(message),
    retryCount: 0,
    generatedImageCount: 0,
    reviewedImageCount: 0,
    exportedFileCount: 0,
    recognitionStatus: 'skipped',
    recognitionDurationMs: 0,
    recognitionProvider: '',
    recognitionModel: '',
    recognitionError: '',
    recognizedFieldCount: 0,
    confirmedFieldCount: 0,
    riskyFieldCount: 0,
    conflictFieldCount: 0,
    stepDurations: {
      importScan: 1,
      recognition: 0,
      productConfirmWait: 0,
      planGeneration: 0,
      imageGeneration: 0,
      review: 0,
      export: 0
    }
  };
}

function isFailedSku(sku) {
  return !sku?.taskId || sku.status === 'failed' || Boolean(sku.error);
}

function nonEmptyValue(value) {
  if (Array.isArray(value)) return value.length > 0;
  if (value && typeof value === 'object') return Object.keys(value).length > 0;
  return value !== null && value !== undefined && value !== '';
}

function countRecognizedFields(data = {}) {
  const fields = data.productInfoRaw || data.productInfo || {};
  return Object.values(fields).filter(nonEmptyValue).length;
}

function buildRealVisionSuccessSkuResult({ sku, index, input, recognition }) {
  const durations = successfulStepDurations(index, input.exportZip);
  durations.recognition = Number(recognition.durationMs || 0);
  const totalDuration = Object.values(durations).reduce((sum, value) => sum + value, 0);
  return {
    skuId: sku.skuId || sku.id || `SKU-${index + 1}`,
    skuName: sku.displayName || sku.folderName || sku.skuId || `SKU-${index + 1}`,
    taskId: sku.taskId || null,
    status: 'completed',
    currentStep: input.exportZip ? 'export' : 'review',
    startedAt: nowIso(),
    completedAt: nowIso(),
    durationMs: totalDuration,
    failedStep: null,
    errorMessage: '',
    retryCount: 0,
    generatedImageCount: 2,
    reviewedImageCount: 2,
    exportedFileCount: input.exportZip ? 1 : 0,
    recognitionStatus: 'success',
    recognitionDurationMs: durations.recognition,
    recognitionProvider: recognition.provider || '',
    recognitionModel: recognition.model || '',
    recognitionError: '',
    recognizedFieldCount: countRecognizedFields(recognition.data),
    confirmedFieldCount: 0,
    riskyFieldCount: Array.isArray(recognition.data?.risks) ? recognition.data.risks.length : 0,
    conflictFieldCount: 0,
    stepDurations: durations,
    recognitionSummary: {
      hasVisibleText: Array.isArray(recognition.data?.visibleText) && recognition.data.visibleText.length > 0,
      riskCount: Array.isArray(recognition.data?.risks) ? recognition.data.risks.length : 0
    }
  };
}

function buildRealVisionFailedSkuResult({ sku, index, input, recognition, errorMessage }) {
  const recognitionDuration = Number(recognition?.durationMs || 0);
  const durations = {
    importScan: 2,
    recognition: recognitionDuration,
    productConfirmWait: 0,
    planGeneration: 0,
    imageGeneration: 0,
    review: 0,
    export: 0
  };
  const message = errorMessage || recognition?.error?.message || '真实识别失败';
  return {
    skuId: sku.skuId || sku.id || `SKU-${index + 1}`,
    skuName: sku.displayName || sku.folderName || sku.skuId || `SKU-${index + 1}`,
    taskId: sku.taskId || null,
    status: 'failed',
    currentStep: 'recognition',
    startedAt: nowIso(),
    completedAt: nowIso(),
    durationMs: Object.values(durations).reduce((sum, value) => sum + value, 0),
    failedStep: 'recognition',
    errorMessage: message,
    retryCount: 0,
    generatedImageCount: 0,
    reviewedImageCount: 0,
    exportedFileCount: 0,
    recognitionStatus: 'failed',
    recognitionDurationMs: recognitionDuration,
    recognitionProvider: recognition?.provider || '',
    recognitionModel: recognition?.model || '',
    recognitionError: message,
    recognizedFieldCount: 0,
    confirmedFieldCount: 0,
    riskyFieldCount: 0,
    conflictFieldCount: 0,
    stepDurations: durations
  };
}

function aggregateStepDurations(skuResults) {
  const aggregate = emptyStepDurations();
  for (const result of skuResults) {
    for (const key of STEP_KEYS.filter((item) => item !== 'total')) {
      const value = Number(result.stepDurations?.[key] || 0);
      if (value > 0 || key === 'productConfirmWait' || key === 'export') {
        addDuration(aggregate[key], value);
      }
    }
    addDuration(aggregate.total, Number(result.durationMs || 0));
  }
  return aggregate;
}

function buildProviderStats(skuResults, input = { mode: 'mockOnly' }, providerCalls = []) {
  const successSku = skuResults.filter((item) => item.status === 'completed');
  const imageMs = successSku.reduce((sum, item) => sum + Number(item.stepDurations.imageGeneration || 0), 0);
  const reviewMs = successSku.reduce((sum, item) => sum + Number(item.stepDurations.review || 0), 0);
  const mockProviders = [
    input.mode === 'mockOnly' ? {
      providerName: 'Mock Vision',
      providerType: 'vision',
      modelName: 'mock-only',
      callCount: successSku.length,
      successCount: successSku.length,
      failureCount: 0,
      totalDurationMs: successSku.reduce((sum, item) => sum + Number(item.stepDurations.recognition || 0), 0),
      averageDurationMs: successSku.length ? Math.round(successSku.reduce((sum, item) => sum + Number(item.stepDurations.recognition || 0), 0) / successSku.length) : 0,
      estimatedCost: 0
    } : null,
    {
      providerName: 'Mock Image',
      providerType: 'image',
      modelName: 'mock-only',
      callCount: successSku.length * 2,
      successCount: successSku.length * 2,
      failureCount: 0,
      totalDurationMs: imageMs,
      averageDurationMs: successSku.length ? Math.round(imageMs / successSku.length) : 0,
      estimatedCost: 0
    },
    {
      providerName: 'Mock Review',
      providerType: 'review',
      modelName: 'mock-only',
      callCount: successSku.length * 2,
      successCount: successSku.length * 2,
      failureCount: 0,
      totalDurationMs: reviewMs,
      averageDurationMs: successSku.length ? Math.round(reviewMs / successSku.length) : 0,
      estimatedCost: 0
    }
  ].filter(Boolean);

  if (input.mode !== 'realVisionMockGenerate') return mockProviders;

  const providerName = providerCalls[0]?.providerName || 'vision';
  const modelName = providerCalls[0]?.modelName || '';
  const totalDurationMs = providerCalls.reduce((sum, item) => sum + Number(item.durationMs || 0), 0);
  const callCount = providerCalls.length;
  const perCallCost = getProviderCallCost('vision', providerName);
  return [
    {
      providerName,
      providerType: 'vision',
      modelName,
      callCount,
      successCount: providerCalls.filter((item) => item.success).length,
      failureCount: providerCalls.filter((item) => !item.success).length,
      totalDurationMs,
      averageDurationMs: callCount ? Math.round(totalDurationMs / callCount) : 0,
      estimatedCost: perCallCost * callCount,
      costNote: perCallCost > 0 ? '按当前成本配置估算。' : '当前成本为估算占位，后续可接入真实价格表。',
      errorMessages: providerCalls.filter((item) => item.errorMessage).map((item) => item.errorMessage)
    },
    ...mockProviders
  ];
}

function buildErrorSummary(skuResults) {
  const failed = skuResults.filter((item) => item.status === 'failed');
  const errorsByStep = {};
  const topErrors = {};
  for (const item of failed) {
    errorsByStep[item.failedStep] = (errorsByStep[item.failedStep] || 0) + 1;
    topErrors[item.errorMessage] = (topErrors[item.errorMessage] || 0) + 1;
  }
  return {
    errorCount: failed.length,
    errorsByStep,
    errorsByProvider: {},
    topErrors: Object.entries(topErrors).map(([message, count]) => ({ message, count })),
    failedSkuList: failed.map((item) => item.skuId)
  };
}

function summaryStatus(successSku, failedSku, totalSku) {
  if (failedSku === 0) return 'completed';
  if (successSku === 0 && totalSku > 0) return 'failed';
  return 'partial';
}

function buildCostNotice(input, providerStats) {
  if (input.mode !== 'realVisionMockGenerate') return 'mockOnly 不调用真实 Provider，不产生 AI 费用。';
  const vision = providerStats.find((item) => item.providerType === 'vision');
  if (Number(vision?.estimatedCost || 0) === 0) {
    return '当前成本为估算占位，尚未接入真实价格表。真实识别可能已产生实际 API 成本。';
  }
  return '真实识别成本已按当前成本配置估算，实际账单以 Provider 后台为准。';
}

async function runRealVisionSkuResults(selectedSkus, input, options = {}) {
  const provider = createVisionProvider(options);
  const skuResults = [];
  const providerCalls = [];
  for (const [index, sku] of selectedSkus.entries()) {
    if (sku.status === 'failed' || sku.error) {
      skuResults.push(buildFailedSkuResult(sku, index));
      continue;
    }
    const task = await loadTaskForSku(sku, options);
    if (!task) {
      const recognition = { provider: provider.provider, model: provider.model, durationMs: 0, error: { message: 'SKU 缺少可识别的任务数据' } };
      providerCalls.push({ providerName: provider.provider, modelName: provider.model, durationMs: 0, success: false, errorMessage: recognition.error.message });
      skuResults.push(buildRealVisionFailedSkuResult({ sku, index, input, recognition }));
      continue;
    }
    let recognition;
    try {
      recognition = await provider.recognize({
        task,
        image: task.sourceImages?.[0] || task.originalImage,
        images: task.sourceImages || []
      });
    } catch (err) {
      recognition = {
        provider: provider.provider,
        model: provider.model,
        durationMs: 0,
        status: 'failed',
        error: { message: err.message || '真实识别失败' },
        data: null
      };
    }
    const success = recognition?.status === 'success' || recognition?.status === 'succeeded';
    const errorMessage = recognition?.error?.code === 'MISSING_API_KEY'
      ? '真实识别 Provider 未配置或不可用，请先检查 Provider 设置。'
      : recognition?.error?.message || '';
    providerCalls.push({
      providerName: recognition?.provider || provider.provider,
      modelName: recognition?.model || provider.model,
      durationMs: Number(recognition?.durationMs || 0),
      success,
      errorMessage
    });
    skuResults.push(success
      ? buildRealVisionSuccessSkuResult({ sku, index, input, recognition })
      : buildRealVisionFailedSkuResult({ sku, index, input, recognition, errorMessage }));
  }
  return { skuResults, providerCalls };
}

export function getStressTestConfig() {
  return {
    modes: STRESS_TEST_MODES,
    defaults: {
      mode: 'mockOnly',
      skuCount: 3,
      concurrency: 1,
      exportZip: false
    },
    skuCountOptions: [3, 5, 10],
    maxConcurrency: 2
  };
}

export async function runStressTest(payload = {}, options = {}) {
  const input = normalizePayload(payload);
  const modeConfig = STRESS_TEST_MODES.find((mode) => mode.id === input.mode);
  if (!modeConfig?.enabled) {
    const error = new Error('当前阶段只支持 mockOnly，真实 Provider 模式暂未启用。');
    error.statusCode = 400;
    throw error;
  }

  const batch = await loadBatch(input, options);
  const selectedSkus = (batch?.skuTasks || []).slice(0, input.skuCount);
  if (!selectedSkus.length) {
    const error = new Error('没有可用于压测的 SKU。请先创建或导入 batch SKU。');
    error.statusCode = 400;
    throw error;
  }

  const startedAt = nowIso();
  const { skuResults, providerCalls } = input.mode === 'realVisionMockGenerate'
    ? await runRealVisionSkuResults(selectedSkus, input, options)
    : {
        skuResults: selectedSkus.map((sku, index) => (
          isFailedSku(sku)
            ? buildFailedSkuResult(sku, index)
            : buildSuccessfulSkuResult(sku, index, input)
        )),
        providerCalls: []
      };
  const completedAt = nowIso();
  const successSku = skuResults.filter((item) => item.status === 'completed').length;
  const failedSku = skuResults.filter((item) => item.status === 'failed').length;
  const durationMs = skuResults.reduce((sum, item) => sum + Number(item.durationMs || 0), 0);
  const stressTestId = `stress-${Date.now()}-${nanoid(8)}`;
  const providerStats = buildProviderStats(skuResults, input, providerCalls);
  const estimatedCost = providerStats.reduce((sum, item) => sum + Number(item.estimatedCost || 0), 0);
  const mockProviderCalls = providerStats
    .filter((item) => item.providerName.startsWith('Mock '))
    .reduce((sum, item) => sum + Number(item.callCount || 0), 0);
  const realProviderCalls = providerStats
    .filter((item) => !item.providerName.startsWith('Mock '))
    .reduce((sum, item) => sum + Number(item.callCount || 0), 0);
  const report = {
    config: input,
    summary: {
      stressTestId,
      mode: input.mode,
      batchId: batch?.id || input.batchId,
      batchName: batch?.name || '',
      startedAt,
      completedAt,
      durationMs,
      status: summaryStatus(successSku, failedSku, skuResults.length),
      totalSku: skuResults.length,
      successSku,
      failedSku,
      skippedSku: 0,
      concurrency: input.concurrency,
      exportZip: input.exportZip,
      estimatedCost,
      realProviderCalls,
      mockProviderCalls,
      costWarning: modeConfig.costWarning
    },
    skuResults,
    stepDurations: aggregateStepDurations(skuResults),
    providerStats,
    errors: buildErrorSummary(skuResults),
    costNotice: buildCostNotice(input, providerStats),
    generatedAt: completedAt
  };

  const filePath = reportPath(stressTestId, options);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(report, null, 2), 'utf8');
  return report;
}

export async function getStressTestReport(stressTestId, options = {}) {
  const filePath = reportPath(stressTestId, options);
  try {
    const content = await fs.readFile(filePath, 'utf8');
    return JSON.parse(content);
  } catch (err) {
    if (err.code === 'ENOENT') {
      const error = new Error('Stress test report not found');
      error.statusCode = 404;
      throw error;
    }
    throw err;
  }
}
