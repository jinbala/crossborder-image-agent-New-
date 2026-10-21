import { createHash, randomBytes } from 'node:crypto';

const extensionOrigin = /^chrome-extension:\/\/[a-p]{32}$/;
const allowedPaths = /^\/api\/workbench\/collection-jobs(?:\/rows|\/collect-job-[A-Za-z0-9_-]+(?:\/browser-images)?)$/;
export function createExtensionPairing({ now = Date.now } = {}) {
  const codes = new Map();
  const sessions = new Map();
  const attempts = new Map();
  const hash = (value) => createHash('sha256').update(String(value || '')).digest('hex');
  const clean = () => {
    for (const map of [codes, sessions, attempts]) for (const [key, value] of map) if (value.expiresAt <= now()) map.delete(key);
  };
  return {
    issueCode() {
      clean();
      // Only the most recent visible code can be redeemed.
      codes.clear();
      const code = randomBytes(6).toString('hex').toUpperCase();
      const expiresAt = now() + 5 * 60_000;
      codes.set(hash(code), { expiresAt });
      return { code, expiresAt: new Date(expiresAt).toISOString() };
    },
    redeem(code, origin) {
      clean();
      if (!extensionOrigin.test(origin || '')) throw Object.assign(new Error('仅允许浏览器扩展配对'), { statusCode: 403 });
      const attempt = attempts.get(origin) || { count: 0, expiresAt: now() + 60_000 };
      attempt.count += 1;
      attempts.set(origin, attempt);
      if (attempt.count > 10) throw Object.assign(new Error('配对尝试过多，请一分钟后重试'), { statusCode: 429 });
      const key = hash(String(code || '').trim().toUpperCase());
      if (!codes.has(key)) throw Object.assign(new Error('配对码无效或已过期，请在客户端重新生成'), { statusCode: 401 });
      codes.delete(key);
      const accessToken = randomBytes(32).toString('hex');
      const expiresAt = now() + 8 * 60 * 60_000;
      sessions.set(hash(accessToken), { origin, expiresAt });
      return { accessToken, expiresAt: new Date(expiresAt).toISOString(), scope: 'collection-only' };
    },
    authorize(token, origin, requestPath, method) {
      clean();
      const session = sessions.get(hash(token));
      if (!session || session.origin !== origin || !allowedPaths.test(requestPath)) return false;
      return (method === 'POST' && /\/(?:rows|browser-images)$/.test(requestPath)) || (method === 'GET' && !/\/(?:rows|browser-images)$/.test(requestPath));
    },
    preflight(origin, requestPath) {
      return extensionOrigin.test(origin || '') && (requestPath === '/api/desktop/pair' || allowedPaths.test(requestPath));
    }
  };
}

export const extensionPairing = createExtensionPairing();
