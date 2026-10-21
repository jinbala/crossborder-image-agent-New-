const CONNECTION_KEY = 'workbenchConnection';
function problem(code, message) { return Object.assign(new Error(message), { code }); }
export function normalizeServiceUrl(input) {
  if (!String(input || '').trim()) throw new Error('请填写客户端显示的本机服务地址（含动态端口），不会默认连接 4000');
  let url;
  try { url = new URL(String(input).trim()); } catch { throw new Error('本机服务地址格式不正确，请复制客户端显示的 http://127.0.0.1:端口'); }
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.username || url.password || !['', '/'].includes(url.pathname) || url.search || url.hash) throw new Error('仅允许 http://127.0.0.1:端口 的本机服务地址');
  return url.origin;
}
export async function getConnection() {
  const stored = (await chrome.storage.session.get(CONNECTION_KEY))[CONNECTION_KEY];
  return stored || { serviceUrl: '', paired: false, mode: 'unconfigured' };
}
async function localFetch(origin, route, options = {}) {
  try { return await fetch(origin + '/api' + route, { ...options, credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(options.timeout || 60000) }); }
  catch (error) {
    const timedOut = ['TimeoutError', 'AbortError'].includes(error?.name);
    throw problem(timedOut ? 'LOCAL_SERVICE_TIMEOUT' : 'LOCAL_SERVICE_UNREACHABLE',
      (timedOut ? '本机服务响应超时：' : '无法连接本机服务：') + origin + '。请核对客户端“客户端与恢复”显示的地址、服务状态和浏览器本地网络权限，重新配对后再发送。采集清单已保留，无需重采。');
  }
}
async function invalidate(connection) {
  const { accessToken, ...safe } = connection;
  await chrome.storage.session.set({ [CONNECTION_KEY]: { ...safe, paired: false } });
}
async function requireConnection() {
  const connection = await getConnection();
  if (!connection.serviceUrl || !['desktop', 'standalone'].includes(connection.mode)) throw problem('CLIENT_NOT_PAIRED', '尚未连接本地工作台。请在“客户端连接”填写客户端显示的动态端口地址和配对码，再次发送即可；不要清空清单。');
  if (connection.mode === 'desktop' && (!connection.paired || !connection.accessToken || !Number.isFinite(Date.parse(connection.expiresAt)) || Date.parse(connection.expiresAt) <= Date.now())) {
    await invalidate(connection); throw problem('CLIENT_PAIRING_EXPIRED', '客户端配对已失效，请重新生成配对码并连接；采集清单保留。');
  }
  return { connection, origin: normalizeServiceUrl(connection.serviceUrl) };
}
export async function pairClient(serviceUrl, code) {
  const origin = normalizeServiceUrl(serviceUrl);
  const response = await localFetch(origin, '/desktop/pair', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code }), timeout: 10000 });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw problem('PAIRING_REJECTED', result.error || '客户端配对失败，请生成新配对码');
  if (typeof result.accessToken !== 'string' || !result.accessToken || !Number.isFinite(Date.parse(result.expiresAt))) throw problem('INVALID_PAIRING_RESPONSE', '该端口返回无效配对信息，未保存凭据，请核对客户端地址');
  await chrome.storage.session.set({ [CONNECTION_KEY]: { serviceUrl: origin, accessToken: result.accessToken, expiresAt: result.expiresAt, paired: true, mode: 'desktop' } });
  return publicConnection();
}
export async function backendFetch(route, options = {}) {
  const { connection, origin } = await requireConnection();
  const response = await localFetch(origin, route, { ...options, headers: { ...(connection.accessToken ? { 'x-workbench-token': connection.accessToken } : {}), ...options.headers } });
  if (response.status === 401 || response.status === 403) {
    await invalidate(connection); throw problem('CLIENT_PAIRING_EXPIRED', '客户端连接已过期或被拒绝，请重新输入配对码；不会自动创建重复任务。');
  }
  return response;
}
async function health(origin) {
  const response = await localFetch(origin, '/health', { timeout: 5000 });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.service !== 'crossborder-image-agent-backend' || body.ok !== true) throw problem('WRONG_LOCAL_SERVICE', '该端口不是图片工作台服务，请填写客户端“客户端与恢复”显示的地址');
  return body;
}
export async function checkClientConnection() {
  const { origin } = await requireConnection(); const status = await health(origin);
  return { ...(await publicConnection()), reachable: true, checkedAt: new Date().toISOString(), authorizationVerified: false,
    capabilities: { collectionRequestIdempotency: status.capabilities?.collectionRequestIdempotency === 1 ? 1 : 0,
      collectionCreationEpoch: /^[a-f0-9-]{36}$/i.test(status.capabilities?.collectionCreationEpoch || '') ? status.capabilities.collectionCreationEpoch : null } };
}
export async function useDevelopmentClient(serviceUrl) {
  const origin = normalizeServiceUrl(serviceUrl); await health(origin);
  await chrome.storage.session.set({ [CONNECTION_KEY]: { serviceUrl: origin, mode: 'standalone', paired: false } });
  return publicConnection();
}
export async function publicConnection() {
  const { accessToken, ...connection } = await getConnection();
  return { ...connection, paired: Boolean(connection.paired && accessToken && Date.parse(connection.expiresAt) > Date.now()) };
}
