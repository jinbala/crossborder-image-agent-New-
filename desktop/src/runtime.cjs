const path = require('node:path');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');

function isInside(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function runtimeDirectories(root) {
  return Object.fromEntries(Object.entries({
    data: 'backend/data', uploads: 'uploads', outputs: 'outputs', backups: 'backups',
    logs: 'logs', cache: '.vision-tmp', models: 'models'
  }).map(([key, value]) => [key, path.resolve(root, value)]));
}

async function prepareExtension(source, dataRoot) {
  const destination = path.join(dataRoot, 'browser-extension', 'temu-deep-collector');
  await fs.mkdir(destination, { recursive: true });
  const root = await fs.realpath(dataRoot), real = await fs.realpath(destination);
  if (!isInside(root, real)) throw new Error('扩展安装目录超出客户端数据目录');
  for (const name of ['manifest.json', 'background.js', 'connection.js', 'popup.js', 'popup.html', 'README.md']) {
    const temporary = path.join(real, `${name}.update-${process.pid}`);
    await fs.copyFile(path.join(source, name), temporary);
    await fs.rename(temporary, path.join(real, name));
  }
  return real;
}

function redact(value, privateRoots = []) {
  let text = String(value ?? '');
  for (const root of privateRoots.filter(Boolean).sort((a, b) => b.length - a.length)) {
    text = text.split(root).join('[本地目录]');
    text = text.split(root.replaceAll('\\', '/')).join('[本地目录]');
  }
  return text
    .replace(/\b(?:Bearer|Basic)\s+[^\s,;"']+/gi, '[凭据已隐藏]')
    .replace(/((?:authorization|cookie|password|api[_-]?key|session[_-]?token|access[_-]?token|refresh[_-]?token)\s*[=:]\s*)[^\r\n,;]+/gi, '$1[已隐藏]')
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[邮箱已隐藏]')
    .replace(/\b1[3-9]\d{9}\b/g, '[手机号已隐藏]')
    .replace(/(?<![A-Za-z0-9])[A-Z]:[\\/][^"'<>\r\n|;]*/gi, '[本地路径]');
}

function createToken() { return crypto.randomBytes(32).toString('hex'); }

function filterLog(text, query = {}) {
  const taskId = String(query?.taskId || '').trim().slice(0, 160);
  const from = query?.from ? Date.parse(query.from) : -Infinity;
  const to = query?.to ? Date.parse(query.to) : Infinity;
  if (Number.isNaN(from) || Number.isNaN(to) || from > to) throw new Error('日志时间范围无效');
  let timestamp = NaN;
  return String(text).split('\n').filter((line) => {
    const match = line.match(/^(\d{4}-\d{2}-\d{2}T\S+)/);
    if (match) timestamp = Date.parse(match[1]);
    return (!taskId || line.includes(taskId)) && (from === -Infinity && to === Infinity || Number.isFinite(timestamp) && timestamp >= from && timestamp <= to);
  }).join('\n');
}

function sanitizeValue(value, roots = []) {
  if (typeof value === 'string') return redact(value, roots);
  if (Array.isArray(value)) return value.map((item) => sanitizeValue(item, roots));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [
    key, /^(?:cookie|authorization|password|api[_-]?key|(?:access|refresh|session)[_-]?token)$/i.test(key) ? '[已隐藏]' : sanitizeValue(item, roots)
  ]));
  return value;
}

function canNavigate(target, origin) {
  try { return new URL(target).origin === origin; } catch { return false; }
}

function protocolRoute(input) {
  try {
    const url = new URL(input);
    const id = url.searchParams.get('jobId');
    if (url.protocol !== 'crossborder-workbench:' || url.hostname !== 'collection' || !/^collect-job-[A-Za-z0-9_-]+$/.test(id || '')) return null;
    return `/workbench/collection?jobId=${encodeURIComponent(id)}`;
  } catch { return null; }
}

module.exports = { isInside, runtimeDirectories, redact, sanitizeValue, createToken, canNavigate, protocolRoute, filterLog, prepareExtension };
