const fs = require('node:fs/promises');
const path = require('node:path');
const { verify, createHash } = require('node:crypto');

const versionParts = (value) => /^\d{1,5}\.\d{1,5}\.\d{1,5}$/.test(value) ? value.split('.').map(Number) : null;
function newer(a, b) { const x = versionParts(a), y = versionParts(b); if (!x || !y) throw new Error('版本号无效'); for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i]; return false; }
function payload(manifest) { return JSON.stringify({ version: manifest.version, releasedAt: manifest.releasedAt, notes: manifest.notes, url: manifest.url, sha256: manifest.sha256, size: manifest.size, kind: manifest.kind }); }
function secureUrl(value) { const url = new URL(value); if (url.protocol !== 'https:' || url.username || url.password || url.hash) throw new Error('更新仅允许 HTTPS 地址'); return url; }
function verifyManifest(manifest, publicKey, feedUrl) {
  if (!versionParts(manifest?.version) || !['installer'].includes(manifest.kind) || !/^[a-f0-9]{64}$/.test(manifest.sha256) || !Number.isSafeInteger(manifest.size) || manifest.size < 1 || manifest.size > 500 * 1024 * 1024 || typeof manifest.notes !== 'string' || manifest.notes.length > 20000 || !Number.isFinite(Date.parse(manifest.releasedAt))) throw new Error('更新清单格式无效');
  if (secureUrl(manifest.url).origin !== secureUrl(feedUrl).origin) throw new Error('更新包必须与受信任发布源同源');
  if (!verify(null, Buffer.from(payload(manifest)), publicKey, Buffer.from(manifest.signature || '', 'base64'))) throw new Error('更新签名无效，已禁止下载或执行');
  return manifest;
}
function createUpdater({ directory, config = {}, currentVersion, fetchImpl = fetch }) {
  let checked = null, busy = false;
  const configured = Boolean(config.feedUrl && config.publicKey);
  async function stored() {
    const entries = await fs.readdir(directory).catch(() => []), packages = [];
    for (const file of entries.filter((name) => /^\d+\.\d+\.\d+\.json$/.test(name))) {
      try { const manifest = JSON.parse(await fs.readFile(path.join(directory, file), 'utf8')); verifyManifest(manifest, config.publicKey, config.feedUrl); packages.push(manifest); } catch { /* Never offer damaged/untrusted rollback files. */ }
    }
    return packages;
  }
  async function info() { return { configured, currentVersion, available: checked, staged: configured ? (await stored()).map(({ version, notes }) => ({ version, notes })) : [], busy }; }
  async function check() {
    if (!configured) throw new Error('未配置受信任更新源和发布者公钥；可继续使用当前版本');
    const response = await fetchImpl(secureUrl(config.feedUrl), { redirect: 'error', signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error('更新服务不可用，可稍后重试');
    const content = await response.text(); if (content.length > 65536) throw new Error('更新清单过大');
    const manifest = verifyManifest(JSON.parse(content), config.publicKey, config.feedUrl);
    checked = newer(manifest.version, currentVersion) ? manifest : null;
    return info();
  }
  async function stage() {
    if (busy || !checked) throw new Error('请先检查更新，或等待当前下载完成');
    busy = true;
    const manifest = checked;
    const temporary = path.join(directory, `${manifest.version}.exe.partial`);
    try {
      await fs.mkdir(directory, { recursive: true });
      verifyManifest(manifest, config.publicKey, config.feedUrl);
      const response = await fetchImpl(secureUrl(manifest.url), { redirect: 'error', signal: AbortSignal.timeout(300000) });
      if (!response.ok || !response.body) throw new Error('更新包下载失败，当前版本未修改');
      const handle = await fs.open(temporary, 'w'); const hash = createHash('sha256'); let size = 0;
      try { for await (const chunk of response.body) { size += chunk.length; if (size > manifest.size) throw new Error('更新包超出签名声明大小'); hash.update(chunk); await handle.writeFile(chunk); } } finally { await handle.close(); }
      if (size !== manifest.size || hash.digest('hex') !== manifest.sha256) throw new Error('更新包散列或大小校验失败，当前版本未修改');
      await fs.rename(temporary, path.join(directory, `${manifest.version}.exe`));
      await fs.writeFile(path.join(directory, `${manifest.version}.json.tmp`), JSON.stringify(manifest));
      await fs.rename(path.join(directory, `${manifest.version}.json.tmp`), path.join(directory, `${manifest.version}.json`));
      return info();
    } finally { busy = false; await fs.rm(temporary, { force: true }).catch(() => {}); }
  }
  async function verifiedInstaller(version) {
    if (!versionParts(version)) throw new Error('版本无效');
    const manifest = (await stored()).find((item) => item.version === version);
    if (!manifest) throw new Error('没有此版本的已签名安装包');
    const file = path.join(directory, `${version}.exe`);
    const data = await fs.readFile(file);
    if (data.length !== manifest.size || createHash('sha256').update(data).digest('hex') !== manifest.sha256) throw new Error('安装包已改变，禁止执行');
    return file;
  }
  async function importPackage(manifestPath, installerPath) {
    if (busy || !configured) throw new Error('更新未配置或正在处理，请稍后重试');
    const stat = await fs.stat(manifestPath); if (!stat.isFile() || stat.size > 65536) throw new Error('签名清单无效');
    const manifest = verifyManifest(JSON.parse(await fs.readFile(manifestPath, 'utf8')), config.publicKey, config.feedUrl);
    const installerStat = await fs.stat(installerPath); if (!installerStat.isFile() || installerStat.size !== manifest.size) throw new Error('安装包大小不匹配');
    const data = await fs.readFile(installerPath);
    if (createHash('sha256').update(data).digest('hex') !== manifest.sha256) throw new Error('安装包散列不匹配，不能作为回退包');
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(path.join(directory, `${manifest.version}.exe`), data);
    await fs.writeFile(path.join(directory, `${manifest.version}.json`), JSON.stringify(manifest));
    return info();
  }
  async function readyToInstall(version) {
    const file = await verifiedInstaller(version);
    if (version !== currentVersion) {
      try { await verifiedInstaller(currentVersion); } catch { throw new Error('尚未保存当前版本的签名回退包，已阻止自动安装。请先导入当前版本签名清单和安装包'); }
    }
    return file;
  }
  return { info, check, stage, verifiedInstaller, importPackage, readyToInstall };
}
module.exports = { payload, newer, verifyManifest, createUpdater };
