import { createContext, useContext, useEffect, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { api, setSessionCsrf } from '../services/api.js';
import { useLocale } from '../i18n/LocaleProvider.jsx';
import LanguageSwitcher from './LanguageSwitcher.jsx';

const Context = createContext(null);
export const useAccount = () => useContext(Context);
export const roleNames = { admin: '管理员', operator: '运营', designer: '设计', viewer: '只读', support: '技术支持' };

export default function AuthGate({ children }) {
  const { t } = useLocale();
  const [session, setSession] = useState(null);
  const [agreement, setAgreement] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({ username: '', password: '', displayName: '', workspaceName: '', agree: false, remember: false });
  const location = useLocation();
  async function refresh() {
    const next = await api.getSession(); setSessionCsrf(next.csrf); setSession(next); return next;
  }
  useEffect(() => {
    refresh().catch((err) => setError(err.message));
    api.getAgreement().then(setAgreement).catch((err) => setError(err.message));
    const expired = () => { setSessionCsrf(null); setSession((current) => current?.enabled ? { ...current, user: null } : current); };
    window.addEventListener('workbench-session-expired', expired);
    return () => window.removeEventListener('workbench-session-expired', expired);
  }, []);
  async function signIn(event) {
    event.preventDefault(); setBusy(true); setError('');
    try {
      const payload = { ...form, agreementVersion: session.agreementVersion };
      if (!session.initialized) await api.bootstrapAccount(payload);
      const result = await api.login(payload);
      setSessionCsrf(result.csrf);
      setSession({ ...session, ...result, initialized: true });
      setForm({ ...form, password: '' });
    } catch (err) { setError(err.message); await refresh().catch(() => {}); }
    finally { setBusy(false); }
  }
  async function signOut() {
    await api.logout(); setSessionCsrf(null); await refresh();
  }
  const value = { session, user: session?.user, refresh, signOut };
  if (location.pathname === '/userProtocol') return <div className="mx-auto max-w-3xl space-y-5 p-8"><LanguageSwitcher /><p className="text-sm text-slate-600">{t('协议原文为中文，切换界面语言不会改变已同意的协议版本或内容。')}</p><h1 className="text-2xl font-semibold">{agreement?.title || t("用户协议与隐私说明")}</h1><p className="text-sm text-slate-500">{t("版本：")}{agreement?.version}</p>{agreement?.sections.map((text, index) => <p key={index} className="leading-7">{text}</p>)}<Link className="btn-secondary" to="/">{t("返回工作台")}</Link></div>;
  if (!session) return <div className="mx-auto max-w-lg p-10"><LanguageSwitcher /><p>{error || t("正在连接工作空间…")}</p>{error && <button className="btn-secondary mt-4" onClick={() => refresh().catch((err) => setError(err.message))}>{t("重新连接")}</button>}</div>;
  if (session.enabled && !session.user) return <main className="grid min-h-screen place-items-center px-5 py-10"><form onSubmit={signIn} className="w-full max-w-md space-y-5 rounded-xl border border-slate-200 bg-white p-8 shadow-sm"><LanguageSwitcher /><div><h1 className="text-2xl font-semibold text-ink">{session.initialized ? t("登录跨境图片工作台") : t("创建你的运营工作空间")}</h1><p className="mt-2 text-sm leading-6 text-slate-500">{session.initialized ? t("登录后继续你的任务、素材与图片工作流。") : t("首次使用，请设置管理员账号。")}</p></div>{error && <p role="alert" className="rounded bg-red-50 p-3 text-sm text-red-700">{error}</p>}
    {!session.initialized && <label className="block text-sm">{t("工作空间名称")}<input autoComplete="organization" value={form.workspaceName} onChange={(event) => setForm({ ...form, workspaceName: event.target.value })} className="focus-ring mt-1 w-full rounded border p-2" /></label>}
    <label className="block text-sm">{t("账号")}<input required autoComplete="username" value={form.username} onChange={(event) => setForm({ ...form, username: event.target.value })} className="focus-ring mt-1 w-full rounded border p-2" /></label>
    <label className="block text-sm">{t("密码")}<input required type="password" minLength={session.initialized ? 1 : 12} maxLength={128} autoComplete={session.initialized ? 'current-password' : 'new-password'} value={form.password} onChange={(event) => setForm({ ...form, password: event.target.value })} className="focus-ring mt-1 w-full rounded border p-2" />{!session.initialized && <span className="mt-1 block text-xs text-slate-500">{t("至少 12 个字符")}</span>}</label>
    <label className="flex items-start gap-2 text-sm"><input required type="checkbox" checked={form.agree} onChange={(event) => setForm({ ...form, agree: event.target.checked })} /><span>{t("我已阅读并同意") + " "}<Link className="text-mint underline" to="/userProtocol" target="_blank">{t("用户协议和隐私说明")}</Link></span></label>
    <label className="flex items-center gap-2 text-sm text-slate-600"><input type="checkbox" checked={form.remember} onChange={(event) => setForm({ ...form, remember: event.target.checked })} />{t("保持登录 7 天")}</label><button disabled={busy} className="btn-primary w-full">{busy ? t("正在连接…") : session.initialized ? t("登录") : t("创建并登录")}</button>
  </form></main>;
  return <Context.Provider value={value}>{children}</Context.Provider>;
}
