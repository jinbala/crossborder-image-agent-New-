import { useLocale } from '../i18n/LocaleProvider.jsx';
import { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import Section from '../components/Section.jsx';
import { ErrorBox, Pager } from './WorkspacePages.jsx';
import { api, ASSET_BASE } from '../services/api.js';
import { useAccount } from '../components/AuthGate.jsx';
export default function JobResultPage() {
  const { t, dateTime } = useLocale();
  const { id } = useParams();
  const role = useAccount()?.user?.role;
  const canOperate = ['admin', 'operator'].includes(role), canMakeImages = canOperate || role === 'designer';
  const [data, setData] = useState(null), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  async function load(page = 1) { try { setData(await api.getWorkbenchJobDetail(id, page)); setError(''); } catch (err) { setError(err.message); } }
  useEffect(() => { load(); }, [id]);
  async function resume(retryFailed) {
    const remote = data.options?.matteImages && ['external', 'image2'].includes(data.options.mattingProvider);
    if (!window.confirm(t("确认{value0}？已完成的 SKU 不重复处理；中断 SKU 会重新制作，保留原图。{value1}", { value0: (t(retryFailed ? '重试失败 SKU' : '从 SKU 恢复点继续')), value1: (remote ? t('外部抠图会上传图片，可能再次计费。是否批准本次调用？') : '') }))) return;
    setBusy(true);
    try { await api.resumeSkuPack(id, { confirm: true, retryFailed, confirmPaidMatting: Boolean(remote) }); await load(); } catch (err) { setError(err.message); } finally { setBusy(false); }
  }
  async function stop(action) {
    if (!window.confirm(t("确认{value0}？当前 SKU 完成后停止，已完成结果保留。", { value0: (t(action === 'cancel' ? '取消' : '暂停')) }))) return;
    try { await api.taskCenterAction(id, { action, confirm: true }); await load(); } catch (err) { setError(err.message); }
  }
  async function executeTemplate() {
    if (!window.confirm(t("确认将已预览的 {value0} 个单元格写入模板副本？原文件和公式不修改。", { value0: (data.summary.changedCells) }))) return;
    setBusy(true);
    try { await api.executeWorkbookFill(id, { previewHash: data.previewHash, confirm: true }); await load(); } catch (err) { setError(err.message); } finally { setBusy(false); }
  }
  return <div className="space-y-5">
    <h1 className="text-2xl font-semibold">{t("任务结果与追踪")}</h1><ErrorBox error={error} />
    <Link className="text-sm text-mint underline" to="/task-center">{t("返回统一任务中心")}</Link>
    {data?.type === 'template-fill' && data.status === 'waiting_user' && <Section title={t("继续确认模板副本回填")}><p className="mb-3 text-sm">{t("预览已持久化，刷新或重启后仍可核对下面的逐格差异。执行仅写入副本，服务端重新检查审批散列和原模板散列。")}</p>{data.blocked?.map((item, index) => <p key={index} className="mb-2 text-sm text-amber-800">{item.ref}：{item.reason === 'FORMULA_PRESERVED' ? t("公式单元格不可覆盖，请重新选择映射或模板") : t("单元格已有内容，请返回素材台账调整规则并重新预览")}</p>)}<button className="btn-primary" disabled={busy || !data.canExecute || !canOperate} onClick={executeTemplate}>{t("确认差异并生成副本")}</button><Link className="ml-3 text-sm text-mint underline" to="/workbench/materials">{t("返回素材台账调整")}</Link></Section>}
    {data?.type === 'sku-pack' && canOperate && ['running', 'paused'].includes(data.status) && <div className="flex gap-3"><button className="btn-secondary" onClick={() => stop('pause')}>{t("完成当前 SKU 后暂停")}</button><button className="btn-secondary" onClick={() => stop('cancel')}>{t("取消并保留结果")}</button><button className="btn-secondary" onClick={() => load()}>{t("刷新进度")}</button></div>}
    {data?.type === 'sku-pack' && data.recovery?.available && <Section title={t("SKU 恢复点")}><p className="mb-3 text-sm">{data.recovery.message}</p><div className="flex gap-3"><button className="btn-primary" disabled={busy || !canMakeImages} onClick={() => resume(false)}>{t("继续未完成 SKU")}</button><button className="btn-secondary" disabled={busy || !canMakeImages} onClick={() => resume(true)}>{t("重试失败 SKU")}</button></div></Section>}
    {data && <>
      <Section title={data.name || data.id}>
        <div className="space-y-3 text-sm"><p>{data.type} · {data.status} · {dateTime(data.updatedAt)}</p><p>{Object.entries(data.summary || {}).map(([key, value]) => `${key}: ${value}`).join(' · ')}</p>
          <div className="flex flex-wrap gap-3">{data.downloadUrl && <a className="btn-primary" href={`${ASSET_BASE}${data.downloadUrl}`} download>{t("下载结果")}</a>}<a className="btn-secondary" href={`${ASSET_BASE}${data.manifestUrl}`} download>{t("下载完整清单")}</a>{data.diffUrl && <a className="btn-secondary" href={`${ASSET_BASE}${data.diffUrl}`} download>{t("下载写入差异")}</a>}</div>
          <details><summary className="cursor-pointer">{t("查看处理规则与输入参数")}</summary><pre className="mt-3 max-h-64 overflow-auto rounded bg-slate-50 p-3 text-xs">{JSON.stringify(data.options || { sourceHash: data.sourceHash, outputHash: data.outputHash, rules: data.rules, rounding: data.rounding, currency: data.currency, scope: data.scope }, null, 2)}</pre></details>
        </div>
      </Section>
      <Section title={t("逐项结果（分页）")}><div className="grid gap-3 md:grid-cols-2">{data.entries.map((item, index) => <article key={index} className="rounded border p-3"><p className="text-sm font-medium">{item.sku || item.sourceName || item.fileName || item.cell || t("条目 {value0}", { value0: (index + 1) })}</p>{/^\/(outputs|uploads)\//.test(item.url || '') && <img className="my-3 h-40 w-full object-contain" alt={item.fileName || t("处理结果")} src={`${ASSET_BASE}${item.url}`} />}<pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all text-xs leading-6 text-slate-600">{JSON.stringify(item, null, 2)}</pre></article>)}</div><Pager pagination={data.pagination} onPage={load} /></Section>
    </>}
  </div>;
}
