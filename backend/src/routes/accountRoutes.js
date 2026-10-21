import express from 'express';
import { rateLimit } from '../middleware/rateLimit.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { authEnabled, initialized, localActor, AGREEMENT_VERSION, createMember, login, getSession, logout, changePassword, fail } from '../services/accountService.js';
import { sessionToken, validOrigin, csrfGuard } from '../middleware/webAccess.js';

const router = express.Router();
const secure = () => process.env.WEB_PUBLIC_ORIGIN?.startsWith('https://') === true;
const cookieOptions = () => ({ httpOnly: true, sameSite: 'lax', secure: secure(), path: '/' });
router.get('/agreement', (_req, res) => res.json({ version: AGREEMENT_VERSION, title: '用户协议和隐私说明', sections: [
  '工作空间保存账号、任务、素材引用和操作记录。密码仅保存加盐散列，登录会话可随时退出。',
  '本地处理默认保留在设备。仅在明确选择远程服务、同步或上传时传输相应数据；付费调用执行前需要确认。',
  '网页采集在用户授权范围内运行，遇到登录失效或验证码暂停并交由人工处理。',
  '管理员负责成员授权和数据备份。归档可恢复，清理与覆盖操作需要先检查影响范围。'
] }));
router.get('/session', (req, res) => {
  if (!authEnabled()) return res.json({ enabled: false, initialized: initialized(), user: localActor(), csrf: null, agreementVersion: AGREEMENT_VERSION });
  const session = getSession(sessionToken(req));
  res.setHeader('Cache-Control', 'no-store');
  res.json({ enabled: true, initialized: initialized(), agreementVersion: AGREEMENT_VERSION, ...session, user: session?.user || null });
});
router.post('/bootstrap', asyncHandler(async (req, res) => {
  if (!validOrigin(req)) throw fail('请求来源无效', 403);
  const host = String(req.headers.host || '').split(':')[0];
  if (!['127.0.0.1', 'localhost'].includes(host) || !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress)) throw fail('请先在服务器本机初始化管理员', 403);
  const user = await createMember(req.body || {}, null, true);
  res.status(201).json({ user });
}));
router.post('/login', rateLimit({ limit: 100, windowMs: 15 * 60000, name: '登录' }), asyncHandler(async (req, res) => {
  if (!validOrigin(req)) throw fail('请求来源无效', 403);
  const result = await login(req.body || {}, req.socket.remoteAddress);
  res.cookie('crossborder_session', result.token, { ...cookieOptions(), maxAge: result.expiresAt - Date.now() });
  const { token, ...session } = result;
  res.setHeader('Cache-Control', 'no-store'); res.json(session);
}));
router.post('/logout', asyncHandler(async (req, res) => {
  req.session = getSession(sessionToken(req));
  if (req.session) csrfGuard(req);
  logout(sessionToken(req));
  res.clearCookie('crossborder_session', cookieOptions());
  res.json({ ok: true });
}));
router.post('/password', asyncHandler(async (req, res) => {
  req.session = getSession(sessionToken(req));
  if (!req.session) throw fail('请先登录', 401);
  csrfGuard(req);
  await changePassword(req.session.user.id, req.body?.oldPassword, req.body?.newPassword);
  res.clearCookie('crossborder_session', cookieOptions()); res.json({ ok: true, loginRequired: true });
}));
export default router;
