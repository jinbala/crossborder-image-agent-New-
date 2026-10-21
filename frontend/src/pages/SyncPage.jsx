import { useLocale } from '../i18n/LocaleProvider.jsx';
import { useEffect, useState } from 'react';
import Section from '../components/Section.jsx';
import { useAccount } from '../components/AuthGate.jsx';
import { ErrorBox } from './WorkspacePages.jsx';
import { api } from '../services/api.js';

export default function SyncPage() {
  const { t, dateTime } = useLocale();
  const account = useAccount();
  const desktop = window.desktop;
  const [info, setInfo] = useState(null);
  const [devices, setDevices] = useState([]);
  const [pair, setPair] = useState(null);
  const [form, setForm] = useState({ serviceUrl: '', code: '', name: 'Windows 客户端' });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function load() { if (desktop) setInfo(await desktop.cloudInfo()); else setDevices((await api.listDevices()).records); }
  useEffect(() => { load().catch((err) => setError(err.message)); }, []);
  async function run(fn) { setBusy(true); setError(''); try { const result = await fn(); if (desktop) setInfo(result); else await load(); } catch (err) { setError(err.message); } finally { setBusy(false); } }
  return <div className="space-y-5"><h1 className="text-2xl font-semibold">{t("设备绑定与受控同步")}</h1><ErrorBox error={error} />
    <p className="rounded bg-teal-50 p-4 text-sm leading-7">{t("仅同步任务 ID、状态、SKU、标题、数量和时间。不传原图、本地路径、Cookie 或 Provider 密钥。离线修改保留在本地队列；版本冲突必须人工选择。当前为单工作空间团队共享摘要。")}</p>
    {desktop ? <>
      <Section title={t("Web 工作空间连接")}>{info?.connected ? <div className="space-y-3"><p>{info.serviceUrl} · {info.deviceId}</p><p className="text-sm text-slate-500">{t("上次同步：")}{info.lastSync || t("尚未同步")}{" " + t("· 待发送") + " "}{info.pendingCount}{" " + t("条 · 冲突") + " "}{info.conflicts.length}{" " + t("条")}</p><div className="flex gap-3"><button disabled={busy} className="btn-primary" onClick={() => run(() => desktop.cloudSync())}>{busy ? t("处理中…") : t("立即同步")}</button><button disabled={busy} className="btn-secondary" onClick={() => { if (window.confirm(t("仅移除本机加密连接凭据，不删除 Web 摘要。确认断开？"))) run(() => desktop.cloudDisconnect()); }}>{t("断开连接")}</button></div></div> : <form className="space-y-3" onSubmit={(event) => { event.preventDefault(); if (window.confirm(t("确认将任务摘要同步到填写的工作空间？图片和凭据不会上传。"))) run(() => desktop.cloudConnect(form)); }}>{[['serviceUrl', '工作空间地址（HTTPS）'], ['code', 'Web 页面生成的 5 分钟配对码'], ['name', '设备名称']].map(([key, title]) => <label className="block text-sm" key={key}>{t(title)}<input required className="focus-ring mt-1 w-full rounded border p-2" value={form[key]} onChange={(event) => setForm({ ...form, [key]: event.target.value })} /></label>)}<button disabled={busy || info?.secureStorageAvailable === false} className="btn-primary">{t("绑定设备")}</button>{info?.secureStorageAvailable === false && <p className="text-red-700">{t("Windows 安全存储不可用，已禁止保存凭据。")}</p>}</form>}</Section>
      {info?.conflicts?.length > 0 && <Section title={t("版本冲突（保留两份，禁止静默覆盖）")}><div className="space-y-4">{info.conflicts.map((item) => <div key={item.id} className="rounded border p-3"><p className="font-medium">{item.id}</p><div className="my-3 grid gap-3 md:grid-cols-2"><pre className="overflow-auto rounded bg-slate-50 p-3 text-xs">{t("本机：")}{JSON.stringify(item.local, null, 2)}</pre><pre className="overflow-auto rounded bg-slate-50 p-3 text-xs">Web：{JSON.stringify(item.remote, null, 2)}</pre></div><div className="flex gap-3">{[['local', '采用本机并重新同步'], ['remote', '采用 Web 摘要']].map(([choice, label]) => <button disabled={busy} key={choice} className="btn-secondary" onClick={() => { if (window.confirm(t("确认{value0}？原业务任务和图片不会修改。", { value0: (t(label)) }))) run(() => desktop.cloudResolve(item.id, choice)); }}>{t(label)}</button>)}</div></div>)}</div></Section>}
      <Section title={t("Web 摘要镜像")}><div className="space-y-2">{info?.mirror?.slice(0, 100).map((item) => <div key={item.id} className="rounded border p-3 text-sm">{item.data.title} · {item.data.state} · v{item.version}</div>)}{!info?.mirror?.length && <p className="text-sm text-slate-500">{t("绑定后点击同步查看摘要。")}</p>}</div></Section>
    </> : <>
      <Section title={t("绑定新客户端")}>{account.user.role !== 'viewer' && <button disabled={busy} className="btn-primary" onClick={() => run(async () => { setPair(await api.createDeviceCode()); })}>{t("生成一次性配对码")}</button>}{pair && <div className="mt-4 rounded border p-4"><p className="break-all font-mono text-2xl">{pair.code}</p><p className="mt-2 text-sm">{t("到期：")}{dateTime(pair.expiresAt)}{t("。请在客户端“设备同步”页面填写当前网站地址与此码。")}</p></div>}</Section>
      <Section title={t("已绑定设备")}><div className="space-y-3">{devices.map((item) => <div className="flex flex-wrap items-center justify-between gap-3 rounded border p-3" key={item.id}><div><p>{item.name} · {item.active ? t("已授权") : t("已撤销")}</p><p className="text-xs text-slate-500">{t("最后活动：")}{dateTime(item.last_seen)}</p></div>{Boolean(item.active) && <button className="btn-secondary" disabled={busy} onClick={() => { if (window.confirm(t("撤销后设备立即失去同步权限。确认？"))) run(() => api.revokeDevice(item.id)); }}>{t("撤销授权")}</button>}</div>)}</div></Section>
    </>}
  </div>;
}
