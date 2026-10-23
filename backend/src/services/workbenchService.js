import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import archiver from 'archiver';
import sharp from 'sharp';
import { nanoid } from 'nanoid';
import { paths } from './db.js';
import { indexTask, refreshTaskIndex } from './taskCenterService.js';
import { platformDb, pageOptions } from './platformStore.js';
import { assertResource, resourceVisible, ownerSql } from './ownershipService.js';
import { readSkuPackSnapshot } from './skuPackStateService.js';
import { readWorkbenchSnapshot, snapshotReadNotice, writeWorkbenchManifest } from './workbenchSnapshotService.js';

const WORKBENCH_DIR = path.join(paths.outputDir, 'workbench');
const IMAGE_FORMATS = new Set(['jpeg', 'png', 'webp']);

function nowIso() {
  return new Date().toISOString();
}

function publicPath(absolutePath) {
  return `/${path.relative(paths.rootDir, absolutePath).split(path.sep).join('/')}`;
}

function parseBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

function clampNumber(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.round(parsed)));
}

function cleanLabel(value, fallback) {
  const clean = String(value || '').trim().replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-');
  return clean.slice(0, 60) || fallback;
}

function cleanText(value, maxLength = 500) {
  return String(value ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim().slice(0, maxLength);
}

function csvCell(value) {
  let text = cleanText(value, 5000);
  if (/^[=+\-@]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}

function toCsv(headers, rows) {
  return `\uFEFF${[headers, ...rows].map((row) => row.map(csvCell).join(',')).join('\r\n')}\r\n`;
}

function finiteNumber(value, fallback = null) {
  if (value === '' || value === undefined || value === null) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

const PLATFORM_PROFILES = {
  temu: { name: 'Temu', titleLimit: 500, imageField: 'mainImageId', imageLabel: 'Temu 素材 ID' },
  amazon: { name: 'Amazon', titleLimit: 200, imageField: 'mainImageUrl', imageLabel: '主图 URL' },
  aliexpress: { name: 'AliExpress', titleLimit: 218, imageField: 'mainImageUrl', imageLabel: '主图 URL' },
  tiktok: { name: 'TikTok Shop', titleLimit: 255, imageField: 'mainImageUrl', imageLabel: '主图 URL' },
  shopee: { name: 'Shopee', titleLimit: 120, imageField: 'mainImageUrl', imageLabel: '主图 URL' },
  shein: { name: 'Shein', titleLimit: 255, imageField: 'mainImageUrl', imageLabel: '主图 URL' },
  ozon: { name: 'Ozon', titleLimit: 500, imageField: 'mainImageUrl', imageLabel: '主图 URL' },
  mercado: { name: 'Mercado Libre', titleLimit: 60, imageField: 'mainImageUrl', imageLabel: '主图 URL' }
};

export function normalizeImagePackOptions(input = {}) {
  const format = IMAGE_FORMATS.has(String(input.format || '').toLowerCase())
    ? String(input.format).toLowerCase()
    : 'jpeg';
  return {
    name: cleanLabel(input.name, '未命名图包'),
    prefix: cleanLabel(input.prefix, 'image'),
    format,
    quality: clampNumber(input.quality, 88, 40, 100),
    maxDimension: clampNumber(input.maxDimension, 1600, 320, 6000),
    square: parseBoolean(input.square, false),
    squareSize: clampNumber(input.squareSize, 1600, 320, 6000),
    background: /^#[0-9a-f]{6}$/i.test(String(input.background || '')) ? String(input.background) : '#ffffff'
  };
}

async function writeJson(filePath, value) {
  if (path.basename(filePath) === 'manifest.json') {
    await writeWorkbenchManifest(value); indexTask(value);
  } else await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function createZip(zipPath, imageDir, manifest) {
  await new Promise((resolve, reject) => {
    const output = fsSync.createWriteStream(zipPath);
    const archive = archiver('zip', { zlib: { level: 9 } });
    output.on('close', resolve);
    output.on('error', reject);
    archive.on('error', reject);
    archive.pipe(output);
    archive.directory(imageDir, 'images');
    archive.append(JSON.stringify(manifest, null, 2), { name: 'manifest.json' });
    archive.finalize();
  });
}

function imageExtension(format) {
  return format === 'jpeg' ? 'jpg' : format;
}

async function transformImage(file, outputPath, options) {
  const inputMetadata = await sharp(file.path).metadata();
  if (!inputMetadata.width || !inputMetadata.height || !IMAGE_FORMATS.has(inputMetadata.format)) {
    const error = new Error(`不支持的图片：${file.originalname}`);
    error.statusCode = 400;
    throw error;
  }

  let pipeline = sharp(file.path).rotate();
  if (options.square) {
    pipeline = pipeline.resize(options.squareSize, options.squareSize, {
      fit: 'contain',
      background: options.format === 'jpeg' ? options.background : { r: 255, g: 255, b: 255, alpha: 0 }
    });
  } else {
    pipeline = pipeline.resize({
      width: options.maxDimension,
      height: options.maxDimension,
      fit: 'inside',
      withoutEnlargement: true
    });
  }

  if (options.format === 'jpeg') pipeline = pipeline.jpeg({ quality: options.quality, mozjpeg: true });
  if (options.format === 'png') pipeline = pipeline.png({ quality: options.quality, compressionLevel: 9 });
  if (options.format === 'webp') pipeline = pipeline.webp({ quality: options.quality });
  await pipeline.toFile(outputPath);

  const outputMetadata = await sharp(outputPath).metadata();
  const stats = await fs.stat(outputPath);
  return {
    source: {
      name: file.originalname,
      width: inputMetadata.width,
      height: inputMetadata.height,
      format: inputMetadata.format,
      bytes: file.size
    },
    output: {
      width: outputMetadata.width,
      height: outputMetadata.height,
      format: outputMetadata.format,
      bytes: stats.size
    }
  };
}

export async function createImagePack(files = [], rawOptions = {}) {
  if (!Array.isArray(files) || files.length === 0) {
    const error = new Error('请至少选择一张图片');
    error.statusCode = 400;
    throw error;
  }

  const options = normalizeImagePackOptions(rawOptions);
  const jobId = `pack-${Date.now()}-${nanoid(6)}`;
  const jobDir = path.join(WORKBENCH_DIR, jobId);
  const imageDir = path.join(jobDir, 'images');
  await fs.mkdir(imageDir, { recursive: true });

  const items = [];
  const extension = imageExtension(options.format);
  for (let index = 0; index < files.length; index += 1) {
    const fileName = `${options.prefix}-${String(index + 1).padStart(3, '0')}.${extension}`;
    const outputPath = path.join(imageDir, fileName);
    const metadata = await transformImage(files[index], outputPath, options);
    items.push({
      index: index + 1,
      fileName,
      url: publicPath(outputPath),
      ...metadata
    });
  }

  const createdAt = nowIso();
  const manifest = {
    id: jobId,
    type: 'image-pack',
    status: 'completed',
    name: options.name,
    createdAt,
    updatedAt: createdAt,
    options,
    summary: {
      inputCount: files.length,
      outputCount: items.length,
      inputBytes: items.reduce((sum, item) => sum + (item.source.bytes || 0), 0),
      outputBytes: items.reduce((sum, item) => sum + (item.output.bytes || 0), 0)
    },
    items
  };
  const manifestPath = path.join(jobDir, 'manifest.json');
  const zipPath = path.join(jobDir, `${jobId}.zip`);
  await writeJson(manifestPath, manifest);
  await createZip(zipPath, imageDir, manifest);
  const zipStats = await fs.stat(zipPath);
  const completed = {
    ...manifest,
    manifestUrl: publicPath(manifestPath),
    downloadUrl: publicPath(zipPath),
    zipBytes: zipStats.size
  };
  await writeJson(manifestPath, completed);
  return completed;
}

export async function createCollectionPlan(raw = {}) {
  const urls = [...new Set((Array.isArray(raw.urls) ? raw.urls : [])
    .map((value) => String(value || '').trim())
    .filter(Boolean))];
  if (urls.length === 0) {
    const error = new Error('请至少填写一个来源链接');
    error.statusCode = 400;
    throw error;
  }
  if (urls.length > 500) {
    const error = new Error('单个采集计划最多支持 500 个链接');
    error.statusCode = 400;
    throw error;
  }
  for (const value of urls) {
    let parsed;
    try {
      parsed = new URL(value);
    } catch {
      const error = new Error(`链接格式无效：${value}`);
      error.statusCode = 400;
      throw error;
    }
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      const error = new Error(`仅支持 HTTP/HTTPS 链接：${value}`);
      error.statusCode = 400;
      throw error;
    }
  }

  const jobId = `collect-${Date.now()}-${nanoid(6)}`;
  const jobDir = path.join(WORKBENCH_DIR, jobId);
  await fs.mkdir(jobDir, { recursive: true });
  const createdAt = nowIso();
  const manifest = {
    id: jobId,
    type: 'collection-plan',
    status: 'planned',
    name: cleanLabel(raw.name, '未命名采集计划'),
    createdAt,
    updatedAt: createdAt,
    mode: 'manual-import',
    notice: '当前版本只创建来源清单，不绕过登录、验证码或平台访问控制。',
    summary: { inputCount: urls.length, pendingCount: urls.length },
    items: urls.map((url, index) => ({ index: index + 1, url, status: 'pending' }))
  };
  const manifestPath = path.join(jobDir, 'manifest.json');
  await writeJson(manifestPath, manifest);
  return { ...manifest, manifestUrl: publicPath(manifestPath) };
}

function listingIssues(row, profile) {
  const issues = [];
  if (!row.sku) issues.push({ level: 'blocked', field: 'sku', message: '缺少 SKU' });
  if (!row.title) issues.push({ level: 'blocked', field: 'title', message: '缺少商品标题' });
  if (row.title.length > profile.titleLimit) {
    issues.push({ level: 'blocked', field: 'title', message: `标题超过 ${profile.titleLimit} 个字符` });
  }
  if (row.price === null || row.price <= 0) issues.push({ level: 'blocked', field: 'price', message: '价格必须大于 0' });
  if (row.stock === null || row.stock < 0 || !Number.isInteger(row.stock)) issues.push({ level: 'blocked', field: 'stock', message: '库存必须是大于等于 0 的整数' });
  if (!row.mainImageRef) issues.push({ level: 'blocked', field: profile.imageField, message: `缺少${profile.imageLabel}` });
  if (row.weightGrams === null || row.weightGrams <= 0) issues.push({ level: 'warning', field: 'weightGrams', message: '未填写有效重量，正式刊登前需补充' });
  if (!row.description) issues.push({ level: 'warning', field: 'description', message: '未填写商品描述' });
  return issues;
}

export async function createListingDryRun(raw = {}) {
  const platformId = cleanText(raw.platformId, 30).toLowerCase();
  const profile = PLATFORM_PROFILES[platformId];
  if (!profile) {
    const error = new Error(`不支持的平台：${platformId || '空'}`);
    error.statusCode = 400;
    throw error;
  }
  const inputRows = Array.isArray(raw.rows) ? raw.rows : [];
  if (inputRows.length === 0 || inputRows.length > 1000) {
    const error = new Error('刊登预演每次需要 1–1000 条商品记录');
    error.statusCode = 400;
    throw error;
  }

  const rows = inputRows.map((input, index) => {
    const mainImageRef = cleanText(input.mainImageRef || input[profile.imageField], 1000);
    const row = {
      index: index + 1,
      sku: cleanText(input.sku, 120),
      title: cleanText(input.title, 1000),
      price: finiteNumber(input.price),
      stock: finiteNumber(input.stock),
      weightGrams: finiteNumber(input.weightGrams),
      mainImageRef,
      additionalImageRefs: Array.isArray(input.additionalImageRefs)
        ? input.additionalImageRefs.map((item) => cleanText(item, 1000)).filter(Boolean).slice(0, 20)
        : cleanText(input.additionalImageRefs, 5000).split(';').map((item) => item.trim()).filter(Boolean).slice(0, 20),
      description: cleanText(input.description, 5000)
    };
    const issues = listingIssues(row, profile);
    return {
      ...row,
      status: issues.some((issue) => issue.level === 'blocked') ? 'blocked' : (issues.length ? 'warning' : 'ready'),
      issues
    };
  });

  const jobId = `listing-${Date.now()}-${nanoid(6)}`;
  const jobDir = path.join(WORKBENCH_DIR, jobId);
  await fs.mkdir(jobDir, { recursive: true });
  const createdAt = nowIso();
  const manifestPath = path.join(jobDir, 'manifest.json');
  const csvPath = path.join(jobDir, `${jobId}-${platformId}-draft.csv`);
  const csvHeaders = ['platform', 'sku', 'title', 'price', 'stock', 'weight_grams', profile.imageField, 'additional_images', 'status', 'issues'];
  const csvRows = rows.map((row) => [
    profile.name,
    row.sku,
    row.title,
    row.price ?? '',
    row.stock ?? '',
    row.weightGrams ?? '',
    row.mainImageRef,
    row.additionalImageRefs.join(';'),
    row.status,
    row.issues.map((issue) => `${issue.level}:${issue.field}:${issue.message}`).join(' | ')
  ]);
  await fs.writeFile(csvPath, toCsv(csvHeaders, csvRows), 'utf8');

  const manifest = {
    id: jobId,
    type: 'listing-dry-run',
    status: 'completed',
    name: cleanLabel(raw.name, `${profile.name} 刊登预演`),
    createdAt,
    updatedAt: createdAt,
    platformId,
    platformName: profile.name,
    templateType: 'preflight-draft',
    notice: '这是本地字段预检草稿，不是平台官方模板，也不会上传或发布商品。',
    summary: {
      inputCount: rows.length,
      readyCount: rows.filter((row) => row.status === 'ready').length,
      warningCount: rows.filter((row) => row.status === 'warning').length,
      blockedCount: rows.filter((row) => row.status === 'blocked').length
    },
    rows,
    manifestUrl: publicPath(manifestPath),
    downloadUrl: publicPath(csvPath)
  };
  await writeJson(manifestPath, manifest);
  return manifest;
}

function normalizePricingRules(inputRules) {
  if (!Array.isArray(inputRules) || inputRules.length === 0 || inputRules.length > 10) {
    const error = new Error('调价预览需要 1–10 条规则');
    error.statusCode = 400;
    throw error;
  }
  return inputRules.map((input, index) => {
    const type = cleanText(input.type, 20).toLowerCase();
    const value = finiteNumber(input.value);
    if (!['percent', 'fixed'].includes(type) || value === null) {
      const error = new Error(`第 ${index + 1} 条调价规则格式无效`);
      error.statusCode = 400;
      throw error;
    }
    if (type === 'percent' && Math.abs(value) > 100) {
      const error = new Error(`第 ${index + 1} 条百分比规则不能超过 ±100%`);
      error.statusCode = 400;
      throw error;
    }
    if (type === 'fixed' && Math.abs(value) > 1000000) {
      const error = new Error(`第 ${index + 1} 条固定金额规则超出范围`);
      error.statusCode = 400;
      throw error;
    }
    return { index: index + 1, type, value };
  });
}

function roundPriceCents(cents, rounding) {
  if (rounding === 'integer') return Math.round(cents / 100) * 100;
  if (rounding === 'ending99') return Math.max(99, Math.floor(cents / 100) * 100 + 99);
  return cents;
}

export async function createPricingPreview(raw = {}) {
  const currency = String(raw.currency || 'USD').toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) throw Object.assign(new Error('币种必须为三位字母代码'), { statusCode: 400 });
  const scope = cleanText(raw.scope || 'all', 120);
  const inputItems = Array.isArray(raw.items) ? raw.items : [];
  if (inputItems.length === 0 || inputItems.length > 5000) {
    const error = new Error('调价预览每次需要 1–5000 条 SKU');
    error.statusCode = 400;
    throw error;
  }
  const rules = normalizePricingRules(raw.rules);
  const rounding = ['cent', 'integer', 'ending99'].includes(raw.rounding) ? raw.rounding : 'cent';

  const items = inputItems.map((input, index) => {
    const sku = cleanText(input.sku, 120);
    const originalPrice = finiteNumber(input.price);
    const issues = [];
    if (!sku) issues.push({ level: 'blocked', field: 'sku', message: '缺少 SKU' });
    if (scope !== 'all' && !sku.startsWith(scope)) issues.push({ level: 'blocked', field: 'sku', message: 'SKU 不在规则适用范围内，未调价' });
    if (originalPrice === null || originalPrice <= 0) issues.push({ level: 'blocked', field: 'price', message: '原价必须大于 0' });
    let cents = originalPrice === null ? 0 : Math.round(originalPrice * 100);
    const trace = [];
    if (!issues.length) {
      for (const rule of rules) {
        const before = cents;
        cents = rule.type === 'percent'
          ? Math.round(cents * (100 + rule.value) / 100)
          : cents + Math.round(rule.value * 100);
        trace.push({ ruleIndex: rule.index, type: rule.type, value: rule.value, before: before / 100, after: cents / 100 });
      }
      cents = roundPriceCents(cents, rounding);
      if (cents <= 0) issues.push({ level: 'blocked', field: 'newPrice', message: '规则计算后的价格必须大于 0' });
      if (Math.abs(cents - Math.round(originalPrice * 100)) / Math.round(originalPrice * 100) >= 0.5) {
        issues.push({ level: 'warning', field: 'newPrice', message: '价格变动达到或超过 50%，建议人工复核' });
      }
    }
    const finalPrice = cents / 100;
    const change = originalPrice ? Number((finalPrice - originalPrice).toFixed(2)) : null;
    return {
      index: index + 1,
      sku,
      originalPrice,
      newPrice: issues.some((issue) => issue.level === 'blocked') ? null : finalPrice,
      change,
      changePercent: originalPrice ? Number(((finalPrice - originalPrice) / originalPrice * 100).toFixed(2)) : null,
      status: issues.some((issue) => issue.level === 'blocked') ? 'blocked' : (issues.length ? 'warning' : 'ready'),
      issues,
      trace
    };
  });

  const validItems = items.filter((item) => item.newPrice !== null);
  const jobId = `pricing-${Date.now()}-${nanoid(6)}`;
  const jobDir = path.join(WORKBENCH_DIR, jobId);
  await fs.mkdir(jobDir, { recursive: true });
  const createdAt = nowIso();
  const manifestPath = path.join(jobDir, 'manifest.json');
  const csvPath = path.join(jobDir, `${jobId}-preview.csv`);
  await fs.writeFile(csvPath, toCsv(
    ['sku', 'original_price', 'new_price', 'change', 'change_percent', 'status', 'issues'],
    items.map((item) => [item.sku, item.originalPrice ?? '', item.newPrice ?? '', item.change ?? '', item.changePercent ?? '', item.status, item.issues.map((issue) => issue.message).join(' | ')])
  ), 'utf8');

  const manifest = {
    id: jobId,
    type: 'pricing-preview',
    currency,
    scope,
    formatVersion: 1,
    status: 'completed',
    name: cleanLabel(raw.name, '调价预览'),
    createdAt,
    updatedAt: createdAt,
    mode: 'local-preview',
    notice: '结果仅供预览和导出，不会连接店铺或修改线上价格。',
    rules,
    rounding,
    summary: {
      inputCount: items.length,
      readyCount: items.filter((item) => item.status === 'ready').length,
      warningCount: items.filter((item) => item.status === 'warning').length,
      blockedCount: items.filter((item) => item.status === 'blocked').length,
      totalBefore: Number(validItems.reduce((sum, item) => sum + item.originalPrice, 0).toFixed(2)),
      totalAfter: Number(validItems.reduce((sum, item) => sum + item.newPrice, 0).toFixed(2))
    },
    items,
    manifestUrl: publicPath(manifestPath),
    downloadUrl: publicPath(csvPath)
  };
  await writeJson(manifestPath, manifest);
  return manifest;
}

export async function listWorkbenchJobs() {
  await fs.mkdir(WORKBENCH_DIR, { recursive: true });
  const entries = await fs.readdir(WORKBENCH_DIR, { withFileTypes: true });
  const jobs = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (/^sku-pack-.*-part-\d+$/.test(entry.name)) continue;
    try {
      const raw = await fs.readFile(path.join(WORKBENCH_DIR, entry.name, 'manifest.json'), 'utf8');
      if (resourceVisible('job', entry.name)) jobs.push(JSON.parse(raw));
    } catch {
      // Ignore incomplete folders so one interrupted job cannot hide the queue.
    }
  }
  return jobs.sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
}

export async function recentWorkbenchJobs(limit = 20) {
  await refreshTaskIndex();
  const scope = ownerSql();
  return platformDb().prepare(`SELECT * FROM task_index WHERE kind NOT IN ('image','batch','device-task') AND ${scope.clause} ORDER BY updated_at DESC,id LIMIT ?`).all(...scope.args, Math.min(100, Math.max(1, Number(limit) || 20))).map((row) => {
    const summary = JSON.parse(row.summary);
    return { id: row.id, type: row.kind, name: row.title, status: summary.sourceState || row.state, summary, createdAt: row.created_at, updatedAt: row.updated_at, downloadUrl: summary.downloadUrl, manifestUrl: `/outputs/workbench/${row.id}/manifest.json` };
  });
}

export async function workbenchJobDetail(id, query = {}) {
  assertResource('job', id);
  if (!/^[A-Za-z0-9_-]{1,180}$/.test(id)) throw Object.assign(new Error('任务 ID 无效'), { statusCode: 400 });
  if (id.startsWith('sku-pack-')) {
    const snapshot = await readSkuPackSnapshot(id), { skuResults, ...summary } = snapshot.state;
    const entries = skuResults.flatMap(group => group.items.map(item => ({ sku: group.sku, ...item })));
    const { page, pageSize } = pageOptions(query);
    return { ...summary, entries: entries.slice((page - 1) * pageSize, page * pageSize), pagination: { page, pageSize, total: entries.length, totalPages: Math.max(1, Math.ceil(entries.length / pageSize)) },
      manifestUrl: `/api/workbench/sku-packs/${id}/manifest`,
      manifestRead: snapshot.source !== 'primary' ? { source: snapshot.source, sourceName: snapshot.sourceName, sourceHash: snapshot.sourceHash, reason: snapshot.reason, readOnly: true, primaryUnchanged: true } : undefined };
  }
  const snapshot = await readWorkbenchSnapshot(id), manifest = snapshot.state;
  const entries = manifest.items || manifest.rows || manifest.changes || manifest.skuResults?.flatMap((sku) => sku.items.map((item) => ({ sku: sku.sku, ...item }))) || [];
  const { page, pageSize } = pageOptions(query);
  const { items, rows, changes, skuResults, ...summary } = manifest;
  return { ...summary, entries: entries.slice((page - 1) * pageSize, page * pageSize), pagination: { page, pageSize, total: entries.length, totalPages: Math.max(1, Math.ceil(entries.length / pageSize)) }, manifestUrl: `/api/workbench/jobs/${id}/manifest`, manifestRead: snapshotReadNotice(snapshot) };
}

export function getWorkbenchOverview() {
  return {
    product: 'Crossborder Operations Workbench',
    version: '0.7.0',
    scope: 'clean-room-reimplementation',
    modules: [
      { id: 'image-pack', name: '图包处理', status: 'available', description: '批量改名、压缩、格式转换和方图补边' },
      { id: 'sku-pack', name: 'SKU 文件夹图包', status: 'available', description: '按 SKU 分组、拖拽/自然/随机排序、目标 KB 压缩、感知去重、内容辅助角色识别、命名和方图导出' },
      { id: 'collection-plan', name: '采集与批量下载', status: 'available', description: '支持表格导入、公开页面解析、销量过滤、断点续跑、防丢备份和原图下载' },
      { id: 'temu-deep', name: 'Temu 深度采集', status: 'available-runtime-required', description: 'Chrome/Edge 扩展提取懒加载、结构化和变种图片，可授权回传登录态图片字节；仍需真实 Temu 页面验收' },
      { id: 'material-ledger', name: '素材台账', status: 'available', description: '维护 SKU、平台素材 ID、图片用途和来源之间的映射' },
      { id: 'template-inspection', name: '模板识别', status: 'available', description: '安全读取 XLSX 工作表和表头，生成字段匹配与缺失项报告' },
      { id: 'matting', name: '主体抠图', status: 'available-existing', description: '复用项目已有的本地/外部抠图能力' },
      { id: 'listing-dry-run', name: '刊登预演', status: 'available', description: '生成平台字段映射、检查报告和草稿 CSV，不自动发布' },
      { id: 'pricing-preview', name: '调价预览', status: 'available', description: '支持多轮百分比/固定金额计算和 CSV 导出，不修改店铺价格' },
      { id: 'store-automation', name: '店铺自动化', status: 'not-connected', description: '尚未接入任何店铺账号或远程私有接口' }
    ]
  };
}

export { WORKBENCH_DIR };
