import { useLocale } from '../i18n/LocaleProvider.jsx';
import { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { api } from '../services/api.js';
import Section from '../components/Section.jsx';
import { ErrorBox, Pager } from './WorkspacePages.jsx';

export default function CommerceSandboxPage() {
  const { t } = useLocale();
  const { id } = useParams();
  const [job, setJob] = useState(null), [error, setError] = useState(''), [busy, setBusy] = useState(false), [page, setPage] = useState(1);
  async function load() { try { setJob(await api.getCommerceSandbox(id)); setError(''); } catch (err) { setError(err.message); } }
  useEffect(() => { load(); }, [id]);
  useEffect(() => { if (!busy) return; const timer = setInterval(load, 1000); return () => clearInterval(timer); }, [busy, id]);
  async function run(retryFailed) {
    if (!window.confirm(t("已核对下面的前后差异？确认仅执行本地模拟；已完成项不会重复提交。"))) return;
    setBusy(true);
    try { setJob(await api.runCommerceSandbox(id, { confirm: true, approvalHash: job.approvalHash, retryFailed })); } catch (err) { setError(err.message); } finally { setBusy(false); }
  }
  async function stop(action) {
    if (!window.confirm(t("确认{value0}？当前条目提交完成后停止。", { value0: (t(action === 'cancel' ? '取消' : '暂停')) }))) return;
    try { await api.stopCommerceSandbox(id, action); await load(); } catch (err) { setError(err.message); }
  }
  function download() {
    const url = URL.createObjectURL(new Blob([JSON.stringify(job, null, 2)], { type: 'application/json' }));
    const anchor = document.createElement('a'); anchor.href = url; anchor.download = `${job.id}-simulated.json`; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return <div className="space-y-5"><h1 className="text-2xl font-semibold">{t("本地模拟沙箱")}</h1><ErrorBox error={error} /><p className="rounded border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">{t("这是本机模拟商店，不是 Temu 官方沙箱。零网络请求、零真实商品发布、零线上改价。官方适配须取得授权后另行验收。")}</p><Link className="text-mint underline" to="/workbench/commerce">{t("返回刊登与调价预览")}</Link>
    {job && <><Section title={job.name}><p className="mb-3 text-sm">{t("状态：")}{job.state} · {job.kind === 'listing' ? t("模拟刊登") : t("模拟调价")} · {job.currency || ''}</p><p className="mb-3 break-all text-xs">{t("审批散列：")}{job.approvalHash}</p><p className="mb-4 text-sm">{t("成功") + " "}{job.summary.successCount}{" " + t("· 失败") + " "}{job.summary.failedCount}{" " + t("· 跳过") + " "}{job.summary.skippedCount}{" " + t("· 待处理") + " "}{job.summary.pendingCount}</p><div className="flex flex-wrap gap-3"><button disabled={busy} className="btn-primary" onClick={() => run(false)}>{t("批准并继续模拟")}</button><button disabled={busy || !job.summary.failedCount} className="btn-secondary" onClick={() => run(true)}>{t("仅重试失败项")}</button><button className="btn-secondary" onClick={() => stop('pause')}>{t("暂停")}</button><button className="btn-secondary" onClick={() => stop('cancel')}>{t("取消")}</button><button className="btn-secondary" onClick={load}>{t("刷新")}</button><button className="btn-secondary" onClick={download}>{t("导出模拟结果")}</button></div></Section>
      <Section title={t("逐项差异与幂等回执")}><div className="space-y-3">{job.items.slice((page - 1) * 30, page * 30).map((item) => <div key={item.id} className="rounded border p-3 text-sm"><p>{item.sku} · {item.status}{" " + t("· 尝试") + " "}{item.attempt}{" " + t("次")}</p><pre className="my-2 overflow-auto text-xs">{JSON.stringify({ before: item.before, after: item.after }, null, 2)}</pre><p className="break-all text-xs text-slate-500">{item.reason || item.receiptId || t("尚未执行")}</p></div>)}</div><Pager pagination={{ page, total: job.items.length, totalPages: Math.max(1, Math.ceil(job.items.length / 30)) }} onPage={setPage} /></Section></>}
  </div>;
}
