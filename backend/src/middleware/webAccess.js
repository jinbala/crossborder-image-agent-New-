import { authEnabled, getSession, localActor, fail } from '../services/accountService.js';
import { audit } from '../services/platformStore.js';
import { withActor } from '../services/ownershipService.js';

export function sessionToken(req) {
  return String(req.headers.cookie || '').split(';').map((part) => part.trim()).find((part) => part.startsWith('crossborder_session='))?.slice('crossborder_session='.length) || '';
}
export function validOrigin(req) {
  if (!req.headers.origin) return true;
  const allowed = process.env.WEB_PUBLIC_ORIGIN ? [process.env.WEB_PUBLIC_ORIGIN] : [`http://${req.headers.host}`, `https://${req.headers.host}`];
  if (process.env.NODE_ENV !== 'production') allowed.push('http://127.0.0.1:5173', 'http://localhost:5173');
  return allowed.includes(req.headers.origin);
}
export function csrfGuard(req) {
  if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && (!validOrigin(req) || !req.session?.csrf || req.headers['x-csrf-token'] !== req.session.csrf)) throw fail('会话校验失败，请刷新页面后重试', 403);
}
export function canAccess(role, method, route) {
  if (role === 'admin') return true;
  if (role === 'support') return ['GET', 'HEAD'].includes(method) && ['/api/platform/support/status', '/api/platform/audit', '/api/platform/help', '/api/platform/records/notice'].includes(route);
  if (['GET', 'HEAD'].includes(method) && ['/api/settings/effective', '/api/settings/providers/status', '/api/health/provider-config'].includes(route)) return true;
  if (['GET', 'HEAD'].includes(method)) return !/^\/api\/(?:storage|snapshots|cleanup|stress-test|settings|import-scan|health)(?:\/|$)/.test(route);
  if (role === 'viewer') return false;
  if (/^\/api\/(?:storage|snapshots|cleanup|stress-test|settings|import-scan|desktop)(?:\/|$)/.test(route) || route === '/api/batches/import-folder') return false;
  if (role === 'operator') return true;
  if (role === 'designer' && /^\/api\/final-acceptance\/workspace(?:\/(?:validate|reset))?$/.test(route)) return true;
  if (role === 'designer' && /^\/api\/workbench\/image-packs\/pack-[A-Za-z0-9_-]+\/(?:resume|control)$/.test(route)) return true;
  return /^\/api\/(?:tasks|generate|matting|workflow-templates)(?:\/|$)/.test(route) || /^\/api\/workbench\/(?:sku-packs|image-packs|sku-metadata-imports)$/.test(route) || /^\/api\/workbench\/sku-packs\/[A-Za-z0-9_-]+\/(?:resume|repair-manifest)$/.test(route) || /^\/api\/workbench\/collection-jobs\/collect-job-[A-Za-z0-9_-]+\/sku-pack$/.test(route);
}
export function webAccess(req, res, next) {
  try {
    if (!/^\/(?:api|uploads|outputs)(?:\/|$)/.test(req.path) || req.path === '/api/health' || req.path.startsWith('/api/auth/')) return next();
    if (req.path === '/api/platform/sync' || req.path === '/api/platform/devices/redeem' || /^\/api\/platform\/erp\/v1\/(tasks|products)$/.test(req.path)) return next();
    if (!authEnabled()) req.actor = localActor();
    else {
      req.session = getSession(sessionToken(req));
      if (!req.session) throw fail('请先登录', 401);
      req.actor = req.session.user;
      csrfGuard(req);
      if ((req.actor.role === 'support' || !req.path.startsWith('/api/platform/')) && !canAccess(req.actor.role, req.method, req.path)) throw fail('当前角色没有此操作权限', 403);
    }
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) res.on('finish', () => {
      audit(req.actor, `${req.method} ${req.path.replace(/\/[^/]{80,}/g, '/[id]')}`, req.params?.id || '', res.statusCode);
    });
    withActor(req.actor, () => next());
  } catch (error) { next(error); }
}
export function requireRole(...roles) {
  return (req, _res, next) => roles.includes(req.actor?.role) ? next() : next(fail('当前角色没有此操作权限', 403));
}
