#!/usr/bin/env node
import '../src/config/env.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { getVisionProvider } from '../src/providers/vision/index.js';
import { applyRecognitionModeToEnv, getVisionRecognitionConfig, normalizeRecognitionMode } from '../src/providers/vision/visionRecognitionConfig.js';

const scriptPath = fileURLToPath(import.meta.url);
const backendRoot = path.resolve(path.dirname(scriptPath), '..');
const projectRoot = path.resolve(backendRoot, '..');
const resultDir = path.join(backendRoot, 'test-results');
const reportPath = path.join(projectRoot, 'docs', 'vision-recognition-test-report.md');

const SUPPORTED_PROVIDERS = ['gemini', 'qwen', 'openai', 'mock'];
const SUPPORTED_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp']);
const MAX_IMAGES_PER_SKU = 15;
const MAX_FILE_SIZE = 10 * 1024 * 1024;
const MAX_TOTAL_SIZE = 100 * 1024 * 1024;

const fieldWeights = {
  productName: 10,
  category: 8,
  capacity: 10,
  interfaceType: 8,
  compatibleDevices: 8,
  dimensions: 8,
  material: 6,
  packageIncluded: 8,
  sellingPoints: 8,
  visibleSpecs: 8,
  visibleText: 10,
  risks: 8,
  notes: 0,
  brand: 0,
  model: 0
};

function usage() {
  return [
    'Usage:',
    '  node scripts/runVisionBatchTest.js --provider gemini --dir test-assets/sku001-hard-drive',
    '  node scripts/runVisionBatchTest.js --providers gemini,qwen,openai --dir test-assets/sku001-hard-drive',
    '  node scripts/runVisionBatchTest.js --provider gemini --dir test-assets --recursive',
    '  node scripts/runVisionBatchTest.js --providers gemini,qwen,openai --dir test-assets --recursive',
    '  node scripts/runVisionBatchTest.js --provider gemini --dir test-assets/sku001-hard-drive --mode fast',
    '  node scripts/runVisionBatchTest.js --from-result test-results/vision-batch-xxxx.json'
  ].join('\n');
}

function parseProviders(value) {
  const providers = String(value || '')
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
  const unsupported = providers.find((provider) => !SUPPORTED_PROVIDERS.includes(provider));
  if (unsupported) {
    const error = new Error(`Unsupported provider: ${unsupported}`);
    error.code = 'UNSUPPORTED_PROVIDER';
    throw error;
  }
  return [...new Set(providers)];
}

export function parseVisionBatchArgs(argv = []) {
  const options = {
    providers: [],
    dir: null,
    recursive: false,
    fromResult: null,
    mode: null
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--provider') {
      options.providers = parseProviders(argv[++index]);
    } else if (arg === '--providers') {
      options.providers = parseProviders(argv[++index]);
    } else if (arg === '--dir') {
      options.dir = argv[++index] || null;
    } else if (arg === '--recursive') {
      options.recursive = true;
    } else if (arg === '--from-result') {
      options.fromResult = argv[++index] || null;
      options.providers = [];
    } else if (arg === '--mode') {
      options.mode = normalizeRecognitionMode(argv[++index]);
    } else if (arg.startsWith('--')) {
      const error = new Error(`Unknown option: ${arg}`);
      error.code = 'UNKNOWN_OPTION';
      throw error;
    }
  }

  if (!options.fromResult && !options.providers.length) {
    options.providers = parseProviders(process.env.VISION_PROVIDER || process.env.AI_PROVIDER || 'mock');
  }

  return options;
}

export function getProviderAvailability(provider, env = process.env) {
  const keyByProvider = {
    gemini: 'GEMINI_API_KEY',
    qwen: 'QWEN_API_KEY',
    openai: 'OPENAI_API_KEY'
  };
  const requiredKey = keyByProvider[provider];
  if (!requiredKey || provider === 'mock') return { available: true, status: 'ready', error: null };
  if (!env[requiredKey]) {
    return {
      available: false,
      status: 'skipped',
      error: {
        code: 'MISSING_API_KEY',
        message: `${requiredKey} is required for provider ${provider}`
      }
    };
  }
  return { available: true, status: 'ready', error: null };
}

function hasValue(value) {
  if (Array.isArray(value)) return value.length > 0;
  return value !== null && value !== undefined && value !== '';
}

export function computeFieldCompleteness(data) {
  const safeData = data && typeof data === 'object' ? data : {};
  const product = safeData.productInfoRaw && typeof safeData.productInfoRaw === 'object'
    ? safeData.productInfoRaw
    : {};
  const fields = {
    productName: hasValue(product.productName || product.name),
    category: hasValue(product.category),
    brand: hasValue(product.brand),
    model: hasValue(product.model),
    capacity: hasValue(product.capacity),
    interfaceType: hasValue(product.interfaceType),
    compatibleDevices: hasValue(product.compatibleDevices),
    dimensions: hasValue(product.dimensions || product.sizes),
    material: hasValue(product.material),
    packageIncluded: hasValue(product.packageIncluded),
    sellingPoints: hasValue(product.sellingPoints),
    visibleSpecs: hasValue(product.visibleSpecs),
    visibleText: hasValue(safeData.visibleText),
    risks: hasValue(safeData.risks),
    notes: hasValue(safeData.notes)
  };
  const score = Object.entries(fieldWeights).reduce((sum, [field, weight]) => sum + (fields[field] ? weight : 0), 0);
  const maxScore = Object.values(fieldWeights).reduce((sum, weight) => sum + weight, 0);
  return { fields, score, maxScore, percent: maxScore ? Math.round((score / maxScore) * 100) : 0 };
}

function isSupportedImage(filePath) {
  return SUPPORTED_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

async function listSkuDirs(rootDir) {
  const entries = await fs.readdir(rootDir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(rootDir, entry.name))
    .sort((a, b) => path.basename(a).localeCompare(path.basename(b)));
}

async function listImageFiles(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const unsupported = [];
  const supported = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const filePath = path.join(dir, entry.name);
    if (isSupportedImage(filePath)) supported.push(filePath);
    else unsupported.push({ fileName: entry.name, reason: 'UNSUPPORTED_FORMAT' });
  }
  supported.sort((a, b) => path.basename(a).localeCompare(path.basename(b)));
  return { supported, unsupported };
}

async function imageDescriptor(filePath, imageIndex) {
  const stats = await fs.stat(filePath);
  if (stats.size > MAX_FILE_SIZE) {
    return { skipped: true, fileName: path.basename(filePath), reason: 'IMAGE_TOO_LARGE', size: stats.size };
  }
  const metadata = await sharp(filePath).metadata();
  return {
    id: `batch-image-${imageIndex + 1}`,
    imageIndex,
    fileName: path.basename(filePath),
    originalName: path.basename(filePath),
    displayName: path.basename(filePath),
    storedName: path.basename(filePath),
    filePath,
    size: stats.size,
    mimeType: `image/${metadata.format === 'jpeg' ? 'jpeg' : metadata.format}`,
    width: metadata.width,
    height: metadata.height,
    format: metadata.format
  };
}

export async function buildSkuSet(dir) {
  const { supported, unsupported } = await listImageFiles(dir);
  const warnings = [...unsupported];
  const images = [];
  let totalSize = 0;

  for (const filePath of supported) {
    if (images.length >= MAX_IMAGES_PER_SKU) {
      warnings.push({ fileName: path.basename(filePath), reason: 'TOO_MANY_IMAGES' });
      continue;
    }
    const descriptor = await imageDescriptor(filePath, images.length);
    if (descriptor.skipped) {
      warnings.push(descriptor);
      continue;
    }
    if (totalSize + descriptor.size > MAX_TOTAL_SIZE) {
      warnings.push({ fileName: descriptor.fileName, reason: 'SKU_TOTAL_TOO_LARGE', size: descriptor.size });
      continue;
    }
    totalSize += descriptor.size;
    images.push(descriptor);
  }

  return {
    skuId: path.basename(dir),
    imageCount: images.length,
    images,
    warnings
  };
}

async function collectSkuSets(options) {
  const root = path.resolve(process.cwd(), options.dir || 'test-assets');
  const dirs = options.recursive ? await listSkuDirs(root) : [root];
  const skuSets = [];
  const emptySkuFolders = [];

  for (const dir of dirs) {
    const skuSet = await buildSkuSet(dir);
    if (skuSet.imageCount > 0) skuSets.push(skuSet);
    else emptySkuFolders.push({ skuId: skuSet.skuId, warnings: skuSet.warnings });
  }

  if (!skuSets.length) {
    const error = new Error(options.recursive
      ? `No SKU folders with supported images were found under ${root}. Put images inside SKU subfolders.`
      : `No supported images were found in ${root}. Supported formats: jpg, jpeg, png, webp.`);
    error.code = 'NO_SKU_IMAGES';
    error.details = { emptySkuFolders };
    throw error;
  }

  return { root, skuSets, emptySkuFolders };
}

function modelForProvider(provider) {
  if (provider === 'gemini') return process.env.GEMINI_VISION_MODEL || process.env.VISION_MODEL || 'gemini-2.5-flash';
  if (provider === 'qwen') return process.env.QWEN_MODEL || process.env.VISION_MODEL || 'qwen-vl-max-latest';
  if (provider === 'openai') return process.env.OPENAI_VISION_MODEL || process.env.VISION_MODEL || 'gpt-4.1-mini';
  return 'mock-vision-v0.2';
}

function taskForSku(skuSet) {
  return {
    id: `batch_${skuSet.skuId}`,
    platform: 'Amazon',
    site: 'US',
    language: 'English',
    category: 'general',
    sourceImages: skuSet.images,
    targets: []
  };
}

async function runProvider(provider, skuSet) {
  const availability = getProviderAvailability(provider);
  if (!availability.available) {
    return {
      provider,
      model: modelForProvider(provider),
      durationMs: 0,
      status: 'skipped',
      error: availability.error,
      data: null,
      fieldCompleteness: computeFieldCompleteness(null),
      rawResponsePreview: '',
      metadata: {},
      modeDebug: {}
    };
  }

  const previous = process.env.VISION_PROVIDER;
  process.env.VISION_PROVIDER = provider;
  try {
    const visionProvider = getVisionProvider();
    const result = await visionProvider.recognize({
      task: taskForSku(skuSet),
      image: skuSet.images[0],
      images: skuSet.images
    });
    const dataForScoring = result.status === 'success' && result.data ? result.data : null;
    const providerResult = {
      provider: result.provider || provider,
      model: result.model || modelForProvider(provider),
      durationMs: result.durationMs || 0,
      status: result.status || 'failed',
      error: result.error || null,
      data: result.data || null,
      fieldCompleteness: computeFieldCompleteness(dataForScoring),
      rawResponsePreview: result.rawResponsePreview || '',
      metadata: result.metadata || {}
    };
    providerResult.modeDebug = providerModeDebug(providerResult, skuSet);
    return providerResult;
  } catch (error) {
    const providerResult = {
      provider,
      model: modelForProvider(provider),
      durationMs: 0,
      status: 'failed',
      error: {
        code: error.code || 'PROVIDER_ERROR',
        message: error.message
      },
      data: null,
      fieldCompleteness: computeFieldCompleteness(null),
      rawResponsePreview: '',
      metadata: {}
    };
    providerResult.modeDebug = providerModeDebug(providerResult, skuSet);
    return providerResult;
  } finally {
    if (previous == null) delete process.env.VISION_PROVIDER;
    else process.env.VISION_PROVIDER = previous;
  }
}

export function summarizeBatchResults(payload) {
  const byProvider = {};
  const commonIssues = {
    parseFailures: 0,
    normalizeFailures: 0,
    timeouts: 0,
    missingApiKeys: 0,
    ocrTooLong: 0,
    fieldMissing: 0
  };

  for (const provider of payload.providers) {
    const results = payload.results.flatMap((sku) => sku.providerResults.filter((item) => item.provider === provider));
    const successes = results.filter((item) => item.status === 'success');
    const durationResults = results.filter((item) => item.durationMs > 0);
    const scoreResults = successes.filter((item) => item.fieldCompleteness);
    byProvider[provider] = {
      success: successes.length,
      failed: results.filter((item) => item.status === 'failed').length,
      skipped: results.filter((item) => item.status === 'skipped').length,
      averageDurationMs: durationResults.length
        ? Math.round(durationResults.reduce((sum, item) => sum + item.durationMs, 0) / durationResults.length)
        : 0,
      averageFieldCompleteness: scoreResults.length
        ? Math.round(scoreResults.reduce((sum, item) => sum + item.fieldCompleteness.score, 0) / scoreResults.length)
        : 0,
      jsonStability: results.length ? `${successes.length}/${results.length}` : '0/0'
    };

    for (const result of results) {
      if (result.error?.code === 'PARSE_ERROR') commonIssues.parseFailures += 1;
      if (result.error?.code === 'NORMALIZE_ERROR') commonIssues.normalizeFailures += 1;
      if (/timeout/i.test(result.error?.message || '')) commonIssues.timeouts += 1;
      if (result.error?.code === 'MISSING_API_KEY') commonIssues.missingApiKeys += 1;
      if (result.data?.ocrSummary?.visibleTextTruncated || (result.data?.visibleText?.length || 0) > 80) commonIssues.ocrTooLong += 1;
      if (result.status === 'success' && result.fieldCompleteness && result.fieldCompleteness.score < 60) {
        commonIssues.fieldMissing += 1;
      }
    }
  }

  return { byProvider, commonIssues };
}

function batchSummary(metadata = {}) {
  if (!metadata.batchCount) return '-';
  const failed = metadata.failedBatches?.length || 0;
  return `${metadata.batchCount} batches / failed ${failed}`;
}

function preprocessSummary(metadata = {}) {
  const preprocess = metadata.preprocess;
  if (!preprocess) return '-';
  if (preprocess.enabled === false) return 'disabled';
  const before = preprocess.totalOriginalBytes || 0;
  const after = preprocess.totalProcessedBytes || 0;
  return `${Math.round(before / 1024)}KB -> ${Math.round(after / 1024)}KB`;
}

function partialSummary(metadata = {}) {
  return metadata.partialSuccess ? 'partialSuccess' : '-';
}

function formatBytes(bytes = 0) {
  return `${(Number(bytes || 0) / 1024 / 1024).toFixed(2)} MB`;
}

function compressionRatio(metadata = {}) {
  const before = metadata.preprocess?.totalOriginalBytes || 0;
  const after = metadata.preprocess?.totalProcessedBytes || 0;
  if (!before || !after) return '-';
  return `${Math.round((1 - after / before) * 100)}%`;
}

function visibleTextReport(data = {}) {
  const items = Array.isArray(data.visibleText) ? data.visibleText : [];
  const summary = data.ocrSummary || {};
  return {
    count: items.length,
    originalCount: summary.visibleTextOriginalCount ?? items.length,
    keptCount: summary.visibleTextKeptCount ?? items.length,
    truncated: Boolean(summary.visibleTextTruncated),
    samples: items.slice(0, 10).map((item) => typeof item === 'string' ? item : item.text).filter(Boolean)
  };
}

function providerModeDebug(result = {}, sku = {}) {
  const metadata = result.metadata || {};
  const preprocess = metadata.preprocess || {};
  const failedBatches = metadata.failedBatches || [];
  const batches = metadata.batches || [];
  const totalProcessedImageBytes = preprocess.totalProcessedBytes || 0;
  const slowestBatch = batches.reduce((slowest, batch) => (
    !slowest || (batch.durationMs || 0) > (slowest.durationMs || 0) ? batch : slowest
  ), null);

  return {
    mode: metadata.recognitionMode || '-',
    maxWidth: metadata.imageMaxWidth || null,
    quality: metadata.imageQuality || null,
    requestTimeoutMs: metadata.requestTimeoutMs || null,
    visibleTextLimitPerImage: result.data?.ocrSummary?.perImageLimit || null,
    visibleTextTotalLimit: result.data?.ocrSummary?.totalLimit || null,
    maxImagesSent: metadata.imageCountSent ?? null,
    imageCountOriginal: metadata.imageCountOriginal ?? sku.imageCount ?? null,
    imageCountSent: metadata.imageCountSent ?? null,
    imageCountSkipped: metadata.imageCountSkipped ?? null,
    totalProcessedImageBytes,
    imageTotalSizeBefore: preprocess.totalOriginalBytes || 0,
    imageTotalSizeAfter: totalProcessedImageBytes,
    compressionRatio: compressionRatio(metadata),
    batchCount: metadata.batchCount || 0,
    batchSize: metadata.batchSize || null,
    retryCount: metadata.retryCount ?? null,
    retryTriggered: batches.some((batch) => batch.retryTriggered),
    failedBatchCount: failedBatches.length,
    providerDurationMs: result.durationMs || 0,
    slowestBatchDurationMs: slowestBatch?.durationMs || 0,
    slowestBatchIndex: slowestBatch?.batchIndex ?? null,
    latencyOutlier: Boolean(slowestBatch && metadata.requestTimeoutMs && slowestBatch.durationMs >= metadata.requestTimeoutMs)
  };
}

const evidenceCheckFields = [
  'capacity',
  'certifications',
  'warranty',
  'material',
  'compatibleDevices',
  'interfaceType',
  'dimensions',
  'packageIncluded',
  'model',
  'brand'
];

function productFieldValue(product = {}, field) {
  const value = product[field];
  if (Array.isArray(value)) return value;
  return value ? [value] : [];
}

function evidenceRisk(field, values, evidence = []) {
  const sources = [...new Set(evidence.map((item) => item.source).filter(Boolean))];
  const hasValue = values.length > 0;
  const hasEvidence = evidence.length > 0;
  const hasVisibleText = sources.includes('visible_text');
  const onlyVisual = hasEvidence && sources.every((source) => source === 'visual');
  const onlyInferred = hasEvidence && sources.every((source) => source === 'inferred');

  if (!hasValue) return { level: 'none', message: '-' };
  if (['capacity', 'certifications', 'warranty'].includes(field) && !hasVisibleText) {
    return { level: 'high', message: 'value requires visible_text evidence' };
  }
  if (field === 'material' && onlyVisual) {
    return { level: 'medium', message: 'visual-only material needs manual check' };
  }
  if (field === 'compatibleDevices' && (!hasEvidence || onlyInferred)) {
    return { level: 'medium', message: 'compatibility may be inferred' };
  }
  if (!hasEvidence) return { level: 'medium', message: 'no field evidence' };
  return { level: 'low', message: 'has evidence' };
}

function fieldEvidenceRows(result = {}) {
  const data = result.data || {};
  const product = data.productInfoRaw || {};
  const fieldEvidence = data.fieldEvidence || {};
  return evidenceCheckFields.map((field) => {
    const values = productFieldValue(product, field);
    const evidence = Array.isArray(fieldEvidence[field]) ? fieldEvidence[field] : [];
    const risk = evidenceRisk(field, values, evidence);
    return [
      field,
      safeText(values),
      evidence.length ? 'yes' : 'no',
      safeText([...new Set(evidence.map((item) => item.source).filter(Boolean))]),
      risk.level,
      risk.message
    ];
  });
}

function safeText(value) {
  if (Array.isArray(value)) return value.join(', ');
  return value || '-';
}

function markdownTable(headers, rows) {
  return [
    `| ${headers.join(' | ')} |`,
    `| ${headers.map(() => '---').join(' | ')} |`,
    ...rows.map((row) => `| ${row.map((cell) => String(cell ?? '-').replaceAll('\n', '<br>')).join(' | ')} |`)
  ].join('\n');
}

function bestProvider(summary, key) {
  const entries = Object.entries(summary.byProvider);
  if (!entries.length) return '待测试';
  return entries.sort((a, b) => b[1][key] - a[1][key])[0]?.[0] || '待测试';
}

export function reportMarkdown(payload, resultFilePath) {
  const summary = payload.summary || summarizeBatchResults(payload);
  const speedRows = payload.results.flatMap((sku) => sku.providerResults.map((result) => {
    const metadata = result.metadata || {};
    const modeDebug = result.modeDebug || providerModeDebug(result, sku);
    return [
      sku.skuId,
      result.provider,
      modeDebug.mode || payload.config?.recognitionMode || '-',
      formatBytes(modeDebug.imageTotalSizeBefore),
      formatBytes(modeDebug.imageTotalSizeAfter),
      modeDebug.compressionRatio || compressionRatio(metadata),
      `${modeDebug.imageCountSent ?? sku.imageCount}/${modeDebug.imageCountOriginal ?? sku.imageCount}`,
      `${result.durationMs || 0} ms`,
      `${result.fieldCompleteness?.score || 0}/100`
    ];
  }));
  const providerRows = payload.providers.map((provider) => {
    const item = summary.byProvider[provider] || {};
    return [
      provider,
      item.success || 0,
      item.failed || 0,
      item.skipped || 0,
      `${item.averageDurationMs || 0} ms`,
      `${item.averageFieldCompleteness || 0}/100`,
      item.jsonStability || '0/0',
      '需人工复核准确率'
    ];
  });

  const skuSections = payload.results.map((sku) => {
    const rows = sku.providerResults.map((result) => {
      const product = result.data?.productInfoRaw || {};
      return [
        result.provider,
        result.status,
        `${result.durationMs || 0} ms`,
        `${result.fieldCompleteness?.score || 0}/100`,
        batchSummary(result.metadata),
        partialSummary(result.metadata),
        preprocessSummary(result.metadata),
        safeText(product.productName),
        safeText(product.category),
        safeText(product.capacity),
        safeText(product.interfaceType),
        safeText(product.compatibleDevices),
        result.data?.risks?.length || 0,
        result.error ? `${result.error.code}: ${result.error.message}` : safeText(result.data?.notes)
      ];
    });
    return `### ${sku.skuId}

${markdownTable(['Provider', '状态', '耗时', '字段完整度', '批次', '部分成功', '压缩前后', '商品名称', '类目', '容量', '接口', '兼容设备', '风险数', '备注'], rows)}`;
  }).join('\n\n');

  const detailSections = payload.results.flatMap((sku) => sku.providerResults.map((result) => {
    const product = result.data?.productInfoRaw || {};
    const visibleText = visibleTextReport(result.data || {});
    const modeDebug = result.modeDebug || providerModeDebug(result, sku);
    return `### ${sku.skuId} / ${result.provider}

- productName: ${safeText(product.productName)}
- category: ${safeText(product.category)}
- brand: ${safeText(product.brand)}
- model: ${safeText(product.model)}
- capacity: ${safeText(product.capacity)}
- interfaceType: ${safeText(product.interfaceType)}
- compatibleDevices: ${safeText(product.compatibleDevices)}
- dimensions: ${safeText(product.dimensions)}
- material: ${safeText(product.material)}
- packageIncluded: ${safeText(product.packageIncluded)}
- sellingPoints: ${safeText(product.sellingPoints)}
- visibleSpecs: ${safeText(product.visibleSpecs)}
- visibleText count: ${visibleText.count}
- visibleText original count: ${visibleText.originalCount}
- visibleText kept count: ${visibleText.keptCount}
- visibleText truncated: ${visibleText.truncated ? 'yes' : 'no'}
- visibleText samples: ${safeText(visibleText.samples)}
- risks count: ${result.data?.risks?.length || 0}
- notes: ${safeText(result.data?.notes)}
- field completeness: ${result.fieldCompleteness?.score || 0}/100
- batch: ${batchSummary(result.metadata)}
- batch size: ${result.metadata?.batchSize || '-'}
- retry count: ${result.metadata?.retryCount ?? '-'}
- partial success: ${result.metadata?.partialSuccess ? 'yes' : 'no'}
- preprocess: ${preprocessSummary(result.metadata)}
- failed batches: ${safeText((result.metadata?.failedBatches || []).map((batch) => `batch ${batch.batchIndex + 1}: ${batch.error?.code || 'ERROR'}`))}
- modeDebug.mode: ${modeDebug.mode}
- modeDebug.maxWidth: ${modeDebug.maxWidth}
- modeDebug.quality: ${modeDebug.quality}
- modeDebug.requestTimeoutMs: ${modeDebug.requestTimeoutMs}
- modeDebug.visibleTextLimitPerImage: ${modeDebug.visibleTextLimitPerImage}
- modeDebug.visibleTextTotalLimit: ${modeDebug.visibleTextTotalLimit}
- modeDebug.maxImagesSent: ${modeDebug.maxImagesSent}
- modeDebug.imageCountSent: ${modeDebug.imageCountSent}
- modeDebug.totalProcessedImageBytes: ${modeDebug.totalProcessedImageBytes}
- modeDebug.batchCount: ${modeDebug.batchCount}
- modeDebug.retryCount: ${modeDebug.retryCount}
- modeDebug.retryTriggered: ${modeDebug.retryTriggered ? 'yes' : 'no'}
- modeDebug.providerDurationMs: ${modeDebug.providerDurationMs}
- modeDebug.slowestBatchDurationMs: ${modeDebug.slowestBatchDurationMs}
- modeDebug.latencyOutlier: ${modeDebug.latencyOutlier ? 'yes' : 'no'}
- status/error: ${result.status}${result.error ? ` / ${result.error.code}: ${result.error.message}` : ''}`;
  })).join('\n\n');

  const evidenceSections = payload.results.flatMap((sku) => sku.providerResults.map((result) => `### ${sku.skuId} / ${result.provider}

${markdownTable(['字段', '值', '是否有证据', '证据类型', '风险', '说明'], fieldEvidenceRows(result))}`)).join('\n\n');

  return `# Vision Recognition Test Report

## 1. 测试概览

- 测试时间：${payload.createdAt}
- 测试 SKU 数量：${payload.totalSkuCount}
- 测试图片数量：${payload.totalImageCount}
- 测试 Provider：${payload.providers.join(', ')}
- 结果 JSON：\`${path.relative(projectRoot, resultFilePath).replaceAll('\\', '/')}\`
- 图片压缩：${payload.config?.imagePreprocess || (process.env.VISION_IMAGE_PREPROCESS === 'false' ? 'disabled' : 'enabled')}
- 识别模式：${payload.config?.recognitionMode || process.env.VISION_RECOGNITION_MODE || 'balanced'}
- 图片最大宽度：${payload.config?.imageMaxWidth || process.env.VISION_IMAGE_MAX_WIDTH || 1280}
- JPEG 质量：${payload.config?.imageQuality || process.env.VISION_IMAGE_QUALITY || 75}
- VISION_BATCH_SIZE：${payload.config?.batchSize || process.env.VISION_BATCH_SIZE || 4}
- VISION_RETRY_COUNT：${payload.config?.retryCount ?? process.env.VISION_RETRY_COUNT ?? 1}
- 说明：字段完整性不等于准确率，所有结论都需要人工复核。

## 2. Provider 总体对比

${markdownTable(['Provider', '成功数', '失败数', '跳过数', '平均耗时', '平均字段完整度', 'JSON 稳定性', '备注'], providerRows)}

## 3. SKU 识别摘要

${skuSections || '等待真实测试结果。'}

## 4. 速度优化对比

${markdownTable(['SKU', 'Provider', 'Mode', '原图总大小', '发送大小', '压缩率', '发送图片数', '耗时', '字段完整度'], speedRows)}

## 5. 字段证据检查

${evidenceSections || '等待真实测试结果。'}

## 6. 字段完整性详情

${detailSections || '等待真实测试结果。'}

## 7. 常见问题

- JSON 解析失败：${summary.commonIssues.parseFailures}
- normalize 失败：${summary.commonIssues.normalizeFailures}
- 超时：${summary.commonIssues.timeouts}
- 缺少 API Key：${summary.commonIssues.missingApiKeys}
- OCR 过长：${summary.commonIssues.ocrTooLong}
- 字段漏识别：${summary.commonIssues.fieldMissing}

## 8. 移动硬盘重点检查

- 是否识别为 portable external hard drive / external SSD：需人工复核 category/productName。
- 是否识别容量，例如 1TB / 2TB / 4TB：查看 capacity 和 visibleSpecs。
- 是否识别接口，例如 USB 3.0、Type-C、USB-C：查看 interfaceType 和 visibleSpecs。
- 是否识别兼容设备，例如 PC、Mac、laptop、desktop、phone：查看 compatibleDevices。
- 是否识别包装清单，例如 hard drive、USB cable、manual、box：查看 packageIncluded。
- 是否识别材质或外观：查看 material / colors / visibleSpecs。
- 是否识别图片上的英文文字：查看 visibleText count 和具体 JSON。
- 是否检测中文图片文字：查看 visibleText language 和 risks。
- 是否检测水印、价格、促销、认证等风险：查看 risks。
- 是否胡编不存在的认证、容量、功能：必须人工核对原图。

## 9. 初步结论

- 最稳定 provider：${bestProvider(summary, 'success')}
- 字段最完整 provider：${bestProvider(summary, 'averageFieldCompleteness')}
- OCR 最好 provider：需人工复核 visibleText 质量
- 风险识别最好 provider：需人工复核 risks 质量
- 速度最快 provider：${Object.entries(summary.byProvider).sort((a, b) => (a[1].averageDurationMs || Infinity) - (b[1].averageDurationMs || Infinity))[0]?.[0] || '待测试'}
- 建议下一步：先用 3-5 个 SKU 对比 Gemini / Qwen / OpenAI；如果字段完整性和准确率稳定，再进入真实审核 Provider。

## 10. 前端手动测试步骤

1. 配置 \`.env\`：\`AI_PROVIDER=mock\`，\`VISION_PROVIDER=gemini\`。
2. 启动小程序。
3. 新建任务。
4. 上传 1-15 张商品图片。
5. 点击上传并识别。
6. 进入商品确认页。
7. 检查商品核心字段。
8. 检查图片文字识别结果是否按图片分组。
9. 检查风险项是否分级展示。
10. 手动修改商品信息。
11. 点击保存并继续。
`;
}

async function writeReport(payload, resultFilePath) {
  await fs.mkdir(path.dirname(reportPath), { recursive: true });
  await fs.writeFile(reportPath, reportMarkdown(payload, resultFilePath), 'utf8');
}

async function writeResult(payload) {
  await fs.mkdir(resultDir, { recursive: true });
  const stamp = payload.createdAt.replace(/[-:TZ.]/g, '').slice(0, 14);
  const filePath = path.join(resultDir, `vision-batch-${stamp}.json`);
  await fs.writeFile(filePath, JSON.stringify(payload, null, 2), 'utf8');
  return filePath;
}

export async function generateReportFromResult(resultPath) {
  const absolutePath = path.resolve(process.cwd(), resultPath);
  const payload = JSON.parse(await fs.readFile(absolutePath, 'utf8'));
  payload.summary = payload.summary || summarizeBatchResults(payload);
  await writeReport(payload, absolutePath);
  return { payload, resultFilePath: absolutePath, reportPath };
}

export async function runVisionBatch(options) {
  if (options.fromResult) return generateReportFromResult(options.fromResult);
  if (!options.dir) {
    const error = new Error(usage());
    error.code = 'MISSING_DIR';
    throw error;
  }
  const previousModeEnv = {
    VISION_RECOGNITION_MODE: process.env.VISION_RECOGNITION_MODE,
    VISION_IMAGE_MAX_WIDTH: process.env.VISION_IMAGE_MAX_WIDTH,
    VISION_IMAGE_QUALITY: process.env.VISION_IMAGE_QUALITY,
    VISION_VISIBLE_TEXT_LIMIT_PER_IMAGE: process.env.VISION_VISIBLE_TEXT_LIMIT_PER_IMAGE,
    VISION_VISIBLE_TEXT_TOTAL_LIMIT: process.env.VISION_VISIBLE_TEXT_TOTAL_LIMIT,
    VISION_MAX_IMAGES_SENT: process.env.VISION_MAX_IMAGES_SENT
  };
  if (options.mode) applyRecognitionModeToEnv(options.mode);

  try {
    const recognitionConfig = getVisionRecognitionConfig();
    const { root, skuSets, emptySkuFolders } = await collectSkuSets(options);
    const createdAt = new Date().toISOString();
    const payload = {
    runId: `vision-batch-${createdAt.replace(/[-:TZ.]/g, '').slice(0, 14)}`,
    createdAt,
    providers: options.providers,
    rootDir: path.relative(backendRoot, root).replaceAll('\\', '/') || options.dir,
    recursive: options.recursive,
    config: {
      imagePreprocess: process.env.VISION_IMAGE_PREPROCESS === 'false' ? 'disabled' : 'enabled',
      recognitionMode: recognitionConfig.mode,
      batchSize: Number(process.env.VISION_BATCH_SIZE || 4),
      retryCount: Number(process.env.VISION_RETRY_COUNT || 1),
      imageMaxWidth: recognitionConfig.imageMaxWidth,
      imageQuality: recognitionConfig.imageQuality,
      requestTimeoutMs: recognitionConfig.requestTimeoutMs,
      maxImagesSent: recognitionConfig.maxImages,
      visibleTextLimitPerImage: recognitionConfig.visibleTextLimitPerImage,
      visibleTextTotalLimit: recognitionConfig.visibleTextTotalLimit
    },
    totalSkuCount: skuSets.length,
    totalImageCount: skuSets.reduce((sum, sku) => sum + sku.imageCount, 0),
    emptySkuFolders,
    results: []
    };

    for (const skuSet of skuSets) {
      const providerResults = [];
      for (const provider of options.providers) {
        providerResults.push(await runProvider(provider, skuSet));
      }
      payload.results.push({
        skuId: skuSet.skuId,
        imageCount: skuSet.imageCount,
        warnings: skuSet.warnings,
        images: skuSet.images.map((image) => ({
          fileName: image.fileName,
          size: image.size,
          mimeType: image.mimeType,
          width: image.width,
          height: image.height
        })),
        providerResults
      });
    }

    payload.summary = summarizeBatchResults(payload);
    const resultFilePath = await writeResult(payload);
    await writeReport(payload, resultFilePath);
    return { payload, resultFilePath, reportPath };
  } finally {
    for (const [key, value] of Object.entries(previousModeEnv)) {
      if (value == null) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function printSummary(result) {
  console.log(`Result JSON: ${result.resultFilePath}`);
  console.log(`Markdown report: ${result.reportPath}`);
  const summary = result.payload.summary || summarizeBatchResults(result.payload);
  console.log(JSON.stringify(summary, null, 2));
}

async function main() {
  try {
    const options = parseVisionBatchArgs(process.argv.slice(2));
    const result = await runVisionBatch(options);
    printSummary(result);
  } catch (error) {
    console.error(JSON.stringify({
      status: 'failed',
      error: {
        code: error.code || 'VISION_BATCH_ERROR',
        message: error.message,
        details: error.details || undefined
      }
    }, null, 2));
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(scriptPath)) {
  main();
}
