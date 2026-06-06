#!/usr/bin/env node
import '../src/config/env.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { getVisionProvider } from '../src/providers/vision/index.js';

const scriptPath = fileURLToPath(import.meta.url);
const backendRoot = path.resolve(path.dirname(scriptPath), '..');
const projectRoot = path.resolve(backendRoot, '..');
const testResultsDir = path.join(backendRoot, 'test-results');
const reportPath = path.join(projectRoot, 'docs', 'vision-recognition-test-report.md');

const SUPPORTED_PROVIDERS = ['mock', 'qwen', 'openai', 'gemini'];
const SUPPORTED_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp']);
const MAX_IMAGES_PER_SKU = 15;
const MAX_FILE_SIZE = 10 * 1024 * 1024;
const MAX_TOTAL_SIZE = 100 * 1024 * 1024;

function usage() {
  return [
    'Usage:',
    '  node scripts/testVisionRecognition.js <path-to-product-image>',
    '  node scripts/testVisionRecognition.js --provider qwen --images test-assets/sku001/main.jpg test-assets/sku001/size.jpg',
    '  node scripts/testVisionRecognition.js --provider openai --dir test-assets/sku001',
    '  node scripts/testVisionRecognition.js --providers qwen,openai,gemini --dir test-assets/sku001',
    '  node scripts/testVisionRecognition.js --providers qwen,openai,gemini --dir test-assets --recursive'
  ].join('\n');
}

function normalizeProviderList(value) {
  const providers = String(value || '')
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);

  const unsupported = providers.find((provider) => !SUPPORTED_PROVIDERS.includes(provider));
  if (unsupported) {
    const error = new Error(`Unsupported provider: ${unsupported}. Supported providers: ${SUPPORTED_PROVIDERS.join(', ')}`);
    error.code = 'UNSUPPORTED_PROVIDER';
    throw error;
  }

  return providers.length ? providers : [(process.env.VISION_PROVIDER || process.env.AI_PROVIDER || 'mock').toLowerCase()];
}

export function parseVisionDebugArgs(argv = []) {
  const options = {
    providers: normalizeProviderList(process.env.VISION_PROVIDER || process.env.AI_PROVIDER || 'mock'),
    images: [],
    dir: null,
    recursive: false
  };

  const args = [...argv];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--provider') {
      options.providers = normalizeProviderList(args[++i]);
    } else if (arg === '--providers') {
      options.providers = normalizeProviderList(args[++i]);
    } else if (arg === '--dir') {
      options.dir = args[++i] || null;
    } else if (arg === '--recursive') {
      options.recursive = true;
    } else if (arg === '--images') {
      while (args[i + 1] && !args[i + 1].startsWith('--')) {
        options.images.push(args[++i]);
      }
    } else if (arg.startsWith('--')) {
      const error = new Error(`Unknown option: ${arg}`);
      error.code = 'UNKNOWN_OPTION';
      throw error;
    } else {
      options.images.push(arg);
    }
  }

  options.providers = [...new Set(options.providers)];
  return options;
}

export async function validateImageArgument(imagePath) {
  if (!imagePath) {
    const error = new Error(usage());
    error.code = 'MISSING_IMAGE_PATH';
    throw error;
  }

  const absolutePath = path.resolve(process.cwd(), imagePath);
  try {
    await fs.access(absolutePath);
  } catch {
    const error = new Error(`Image file does not exist: ${absolutePath}`);
    error.code = 'IMAGE_NOT_FOUND';
    throw error;
  }

  return absolutePath;
}

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function isSupportedImageFile(filePath) {
  return SUPPORTED_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

async function listImagesInDir(dirPath) {
  const absoluteDir = path.resolve(process.cwd(), dirPath);
  const entries = await fs.readdir(absoluteDir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => path.join(absoluteDir, entry.name))
    .filter(isSupportedImageFile)
    .sort((a, b) => path.basename(a).localeCompare(path.basename(b)));
}

async function listSkuDirs(rootDir) {
  const absoluteDir = path.resolve(process.cwd(), rootDir);
  const entries = await fs.readdir(absoluteDir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(absoluteDir, entry.name))
    .sort((a, b) => path.basename(a).localeCompare(path.basename(b)));
}

async function buildImageDescriptor(filePath, imageIndex) {
  const absolutePath = await validateImageArgument(filePath);
  if (!isSupportedImageFile(absolutePath)) {
    const error = new Error(`Unsupported image format: ${absolutePath}. Supported formats: jpg, jpeg, png, webp`);
    error.code = 'UNSUPPORTED_IMAGE_FORMAT';
    throw error;
  }

  const stat = await fs.stat(absolutePath);
  if (stat.size > MAX_FILE_SIZE) {
    const error = new Error(`Image exceeds 10MB: ${absolutePath}`);
    error.code = 'IMAGE_TOO_LARGE';
    throw error;
  }

  const metadata = await sharp(absolutePath).metadata();
  if (!metadata.width || !metadata.height || !['jpeg', 'png', 'webp'].includes(metadata.format)) {
    const error = new Error(`Unsupported or invalid image file: ${absolutePath}`);
    error.code = 'INVALID_IMAGE';
    throw error;
  }

  return {
    id: `debug-source-${imageIndex + 1}`,
    role: 'source',
    imageIndex,
    fileName: path.basename(absolutePath),
    storedName: path.basename(absolutePath),
    filePath: absolutePath,
    mimeType: `image/${metadata.format === 'jpeg' ? 'jpeg' : metadata.format}`,
    size: stat.size,
    width: metadata.width,
    height: metadata.height,
    format: metadata.format
  };
}

async function buildSkuImageSet(skuId, imagePaths) {
  const selected = imagePaths.slice(0, MAX_IMAGES_PER_SKU);
  if (!selected.length) {
    const error = new Error(`No supported images found for SKU: ${skuId}`);
    error.code = 'NO_IMAGES';
    throw error;
  }

  const images = [];
  for (let index = 0; index < selected.length; index += 1) {
    images.push(await buildImageDescriptor(selected[index], index));
  }

  const totalSize = images.reduce((sum, image) => sum + image.size, 0);
  if (totalSize > MAX_TOTAL_SIZE) {
    const error = new Error(`SKU ${skuId} exceeds total upload limit of 100MB`);
    error.code = 'SKU_TOTAL_TOO_LARGE';
    throw error;
  }

  return {
    skuId,
    imageCount: images.length,
    images,
    warnings: imagePaths.length > MAX_IMAGES_PER_SKU
      ? [`Only the first ${MAX_IMAGES_PER_SKU} images were used for this SKU.`]
      : []
  };
}

export async function collectSkuImageSets(options) {
  if (options.images?.length) {
    const firstImage = path.resolve(process.cwd(), options.images[0]);
    const parentName = path.basename(path.dirname(firstImage));
    return [await buildSkuImageSet(parentName || 'manual-images', options.images)];
  }

  if (options.dir) {
    if (!(await fileExists(path.resolve(process.cwd(), options.dir)))) {
      const error = new Error(`Image directory does not exist: ${path.resolve(process.cwd(), options.dir)}`);
      error.code = 'DIR_NOT_FOUND';
      throw error;
    }

    if (options.recursive) {
      const skuDirs = await listSkuDirs(options.dir);
      const sets = [];
      for (const skuDir of skuDirs) {
        const images = await listImagesInDir(skuDir);
        if (images.length) {
          sets.push(await buildSkuImageSet(path.basename(skuDir), images));
        }
      }
      if (!sets.length) {
        const error = new Error(`No SKU folders with supported images found under: ${path.resolve(process.cwd(), options.dir)}`);
        error.code = 'NO_IMAGES';
        throw error;
      }
      return sets;
    }

    const images = await listImagesInDir(options.dir);
    return [await buildSkuImageSet(path.basename(path.resolve(process.cwd(), options.dir)), images)];
  }

  const error = new Error(usage());
  error.code = 'MISSING_IMAGE_PATH';
  throw error;
}

function summarizeData(data) {
  if (!data) return null;
  const info = data.productInfoRaw || {};
  return {
    productName: info.productName || info.name || null,
    category: info.category || null,
    brand: info.brand || null,
    model: info.model || null,
    colors: info.colors || [],
    sizes: info.sizes || [],
    capacity: info.capacity || [],
    material: info.material || null,
    packageIncluded: info.packageIncluded || [],
    visibleTextCount: data.visibleText?.length || 0,
    riskCount: data.risks?.length || 0,
    notes: data.notes || []
  };
}

function taskForSku(skuSet) {
  return {
    id: `debug_${skuSet.skuId}`,
    platform: 'debug',
    site: 'debug',
    language: 'English',
    category: 'general',
    targets: [],
    sourceImages: skuSet.images
  };
}

async function runProviderForSku(providerName, skuSet) {
  const previousVisionProvider = process.env.VISION_PROVIDER;
  process.env.VISION_PROVIDER = providerName;
  try {
    const provider = getVisionProvider();
    const result = await provider.recognize({
      task: taskForSku(skuSet),
      image: skuSet.images[0],
      images: skuSet.images
    });

    return {
      provider: result.provider,
      model: result.model,
      durationMs: result.durationMs,
      status: result.status,
      error: result.error,
      data: result.data,
      dataSummary: summarizeData(result.data),
      rawResponsePreview: result.rawResponsePreview
    };
  } catch (error) {
    return {
      provider: providerName,
      model: null,
      durationMs: 0,
      status: 'failed',
      error: {
        code: error.code || 'DEBUG_PROVIDER_ERROR',
        message: error.message,
        details: {}
      },
      data: null,
      dataSummary: null,
      rawResponsePreview: null
    };
  } finally {
    if (previousVisionProvider == null) {
      delete process.env.VISION_PROVIDER;
    } else {
      process.env.VISION_PROVIDER = previousVisionProvider;
    }
  }
}

function fieldCompleteness(data) {
  const info = data?.productInfoRaw || {};
  const fields = [
    'productName',
    'category',
    'brand',
    'model',
    'colors',
    'sizes',
    'capacity',
    'material',
    'packageIncluded',
    'visibleSpecs'
  ];
  const filled = fields.filter((field) => {
    const value = info[field];
    return Array.isArray(value) ? value.length > 0 : value != null && value !== '';
  }).length;
  return filled / fields.length;
}

function computeProviderStats(results, providers) {
  return providers.map((provider) => {
    const providerResults = results.flatMap((sku) => sku.providerResults.filter((item) => item.provider === provider));
    const success = providerResults.filter((item) => item.status === 'success').length;
    const failed = providerResults.length - success;
    const averageDurationMs = providerResults.length
      ? Math.round(providerResults.reduce((sum, item) => sum + (item.durationMs || 0), 0) / providerResults.length)
      : 0;
    const parseFailures = providerResults.filter((item) => item.error?.code === 'PARSE_ERROR').length;
    const normalizeFailures = providerResults.filter((item) => item.error?.code === 'NORMALIZE_ERROR').length;
    const commonErrors = [...new Set(providerResults.map((item) => item.error?.code).filter(Boolean))];

    const jsonStability = providerResults.length ? Math.round((success / providerResults.length) * 20) : 0;
    const completeness = providerResults.length
      ? Math.round((providerResults.reduce((sum, item) => sum + fieldCompleteness(item.data), 0) / providerResults.length) * 20)
      : 0;
    const visibleText = providerResults.length
      ? Math.round((providerResults.reduce((sum, item) => sum + Math.min(item.data?.visibleText?.length || 0, 3) / 3, 0) / providerResults.length) * 20)
      : 0;
    const risk = providerResults.some((item) => item.data?.risks?.length) ? 15 : 0;
    const speed = averageDurationMs > 0 ? Math.max(0, Math.min(10, Math.round(10 - averageDurationMs / 6000))) : 0;

    return {
      provider,
      total: providerResults.length,
      success,
      failed,
      averageDurationMs,
      parseFailures,
      normalizeFailures,
      commonErrors,
      score: {
        total: jsonStability + completeness + visibleText + risk + speed,
        note: 'Initial automated score only. Risk detection and hallucination control require manual review.',
        breakdown: {
          jsonStability,
          productFieldCompleteness: completeness,
          visibleTextRecognition: visibleText,
          riskRecognition: risk,
          noHallucinationControl: '需要人工复核',
          responseSpeed: speed
        }
      }
    };
  });
}

async function writeResultFile(payload) {
  await fs.mkdir(testResultsDir, { recursive: true });
  const safeTimestamp = payload.createdAt.replace(/[:.]/g, '-');
  const filePath = path.join(testResultsDir, `vision-test-${safeTimestamp}.json`);
  await fs.writeFile(filePath, JSON.stringify(payload, null, 2), 'utf8');
  return filePath;
}

function markdownTable(headers, rows) {
  return [
    `| ${headers.join(' | ')} |`,
    `| ${headers.map(() => '---').join(' | ')} |`,
    ...rows.map((row) => `| ${row.map((cell) => String(cell ?? '').replaceAll('\n', '<br>')).join(' | ')} |`)
  ].join('\n');
}

async function writeMarkdownReport(payload, resultFilePath) {
  await fs.mkdir(path.dirname(reportPath), { recursive: true });
  const providerStats = payload.providerStats || [];
  const providerRows = providerStats.map((stat) => [
    stat.provider,
    stat.success,
    stat.failed,
    `${stat.averageDurationMs} ms`,
    stat.parseFailures,
    stat.normalizeFailures,
    stat.commonErrors.join(', ') || '-',
    `${stat.score.total}/100`,
    stat.score.breakdown.noHallucinationControl
  ]);

  const skuRows = payload.results.flatMap((sku) => sku.providerResults.map((result) => [
    sku.skuId,
    sku.imageCount,
    result.provider,
    result.status,
    result.durationMs ? `${result.durationMs} ms` : '-',
    result.dataSummary?.productName || '-',
    result.dataSummary?.category || '-',
    result.dataSummary?.brand || '-',
    result.dataSummary?.model || '-',
    Array.isArray(result.dataSummary?.capacity) ? result.dataSummary.capacity.join(', ') : '-',
    Array.isArray(result.dataSummary?.sizes) ? result.dataSummary.sizes.join(', ') : '-',
    Array.isArray(result.dataSummary?.colors) ? result.dataSummary.colors.join(', ') : '-',
    result.dataSummary?.material || '-',
    Array.isArray(result.dataSummary?.packageIncluded) ? result.dataSummary.packageIncluded.join(', ') : '-',
    result.dataSummary?.visibleTextCount ?? '-',
    result.dataSummary?.riskCount ?? '-',
    result.error?.code || '-'
  ]));

  const report = `# Vision Recognition Test Report

## Test Time

- Created at: ${payload.createdAt}
- Result JSON: \`${path.relative(projectRoot, resultFilePath).replaceAll('\\', '/')}\`

## Test Scope

- Providers: ${payload.providers.join(', ')}
- SKU count: ${payload.totalSkuCount}
- Total image count: ${payload.totalImageCount}
- Real image generation: not tested
- Real review provider: not tested
- Database writes: none

## Provider Summary

${providerRows.length ? markdownTable([
  'Provider',
  'Success',
  'Failed',
  'Avg Duration',
  'Parse Failures',
  'Normalize Failures',
  'Common Errors',
  'Initial Score',
  'No-Hallucination'
], providerRows) : '等待真实 API Key 和测试图片。'}

## Provider Scoring Notes

The 100-point score is an initial automated helper, not an absolute conclusion.

- JSON stability: 20 points
- Product field completeness: 20 points
- visibleText recognition: 20 points
- Risk recognition: 15 points
- No-hallucination control: 15 points, marked as manual review because images need human ground truth
- Response speed: 10 points

## SKU Recognition Summary

${skuRows.length ? markdownTable([
  'SKU',
  'Images',
  'Provider',
  'Status',
  'Duration',
  'Product Name',
  'Category',
  'Brand',
  'Model',
  'Capacity',
  'Size',
  'Color',
  'Material',
  'Package Included',
  'Visible Text Count',
  'Risk Count',
  'Error'
], skuRows) : '等待真实 API Key 和测试图片。'}

## JSON Parsing Stability

Parse failures: ${providerStats.reduce((sum, stat) => sum + stat.parseFailures, 0)}

## Normalize Mapping Stability

Normalize failures: ${providerStats.reduce((sum, stat) => sum + stat.normalizeFailures, 0)}

## Common Errors

${providerStats.flatMap((stat) => stat.commonErrors.map((error) => `- ${stat.provider}: ${error}`)).join('\n') || '- None recorded'}

## Comprehensive Evaluation

This report is generated from manual debug runs. Use it to compare provider stability, speed, and field extraction coverage, then manually review whether extracted fields are accurate and whether the model invented unsupported product parameters.

## Next Recommendations

1. Run 3-5 representative SKUs through qwen, openai, and gemini.
2. Manually review productName, category, brand, model, capacity, sizes, colors, material, packageIncluded, visibleText, and risks.
3. Tune only \`visionPrompt.js\`, \`robustJsonParser.js\`, or \`normalizeVisionResult.js\` if real outputs reveal stability problems.
4. Keep real generation and real review disabled until recognition quality is acceptable.

## Frontend Manual Validation Steps

1. Start backend and frontend.
2. Set local \`.env\` with \`VISION_PROVIDER=qwen\`, \`openai\`, or \`gemini\`.
3. Open the app.
4. Upload 1-15 product images.
5. Click "上传并识别全部图片".
6. Open the product confirmation page.
7. Check provider, model, and duration.
8. Check product information fields.
9. Check visible text results.
10. Check recognition risks.
11. Manually correct product information.
12. Confirm product info and continue through the mock image-plan flow.
`;

  await fs.writeFile(reportPath, report, 'utf8');
}

export async function runVisionRecognitionBatch(rawOptions) {
  const options = Array.isArray(rawOptions) ? parseVisionDebugArgs(rawOptions) : rawOptions;
  const skuSets = await collectSkuImageSets(options);
  const createdAt = new Date().toISOString();
  const payload = {
    runId: `vision_${createdAt.replace(/[-:.TZ]/g, '')}`,
    createdAt,
    providers: options.providers,
    totalSkuCount: skuSets.length,
    totalImageCount: skuSets.reduce((sum, sku) => sum + sku.imageCount, 0),
    results: []
  };

  for (const skuSet of skuSets) {
    const providerResults = [];
    for (const provider of options.providers) {
      providerResults.push(await runProviderForSku(provider, skuSet));
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

  payload.providerStats = computeProviderStats(payload.results, payload.providers);
  const resultFilePath = await writeResultFile(payload);
  await writeMarkdownReport(payload, resultFilePath);
  return { ...payload, resultFilePath, reportPath };
}

export async function runVisionRecognitionDebug(imagePath) {
  const options = parseVisionDebugArgs([imagePath]);
  const batch = await runVisionRecognitionBatch(options);
  return batch.results[0].providerResults[0];
}

function printConsoleSummary(payload) {
  for (const sku of payload.results) {
    console.log(`\nSKU: ${sku.skuId} (${sku.imageCount} images)`);
    if (sku.warnings?.length) {
      sku.warnings.forEach((warning) => console.log(`  Warning: ${warning}`));
    }
    for (const result of sku.providerResults) {
      console.log(`  ${result.provider} / ${result.model || 'unknown'} / ${result.durationMs || 0} ms / ${result.status}`);
      if (result.error) {
        console.log(`    Error: ${result.error.code || 'UNKNOWN'} - ${result.error.message}`);
      }
      if (result.dataSummary) {
        console.log(`    Summary: ${JSON.stringify(result.dataSummary)}`);
      }
      if (result.rawResponsePreview) {
        console.log(`    rawResponsePreview: ${result.rawResponsePreview.slice(0, 1000)}`);
      }
    }
  }

  console.log(`\nResult JSON: ${payload.resultFilePath}`);
  console.log(`Report: ${payload.reportPath}`);
}

async function main() {
  try {
    const options = parseVisionDebugArgs(process.argv.slice(2));
    const result = await runVisionRecognitionBatch(options);
    printConsoleSummary(result);
    process.exitCode = result.results.some((sku) => sku.providerResults.some((item) => item.status === 'success')) ? 0 : 2;
  } catch (error) {
    console.error(JSON.stringify({
      status: 'failed',
      error: {
        code: error.code || 'DEBUG_SCRIPT_ERROR',
        message: error.message
      }
    }, null, 2));
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(scriptPath)) {
  main();
}
