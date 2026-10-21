import { timingSafeEqual } from 'node:crypto';
import { extensionPairing } from '../services/extensionPairingService.js';

function equals(left, right) {
  const a = Buffer.from(String(left || ''));
  const b = Buffer.from(String(right || ''));
  return a.length === b.length && timingSafeEqual(a, b);
}

export function localAccess(req, res, next) {
  const secret = process.env.LOCAL_API_TOKEN;
  if (!secret) return next(); // Standalone development mode retains its existing workflow.
  if (req.path === '/api/health' && req.method === 'GET') return next();
  const host = String(req.headers.host || '');
  if (!/^127\.0\.0\.1:\d+$/.test(host)) return res.status(403).json({ error: '无效的本地服务地址' });
  const origin = req.headers.origin;
  if (extensionPairing.preflight(origin, req.path)) {
    // Scoped failures must be readable by the extension; CORS itself grants no access.
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    if (req.method === 'OPTIONS') {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Workbench-Token');
      return res.sendStatus(204);
    }
    if ((req.path === '/api/desktop/pair' && req.method === 'POST') || extensionPairing.authorize(req.headers['x-workbench-token'], origin, req.path, req.method)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      return next();
    }
    return res.status(401).json({ error: '扩展配对已失效，请在客户端重新生成配对码并连接' });
  }
  if (origin && origin !== `http://${host}`) return res.status(403).json({ error: '请求来源未授权' });
  const cookies = String(req.headers.cookie || '').split(';').map((part) => part.trim());
  const cookie = cookies.find((part) => part.startsWith('crossborder_local='))?.slice('crossborder_local='.length);
  if (!equals(req.headers['x-local-token'] || cookie, secret)) return res.status(401).json({ error: '本地会话已失效，请重新打开客户端' });
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; connect-src 'self'; font-src 'self' data:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'");
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  next();
}
