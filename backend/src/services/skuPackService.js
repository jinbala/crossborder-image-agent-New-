import fs from 'node:fs/promises';
import { atomicRename } from '../utils/atomicRename.js';
import { indexTask } from './taskCenterService.js';
import { platformDb, collectionCreationEpoch, audit } from './platformStore.js';
import { mapWithResourceLimit } from './resourcePolicy.js';
import { assertResource, currentActor } from './ownershipService.js';
import { getMattingConfig } from './mattingService.js';
import { fingerprintCollectionRequest as fingerprint } from './collectionRequestService.js';
import fsSync from 'node:fs';
import path from 'node:path';
import archiver from 'archiver';
import sharp from 'sharp';
import { readSkuPackState, readSkuPackSnapshot, publishedArchives, checkpointRevision, skuPackDirectory } from './skuPackStateService.js';
import { createHash } from 'node:crypto';
import { nanoid } from 'nanoid';
import { paths } from './db.js';
import { getMattingProvider, SharpMattingProvider } from '../providers/matting/index.js';

const OUTPUT_ROOT = path.join(paths.outputDir, 'workbench');
const FORMATS = new Set(['jpeg', 'png', 'webp']);
const ROLES = new Set(['main', 'additional', 'square', 'swatch', 'detail', 'variant', 'general']);
const activePacks = new Map();

function clean(value, fallback = '', max = 120) {
  const text = String(value ?? '').trim().replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-').replace(/\s+/g, ' ');
  return text.slice(0, max) || fallback;
}

function bool(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

function number(value, fallback, min, max) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.min(max, Math.max(min, Math.round(parsed))) : fallback;
}

function optionalNumber(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(max, Math.max(min, Math.round(parsed)));
}

function publicPath(absolutePath) {
  return `/${path.relative(paths.rootDir, absolutePath).split(path.sep).join('/')}`;
}

function extensionFor(format) {
  return format === 'jpeg' ? 'jpg' : format;
}

function hashSeed(value) {
  let hash = 2166136261;
  for (const char of String(value)) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function seededRandom(seedText) {
  let state = hashSeed(seedText) || 1;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 4294967296;
  };
}

function shuffled(items, seed) {
  const output = [...items];
  const random = seededRandom(seed);
  for (let index = output.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(random() * (index + 1));
    [output[index], output[swapIndex]] = [output[swapIndex], output[index]];
  }
  return output;
}

function normalizedRelativePath(value, fallback) {
  const parts = String(value || fallback || '').replaceAll('\\', '/').split('/').filter((part) => part && part !== '.');
  if (!parts.length || parts.some((part) => part === '..')) return clean(path.basename(fallback || 'image'), 'image');
  return parts.map((part) => clean(part, 'item', 180)).join('/');
}

function stripCommonRoot(pathsInput) {
  const partsList = pathsInput.map((value) => value.split('/'));
  const root = partsList[0]?.[0];
  const canStrip = Boolean(root) && partsList.every((parts) => parts.length >= 3 && parts[0].toLowerCase() === root.toLowerCase());
  return canStrip ? partsList.map((parts) => parts.slice(1).join('/')) : pathsInput;
}

function roleHint(relativePath) {
  const name = path.basename(relativePath, path.extname(relativePath)).toLowerCase();
  const rules = [
    ['main', /(^|[-_\s])(main|master|主图)(?=[-_\s\d]|$)/i],
    ['square', /(^|[-_\s])(square|方图|方形图)(?=[-_\s\d]|$)/i],
    ['swatch', /(^|[-_\s])(swatch|color|colour|色块|颜色)(?=[-_\s\d]|$)/i],
    ['detail', /(^|[-_\s])(detail|closeup|细节|详情)(?=[-_\s\d]|$)/i],
    ['variant', /(^|[-_\s])(variant|variation|变种|变体)(?=[-_\s\d]|$)/i],
    ['additional', /(^|[-_\s])(additional|gallery|附图|轮播)(?=[-_\s\d]|$)/i],
    ['general', /(^|[-_\s])(general|通用)(?=[-_\s\d]|$)/i]
  ];
  return rules.find(([, pattern]) => pattern.test(name))?.[0] || '';
}

function normalizeOptions(input = {}) {
  const format = FORMATS.has(String(input.format || '').toLowerCase()) ? String(input.format).toLowerCase() : 'jpeg';
  const orderMode = ['name', 'random', 'upload', 'manual'].includes(input.orderMode) ? input.orderMode : 'name';
  const roleOverrides = Object.fromEntries(Object.entries(input.roleOverrides && typeof input.roleOverrides === 'object' ? input.roleOverrides : {})
    .slice(0, 300)
    .map(([key, value]) => [normalizedRelativePath(key, key), ROLES.has(value) ? value : ''])
    .filter(([, value]) => value));
  const mattingProvider = ['sharp', 'rembg', 'external', 'image2'].includes(String(input.mattingProvider || '').toLowerCase()) ? String(input.mattingProvider).toLowerCase() : 'sharp';
  return {
    name: clean(input.name, 'SKU 批量图包', 80),
    format,
    quality: number(input.quality, 88, 40, 100),
    targetKilobytes: optionalNumber(input.targetKilobytes, 0, 10, 5000),
    maxDimension: number(input.maxDimension, 2000, 320, 6000),
    squareSize: number(input.squareSize, 1600, 320, 6000),
    background: /^#[0-9a-f]{6}$/i.test(String(input.background || '')) ? String(input.background) : '#ffffff',
    orderMode,
    randomSeed: clean(input.randomSeed, 'xingya-pack-seed', 100),
    namingTemplate: clean(input.namingTemplate, '{sku}-{role}-{index}', 200),
    randomFileNames: bool(input.randomFileNames, false),
    preserveOriginals: bool(input.preserveOriginals, true),
    preprocessOriginals: bool(input.preprocessOriginals, false),
    generateSquare: bool(input.generateSquare, true),
    matteImages: bool(input.matteImages, false),
    mattingProvider,
    confirmPaidMatting: input.confirmPaidMatting === true,
    mattingFallbackToSharp: bool(input.mattingFallbackToSharp, true),
    deduplicateImages: bool(input.deduplicateImages, false),
    duplicateThreshold: number(input.duplicateThreshold, 4, 0, 16),
    keepDuplicates: Array.isArray(input.keepDuplicates) ? input.keepDuplicates.slice(0, 300).map((value) => normalizedRelativePath(value, value)) : [],
    visualRoleRecognition: bool(input.visualRoleRecognition, false),
    manualOrder: Array.isArray(input.manualOrder)
      ? input.manualOrder.slice(0, 300).map((value) => normalizedRelativePath(value, value))
      : [],
    roleOverrides,
    metadata: input.metadata && typeof input.metadata === 'object' ? input.metadata : {}
  };
}

function roleForItems(items) {
  let mainAssigned = items.some((item) => item.hintedRole === 'main');
  return items.map((item) => {
    let role = item.hintedRole;
    if (!role) {
      if (!mainAssigned) {
        role = 'main';
        mainAssigned = true;
      } else role = 'additional';
    }
    return { ...item, role: ROLES.has(role) ? role : 'general' };
  });
}

async function visualRoleHint(filePath) {
  const image = sharp(filePath).rotate();
  const [metadata, stats] = await Promise.all([image.metadata(), image.stats()]);
  const width = Number(metadata.width || 0);
  const height = Number(metadata.height || 0);
  if (!width || !height) return null;
  const ratio = Math.max(width, height) / Math.max(1, Math.min(width, height));
  const entropy = Number(stats.entropy || 0);
  if (Math.max(width, height) <= 600 && ratio <= 1.25 && entropy < 2.5) {
    return { role: 'swatch', confidence: 0.86, reason: 'small_square_low_entropy' };
  }
  if (ratio >= 2.35) return { role: 'detail', confidence: 0.72, reason: 'extreme_aspect_ratio' };
  return null;
}

function renderName(template, values, randomFileNames) {
  const source = randomFileNames ? '{random}' : template;
  const replacements = {
    sku: values.sku,
    spu: values.spu,
    spec: values.spec,
    variantSku: values.variantSku,
    title: values.title,
    role: values.role,
    index: String(values.index).padStart(3, '0'),
    random: values.random
  };
  let rendered = source.replace(/\{(sku|spu|spec|variantSku|title|role|index|random)\}/g, (_match, key) => replacements[key] || '');
  rendered = clean(rendered, `${values.sku}-${values.role}-${String(values.index).padStart(3, '0')}`, 180);
  return rendered;
}

async function transform(inputPath, outputPath, options, { square = false } = {}) {
  const metadata = await sharp(inputPath).metadata();
  if (!metadata.width || !metadata.height || !FORMATS.has(metadata.format)) throw new Error('不支持或损坏的图片');
  const targetBytes = options.targetKilobytes > 0 ? options.targetKilobytes * 1024 : 0;
  const initialDimension = square ? options.squareSize : options.maxDimension;
  let dimension = initialDimension;
  let quality = options.quality;
  let attempts = 0;
  let buffer;
  do {
    attempts += 1;
    let pipeline = sharp(inputPath).rotate();
    if (square) {
      pipeline = pipeline.resize(dimension, dimension, {
        fit: 'contain',
        background: options.format === 'jpeg' ? options.background : { r: 255, g: 255, b: 255, alpha: 0 }
      });
    } else {
      pipeline = pipeline.resize({ width: dimension, height: dimension, fit: 'inside', withoutEnlargement: true });
    }
    if (options.format === 'jpeg') pipeline = pipeline.flatten({ background: options.background }).jpeg({ quality, mozjpeg: true });
    if (options.format === 'png') pipeline = pipeline.png({ quality, compressionLevel: 9, adaptiveFiltering: true, palette: targetBytes > 0 });
    if (options.format === 'webp') pipeline = pipeline.webp({ quality, smartSubsample: true });
    buffer = await pipeline.toBuffer();
    if (!targetBytes || buffer.length <= targetBytes || attempts >= 12) break;
    if (options.format !== 'png' && quality > 42) quality = Math.max(40, quality - 8);
    else if (dimension > 320) dimension = Math.max(320, Math.round(dimension * 0.86));
    else break;
  } while (true);
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, buffer);
  const outputMeta = await sharp(outputPath).metadata();
  const stats = await fs.stat(outputPath);
  return {
    width: outputMeta.width,
    height: outputMeta.height,
    format: outputMeta.format,
    bytes: stats.size,
    targetBytes: targetBytes || null,
    targetMet: targetBytes ? stats.size <= targetBytes : null,
    finalQuality: quality,
    compressionAttempts: attempts
  };
}

async function perceptualHash(inputPath) {
  const { data, info } = await sharp(inputPath)
    .rotate()
    .resize(9, 8, { fit: 'fill' })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  if (info.width !== 9 || info.height !== 8 || info.channels < 3) throw new Error('无法计算图片感知指纹');
  const luminance = [];
  const totals = [0, 0, 0];
  for (let pixel = 0; pixel < 72; pixel += 1) {
    const offset = pixel * info.channels;
    const red = data[offset];
    const green = data[offset + 1];
    const blue = data[offset + 2];
    totals[0] += red; totals[1] += green; totals[2] += blue;
    luminance.push((red * 299 + green * 587 + blue * 114) / 1000);
  }
  let differenceBits = '';
  for (let row = 0; row < 8; row += 1) {
    for (let column = 0; column < 8; column += 1) {
      differenceBits += luminance[row * 9 + column] >= luminance[row * 9 + column + 1] ? '1' : '0';
    }
  }
  const colorBits = totals.map((total) => Math.round((total / 72) / 17).toString(2).padStart(4, '0')).join('');
  return `${differenceBits}${colorBits}`;
}

function hammingDistance(left, right) {
  if (!left || !right || left.length !== right.length) return Number.POSITIVE_INFINITY;
  let distance = 0;
  for (let index = 0; index < left.length; index += 1) if (left[index] !== right[index]) distance += 1;
  return distance;
}

async function zipDirectory(directory, zipPath, manifest) {
  await new Promise((resolve, reject) => {
    const output = fsSync.createWriteStream(zipPath);
    const archive = archiver('zip', { zlib: { level: 9 } });
    output.on('close', resolve);
    output.on('error', reject);
    archive.on('error', reject);
    archive.pipe(output);
    archive.directory(directory, false);
    archive.append(JSON.stringify(manifest, null, 2), { name: 'manifest.json' });
    archive.finalize();
  });
}

async function renderSkuPack(files = [], rawRelativePaths = [], rawOptions = {}, fixedJobId = null) {
  if (!Array.isArray(files) || files.length === 0) throw Object.assign(new Error('请至少选择一个包含图片的 SKU 文件夹'), { statusCode: 400 });
  if (files.length > 300) throw Object.assign(new Error('单次最多处理 300 张图片'), { statusCode: 400 });
  const options = normalizeOptions(rawOptions);
  if (options.matteImages && ['external', 'image2'].includes(options.mattingProvider) && !options.confirmPaidMatting) {
    throw Object.assign(new Error('外部或 Image2 批量抠图可能产生费用，必须明确勾选费用确认'), { statusCode: 400 });
  }
  if (options.matteImages && options.mattingProvider === 'external' && (!(process.env.MATTING_EXTERNAL_API_URL || process.env.MATTING_BASE_URL) || !(process.env.MATTING_EXTERNAL_API_KEY || process.env.MATTING_API_KEY))) {
    throw Object.assign(new Error('尚未完整配置外部抠图 API 地址和密钥'), { statusCode: 400 });
  }
  if (options.matteImages && options.mattingProvider === 'image2' && !process.env.OPENAI_API_KEY) {
    throw Object.assign(new Error('尚未配置 Image2 所需的 OPENAI_API_KEY'), { statusCode: 400 });
  }
  // Paths reaching this per-SKU renderer are already canonical. Stripping again
  // would turn SKU-A/detail/main.png into a new SKU named "detail".
  const normalizedPaths = files.map((file, index) => normalizedRelativePath(rawRelativePaths[index], file.originalname));
  const normalizedManualOrder = stripCommonRoot(options.manualOrder);
  const manualRank = new Map(normalizedManualOrder.map((value, index) => [value.toLowerCase(), index]));
  const grouped = new Map();
  files.forEach((file, index) => {
    const relativePath = normalizedPaths[index];
    const parts = relativePath.split('/');
    const sku = clean(parts.length > 1 ? parts[0] : 'UNGROUPED', 'UNGROUPED', 120);
    const overrideRole = options.roleOverrides[relativePath] || options.roleOverrides[normalizedRelativePath(rawRelativePaths[index], file.originalname)] || options.roleOverrides[path.basename(relativePath)] || '';
    const item = { file, relativePath, uploadIndex: index, hintedRole: overrideRole || roleHint(relativePath), roleSource: overrideRole ? 'manual' : (roleHint(relativePath) ? 'filename' : 'fallback') };
    if (!grouped.has(sku)) grouped.set(sku, []);
    grouped.get(sku).push(item);
  });

  const jobId = fixedJobId || `sku-pack-${Date.now()}-${nanoid(6)}`;
  const jobDir = path.join(OUTPUT_ROOT, jobId);
  const contentDir = path.join(jobDir, 'package');
  await fs.mkdir(contentDir, { recursive: true });
  const skuResults = [];
  const allItems = [];
  const usedNames = new Set();
  const ext = extensionFor(options.format);
  const primaryMattingProvider = options.matteImages ? getMattingProvider(options.mattingProvider, {
    external: {
      apiKey: process.env.MATTING_EXTERNAL_API_KEY || process.env.MATTING_API_KEY,
      baseURL: process.env.MATTING_EXTERNAL_API_URL || process.env.MATTING_BASE_URL,
      model: process.env.MATTING_EXTERNAL_MODEL || process.env.MATTING_MODEL || 'external-matting'
    }
  }) : null;
  const sharpFallbackProvider = options.matteImages && options.mattingProvider !== 'sharp' && options.mattingFallbackToSharp ? new SharpMattingProvider() : null;

  function allocateBaseName(sku, role, requestedBaseName) {
    let baseName = requestedBaseName;
    let uniqueKey = `${sku}/${role}/${baseName}.${ext}`.toLowerCase();
    let suffix = 2;
    while (usedNames.has(uniqueKey)) {
      baseName = `${requestedBaseName}-${suffix}`;
      uniqueKey = `${sku}/${role}/${baseName}.${ext}`.toLowerCase();
      suffix += 1;
    }
    usedNames.add(uniqueKey);
    return baseName;
  }

  for (const [sku, sourceItems] of grouped.entries()) {
    let ordered = [...sourceItems];
    if (options.orderMode === 'name') ordered.sort((a, b) => a.relativePath.localeCompare(b.relativePath, 'zh-CN', { numeric: true, sensitivity: 'base' }));
    if (options.orderMode === 'random') ordered = shuffled(ordered, `${options.randomSeed}:${sku}`);
    if (options.orderMode === 'manual') ordered.sort((a, b) => {
      const left = manualRank.get(a.relativePath.toLowerCase()) ?? Number.MAX_SAFE_INTEGER;
      const right = manualRank.get(b.relativePath.toLowerCase()) ?? Number.MAX_SAFE_INTEGER;
      return left - right || a.uploadIndex - b.uploadIndex;
    });
    if (options.visualRoleRecognition) {
      await mapWithResourceLimit(ordered, async (item) => {
        if (item.hintedRole) return;
        try {
          const detected = await visualRoleHint(item.file.path);
          if (detected) {
            item.hintedRole = detected.role;
            item.roleSource = 'visual-heuristic';
            item.roleRecognition = detected;
          }
        } catch (error) {
          item.roleRecognition = { role: '', confidence: 0, reason: 'analysis_failed', warning: error.message };
        }
      }, 2);
    }
    ordered = roleForItems(ordered);
    const metadata = options.metadata[sku] || {};
    const result = { sku, inputCount: ordered.length, successCount: 0, failedCount: 0, duplicateSkippedCount: 0, items: [] };
    const roleIndexes = {};
    let firstMainOutput = null;
    const uniqueImages = [];

    for (const item of ordered) {
      const role = item.role;
      if (options.deduplicateImages && !options.keepDuplicates.includes(item.relativePath)) {
        try {
          const imageHash = await perceptualHash(item.file.path);
          const sha256 = createHash('sha256').update(await fs.readFile(item.file.path)).digest('hex');
          const duplicate = uniqueImages.find((candidate) => candidate.sha256 === sha256) || uniqueImages.find((candidate) => hammingDistance(imageHash, candidate.hash) <= options.duplicateThreshold);
          if (duplicate) {
            const skipped = {
              sourceRelativePath: item.relativePath,
              role,
              roleSource: item.roleSource,
              status: 'skipped',
              skipReason: 'DUPLICATE_IMAGE',
              deduplicationMethod: duplicate.sha256 === sha256 ? 'exact-byte-hash' : 'perceptual-similarity',
              sha256,
              duplicateOf: duplicate.relativePath,
              perceptualDistance: hammingDistance(imageHash, duplicate.hash),
              outputFile: null,
              error: null
            };
            result.duplicateSkippedCount += 1;
            result.items.push(skipped);
            allItems.push({ sku, ...skipped });
            continue;
          }
          uniqueImages.push({ hash: imageHash, sha256, relativePath: item.relativePath });
        } catch (error) {
          item.deduplicationWarning = error.message;
        }
      }
      roleIndexes[role] = (roleIndexes[role] || 0) + 1;
      const roleIndex = roleIndexes[role];
      const token = hashSeed(`${options.randomSeed}:${sku}:${item.relativePath}:${roleIndex}`).toString(36).padStart(7, '0').slice(0, 8);
      const requestedBaseName = renderName(options.namingTemplate, {
        sku,
        spu: clean(metadata.spu, sku),
        spec: clean(metadata.spec, ''),
        variantSku: clean(metadata.variantSku, sku),
        title: clean(metadata.title, sku),
        role,
        index: roleIndex,
        random: token
      }, options.randomFileNames);
      const baseName = allocateBaseName(sku, role, requestedBaseName);
      const outputPath = path.join(contentDir, sku, role, `${baseName}.${ext}`);
      const record = { sourceRelativePath: item.relativePath, role, roleSource: item.roleSource, roleRecognition: item.roleRecognition || null, roleIndex, status: 'pending', outputFile: null, error: null };
      if (item.deduplicationWarning) record.deduplicationWarning = item.deduplicationWarning;
      const mattingTempFiles = [];
      try {
        if (options.preserveOriginals) {
          const originalPath = path.join(contentDir, sku, 'originals', `${String(item.uploadIndex + 1).padStart(3, '0')}-${clean(path.basename(item.relativePath), 'image', 180)}`);
          await fs.mkdir(path.dirname(originalPath), { recursive: true });
          await fs.copyFile(item.file.path, originalPath);
          record.originalFile = path.relative(contentDir, originalPath).split(path.sep).join('/');
        }
        if (options.preprocessOriginals) {
          const preprocessedPath = path.join(contentDir, sku, 'preprocessed', `${String(item.uploadIndex + 1).padStart(3, '0')}.${ext}`);
          await transform(item.file.path, preprocessedPath, options, { square: false });
          record.preprocessedFile = path.relative(contentDir, preprocessedPath).split(path.sep).join('/');
        }
        let processingInputPath = item.file.path;
        if (options.matteImages) {
          const sourceImage = { id: `${sku}-${item.uploadIndex + 1}`, displayName: path.basename(item.relativePath), filePath: item.file.path };
          let matting = await primaryMattingProvider.extractSubject({ task: { id: jobId }, sourceImage });
          let fallbackUsed = false;
          if (matting.status !== 'success' && sharpFallbackProvider) {
            const fallback = await sharpFallbackProvider.extractSubject({ task: { id: jobId }, sourceImage });
            if (fallback.status === 'success') { matting = fallback; fallbackUsed = true; }
          }
          if (matting.status !== 'success' || !matting.output?.subjectPngPath) {
            throw Object.assign(new Error(matting.error?.message || '抠图失败'), { code: matting.error?.code || 'MATTING_FAILED' });
          }
          processingInputPath = matting.output.subjectPngPath;
          mattingTempFiles.push(...[matting.output.subjectPngPath, matting.output.maskPath].filter(Boolean));
          record.matting = {
            providerRequested: options.mattingProvider,
            providerUsed: matting.provider,
            model: matting.model,
            fallbackUsed,
            confidence: matting.metadata?.confidence ?? null,
            edgeQuality: matting.metadata?.edgeQuality || 'unknown',
            warnings: matting.metadata?.warnings || []
          };
        }
        const output = await transform(processingInputPath, outputPath, options, { square: role === 'square' });
        record.status = 'success';
        record.outputFile = path.relative(contentDir, outputPath).split(path.sep).join('/');
        record.output = output;
        result.successCount += 1;
        if (role === 'main' && !firstMainOutput) firstMainOutput = { inputPath: outputPath, sourceRelativePath: item.relativePath };
      } catch (error) {
        record.status = 'failed';
        record.error = { code: error.code || 'IMAGE_PROCESSING_FAILED', message: error.message };
        result.failedCount += 1;
      } finally {
        await Promise.all(mattingTempFiles.map((filePath) => fs.rm(filePath, { force: true }).catch(() => {})));
      }
      result.items.push(record);
      allItems.push({ sku, ...record });
    }

    if (options.generateSquare && firstMainOutput) {
      const squareIndex = (roleIndexes.square || 0) + 1;
      const token = hashSeed(`${options.randomSeed}:${sku}:generated-square`).toString(36);
      const requestedBaseName = renderName(options.namingTemplate, { sku, spu: clean(metadata.spu, sku), spec: clean(metadata.spec, ''), variantSku: clean(metadata.variantSku, sku), title: clean(metadata.title, sku), role: 'square', index: squareIndex, random: token }, options.randomFileNames);
      const baseName = allocateBaseName(sku, 'square', requestedBaseName);
      const outputPath = path.join(contentDir, sku, 'square', `${baseName}.${ext}`);
      const record = { sourceRelativePath: firstMainOutput.sourceRelativePath, role: 'square', roleIndex: squareIndex, generated: true, status: 'pending', outputFile: null, error: null };
      try {
        const output = await transform(firstMainOutput.inputPath, outputPath, options, { square: true });
        record.status = 'success';
        record.outputFile = path.relative(contentDir, outputPath).split(path.sep).join('/');
        record.output = output;
        result.successCount += 1;
      } catch (error) {
        record.status = 'failed';
        record.error = { code: error.code || 'SQUARE_GENERATION_FAILED', message: error.message };
        result.failedCount += 1;
      }
      result.items.push(record);
      allItems.push({ sku, ...record });
    }
    skuResults.push(result);
  }

  const createdAt = new Date().toISOString();
  const manifestPath = path.join(jobDir, 'manifest.json');
  const zipPath = path.join(jobDir, `${jobId}.zip`);
  const summary = {
    inputCount: files.length,
    skuCount: skuResults.length,
    outputCount: allItems.filter((item) => item.status === 'success').length,
    failedCount: allItems.filter((item) => item.status === 'failed').length,
    duplicateSkippedCount: allItems.filter((item) => item.status === 'skipped' && item.skipReason === 'DUPLICATE_IMAGE').length,
    generatedSquareCount: allItems.filter((item) => item.generated && item.status === 'success').length,
    mattedCount: allItems.filter((item) => item.matting && item.status === 'success').length
  };
  const manifest = {
    id: jobId,
    type: 'sku-pack',
    status: summary.failedCount ? 'completed_with_errors' : 'completed',
    name: options.name,
    createdAt,
    updatedAt: createdAt,
    options,
    summary,
    skuResults
  };
  await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  await zipDirectory(contentDir, zipPath, manifest);
  const result = { ...manifest, manifestUrl: publicPath(manifestPath), downloadUrl: publicPath(zipPath) };
  await fs.writeFile(manifestPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  indexTask(result);
  return result;
}

async function packCheckpoint(directory, state) {
  const target = path.join(directory, 'manifest.json');
  try { JSON.parse(await fs.readFile(target, 'utf8')); await fs.copyFile(target, `${target}.backup`); } catch { /* Preserve the last valid checkpoint. */ }
  state.updatedAt = new Date().toISOString();
  state.checkpointRevision = checkpointRevision(state) + 1;
  if (!Number.isSafeInteger(state.checkpointRevision)) throw new Error('图包恢复点版本超限');
  await fs.writeFile(`${target}.tmp`, JSON.stringify(state, null, 2)); await atomicRename(`${target}.tmp`, target);
  indexTask(state);
}
async function packLock(directory) {
  const file = path.join(directory, 'run.lock'), token = nanoid(20);
  try { await fs.writeFile(file, JSON.stringify({ pid: process.pid, token }), { flag: 'wx' }); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const owner = await fs.readFile(file, 'utf8').then(JSON.parse).catch(() => null);
    let dead = false;
    if (Number.isInteger(owner?.pid) && owner.pid > 0) { try { process.kill(owner.pid, 0); } catch (error) { dead = error.code === 'ESRCH'; } }
    if (!dead) throw Object.assign(new Error('图包任务正在执行，不能重复启动'), { statusCode: 409 });
    await fs.rename(file, `${file}.recovered-${Date.now()}`); return packLock(directory);
  }
  return async () => { const owner = await fs.readFile(file, 'utf8').then(JSON.parse).catch(() => null); if (owner?.token === token) await fs.rm(file, { force: true }); };
}

export async function createSkuPack(files = [], relativePaths = [], rawOptions = {}, execution = {}) {
  if (!files.length || files.length > 300) throw Object.assign(new Error('请选择 1–300 张 SKU 图片'), { statusCode: 400 });
  const options = normalizeOptions(rawOptions);
  if (options.matteImages && ['external', 'image2'].includes(options.mattingProvider) && !options.confirmPaidMatting && execution.finalizeOnly !== true) throw Object.assign(new Error('外部抠图需要本次任务的明确费用确认'), { statusCode: 400 });
  const id = execution.resumeState?.id || execution.preparedId || `sku-pack-${Date.now()}-${nanoid(6)}`;
  if (!/^sku-pack-[A-Za-z0-9_-]+$/.test(id)) throw Object.assign(new Error('图包任务 ID 无效'), { statusCode: 400 });
  if (execution.preparedId) assertResource('job', id);
  const directory = path.join(OUTPUT_ROOT, id);
  await fs.mkdir(directory, { recursive: true });
  if (path.dirname(await fs.realpath(directory)).toLowerCase() !== (await fs.realpath(OUTPUT_ROOT)).toLowerCase()) throw Object.assign(new Error('图包目录超出输出范围'), { statusCode: 403 });
  const release = await packLock(directory);
  const control = { stop: null }; activePacks.set(id, control);
  let state, finalizing = false;
  const childIds = [];
  try {
    if (execution.validateResume) await execution.validateResume();
    const inputPaths = files.map((file, index) => normalizedRelativePath(relativePaths[index], file.originalname));
    const normalizedPaths = execution.resumeState ? inputPaths : stripCommonRoot(inputPaths);
    files.forEach((file, index) => {
      const original = normalizedRelativePath(relativePaths[index], file.originalname);
      if (options.roleOverrides[original]) options.roleOverrides[normalizedPaths[index]] = options.roleOverrides[original];
    });
    if (!execution.resumeState) {
      await fs.mkdir(path.join(directory, 'inputs'), { recursive: true });
      const sources = [];
      for (let index = 0; index < files.length; index++) {
        const key = `${index}.bin`, file = files[index];
        await fs.copyFile(file.path, path.join(directory, 'inputs', key));
        if (execution.inputHashes?.[index] && createHash('sha256').update(await fs.readFile(path.join(directory, 'inputs', key))).digest('hex') !== execution.inputHashes[index]) {
          await fs.rm(path.join(directory, 'inputs', key), { force: true });
          throw Object.assign(new Error('来源图片在确认后变化，请重新预检；未处理图片'), { statusCode: 409, code: 'COLLECTION_SOURCE_CHANGED' });
        }
        sources.push({ key, originalname: file.originalname, relativePath: normalizedPaths[index], size: file.size || (await fs.stat(file.path)).size });
      }
      await fs.writeFile(path.join(directory, 'resume-source.json'), JSON.stringify({ sources, options }));
      files = sources.map((item) => ({ ...item, path: path.join(directory, 'inputs', item.key) }));
    }
    const grouped = new Map();
    files.forEach((file, index) => { const relative = normalizedPaths[index], parts = relative.split('/'), sku = clean(parts.length > 1 ? parts[0] : 'UNGROUPED', 'UNGROUPED', 120); if (!grouped.has(sku)) grouped.set(sku, []); grouped.get(sku).push({ file, relative }); });
    const priorResults = execution.resumeState?.skuResults || [];
    state = { id, type: 'sku-pack', name: options.name, status: 'running', options, createdAt: execution.resumeState?.createdAt || new Date().toISOString(), skuResults: [...priorResults],
      ...(execution.resumeState?.downloadUrl ? { downloadUrl: execution.resumeState.downloadUrl } : {}),
      archiveGeneration: execution.resumeState?.archiveGeneration || 0,
      checkpointRevision: checkpointRevision(execution.resumeState),
      summary: {}, ...(execution.source || execution.resumeState?.source ? { source: execution.source || execution.resumeState.source } : {}), ...(execution.resumeApproval ? { resumeApproval: execution.resumeApproval } : execution.resumeState?.resumeApproval ? { resumeApproval: execution.resumeState.resumeApproval } : {}), recovery: { available: true, boundary: 'sku', confirmationRequired: true, message: '已完成的 SKU 保持不变；中断 SKU 会重新处理，涉及外部抠图需重新确认费用。' } };
    const summarize = () => {
      const items = state.skuResults.flatMap((item) => item.items);
      state.summary = { inputCount: files.length, skuCount: grouped.size, completedSkuCount: state.skuResults.length,
        outputCount: items.filter((item) => item.status === 'success').length, failedCount: items.filter((item) => item.status === 'failed').length,
        duplicateSkippedCount: items.filter((item) => item.status === 'skipped').length, generatedSquareCount: items.filter((item) => item.generated && item.status === 'success').length,
        mattedCount: items.filter((item) => item.matting && item.status === 'success').length, unprocessedCount: files.length - state.skuResults.reduce((sum, item) => sum + item.inputCount, 0) };
    };
    summarize(); await packCheckpoint(directory, state);
    if (execution.afterPrepared) await execution.afterPrepared({ id });
    let index = 0;
    for (const [sku, entries] of grouped) {
      if (control.stop) break;
      const childId = `${id}-part-${++index}`;
      childIds.push(childId);
      if (state.skuResults.some((item) => item.sku === sku)) continue;
      if (execution.finalizeOnly === true) throw Object.assign(new Error('仅打包恢复不能重新处理图片，请重新预检'), { statusCode: 409 });
      let child = await fs.readFile(path.join(OUTPUT_ROOT, childId, 'manifest.json'), 'utf8').then(JSON.parse).catch(() => null);
      if (!child || !['completed', 'completed_with_errors'].includes(child.status) || execution.retryFailed) child = await renderSkuPack(entries.map((item) => item.file), entries.map((item) => item.relative), options, childId);
      await fs.mkdir(path.join(directory, 'package'), { recursive: true });
      await fs.cp(path.join(OUTPUT_ROOT, childId, 'package'), path.join(directory, 'package'), { recursive: true });
      state.skuResults.push(...child.skuResults);
      summarize(); await packCheckpoint(directory, state);
      platformDb().prepare('DELETE FROM task_index WHERE id=?').run(childId);
      if (execution.afterSku) await execution.afterSku({ id, sku, completedSkuCount: state.skuResults.length });
    }
    finalizing = true;
    const published = await publishedArchives(directory, id);
    const previousGeneration = published.reduce((maximum, item) => Math.max(maximum, item.generation), Number.isSafeInteger(state.archiveGeneration) ? state.archiveGeneration : 0);
    state.archiveGeneration = execution.resumeState || published.length ? previousGeneration + 1 : 0;
    if (!Number.isSafeInteger(state.archiveGeneration)) throw new Error('结果包版本无效，请检查恢复点');
    const zipPath = path.join(directory, state.archiveGeneration ? `${id}-archive-${state.archiveGeneration}-${nanoid(8)}.zip` : `${id}.zip`);
    state.manifestUrl = publicPath(path.join(directory, 'manifest.json'));
    state.recovery.available = true; state.recovery.finalizePending = true;
    await packCheckpoint(directory, state); // Durable even if publication succeeds but its acknowledgement is lost.
    const archiveState = { ...state,
      status: control.stop || (state.summary.failedCount ? (state.summary.outputCount ? 'completed_with_errors' : 'failed') : 'completed'),
      downloadUrl: publicPath(zipPath),
      recovery: { ...state.recovery, available: state.summary.failedCount > 0 || state.summary.unprocessedCount > 0, finalizePending: false } };
    await zipDirectory(path.join(directory, 'package'), `${zipPath}.tmp`, archiveState);
    if (execution.validatePackage) await execution.validatePackage();
    await atomicRename(`${zipPath}.tmp`, zipPath);
    Object.assign(state, archiveState);
    await packCheckpoint(directory, state);
    if (!state.recovery.available) {
      await fs.rm(path.join(directory, 'inputs'), { recursive: true, force: true }).catch(() => {});
      for (const childId of childIds) { const target = path.resolve(OUTPUT_ROOT, childId); if (path.dirname(target) === path.resolve(OUTPUT_ROOT) && path.basename(target).startsWith(`${id}-part-`)) await fs.rm(target, { recursive: true, force: true }).catch(() => {}); }
    }
    return state;
  } catch (error) {
    if (state) { state.status = 'paused'; state.recovery.available = true; if (finalizing) state.recovery.finalizePending = true; state.error = { code: error.code || 'PACK_INTERRUPTED', stage: finalizing ? 'finalize' : 'processing', message: '处理已暂停，恢复时保留已完成的 SKU' }; await packCheckpoint(directory, state).catch(() => {}); }
    throw Object.assign(new Error(`${state ? '图包进度已保存，可在任务中心恢复' : '输入暂存未完成，请重新选择原始文件后重试'}：${id}。${error.message}`), { statusCode: error.statusCode || 500, jobId: id });
  } finally { activePacks.delete(id); await release(); }
}

export async function controlSkuPack(id, action) {
  assertResource('job', id);
  if (!/^sku-pack-[A-Za-z0-9_-]+$/.test(id) || !['pause', 'cancel'].includes(action)) throw Object.assign(new Error('无效的图包操作'), { statusCode: 400 });
  const status = action === 'cancel' ? 'cancelled' : 'paused';
  if (activePacks.has(id)) { activePacks.get(id).stop = status; return { requested: true, status, boundary: 'sku' }; }
  const directory = path.join(OUTPUT_ROOT, id);
  const snapshot = await readSkuPackSnapshot(id);
  if (snapshot.source !== 'primary') throw Object.assign(new Error('当前展示恢复快照，请先确认修复主清单，再暂停或取消此任务'), { statusCode: 409 });
  const state = snapshot.state;
  if (!state.recovery?.available) throw Object.assign(new Error('任务已结束，无需暂停或取消'), { statusCode: 409 });
  state.status = status; await packCheckpoint(directory, state); return state;
}
export function pauseRunningSkuPacks() { for (const control of activePacks.values()) control.stop = 'paused'; return activePacks.size; }

function manifestRepairPreview(id, snapshot) {
  return { id, canRepair: snapshot.source !== 'primary' && !activePacks.has(id), busy: activePacks.has(id),
    source: snapshot.source, sourceName: snapshot.sourceName, sourceHash: snapshot.sourceHash, fileBytes: snapshot.bytes.length,
    previewHash: fingerprint({ id, actorId: currentActor()?.id || 'local', epoch: collectionCreationEpoch(), primaryHash: snapshot.primaryHash, sourceHash: snapshot.sourceHash, source: snapshot.sourceName }),
    onlyManifest: true, imageCount: 0, remote: false };
}

export async function previewSkuManifestRepair(id) { return manifestRepairPreview(id, await readSkuPackSnapshot(id)); }

export async function repairSkuManifest(id, input = {}, execution = {}) {
  const actor = currentActor();
  if (actor && !['admin', 'operator', 'designer'].includes(actor.role)) throw Object.assign(new Error('当前角色不能修复任务清单'), { statusCode: 403 });
  if (input.confirm !== true || !/^[a-f0-9]{64}$/.test(input.previewHash || '') || !/^[a-f0-9]{64}$/.test(input.sourceHash || '')) throw Object.assign(new Error('请先预览并明确确认仅修复主清单'), { statusCode: 400 });
  const directory = await skuPackDirectory(id), release = await packLock(directory);
  const temp = path.join(directory, `manifest.json.repair-${nanoid(12)}.tmp`);
  try {
    const snapshot = await readSkuPackSnapshot(id), preview = manifestRepairPreview(id, snapshot);
    if (snapshot.source === 'primary' && snapshot.sourceHash === input.sourceHash) return { id, repaired: false, alreadyCurrent: true };
    const changed = () => Object.assign(new Error('主清单或恢复来源已变化，请重新预览确认；未重新处理图片'), { statusCode: 409, code: 'SKU_REPAIR_CHANGED' });
    if (!preview.canRepair || preview.previewHash !== input.previewHash || preview.sourceHash !== input.sourceHash) throw changed();
    audit(actor, 'sku-manifest-repair-prepare', id, 202, { previewHash: preview.previewHash, sourceHash: preview.sourceHash, previousHash: snapshot.primaryHash, source: snapshot.source });
    await fs.writeFile(temp, snapshot.bytes, { flag: 'wx' });
    if (execution.beforeCommit) await execution.beforeCommit();
    const current = manifestRepairPreview(id, await readSkuPackSnapshot(id));
    if (current.previewHash !== preview.previewHash) throw changed();
    const preservedDamaged = snapshot.primaryBytes === null ? null : `manifest.json.damaged-${Date.now()}-${nanoid(8)}`;
    if (preservedDamaged) await fs.writeFile(path.join(directory, preservedDamaged), snapshot.primaryBytes, { flag: 'wx' });
    await atomicRename(temp, path.join(directory, 'manifest.json'));
    indexTask(snapshot.state);
    audit(actor, 'sku-manifest-repair-complete', id, 200, { previewHash: preview.previewHash, sourceHash: preview.sourceHash, preservedDamaged, imagesProcessed: 0 });
    return { id, repaired: true, preservedDamaged, sourceHash: snapshot.sourceHash, imagesProcessed: 0 };
  } finally { await fs.rm(temp, { force: true }).catch(() => {}); await release(); }
}

async function packageSnapshot(directory) {
  const base = path.resolve(directory, 'package'), files = [];
  if ((await fs.realpath(base)).toLowerCase() !== base.toLowerCase() || (await fs.lstat(base)).isSymbolicLink()) throw Object.assign(new Error('图包输出目录无效'), { statusCode: 403 });
  async function visit(relative = '') {
    for (const name of (await fs.readdir(path.join(base, relative))).sort()) {
      const child = path.join(relative, name), file = path.join(base, child), stat = await fs.lstat(file), real = await fs.realpath(file);
      if (stat.isSymbolicLink() || !real.toLowerCase().startsWith(`${base.toLowerCase()}${path.sep}`)) throw Object.assign(new Error('图包输出路径越界'), { statusCode: 403 });
      if (stat.isDirectory()) await visit(child);
      else if (stat.isFile()) {
        if (files.length >= 10000) throw Object.assign(new Error('图包文件过多，请人工检查输出目录'), { statusCode: 400 });
        const digest = createHash('sha256'); for await (const chunk of fsSync.createReadStream(file)) digest.update(chunk);
        files.push({ relativePath: child.split(path.sep).join('/'), size: stat.size, sha256: digest.digest('hex') });
      } else throw Object.assign(new Error('图包输出不是普通文件'), { statusCode: 400 });
    }
  }
  await visit(); return files;
}

async function skuResumeContext(id, retryFailed = false) {
  const state = await readSkuPackState(id), directory = path.join(OUTPUT_ROOT, id);
  const legacyFinalize = state.status === 'paused' && ['EPERM', 'EACCES', 'EBUSY'].includes(state.error?.code) && state.summary?.unprocessedCount === 0 && await fs.stat(path.join(directory, `${id}.zip.tmp`)).then(stat => stat.isFile()).catch(() => false);
  const interruptedAfterLastSku = ['running', 'paused'].includes(state.status) && state.recovery?.available === true && state.summary?.unprocessedCount === 0;
  const finalizePending = state.recovery?.finalizePending === true || legacyFinalize || interruptedAfterLastSku;
  if (!state.recovery?.available && !finalizePending) return { state, preview: { id, canResume: false, complete: true, imageCount: 0, skuCount: 0, skus: [], options: state.options } };
  const plan = JSON.parse(await fs.readFile(path.join(directory, 'resume-source.json'), 'utf8'));
  if (!Array.isArray(plan.sources) || !plan.sources.length || plan.sources.length > 300) throw Object.assign(new Error('图包恢复输入清单无效'), { statusCode: 400 });
  const options = { ...normalizeOptions(plan.options), confirmPaidMatting: false };
  const retained = (state.skuResults || []).filter(item => !(retryFailed && item.failedCount > 0));
  const done = new Set(retained.map(item => item.sku));
  const sources = [], selected = [], seenKeys = new Set();
  let selectedBytes = 0;
  for (const item of plan.sources) {
    if (!/^\d+\.bin$/.test(item.key) || seenKeys.has(item.key)) throw Object.assign(new Error('恢复输入无效'), { statusCode: 400 });
    seenKeys.add(item.key);
    const relative = normalizedRelativePath(item.relativePath, item.originalname), parts = relative.split('/');
    const sku = clean(parts.length > 1 ? parts[0] : 'UNGROUPED', 'UNGROUPED', 120);
    if (done.has(sku)) { sources.push({ ...item, path: path.join(directory, 'inputs', item.key) }); continue; }
    const filePath = await fs.realpath(path.join(directory, 'inputs', item.key));
    if (path.dirname(filePath).toLowerCase() !== path.join(directory, 'inputs').toLowerCase()) throw Object.assign(new Error('恢复输入越界'), { statusCode: 403 });
    const stat = await fs.lstat(path.join(directory, 'inputs', item.key));
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 15 * 1024 * 1024) throw Object.assign(new Error('恢复图片路径或大小无效'), { statusCode: 400 });
    selectedBytes += stat.size;
    if (selectedBytes > 500 * 1024 * 1024) throw Object.assign(new Error('恢复图片总大小超过 500MB，请拆分任务'), { statusCode: 400 });
    selected.push({ key: item.key, sku, relativePath: relative, sha256: createHash('sha256').update(await fs.readFile(filePath)).digest('hex'), size: stat.size });
    sources.push({ ...item, path: filePath });
  }
  const onlyFinalize = selected.length === 0 && finalizePending;
  const packageFiles = onlyFinalize ? await packageSnapshot(directory) : [];
  const remote = selected.length > 0 && options.matteImages && ['external', 'image2'].includes(options.mattingProvider);
  const destination = remote ? getMattingConfig().dataDestinations.find(item => item.provider === options.mattingProvider) : null;
  let originValid = !remote;
  try { const url = new URL(destination.origin); originValid = ['http:', 'https:'].includes(url.protocol) && url.origin === destination.origin && !url.username && !url.password; } catch { /* A missing remote provider fails closed. */ }
  const snapshot = { id, actorId: currentActor()?.id || 'local', epoch: collectionCreationEpoch(), state, options, retryFailed, selected, destination, onlyFinalize, packageFiles };
  const preview = { id, canResume: (selected.length > 0 || onlyFinalize) && originValid && !activePacks.has(id), previewHash: fingerprint(snapshot), retryFailed, onlyFinalize, packageFiles,
    imageCount: selected.length, bytes: selectedBytes, skuCount: new Set(selected.map(item => item.sku)).size, skus: [...new Set(selected.map(item => item.sku))],
    inputs: selected, options, remote, destination, busy: activePacks.has(id), blocked: !originValid ? 'MATTING_DESTINATION_UNAVAILABLE' : selected.length || onlyFinalize ? null : 'NO_PENDING_SKUS' };
  return { state: { ...state, skuResults: retained }, plan, sources, preview };
}

export async function previewSkuPackResume(id, input = {}) {
  return (await skuResumeContext(id, input.retryFailed === true)).preview;
}

export async function resumeSkuPack(id, input = {}, execution = {}) {
  if (input.confirm !== true) throw Object.assign(new Error('请确认恢复，中断的 SKU 会重新处理'), { statusCode: 400 });
  const retryFailed = input.retryFailed === true, context = await skuResumeContext(id, retryFailed);
  if (context.preview.complete) return context.state;
  const preview = context.preview;
  if (preview.remote && input.confirmPaidMatting !== true) throw Object.assign(new Error('外部抠图需要本次恢复的明确费用确认'), { statusCode: 400 });
  if ((preview.remote || preview.onlyFinalize || input.previewHash !== undefined) && input.previewHash !== preview.previewHash) throw Object.assign(new Error('图包恢复范围、来源或服务去向已变化，请重新预检确认'), { statusCode: 409, code: 'SKU_RESUME_CHANGED' });
  if (!preview.canResume) throw Object.assign(new Error(preview.busy ? '图包任务正在执行，请稍后刷新' : preview.blocked === 'MATTING_DESTINATION_UNAVAILABLE' ? '抠图服务未配置或数据去向无效，未启动恢复' : '没有可恢复的 SKU，请检查失败重试选项'), { statusCode: 409 });
  const validateResume = async () => {
    const latest = await skuResumeContext(id, retryFailed);
    if (latest.preview.previewHash !== preview.previewHash) throw Object.assign(new Error('恢复点在取得执行锁前变化，请重新预检确认'), { statusCode: 409, code: 'SKU_RESUME_CHANGED' });
    if (execution.validateResume) await execution.validateResume();
  };
  return createSkuPack(context.sources, context.plan.sources.map(item => item.relativePath), { ...context.preview.options, confirmPaidMatting: input.confirmPaidMatting === true }, {
    ...execution, validateResume, resumeState: context.state, retryFailed, finalizeOnly: preview.onlyFinalize === true,
    ...(preview.onlyFinalize ? { validatePackage: async () => { if (fingerprint(await packageSnapshot(path.join(OUTPUT_ROOT, id))) !== fingerprint(preview.packageFiles)) throw Object.assign(new Error('打包期间输出图片发生变化，请重新预检'), { statusCode: 409, code: 'SKU_RESUME_CHANGED' }); } } : {}),
    resumeApproval: { previewHash: preview.previewHash, approvedAt: new Date().toISOString(), retryFailed, imageCount: preview.imageCount, skus: preview.skus, inputs: preview.inputs, destination: preview.destination, onlyFinalize: preview.onlyFinalize === true, ...(preview.onlyFinalize ? { packageFiles: preview.packageFiles } : {}) }
  });
}

export { normalizeOptions as normalizeSkuPackOptions, roleHint, stripCommonRoot, visualRoleHint, perceptualHash, hammingDistance };
