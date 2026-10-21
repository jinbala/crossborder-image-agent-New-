import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { lookup as dnsLookup } from 'node:dns/promises';
import { createHash } from 'node:crypto';
import { assertResource } from './ownershipService.js';
import archiver from 'archiver';
import sharp from 'sharp';
import { nanoid } from 'nanoid';
import { paths } from './db.js';
import { indexTask } from './taskCenterService.js';
import { beginCollectionCreation } from './workspaceLifecycle.js';
import { fingerprintCollectionRequest, reserveCollectionRequest, collectionRequestRecord, finishCollectionRequest, collectionRequestError } from './collectionRequestService.js';

const ROOT = path.join(paths.outputDir, 'workbench');
const MAX_PAGE_BYTES = 5 * 1024 * 1024;
const MAX_IMAGE_BYTES = 25 * 1024 * 1024;
const controls = new Map();
const creatingRequests = new Map();

export function pauseRunningCollections() {
  for (const control of controls.values()) control.paused = true;
  return controls.size;
}
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36 CrossborderWorkbench/0.5';

function clean(value, fallback = '', max = 180) {
  const text = String(value ?? '').trim().replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-').replace(/\s+/g, ' ');
  return text.slice(0, max) || fallback;
}

function cleanText(value, max = 2000) {
  return String(value ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim().slice(0, max);
}

function bool(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

function boundedNumber(value, fallback, min, max) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.min(max, Math.max(min, Math.round(parsed))) : fallback;
}

function publicPath(absolutePath) {
  return `/${path.relative(paths.rootDir, absolutePath).split(path.sep).join('/')}`;
}

function normalizeUrl(value) {
  try {
    const parsed = new URL(String(value || '').trim());
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) return '';
    return parsed.href;
  } catch { return ''; }
}

function normalizeSales(value) {
  if (value === null || value === undefined || value === '') return null;
  const text = String(value).trim().toLowerCase().replaceAll(',', '');
  const match = text.match(/(-?\d+(?:\.\d+)?)\s*(万|w|k|千)?/i);
  if (!match) return null;
  const multiplier = /万|w/i.test(match[2] || '') ? 10000 : /k|千/i.test(match[2] || '') ? 1000 : 1;
  const result = Number(match[1]) * multiplier;
  return Number.isFinite(result) ? Math.max(0, Math.round(result)) : null;
}

function normalizeOptions(raw = {}) {
  const replacementRules = (Array.isArray(raw.replacementRules) ? raw.replacementRules : [])
    .slice(0, 20)
    .map((rule) => ({ from: cleanText(rule?.from, 500), to: cleanText(rule?.to, 500), mode: rule?.mode === 'text' ? 'text' : 'prefix' }))
    .filter((rule) => rule.from);
  return {
    name: clean(raw.name, '图片采集任务', 100),
    mode: raw.mode === 'temu-deep' ? 'temu-deep' : 'normal',
    minSales: boundedNumber(raw.minSales, 0, 0, 1_000_000_000),
    extraWaitMs: boundedNumber(raw.extraWaitMs, 0, 0, 30_000),
    timeoutMs: boundedNumber(raw.timeoutMs, 20_000, 3_000, 60_000),
    maxImagesPerProduct: boundedNumber(raw.maxImagesPerProduct, 30, 1, 100),
    maxAttempts: boundedNumber(raw.maxAttempts, 3, 1, 5),
    downloadOriginal: bool(raw.downloadOriginal, true),
    randomFileNames: bool(raw.randomFileNames, false),
    replacementRules
  };
}

function normalizeRows(rows = []) {
  if (!Array.isArray(rows) || rows.length === 0) {
    const error = new Error('至少需要一条商品链接或图片链接');
    error.statusCode = 400;
    throw error;
  }
  if (rows.length > 5000) {
    const error = new Error('单个采集任务最多支持 5000 行');
    error.statusCode = 400;
    throw error;
  }
  const normalized = rows.map((row, index) => ({
    id: `item-${String(index + 1).padStart(5, '0')}`,
    index: index + 1,
    sourceRow: Number(row.sourceRow) || index + 2,
    sku: clean(row.sku, `ROW-${String(index + 1).padStart(5, '0')}`, 120),
    title: cleanText(row.title, 1000),
    sales: normalizeSales(row.sales),
    productUrl: normalizeUrl(row.productUrl),
    imageUrls: [...new Set((Array.isArray(row.imageUrls) ? row.imageUrls : String(row.imageUrls || '').split(/[\r\n;,|]+/)).map(normalizeUrl).filter(Boolean))],
    variants: (Array.isArray(row.variants) ? row.variants : []).slice(0, 100).map((variant) => ({
      id: cleanText(variant?.id, 120),
      name: cleanText(variant?.name, 240),
      imageUrls: [...new Set((Array.isArray(variant?.imageUrls) ? variant.imageUrls : []).map(normalizeUrl).filter(Boolean))].slice(0, 30)
    })).filter((variant) => variant.id || variant.name || variant.imageUrls.length),
    extraction: row.extraction && typeof row.extraction === 'object' ? {
      sourceCounts: Object.fromEntries(Object.entries(row.extraction.sourceCounts && typeof row.extraction.sourceCounts === 'object' ? row.extraction.sourceCounts : {})
        .slice(0, 20)
        .map(([key, value]) => [clean(key, 'unknown', 40), boundedNumber(value, 0, 0, 10000)])),
      totalFound: boundedNumber(row.extraction.totalFound, 0, 0, 10000),
      returned: boundedNumber(row.extraction.returned, 0, 0, 10000),
      scannedScriptBytes: boundedNumber(row.extraction.scannedScriptBytes, 0, 0, 10_000_000)
    } : null,
    status: 'pending',
    attempts: 0,
    collectedAt: null,
    images: [],
    error: null
  })).filter((row) => row.productUrl || row.imageUrls.length);
  if (normalized.length === 0) {
    const error = new Error('没有识别到有效的 HTTP/HTTPS 商品链接或图片链接');
    error.statusCode = 400;
    throw error;
  }
  return normalized;
}

function isPrivateAddress(address) {
  const normalized = String(address || '').toLowerCase().split('%')[0];
  if (normalized === '::1' || normalized === '::' || normalized.startsWith('fe80:') || normalized.startsWith('fc') || normalized.startsWith('fd')) return true;
  const mapped = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)?.[1];
  const ipv4 = mapped || (net.isIP(normalized) === 4 ? normalized : '');
  if (!ipv4) return false;
  const [a, b] = ipv4.split('.').map(Number);
  return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
}

async function resolvePublic(url, resolver = dnsLookup) {
  const parsed = new URL(url);
  if (parsed.username || parsed.password || !['http:', 'https:'].includes(parsed.protocol)) throw Object.assign(new Error('仅允许无账号信息的 HTTP/HTTPS 地址'), { code: 'UNSAFE_URL' });
  if (parsed.port && !['80', '443'].includes(parsed.port)) throw Object.assign(new Error('仅允许标准 HTTP/HTTPS 端口'), { code: 'UNSAFE_PORT' });
  const hostname = parsed.hostname.toLowerCase();
  if (hostname === 'localhost' || hostname.endsWith('.local')) throw Object.assign(new Error('不允许访问本机或局域网地址'), { code: 'PRIVATE_ADDRESS' });
  const records = net.isIP(hostname) ? [{ address: hostname, family: net.isIP(hostname) }] : await resolver(hostname, { all: true, verbatim: true });
  if (!records.length || records.some((record) => isPrivateAddress(record.address))) throw Object.assign(new Error('目标域名解析到了本机或私有网络地址'), { code: 'PRIVATE_ADDRESS' });
  return { parsed, address: records[0].address, family: records[0].family };
}

async function requestBuffer(url, { maxBytes, timeoutMs, accept, redirects = 4, resolver } = {}) {
  const resolved = await resolvePublic(url, resolver);
  const transport = resolved.parsed.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const request = transport.request(resolved.parsed, {
      method: 'GET',
      headers: { 'User-Agent': USER_AGENT, Accept: accept || '*/*', 'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.7' },
      lookup: (_hostname, options, callback) => {
        if (options?.all) callback(null, [{ address: resolved.address, family: resolved.family }]);
        else callback(null, resolved.address, resolved.family);
      }
    }, (response) => {
      const location = response.headers.location;
      if (location && [301, 302, 303, 307, 308].includes(response.statusCode)) {
        response.resume();
        if (redirects <= 0) return reject(Object.assign(new Error('重定向次数过多'), { code: 'TOO_MANY_REDIRECTS' }));
        const next = new URL(location, resolved.parsed).href;
        requestBuffer(next, { maxBytes, timeoutMs, accept, redirects: redirects - 1, resolver }).then(resolve, reject);
        return;
      }
      if (!response.statusCode || response.statusCode < 200 || response.statusCode >= 300) {
        response.resume();
        reject(Object.assign(new Error(`远程地址返回 HTTP ${response.statusCode || 0}`), { code: 'HTTP_ERROR', status: response.statusCode || 0 }));
        return;
      }
      const declared = Number(response.headers['content-length'] || 0);
      if (declared > maxBytes) {
        response.destroy();
        reject(Object.assign(new Error('远程内容超过允许大小'), { code: 'REMOTE_FILE_TOO_LARGE' }));
        return;
      }
      const chunks = [];
      let total = 0;
      response.on('data', (chunk) => {
        total += chunk.length;
        if (total > maxBytes) {
          response.destroy(Object.assign(new Error('远程内容超过允许大小'), { code: 'REMOTE_FILE_TOO_LARGE' }));
          return;
        }
        chunks.push(chunk);
      });
      response.on('end', () => resolve({ buffer: Buffer.concat(chunks), contentType: String(response.headers['content-type'] || ''), finalUrl: resolved.parsed.href }));
      response.on('error', reject);
    });
    request.setTimeout(timeoutMs || 20_000, () => request.destroy(Object.assign(new Error('远程请求超时'), { code: 'REMOTE_TIMEOUT' })));
    request.on('error', reject);
    request.end();
  });
}

function decodeHtml(value) {
  return String(value || '').replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'").replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&#(\d+);/g, (_match, code) => String.fromCodePoint(Number(code)));
}

function absoluteUrl(value, baseUrl) {
  try {
    const url = new URL(decodeHtml(String(value || '').replaceAll('\\/', '/')), baseUrl);
    return ['http:', 'https:'].includes(url.protocol) ? url.href : '';
  } catch { return ''; }
}

function collectJsonLd(value, result) {
  if (Array.isArray(value)) { value.forEach((item) => collectJsonLd(item, result)); return; }
  if (!value || typeof value !== 'object') return;
  if (!result.title && typeof value.name === 'string') result.title = value.name;
  const images = Array.isArray(value.image) ? value.image : [value.image];
  images.filter(Boolean).forEach((item) => result.images.push(typeof item === 'string' ? item : item?.url || item?.contentUrl || ''));
  for (const [key, child] of Object.entries(value)) {
    if (/sold|sales|purchase|ordercount/i.test(key) && result.sales === null) result.sales = normalizeSales(child);
    if (typeof child === 'object') collectJsonLd(child, result);
  }
}

export function extractProductPage(html, pageUrl) {
  const source = String(html || '');
  const result = { title: '', sales: null, images: [] };
  for (const match of source.matchAll(/<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try { collectJsonLd(JSON.parse(decodeHtml(match[1])), result); } catch { /* Ignore malformed structured data. */ }
  }
  const meta = (key) => source.match(new RegExp(`<meta\\b[^>]*(?:property|name)=["']${key}["'][^>]*content=["']([^"']+)["']`, 'i'))?.[1]
    || source.match(new RegExp(`<meta\\b[^>]*content=["']([^"']+)["'][^>]*(?:property|name)=["']${key}["']`, 'i'))?.[1] || '';
  result.title ||= decodeHtml(meta('og:title') || meta('twitter:title') || source.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || '').replace(/<[^>]+>/g, '').trim();
  [meta('og:image'), meta('twitter:image')].filter(Boolean).forEach((value) => result.images.push(value));
  for (const match of source.matchAll(/<(?:img|source)\b[^>]*(?:src|data-src|data-original|srcset)=["']([^"']+)["']/gi)) {
    const first = match[1].split(',')[0].trim().split(/\s+/)[0];
    result.images.push(first);
    if (result.images.length >= 200) break;
  }
  if (result.sales === null) {
    const salesText = source.match(/(?:已售|销量|sold|salesCount|soldCount)[^\d]{0,30}(\d+(?:\.\d+)?\s*(?:万|w|k|千)?)/i)?.[1];
    result.sales = normalizeSales(salesText);
  }
  result.images = [...new Set(result.images.map((value) => absoluteUrl(value, pageUrl)).filter(Boolean))];
  return result;
}

export function originalImageUrl(value) {
  const normalized = normalizeUrl(value);
  if (!normalized) return '';
  const url = new URL(normalized);
  const host = url.hostname.toLowerCase();
  if (host === 'i.pinimg.com' || host.endsWith('.pinimg.com')) url.pathname = url.pathname.replace(/^\/(?:75x75_RS|136x136|170x|236x|474x|564x|736x)\//i, '/originals/');
  if (host === 'm.media-amazon.com' || host.endsWith('.ssl-images-amazon.com') || host.endsWith('.media-amazon.com')) url.pathname = url.pathname.replace(/\._[^/]+_\.(?=(?:jpe?g|png|webp)$)/i, '.');
  return url.href;
}

export function applyReplacementRules(value, rules = []) {
  let output = String(value || '');
  for (const rule of rules) {
    if (!rule?.from) continue;
    if (rule.mode === 'text') output = output.split(rule.from).join(rule.to || '');
    else if (output.startsWith(rule.from)) output = `${rule.to || ''}${output.slice(rule.from.length)}`;
  }
  return normalizeUrl(output);
}

function hashToken(value) {
  return createHash('sha256').update(String(value)).digest('hex').slice(0, 12);
}

function summarize(manifest) {
  const items = manifest.items || [];
  return {
    inputCount: items.length,
    completedCount: items.filter((item) => item.status === 'completed').length,
    warningCount: items.filter((item) => item.status === 'completed_with_errors').length,
    failedCount: items.filter((item) => item.status === 'failed').length,
    skippedCount: items.filter((item) => item.status === 'skipped').length,
    pendingCount: items.filter((item) => item.status === 'pending' || item.status === 'running').length,
    downloadedCount: items.flatMap((item) => item.images || []).filter((image) => image.status === 'success').length,
    imageFailedCount: items.flatMap((item) => item.images || []).filter((image) => image.status === 'failed').length
  };
}

async function checkpoint(jobDir, manifest) {
  manifest.updatedAt = new Date().toISOString();
  manifest.summary = summarize(manifest);
  const target = path.join(jobDir, 'manifest.json');
  const backup = path.join(jobDir, 'manifest.backup.json');
  let hasPreviousBackup = true;
  try {
    JSON.parse(await fs.readFile(target, 'utf8'));
    await fs.copyFile(target, backup);
  } catch {
    try { JSON.parse(await fs.readFile(backup, 'utf8')); }
    catch { hasPreviousBackup = false; }
  }
  const temporary = path.join(jobDir, `manifest.${process.pid}.${Date.now()}.tmp`);
  await fs.writeFile(temporary, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  await fs.rename(temporary, target);
  if (!hasPreviousBackup) await fs.copyFile(target, backup);
  indexTask(manifest);
  const now = new Date();
  await fs.utimes(path.join(jobDir, 'run.lock'), now, now).catch(() => {});
}

function jobDirectory(jobId) {
  if (!/^collect-job-[A-Za-z0-9_-]+$/.test(String(jobId || ''))) throw Object.assign(new Error('采集任务 ID 无效'), { statusCode: 400 });
  return path.join(ROOT, jobId);
}

export async function getCollectionJob(jobId) {
  assertResource('job', jobId);
  const jobDir = jobDirectory(jobId);
  try { return JSON.parse(await fs.readFile(path.join(jobDir, 'manifest.json'), 'utf8')); }
  catch (error) {
    try {
      const recovered = JSON.parse(await fs.readFile(path.join(jobDir, 'manifest.backup.json'), 'utf8'));
      return { ...recovered, recoveredFromBackup: true };
    } catch { /* Preserve the original read failure when neither checkpoint is usable. */ }
    if (error.code === 'ENOENT') throw Object.assign(new Error('采集任务不存在'), { statusCode: 404 });
    throw error;
  }
}

export function prepareCollectionInput(raw = {}) {
  return { rows: normalizeRows(raw.rows), options: normalizeOptions(raw.options || {}), source: raw.source || { type: 'rows' } };
}

export async function createCollectionJob(raw = {}, deps = {}) {
  const release = beginCollectionCreation();
  try { return await createCollectionJobInternal(raw, deps); } finally { release(); }
}

async function createCollectionJobInternal(raw, deps) {
  const options = normalizeOptions(raw.options || raw);
  const items = normalizeRows(raw.rows);
  for (const item of items) {
    if (item.sales !== null && item.sales < options.minSales) {
      item.status = 'skipped';
      item.error = { code: 'BELOW_MIN_SALES', message: `销量 ${item.sales} 低于过滤值 ${options.minSales}` };
    } else if (options.mode === 'temu-deep' && options.minSales > 0 && item.sales === null) {
      item.status = 'skipped';
      item.error = { code: 'SALES_UNKNOWN', message: `浏览器页面未识别到销量，无法确认是否达到过滤值 ${options.minSales}` };
    }
  }
  const makeManifest = () => collectionManifest(options, items, raw.source || { type: 'rows' });
  if (raw.clientRequestId === undefined) {
    const manifest = makeManifest(), jobDir = jobDirectory(manifest.id);
    await fs.mkdir(path.join(jobDir, 'images'), { recursive: true });
    await checkpoint(jobDir, manifest);
    return manifest;
  }
  const payloadHash = fingerprintCollectionRequest({ options, items, source: raw.source || { type: 'rows' } });
  const reservation = reserveCollectionRequest(raw.clientRequestId, raw.creationEpoch, payloadHash, makeManifest);
  let pending = creatingRequests.get(reservation.job_id);
  if (!pending) {
    pending = publishCollectionCreation(reservation, deps);
    creatingRequests.set(reservation.job_id, pending);
    pending.finally(() => { if (creatingRequests.get(reservation.job_id) === pending) creatingRequests.delete(reservation.job_id); }).catch(() => {});
  }
  const manifest = await pending;
  collectionRequestRecord(reservation); // Recheck ownership, including after an administrator assignment.
  return { ...manifest, creation: { replayed: !reservation.created, durable: true } };
}

function collectionManifest(options, items, source) {
  const id = `collect-job-${Date.now()}-${nanoid(12)}`;
  const jobDir = jobDirectory(id);
  const createdAt = new Date().toISOString();
  const manifest = {
    id,
    type: 'collection-job',
    status: items.some((item) => item.status === 'pending') ? 'queued' : 'completed',
    name: options.name,
    createdAt,
    updatedAt: createdAt,
    source,
    options,
    notice: options.mode === 'temu-deep' ? 'Temu 深采数据必须由用户授权的已登录浏览器会话导入；本任务不会绕过登录或验证码。' : '仅采集公开可访问内容，并对目标地址执行本机/内网访问拦截。',
    items,
    summary: {},
    manifestUrl: publicPath(path.join(jobDir, 'manifest.json')),
    backupUrl: publicPath(path.join(jobDir, 'manifest.backup.json')),
    downloadUrl: null
  };
  manifest.summary = summarize(manifest);
  return manifest;
}

function contained(root, file) { const relative = path.relative(root, file); return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative); }
async function creationDirectory(jobDir, mayCreate) {
  const root = await fs.realpath(paths.rootDir);
  await fs.mkdir(paths.outputDir, { recursive: true });
  if (!contained(root, await fs.realpath(paths.outputDir))) throw collectionRequestError('采集输出目录超出工作空间，未写入任务', 'COLLECTION_PATH_INVALID');
  await fs.mkdir(ROOT, { recursive: true });
  const workbench = await fs.realpath(ROOT);
  if (!contained(root, workbench)) throw collectionRequestError('采集输出目录无效，未写入任务', 'COLLECTION_PATH_INVALID');
  if (mayCreate) await fs.mkdir(jobDir, { recursive: true });
  const directory = await fs.realpath(jobDir).catch(() => null);
  if (!directory || !contained(workbench, directory)) throw collectionRequestError('原采集任务目录缺失或不合法，请检查备份；不会另建任务', 'COLLECTION_REQUEST_FILES_MISSING');
  for (const name of ['manifest.json', 'manifest.backup.json']) {
    const stat = await fs.lstat(path.join(jobDir, name)).catch((error) => { if (error.code === 'ENOENT') return null; throw error; });
    if (stat && (!stat.isFile() || stat.isSymbolicLink())) throw collectionRequestError('采集任务清单路径无效，未修改原文件', 'COLLECTION_PATH_INVALID');
  }
  return directory;
}

async function publishCollectionCreation(reservation, deps) {
  if (reservation.created) await deps.afterReservation?.(reservation);
  const row = collectionRequestRecord(reservation), jobDir = jobDirectory(row.job_id);
  await creationDirectory(jobDir, row.state === 'prepared');
  let release;
  if (row.state === 'prepared') release = await acquireLock(jobDir);
  try {
    const current = collectionRequestRecord(reservation);
    let manifest;
    try { manifest = await getCollectionJob(row.job_id); }
    catch (error) {
      if (error.statusCode !== 404 || current.state !== 'prepared') throw collectionRequestError('原采集任务清单缺失或损坏，请检查备份；不会另建任务或覆盖进度', 'COLLECTION_REQUEST_FILES_MISSING');
      const checkpoints = await Promise.all(['manifest.json', 'manifest.backup.json'].map((name) => fs.lstat(path.join(jobDir, name)).catch((failure) => { if (failure.code === 'ENOENT') return null; throw failure; })));
      if (checkpoints.some(Boolean)) throw collectionRequestError('原采集清单已存在但无法读取，请检查备份；不会用初始请求覆盖它', 'COLLECTION_REQUEST_FILES_MISSING');
      const images = path.join(jobDir, 'images');
      const entries = await fs.readdir(images).catch((failure) => { if (failure.code === 'ENOENT') return []; throw failure; });
      if (entries.length) throw collectionRequestError('原任务已有图片但清单缺失，请恢复备份；不会重置为新任务', 'COLLECTION_REQUEST_FILES_MISSING');
      await fs.mkdir(images, { recursive: true });
      if (!contained(await fs.realpath(jobDir), await fs.realpath(images))) throw collectionRequestError('采集图片目录无效', 'COLLECTION_PATH_INVALID');
      try { manifest = JSON.parse(current.initial_manifest); } catch { throw collectionRequestError('采集请求恢复记录损坏，未修改原文件', 'COLLECTION_REQUEST_CORRUPT'); }
      if (manifest.id !== row.job_id || manifest.creationFingerprint !== row.payload_hash || fingerprintCollectionRequest({ options: manifest.options, items: manifest.items, source: manifest.source }) !== row.payload_hash) throw collectionRequestError('采集请求恢复记录损坏，未修改原文件', 'COLLECTION_REQUEST_CORRUPT');
      await checkpoint(jobDir, manifest);
    }
    if (manifest.id !== row.job_id || manifest.creationFingerprint !== row.payload_hash) throw collectionRequestError('原任务与采集请求不一致，未覆盖原文件', 'COLLECTION_REQUEST_CONFLICT');
    if (current.state === 'prepared') {
      indexTask(manifest);
      await deps.afterCheckpoint?.(manifest);
      finishCollectionRequest(reservation);
    }
    return manifest;
  } finally { await release?.(); }
}

async function archiveImages(jobDir, manifest) {
  const zipPath = path.join(jobDir, `${manifest.id}.zip`);
  const temporary = `${zipPath}.tmp`;
  await fs.rm(temporary, { force: true });
  await new Promise((resolve, reject) => {
    const output = fsSync.createWriteStream(temporary);
    const archive = archiver('zip', { zlib: { level: 9 } });
    output.on('close', resolve);
    output.on('error', reject);
    archive.on('error', reject);
    archive.pipe(output);
    archive.directory(path.join(jobDir, 'images'), 'images');
    archive.append(JSON.stringify(manifest, null, 2), { name: 'manifest.json' });
    archive.finalize();
  });
  await fs.rm(zipPath, { force: true });
  await fs.rename(temporary, zipPath);
  return zipPath;
}

async function acquireLock(jobDir) {
  const lockPath = path.join(jobDir, 'run.lock');
  try {
    const handle = await fs.open(lockPath, 'wx');
    await handle.writeFile(JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }));
    await handle.close();
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const stats = await fs.stat(lockPath).catch(() => null);
    const owner = await fs.readFile(lockPath, 'utf8').then(JSON.parse).catch(() => null);
    let ownerAlive = true;
    if (Number.isInteger(owner?.pid) && owner.pid > 0) {
      try { process.kill(owner.pid, 0); } catch (error) { if (error.code === 'ESRCH') ownerAlive = false; }
    }
    if (!ownerAlive || (stats && Date.now() - stats.mtimeMs > 10 * 60 * 1000)) {
      await fs.rm(lockPath, { force: true });
      return acquireLock(jobDir);
    }
    throw Object.assign(new Error('采集任务正在运行，请稍后再试'), { statusCode: 409 });
  }
  return async () => fs.rm(lockPath, { force: true });
}

function wait(ms) { return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve(); }

async function defaultPageFetcher(url, options, deps) {
  const response = await requestBuffer(url, { maxBytes: MAX_PAGE_BYTES, timeoutMs: options.timeoutMs, accept: 'text/html,application/xhtml+xml', resolver: deps.resolver });
  return { html: response.buffer.toString('utf8'), finalUrl: response.finalUrl, contentType: response.contentType };
}

async function defaultImageFetcher(url, options, deps) {
  return requestBuffer(url, { maxBytes: MAX_IMAGE_BYTES, timeoutMs: options.timeoutMs, accept: 'image/avif,image/webp,image/png,image/jpeg,*/*;q=0.4', resolver: deps.resolver });
}

function imageExtension(format) {
  return ({ jpeg: 'jpg', png: 'png', webp: 'webp', avif: 'avif', gif: 'gif', tiff: 'tif' })[format] || 'img';
}

async function processItem(item, manifest, jobDir, deps) {
  const { options } = manifest;
  item.status = 'running';
  item.attempts += 1;
  item.error = null;
  await checkpoint(jobDir, manifest);
  try {
    if (options.mode === 'temu-deep' && options.minSales > 0 && item.sales === null) {
      item.status = 'skipped';
      item.error = { code: 'SALES_UNKNOWN', message: `浏览器页面未识别到销量，无法确认是否达到过滤值 ${options.minSales}` };
      item.collectedAt = new Date().toISOString();
      return;
    }
    if (item.productUrl && (!item.title || item.sales === null || !item.imageUrls.length)) {
      const pageRequired = !item.imageUrls.length || (options.minSales > 0 && item.sales === null);
      try {
        const page = await (deps.pageFetcher || defaultPageFetcher)(item.productUrl, options, deps);
        const extracted = extractProductPage(page.html || page.buffer?.toString('utf8') || '', page.finalUrl || item.productUrl);
        item.title ||= cleanText(extracted.title, 1000);
        if (item.sales === null) item.sales = extracted.sales;
        item.imageUrls = [...new Set([...item.imageUrls, ...extracted.images])];
        item.finalProductUrl = page.finalUrl || item.productUrl;
        item.pageWarning = null;
      } catch (error) {
        if (pageRequired) throw error;
        item.pageWarning = { code: error.code || 'PAGE_FETCH_FAILED', message: cleanText(error.message, 500) };
      }
    }
    if (options.minSales > 0 && item.sales === null) {
      item.status = 'skipped';
      item.error = { code: 'SALES_UNKNOWN', message: `页面未识别到销量，无法确认是否达到过滤值 ${options.minSales}` };
      item.collectedAt = new Date().toISOString();
      return;
    }
    if (item.sales !== null && item.sales < options.minSales) {
      item.status = 'skipped';
      item.error = { code: 'BELOW_MIN_SALES', message: `销量 ${item.sales} 低于过滤值 ${options.minSales}` };
      item.collectedAt = new Date().toISOString();
      return;
    }
    if (!item.imageUrls.length) throw Object.assign(new Error('页面中未发现可下载图片'), { code: options.mode === 'temu-deep' ? 'BROWSER_RUNTIME_REQUIRED' : 'NO_IMAGES_FOUND' });
    const selectedUrls = item.imageUrls.slice(0, options.maxImagesPerProduct);
    const existing = new Map((item.images || []).map((image) => [image.sourceUrl, image]));
    item.images = [];
    for (let index = 0; index < selectedUrls.length; index += 1) {
      const sourceUrl = selectedUrls[index];
      const previous = existing.get(sourceUrl);
      if (previous?.status === 'success') { item.images.push(previous); continue; }
      let resolvedUrl = applyReplacementRules(sourceUrl, options.replacementRules);
      const addressChanges = resolvedUrl === sourceUrl ? [] : [{ kind: 'replacement', before: sourceUrl, after: resolvedUrl }];
      const replacedUrl = resolvedUrl;
      if (options.downloadOriginal) resolvedUrl = originalImageUrl(resolvedUrl);
      if (resolvedUrl !== replacedUrl) addressChanges.push({ kind: 'original-adapter', before: replacedUrl, after: resolvedUrl });
      const image = { index: index + 1, sourceUrl, resolvedUrl, addressChanges, adapter: resolvedUrl !== sourceUrl ? 'original-or-replacement' : 'unchanged', status: 'pending', file: null, error: null };
      try {
        const response = await (deps.imageFetcher || defaultImageFetcher)(resolvedUrl, options, deps);
        const buffer = Buffer.isBuffer(response) ? response : response.buffer;
        if (!buffer?.length) throw Object.assign(new Error('图片响应为空'), { code: 'EMPTY_IMAGE' });
        const metadata = await sharp(buffer, { animated: false }).metadata();
        if (!metadata.width || !metadata.height || !['jpeg', 'png', 'webp', 'avif', 'gif', 'tiff'].includes(metadata.format)) throw Object.assign(new Error('下载内容不是受支持的安全栅格图片'), { code: 'INVALID_IMAGE' });
        const extension = imageExtension(metadata.format);
        const baseName = options.randomFileNames ? hashToken(`${manifest.id}:${item.id}:${sourceUrl}`) : `${clean(item.sku, item.id, 100)}-${String(item.index).padStart(5, '0')}-${String(index + 1).padStart(3, '0')}`;
        const relative = `${clean(item.sku, item.id, 100)}/${baseName}.${extension}`;
        const outputPath = path.join(jobDir, 'images', ...relative.split('/'));
        await fs.mkdir(path.dirname(outputPath), { recursive: true });
        await fs.writeFile(outputPath, buffer);
        image.status = 'success';
        image.file = relative;
        image.url = publicPath(outputPath);
        image.width = metadata.width;
        image.height = metadata.height;
        image.format = metadata.format;
        image.bytes = buffer.length;
        image.sha256 = createHash('sha256').update(buffer).digest('hex');
        image.finalUrl = normalizeUrl(response.finalUrl) || resolvedUrl;
        if (image.finalUrl !== resolvedUrl) image.addressChanges.push({ kind: 'redirect', before: resolvedUrl, after: image.finalUrl });
      } catch (error) {
        image.status = 'failed';
        image.error = { code: error.code || 'IMAGE_DOWNLOAD_FAILED', message: cleanText(error.message, 500) };
      }
      item.images.push(image);
      await checkpoint(jobDir, manifest);
    }
    const successful = item.images.filter((image) => image.status === 'success').length;
    const failed = item.images.filter((image) => image.status === 'failed').length;
    if (!successful) throw Object.assign(new Error('该商品的图片全部下载失败'), { code: 'ALL_IMAGES_FAILED' });
    item.status = failed || item.pageWarning ? 'completed_with_errors' : 'completed';
    item.collectedAt = new Date().toISOString();
  } catch (error) {
    item.status = 'failed';
    item.error = { code: error.code || 'COLLECTION_FAILED', message: cleanText(error.message, 500) };
    item.collectedAt = new Date().toISOString();
  }
}

export async function runCollectionJob(jobId, raw = {}, deps = {}) {
  const jobDir = jobDirectory(jobId);
  const release = await acquireLock(jobDir);
  const control = { paused: false, cancelled: false };
  controls.set(jobId, control);
  try {
    const manifest = await getCollectionJob(jobId);
    // Acquiring the lock establishes exclusive ownership. Interrupted items retain
    // successful image checkpoints and become eligible for a manual continuation.
    for (const item of manifest.items) if (item.status === 'running') item.status = 'pending';
    const limit = boundedNumber(raw.limit, 10, 1, 50);
    const retryFailed = bool(raw.retryFailed, false);
    const candidates = manifest.items.filter((item) => item.status === 'pending' || (retryFailed && ['failed', 'completed_with_errors'].includes(item.status) && item.attempts < manifest.options.maxAttempts)).slice(0, limit);
    manifest.status = 'running';
    await checkpoint(jobDir, manifest);
    for (const item of candidates) {
      if (control.paused) break;
      await processItem(item, manifest, jobDir, deps);
      await checkpoint(jobDir, manifest);
      if (manifest.options.extraWaitMs) await wait(manifest.options.extraWaitMs);
    }
    const summary = summarize(manifest);
    manifest.status = control.cancelled ? 'cancelled' : (summary.pendingCount > 0 ? 'paused' : (summary.failedCount || summary.warningCount || summary.imageFailedCount ? 'completed_with_errors' : 'completed'));
    const zipPath = await archiveImages(jobDir, manifest);
    manifest.downloadUrl = publicPath(zipPath);
    await checkpoint(jobDir, manifest);
    return manifest;
  } finally {
    controls.delete(jobId);
    await release();
  }
}

export async function importBrowserImage(jobId, raw = {}) {
  const jobDir = jobDirectory(jobId);
  const release = await acquireLock(jobDir);
  try {
    const manifest = await getCollectionJob(jobId);
    const item = manifest.items.find((candidate) => candidate.id === raw.itemId);
    if (!item) throw Object.assign(new Error('采集任务中不存在指定商品'), { statusCode: 404 });
    if (item.status === 'skipped') throw Object.assign(new Error('该商品已因过滤规则跳过，不能导入图片'), { statusCode: 409 });
    const sourceUrl = normalizeUrl(raw.sourceUrl);
    const index = item.imageUrls.indexOf(sourceUrl);
    if (!sourceUrl || index < 0) throw Object.assign(new Error('图片地址不属于该商品的已采集链接'), { statusCode: 400 });
    const existing = (item.images || []).find((image) => image.sourceUrl === sourceUrl && image.status === 'success');
    if (existing) return { imported: false, idempotent: true, image: existing, summary: manifest.summary };
    if (!raw.filePath) throw Object.assign(new Error('缺少浏览器回传图片'), { statusCode: 400 });
    const stats = await fs.stat(raw.filePath);
    if (stats.size <= 0 || stats.size > MAX_IMAGE_BYTES) throw Object.assign(new Error('浏览器回传图片大小无效'), { statusCode: 400 });
    const metadata = await sharp(raw.filePath, { animated: false }).metadata();
    if (!metadata.width || !metadata.height || !['jpeg', 'png', 'webp', 'avif', 'gif', 'tiff'].includes(metadata.format)) {
      throw Object.assign(new Error('浏览器回传内容不是受支持的安全栅格图片'), { statusCode: 400 });
    }
    const extension = imageExtension(metadata.format);
    const baseName = manifest.options.randomFileNames
      ? hashToken(`${manifest.id}:${item.id}:${sourceUrl}`)
      : `${clean(item.sku, item.id, 100)}-${String(item.index).padStart(5, '0')}-${String(index + 1).padStart(3, '0')}`;
    const relative = `${clean(item.sku, item.id, 100)}/${baseName}.${extension}`;
    const outputPath = path.join(jobDir, 'images', ...relative.split('/'));
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    await fs.copyFile(raw.filePath, outputPath);
    const image = {
      index: index + 1,
      sourceUrl,
      resolvedUrl: sourceUrl,
      finalUrl: normalizeUrl(raw.finalUrl) || sourceUrl,
      addressChanges: normalizeUrl(raw.finalUrl) && normalizeUrl(raw.finalUrl) !== sourceUrl ? [{ kind: 'browser-redirect', before: sourceUrl, after: normalizeUrl(raw.finalUrl) }] : [],
      sha256: createHash('sha256').update(await fs.readFile(outputPath)).digest('hex'),
      adapter: 'authorized-browser-session',
      status: 'success',
      file: relative,
      url: publicPath(outputPath),
      width: metadata.width,
      height: metadata.height,
      format: metadata.format,
      bytes: stats.size,
      error: null
    };
    item.images = [...(item.images || []).filter((candidate) => candidate.sourceUrl !== sourceUrl), image]
      .sort((left, right) => left.index - right.index);
    if (item.imageUrls.slice(0, manifest.options.maxImagesPerProduct).every((url) => item.images.some((saved) => saved.sourceUrl === url && saved.status === 'success'))) {
      item.status = 'completed'; item.collectedAt = new Date().toISOString(); item.error = null;
    }
    if (manifest.items.every((candidate) => ['completed', 'skipped'].includes(candidate.status))) {
      manifest.status = 'completed';
      manifest.summary = summarize(manifest);
      manifest.downloadUrl = publicPath(await archiveImages(jobDir, manifest));
    }
    await checkpoint(jobDir, manifest);
    return { imported: true, idempotent: false, image, summary: manifest.summary };
  } finally {
    await release();
  }
}

export async function pauseCollectionJob(jobId, cancel = false) {
  assertResource('job', jobId);
  const control = controls.get(jobId);
  if (control) { control.paused = true; control.cancelled = cancel; return { requested: true, message: '当前商品处理完成后停止，恢复点已保留' }; }
  const directory = jobDirectory(jobId);
  const release = await acquireLock(directory);
  try {
    const manifest = await getCollectionJob(jobId);
    if (['completed', 'completed_with_errors'].includes(manifest.status)) throw Object.assign(new Error('任务已完成'), { statusCode: 409 });
    manifest.status = cancel ? 'cancelled' : 'paused';
    await checkpoint(directory, manifest);
    return { requested: true, manifest };
  } finally { await release(); }
}

export { normalizeOptions as normalizeCollectionOptions, normalizeRows as normalizeCollectionRows, requestBuffer as safeRequestBuffer, summarize as summarizeCollectionJob };
