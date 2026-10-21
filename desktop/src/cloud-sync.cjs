const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

function cloudOrigin(value) {
  const url = new URL(String(value));
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/' || !(url.protocol === 'https:' || (url.protocol === 'http:' && url.hostname === '127.0.0.1'))) throw new Error('请输入 HTTPS 工作空间地址；本机测试可使用 http://127.0.0.1:端口');
  return url.origin;
}
const hash = (value) => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const operationId = () => crypto.randomBytes(16).toString('hex');

function createCloudSync({ directory, secureStorage, exportLocal, fetchImpl = fetch }) {
  const credentialPath = path.join(directory, 'cloud-session.enc');
  const outboxPath = path.join(directory, 'sync-outbox.json');
  let lock = null;
  async function readState() {
    try { return JSON.parse(await fs.readFile(outboxPath, 'utf8')); }
    catch (error) {
      if (error.code !== 'ENOENT') {
        try { const restored = JSON.parse(await fs.readFile(`${outboxPath}.backup`, 'utf8')); await fs.rename(outboxPath, `${outboxPath}.corrupt-${Date.now()}`); await saveState(restored); return restored; }
        catch { throw new Error('同步队列与备份无法读取，请保留文件并联系支持'); }
      }
      return { known: {}, pending: [], conflicts: [], mirror: [], lastSync: null };
    }
  }
  async function saveState(state) {
    await fs.mkdir(directory, { recursive: true });
    await fs.copyFile(outboxPath, `${outboxPath}.backup`).catch(() => {});
    await fs.writeFile(`${outboxPath}.tmp`, JSON.stringify(state));
    await fs.rename(`${outboxPath}.tmp`, outboxPath);
  }
  async function credentials() {
    if (!secureStorage.isEncryptionAvailable()) throw new Error('系统安全存储不可用，无法读取工作空间连接');
    try { return JSON.parse(secureStorage.decryptString(await fs.readFile(credentialPath))); }
    catch (error) { if (error.code === 'ENOENT') return null; throw new Error('工作空间凭据无法解密，请重新绑定'); }
  }
  async function request(origin, endpoint, body, token) {
    const response = await fetchImpl(`${cloudOrigin(origin)}/api/platform${endpoint}`, { method: 'POST', redirect: 'error', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body), signal: AbortSignal.timeout(20000) });
    const text = await response.text();
    if (text.length > 4 * 1024 * 1024) throw new Error('同步响应超出限制');
    let result; try { result = JSON.parse(text); } catch { throw new Error('工作空间没有返回有效的同步响应'); }
    if (!response.ok) throw new Error(result.error || `同步失败（${response.status}）`);
    return result;
  }
  async function info() {
    const state = await readState();
    const available = secureStorage.isEncryptionAvailable();
    const credential = available ? await credentials() : null;
    return { connected: Boolean(credential), secureStorageAvailable: available, serviceUrl: credential?.origin || null, deviceId: credential?.deviceId || null,
      pendingCount: state.pending.length, conflicts: state.conflicts, mirror: state.mirror, lastSync: state.lastSync, metadataOnly: true };
  }
  async function connect(input) {
    if (lock) throw new Error('同步正在运行，请稍后绑定');
    if (!secureStorage.isEncryptionAvailable()) throw new Error('系统安全存储不可用，不能保存设备凭据');
    const origin = cloudOrigin(input.serviceUrl);
    const result = await request(origin, '/devices/redeem', { code: input.code, name: input.name || 'Windows 客户端' });
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(`${credentialPath}.tmp`, secureStorage.encryptString(JSON.stringify({ origin, deviceId: result.deviceId, token: result.deviceToken })));
    await fs.rename(`${credentialPath}.tmp`, credentialPath);
    await saveState({ known: {}, pending: [], conflicts: [], mirror: [], lastSync: null });
    return info();
  }
  async function synchronize() {
    if (lock) return lock;
    lock = (async () => {
      const credential = await credentials();
      if (!credential) throw new Error('请先绑定 Web 工作空间');
      const state = await readState();
      const local = await exportLocal();
      for (const data of local.records) {
        const fingerprint = hash(data);
        if (state.known[data.id]?.fingerprint === fingerprint || state.pending.some((item) => item.data.id === data.id) || state.conflicts.some((item) => item.id === data.id)) continue;
        state.pending.push({ operationId: operationId(), baseVersion: state.known[data.id]?.version || 0, data, fingerprint });
      }
      await saveState(state); // Persist before any network operation.
      do {
        const batch = state.pending.slice(0, 100);
        const result = await request(credential.origin, '/sync', { operations: batch.map(({ fingerprint, ...operation }) => operation) }, credential.token);
        if (!Array.isArray(result.results) || !Array.isArray(result.records) || batch.some((operation) => !result.results.some((receipt) => receipt.operationId === operation.operationId && ['applied', 'conflict'].includes(receipt.status)))) throw new Error('同步回执不完整，队列已保留，可稍后重试');
        for (const receipt of result.results) {
          const operation = batch.find((item) => item.operationId === receipt.operationId);
          if (!operation) continue;
          if (receipt.status === 'conflict') state.conflicts.push({ ...receipt, fingerprint: operation.fingerprint });
          else state.known[receipt.id] = { fingerprint: operation.fingerprint, version: receipt.version };
          state.pending = state.pending.filter((item) => item.operationId !== receipt.operationId);
        }
        state.mirror = result.records;
        state.lastSync = result.synchronizedAt;
        await saveState(state);
        if (!batch.length) break;
      } while (state.pending.length);
      return info();
    })().finally(() => { lock = null; });
    return lock;
  }
  async function resolve(id, choice) {
    if (lock) throw new Error('同步正在运行，请稍后处理冲突');
    const state = await readState();
    const conflict = state.conflicts.find((item) => item.id === id);
    if (!conflict || !['local', 'remote'].includes(choice)) throw new Error('无效的冲突处理选择');
    if (choice === 'local') state.pending.push({ operationId: operationId(), baseVersion: conflict.remote.version, data: conflict.local, fingerprint: conflict.fingerprint });
    else state.known[id] = { fingerprint: conflict.fingerprint, version: conflict.remote.version };
    state.conflicts = state.conflicts.filter((item) => item.id !== id);
    await saveState(state);
    return info();
  }
  async function disconnect() {
    if (lock) throw new Error('同步正在运行，请稍后断开');
    await fs.rm(credentialPath, { force: true });
    return info();
  }
  return { info, connect, synchronize, resolve, disconnect };
}
module.exports = { cloudOrigin, createCloudSync };
