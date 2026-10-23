import { useLocale } from '../i18n/LocaleProvider.jsx';
import { useEffect, useRef, useState } from 'react';
import { approveSkuResume, skuFinalizationHint } from '../utils/skuPackResume.js';
import { approveImagePackResume } from '../utils/imagePackResume.js';
import { approveManifestRepair, manifestRecoveryLabel, canRepairManifest } from '../utils/skuManifestRecovery.js';
import { approveWorkbenchManifestRepair, canRepairWorkbenchManifest } from '../utils/workbenchManifestRecovery.js';
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
  const finalizeHint = skuFinalizationHint(data);
  const manifestNotice = manifestRecoveryLabel(data?.manifestRead, t);
  const canRepair = canRepairManifest(data, canMakeImages) || canRepairWorkbenchManifest(data, role);
  const resuming = useRef(false);
  const activeId = useRef(id); activeId.current = id;
  async function load(page = 1) { try { const loaded = await api.getWorkbenchJobDetail(id, page); if (activeId.current !== id) return; setData(loaded); setError(''); } catch (err) { if (activeId.current === id) setError(err.message); } }
  useEffect(() => { setData(null); load(); }, [id]);
  useEffect(() => {
    if (data?.type !== 'image-pack' || (!data.recovery?.active && !busy)) return;
    const timer = setInterval(() => load(), 900); return () => clearInterval(timer);
  }, [id, data?.type, data?.recovery?.active, busy]);
  async function resumeImages(retryFailed) {
    if (resuming.current || !canMakeImages || data?.manifestRead?.readOnly === true) return;
    resuming.current = true; setBusy(true); setError('');
    try {
      const payload = await approveImagePackResume(api, id, retryFailed, t, message => activeId.current === id && window.confirm(message));
      if (!payload || activeId.current !== id) return;
      await api.resumeImagePack(id, payload); await load();
    } catch (err) { if (activeId.current === id) { await load(); if (activeId.current === id) setError(err.message); } }
    finally { resuming.current = false; setBusy(false); }
  }
  async function stopImages(action) {
    if (!canMakeImages || !window.confirm(t('确认停止图包？当前图片完成后停止，已完成结果保留。'))) return;
    try { await api.controlImagePack(id, { action, confirm: true }); await load(); } catch (err) { if (activeId.current === id) setError(err.message); }
  }
  async function resume(retryFailed) {
    if (resuming.current || !canMakeImages) return;
    resuming.current = true;
    setBusy(true);
    setError('');
    try { const payload = await approveSkuResume(api, id, retryFailed, t, message => activeId.current === id && window.confirm(message)); if (!payload || activeId.current !== id) return; await api.resumeSkuPack(id, payload); await load(); } catch (err) { if (activeId.current === id) { await load(); if (activeId.current === id) setError(err.message); } } finally { resuming.current = false; setBusy(false); }
  }
  async function stop(action) {
    if (!window.confirm(t("确认{value0}？当前 SKU 完成后停止，已完成结果保留。", { value0: (t(action === 'cancel' ? '取消' : '暂停')) }))) return;
    try { await api.taskCenterAction(id, { action, confirm: true }); await load(); } catch (err) { setError(err.message); }
  }
  async function repairManifest() {
    if (resuming.current || !canRepair) return;
    resuming.current = true; setBusy(true); setError('');
    try {
      const confirm = message => activeId.current === id && window.confirm(message);
      const payload = data.type === 'sku-pack' ? await approveManifestRepair(api, id, t, confirm, data?.manifestRead?.sourceHash) : await approveWorkbenchManifestRepair(api, data, t, confirm);
      if (!payload || activeId.current !== id) return;
      if (data.type === 'sku-pack') await api.repairSkuManifest(id, payload);
      else await api.repairWorkbenchManifest(id, payload);
      await load();
    } catch (err) { if (activeId.current === id) { await load(); if (activeId.current === id) setError(err.message); } }
    finally { resuming.current = false; setBusy(false); }
  }
  async function executeTemplate() {
    if (resuming.current || !canOperate || data?.manifestRead?.readOnly === true) return;
    if (!window.confirm(t("确认将已预览的 {value0} 个单元格写入模板副本？原文件和公式不修改。", { value0: (data.summary.changedCells) }))) return;
    resuming.current = true; setBusy(true);
    try { await api.executeWorkbookFill(id, { previewHash: data.previewHash, confirm: true }); await load(); } catch (err) { if (activeId.current === id) setError(err.message); } finally { resuming.current = false; setBusy(false); }
  }
  return <div className="space-y-5">
    <h1 className="text-2xl font-semibold">{t("任务结果与追踪")}</h1><ErrorBox error={error} />
    <Link className="text-sm text-mint underline" to="/task-center">{t("返回统一任务中心")}</Link>
    {data?.type === 'image-pack' && data.recoveryVersion === 1 && <Section title={t('普通图包恢复点')}>
      <p className="mb-3 text-sm">{t('逐图恢复点已保存；修复清单、继续图片和重试失败项均需分别确认。')}</p>
      {data.recovery?.active ? <div className="flex gap-3">
        <button data-image-pack-pause className="btn-secondary" disabled={!canMakeImages} onClick={() => stopImages('pause')}>{t('完成当前图片后暂停')}</button>
        <button className="btn-secondary" disabled={!canMakeImages} onClick={() => stopImages('cancel')}>{t('取消并保留结果')}</button>
      </div> : <div className="flex gap-3">
        <button data-image-pack-resume className="btn-primary" disabled={busy || !canMakeImages || data.manifestRead?.readOnly === true || !(data.summary?.pendingCount > 0 || data.finalizePending === true)} onClick={() => resumeImages(false)}>{t(data.finalizePending && !data.summary?.pendingCount ? '仅重新生成结果包' : '继续未完成图片')}</button>
        <button data-image-pack-retry className="btn-secondary" disabled={busy || !canMakeImages || data.manifestRead?.readOnly === true || !data.summary?.failedCount} onClick={() => resumeImages(true)}>{t('重试失败图片')}</button>
      </div>}
    </Section>}
    {manifestNotice && <section data-manifest-recovery className="space-y-3 rounded border border-amber-300 bg-amber-50 p-4 text-sm"><p>{manifestNotice}</p><p>{data.type === 'sku-pack' ? t('可以下载完整恢复快照；修复清单与继续处理是两个独立操作，均不会自动执行。') : t('可下载完整只读恢复快照；查看和下载不会修复主清单、重做图片或执行任务。')}</p>{data.type === 'collection-job' && <Link data-open-collection-recovery className="btn-secondary inline-flex" to={`/workbench/collection?jobId=${encodeURIComponent(id)}`}>{t('打开采集恢复')}</Link>}{canRepair && <button data-manifest-repair className="btn-secondary" disabled={busy} onClick={repairManifest}>{t('预览并修复主清单')}</button>}</section>}
    {data?.type === 'template-fill' && data.status === 'waiting_user' && <Section title={t("继续确认模板副本回填")}><p className="mb-3 text-sm">{t("预览已持久化，刷新或重启后仍可核对下面的逐格差异。执行仅写入副本，服务端重新检查审批散列和原模板散列。")}</p>{data.blocked?.map((item, index) => <p key={index} className="mb-2 text-sm text-amber-800">{item.ref}：{item.reason === 'FORMULA_PRESERVED' ? t("公式单元格不可覆盖，请重新选择映射或模板") : t("单元格已有内容，请返回素材台账调整规则并重新预览")}</p>)}<button data-template-execute className="btn-primary" disabled={busy || !data.canExecute || !canOperate || data.manifestRead?.readOnly === true} onClick={executeTemplate}>{t("确认差异并生成副本")}</button><Link className="ml-3 text-sm text-mint underline" to="/workbench/materials">{t("返回素材台账调整")}</Link></Section>}
    {data?.type === 'sku-pack' && canOperate && ['running', 'paused'].includes(data.status) && <div className="flex gap-3"><button className="btn-secondary" onClick={() => stop('pause')}>{t("完成当前 SKU 后暂停")}</button><button className="btn-secondary" onClick={() => stop('cancel')}>{t("取消并保留结果")}</button><button className="btn-secondary" onClick={() => load()}>{t("刷新进度")}</button></div>}
    {data?.type === 'sku-pack' && (data.recovery?.available || finalizeHint) && <Section title={t("SKU 恢复点")}><p className="mb-3 text-sm">{finalizeHint ? t('图片处理已完成，结果包尚未保存成功；可仅重新打包，或单独选择重试失败 SKU。') : data.recovery.message}</p><div className="flex gap-3"><button className="btn-primary" disabled={busy || !canMakeImages} onClick={() => resume(false)}>{finalizeHint ? t('仅重新生成结果包') : t("继续未完成 SKU")}</button><button className="btn-secondary" disabled={busy || !canMakeImages} onClick={() => resume(true)}>{t("重试失败 SKU")}</button></div></Section>}
    {data && <>
      {data.source?.type === 'collection-job' && <Section title={t('来源采集任务')}><div data-result-collection-source className="space-y-2 text-sm"><p>{data.source.name || data.source.jobId}</p><Link className="text-mint underline" to={`/workbench/collection?jobId=${encodeURIComponent(data.source.jobId)}`}>{t('返回来源采集任务')}</Link><p>{t('来源图片清单与散列保存在下载的 manifest 中，原采集结果保持不变。')}</p></div></Section>}
      <Section title={data.name || data.id}>
        <div className="space-y-3 text-sm"><p>{data.type} · {data.status} · {dateTime(data.updatedAt)}</p><p>{Object.entries(data.summary || {}).map(([key, value]) => `${key}: ${value}`).join(' · ')}</p>
          {data.type === 'sku-pack' && !finalizeHint && Number.isSafeInteger(data.archiveGeneration) && data.archiveGeneration > 0 && <p data-sku-archive-version className="text-slate-600">{t('结果包版本：{version}；之前已保存的 ZIP 保持不变。', { version: data.archiveGeneration })}</p>}
          <div className="flex flex-wrap gap-3">{data.downloadUrl && <a data-result-download className="btn-primary" href={`${ASSET_BASE}${data.downloadUrl}`} download>{t(finalizeHint ? '下载上次保存的结果包' : '下载结果')}</a>}<a data-result-manifest className="btn-secondary" href={data.type === 'sku-pack' ? api.skuPackManifestUrl(id) : api.workbenchManifestUrl(id)} download>{t("下载完整清单")}</a>{data.diffUrl && <a className="btn-secondary" href={`${ASSET_BASE}${data.diffUrl}`} download>{t("下载写入差异")}</a>}</div>
          <details><summary className="cursor-pointer">{t("查看处理规则与输入参数")}</summary><pre className="mt-3 max-h-64 overflow-auto rounded bg-slate-50 p-3 text-xs">{JSON.stringify(data.options || { sourceHash: data.sourceHash, outputHash: data.outputHash, rules: data.rules, rounding: data.rounding, currency: data.currency, scope: data.scope }, null, 2)}</pre></details>
        </div>
      </Section>
      <Section title={t("逐项结果（分页）")}><div className="grid gap-3 md:grid-cols-2">{data.entries.map((item, index) => <article key={index} className="rounded border p-3"><p className="text-sm font-medium">{item.sku || item.sourceName || item.fileName || item.cell || t("条目 {value0}", { value0: (index + 1) })}</p>{/^\/(outputs|uploads)\//.test(item.url || '') && <img className="my-3 h-40 w-full object-contain" alt={item.fileName || t("处理结果")} src={`${ASSET_BASE}${item.url}`} />}<pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all text-xs leading-6 text-slate-600">{JSON.stringify(item, null, 2)}</pre></article>)}</div><Pager pagination={data.pagination} onPage={load} /></Section>
    </>}
  </div>;
}
