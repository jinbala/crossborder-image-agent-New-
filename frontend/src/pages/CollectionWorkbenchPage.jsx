import { useLocale } from '../i18n/LocaleProvider.jsx';
import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, CheckCircle2, Download, FileSpreadsheet, LoaderCircle, Play, RefreshCw, ShieldCheck } from 'lucide-react';
import Section from '../components/Section.jsx';
import { ASSET_BASE, api } from '../services/api.js';
import { useAccount } from '../components/AuthGate.jsx';
import { assertCollectionDraftContext, recoverCollectionDraft } from '../utils/collectionDraft.js';
import { Link } from 'react-router-dom';
import { collectionResultGuide, collectionPreviewPage, collectionStatuses, collectionStatusLabel, collectionItemsPage, collectionItemsCsv, collectionRunShouldStop } from '../utils/collectionResults.js';
import { collectionPackLink } from '../utils/collectionPack.js';
import { manifestRecoveryLabel } from '../utils/skuManifestRecovery.js';
import { collectionSnapshotReadOnly, canRepairCollectionManifest, approveCollectionManifestRepair } from '../utils/collectionManifestRecovery.js';

const DEFAULT_OPTIONS = {
  name: '',
  mode: 'normal',
  minSales: 0,
  extraWaitMs: 1000,
  timeoutMs: 20000,
  maxImagesPerProduct: 30,
  maxAttempts: 3,
  downloadOriginal: true,
  randomFileNames: false
};

function parseRules(text) {
  return String(text || '').split(/\r?\n/).map((line) => {
    const separator = line.includes('=>') ? '=>' : '|';
    const [from, ...rest] = line.split(separator);
    return { mode: 'prefix', from: from?.trim() || '', to: rest.join(separator).trim() };
  }).filter((rule) => rule.from);
}

function Field({ label, children }) {
  const { t } = useLocale();
  return <label className="block text-sm text-slate-600"><span>{t(label)}</span>{children}</label>;
}

function Toggle({ checked, onChange, title, description }) {
  return <label className="flex cursor-pointer gap-3 rounded-lg border border-slate-200 p-3"><input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} className="mt-0.5 h-4 w-4 accent-teal-700" /><span><span className="block text-sm font-medium text-ink">{title}</span><span className="mt-0.5 block text-xs leading-5 text-slate-500">{description}</span></span></label>;
}

export default function CollectionWorkbenchPage() {
  const { t } = useLocale();
  const account = useAccount();
  const actorId = account?.user?.id || 'local';
  const [file, setFile] = useState(null);
  const [manualUrls, setManualUrls] = useState('');
  const [options, setOptions] = useState(DEFAULT_OPTIONS);
  const [rulesText, setRulesText] = useState('');
  const [job, setJob] = useState(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [previewPage, setPreviewPage] = useState(1);
  const [itemQuery, setItemQuery] = useState({ q: '', status: '', page: 1, pageSize: 25 });
  const [draftContext, setDraftContext] = useState(null);
  const [draftLoading, setDraftLoading] = useState(true);
  const creating = useRef(false);
  const executing = useRef(false);

  useEffect(() => {
    setItemQuery({ q: '', status: '', page: 1, pageSize: 25 });
    setPreviewPage(1);
  }, [job?.id]);

  async function refreshDraft() {
    const next = assertCollectionDraftContext(await api.getCollectionDraft(), actorId);
    setDraftContext(next); return next;
  }
  useEffect(() => {
    let active = true;
    setDraftContext(null); setDraftLoading(true);
    api.getCollectionDraft().then((value) => { if (active) setDraftContext(assertCollectionDraftContext(value, actorId)); })
      .catch((err) => { if (active) setError(err.message); }).finally(() => { if (active) setDraftLoading(false); });
    return () => { active = false; };
  }, [actorId]);

  useEffect(() => {
    const jobId = new URLSearchParams(window.location.search).get('jobId');
    if (!jobId) return;
    let active = true;
    setBusy('refresh');
    api.getCollectionJob(jobId)
      .then((loaded) => { if (active) setJob(loaded); })
      .catch((loadError) => { if (active) setError(loadError.message); })
      .finally(() => { if (active) setBusy(''); });
    return () => { active = false; };
  }, []);

  function patchOptions(patch) { setOptions((current) => ({ ...current, ...patch })); }

  async function create(event) {
    event.preventDefault();
    const urls = manualUrls.split(/\r?\n/).map((value) => value.trim()).filter(Boolean);
    if ((!file && urls.length === 0) || creating.current || !draftContext || draftContext.draft) return;
    creating.current = true;
    setBusy('create'); setError('');
    try {
      const normalizedOptions = { ...options, replacementRules: parseRules(rulesText) };
      const staged = assertCollectionDraftContext(file
        ? await api.stageCollectionSheet(file, normalizedOptions, draftContext)
        : await api.stageCollectionRows(urls.map((productUrl) => ({ productUrl })), normalizedOptions, draftContext), actorId);
      setDraftContext(staged);
      const result = await recoverCollectionDraft(api, staged, actorId, setJob);
      setDraftContext(result.context);
    } catch (createError) { setError(createError.message); }
    finally { await refreshDraft().catch(() => {}); creating.current = false; setBusy(''); }
  }

  async function resumeDraft() {
    if (creating.current || !draftContext?.draft) return;
    creating.current = true; setBusy('create'); setError('');
    try {
      const result = await recoverCollectionDraft(api, draftContext, actorId, setJob);
      setDraftContext(result.context);
    } catch (err) { setError(err.message); }
    finally { await refreshDraft().catch(() => {}); creating.current = false; setBusy(''); }
  }
  async function discardDraft() {
    if (creating.current || !draftContext?.draft || !window.confirm(t('放弃本轮待确认请求？服务器可能已经创建任务，已有任务和图片不会删除；请先检查任务中心。'))) return;
    creating.current = true; setBusy('discard'); setError('');
    try { await api.discardCollectionDraft(draftContext.draft.id, actorId); await refreshDraft(); }
    catch (err) { setError(err.message); }
    finally { creating.current = false; setBusy(''); }
  }

  async function runBatch({ retryFailed = false } = {}) {
    if (!job || collectionSnapshotReadOnly(job) || executing.current || !confirmResume()) return;
    executing.current = true;
    setBusy(retryFailed ? 'retry' : 'run'); setError('');
    try { setJob(await api.runCollectionJob(job.id, { limit: 10, retryFailed })); }
    catch (runError) { setError(runError.message); }
    finally { executing.current = false; setBusy(''); }
  }

  async function runContinuously() {
    if (!job || collectionSnapshotReadOnly(job) || executing.current || !confirmResume()) return;
    executing.current = true;
    setBusy('all'); setError('');
    try {
      let current = job;
      for (let batch = 0; batch < 500 && (current.summary?.pendingCount || 0) > 0; batch += 1) {
        const before = current.summary?.pendingCount || 0;
        current = await api.runCollectionJob(current.id, { limit: 10 });
        setJob(current);
        if (collectionRunShouldStop(current)) break;
        if ((current.summary?.pendingCount || 0) >= before) break;
      }
    } catch (runError) { setError(runError.message); }
    finally { executing.current = false; setBusy(''); }
  }

  function confirmResume() {
    return job?.status !== 'cancelled' || window.confirm(t('此任务已取消。确认恢复未处理项或重试失败项？已完成图片不会重复下载。'));
  }

  function exportItems() {
    const url = URL.createObjectURL(new Blob([collectionItemsCsv(job, itemQuery)], { type: 'text/csv;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url; link.download = `collection-${job.id.replace(/[^A-Za-z0-9_-]/g, '_')}-items.csv`;
    document.body.append(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  async function refresh() {
    if (!job) return;
    setBusy('refresh'); setError('');
    try { setJob(await api.getCollectionJob(job.id)); }
    catch (refreshError) { setError(refreshError.message); }
    finally { setBusy(''); }
  }

  async function repairManifest() {
    if (executing.current || !canRepairCollectionManifest(job, account?.user?.role)) return;
    executing.current = true; setBusy('repair'); setError('');
    try {
      const payload = await approveCollectionManifestRepair(api, job, t, message => window.confirm(message));
      if (!payload) return;
      await api.repairCollectionManifest(job.id, payload);
      setJob(await api.getCollectionJob(job.id));
    } catch (err) { setError(err.message); }
    finally { executing.current = false; setBusy(''); }
  }

  const summary = job?.summary || {};
  const readOnly = collectionSnapshotReadOnly(job);
  const manifestNotice = manifestRecoveryLabel(job?.manifestRead, t);
  const nextStep = collectionResultGuide(job);
  const previews = collectionPreviewPage(job, previewPage);
  const itemPage = collectionItemsPage(job, itemQuery);
  const retryable = job?.items?.some((item) => ['failed', 'completed_with_errors'].includes(item.status) && item.attempts < (job.options?.maxAttempts || 3));

  return (
    <div className="space-y-5">
      <div>
        <a href="/workbench" className="focus-ring inline-flex items-center gap-1 text-sm text-slate-500 hover:text-mint"><ArrowLeft size={16} />{" " + t("返回运营工作台")}</a>
        <h1 className="mt-2 text-2xl font-semibold text-ink">{t("图片采集与表格批量下载")}</h1>
        <p className="mt-1 text-sm text-slate-500">{t("从 CSV/XLSX 读取商品或图片链接，按销量过滤，逐项保存进度并下载原图。")}</p>
      </div>

      {error && <div role="alert" className="rounded border border-red-200 bg-red-50 p-3 text-sm text-red-700">{error}</div>}

      {!draftContext && !draftLoading && <button type="button" className="btn-secondary" disabled={Boolean(busy)} onClick={() => refreshDraft().catch((err) => setError(err.message))}>{t('重新读取待确认请求')}</button>}
      {draftContext?.draft && <section data-collection-draft className="space-y-3 rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm text-amber-950">
        <h2 className="font-semibold">{t('发现待确认采集请求')}</h2>
        <p>{t('首次提交的商品与规则已保存在服务端。继续会找回原任务，不采用当前表单修改；刷新页面或客户端换端口后仍可找回。')}</p>
        {draftContext.draft.name && <p>{draftContext.draft.name} · {draftContext.draft.rowCount} · {draftContext.draft.fileName}</p>}
        {['unavailable', 'corrupt'].includes(draftContext.draft.state) && <p>{t('原请求记录损坏或任务归属已变化，无法继续；请检查任务中心或明确放弃本轮请求。')}</p>}
        <div className="flex flex-wrap gap-2"><button type="button" data-resume-collection disabled={Boolean(busy) || ['unavailable', 'corrupt'].includes(draftContext.draft.state)} onClick={resumeDraft} className="btn-primary">{t('找回并继续原请求')}</button><button type="button" disabled={Boolean(busy)} onClick={discardDraft} className="btn-secondary">{t('放弃待确认请求')}</button><a href="/task-center" className="btn-secondary">{t('检查任务中心')}</a></div>
      </section>}

      {!job && <form onSubmit={create} className="space-y-5">
        <fieldset disabled={Boolean(busy) || draftLoading || !draftContext || Boolean(draftContext.draft)} className="space-y-5 disabled:opacity-60">
        <Section title={t("1. 导入表格或粘贴商品链接")}>
          <label className="block cursor-pointer rounded-xl border-2 border-dashed border-slate-300 bg-slate-50 px-6 py-8 text-center hover:border-mint hover:bg-teal-50/50">
            <FileSpreadsheet className="mx-auto text-mint" size={34} />
            <div className="mt-2 font-medium text-ink">{t("选择 CSV、TSV、TXT 或 XLSX")}</div>
            <div className="mt-1 text-xs text-slate-500">{t("可识别 SKU、商品标题、销量、商品链接、主图/附图链接；最大 10MB、5000 行。")}</div>
            <input type="file" accept=".csv,.tsv,.txt,.xlsx" className="sr-only" onChange={(event) => setFile(event.target.files?.[0] || null)} />
            {file && <div className="mt-3 text-sm font-medium text-teal-800">{t("已选择：")}{file.name}</div>}
          </label>
          <div className="my-3 flex items-center gap-3 text-xs text-slate-400"><span className="h-px flex-1 bg-slate-200" /><span>{t("或者")}</span><span className="h-px flex-1 bg-slate-200" /></div>
          <textarea value={manualUrls} onChange={(event) => setManualUrls(event.target.value)} rows="5" placeholder={t("每行一个公开商品链接\nhttps://www.amazon.com/...\nhttps://www.pinterest.com/pin/...")} className="focus-ring w-full resize-y rounded border border-slate-300 px-3 py-2 font-mono text-xs text-ink" />
          <p className="mt-2 text-xs text-slate-500">{t("直接粘贴链接时会采集公开页面标题、销量文本和图片；需要登录或动态渲染的站点请使用对应浏览器扩展。")}</p>
        </Section>

        <div className="grid gap-5 xl:grid-cols-2">
          <Section title={t("2. 采集设置")}>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label={t("任务名称")}><input value={options.name} onChange={(event) => patchOptions({ name: event.target.value })} placeholder={t("例如：Amazon 秋季新品")} className="focus-ring mt-1 w-full rounded border border-slate-300 px-3 py-2 text-ink" /></Field>
              <Field label={t("最低销量")}><input type="number" min="0" value={options.minSales} onChange={(event) => patchOptions({ minSales: event.target.value })} className="focus-ring mt-1 w-full rounded border border-slate-300 px-3 py-2 text-ink" /></Field>
              <Field label={t("商品间额外等待（毫秒）")}><input type="number" min="0" max="30000" step="500" value={options.extraWaitMs} onChange={(event) => patchOptions({ extraWaitMs: event.target.value })} className="focus-ring mt-1 w-full rounded border border-slate-300 px-3 py-2 text-ink" /></Field>
              <Field label={t("每商品最多图片")}><input type="number" min="1" max="100" value={options.maxImagesPerProduct} onChange={(event) => patchOptions({ maxImagesPerProduct: event.target.value })} className="focus-ring mt-1 w-full rounded border border-slate-300 px-3 py-2 text-ink" /></Field>
              <Field label={t("请求超时（毫秒）")}><input type="number" min="3000" max="60000" step="1000" value={options.timeoutMs} onChange={(event) => patchOptions({ timeoutMs: event.target.value })} className="focus-ring mt-1 w-full rounded border border-slate-300 px-3 py-2 text-ink" /></Field>
              <Field label={t("最大重试次数")}><input type="number" min="1" max="5" value={options.maxAttempts} onChange={(event) => patchOptions({ maxAttempts: event.target.value })} className="focus-ring mt-1 w-full rounded border border-slate-300 px-3 py-2 text-ink" /></Field>
            </div>
            <div className="mt-4 grid gap-3">
              <Toggle checked={options.downloadOriginal} onChange={(value) => patchOptions({ downloadOriginal: value })} title={t("尝试下载原图")} description={t("明确适配 Amazon 和 Pinterest；其他站点保持原地址并如实记录失败。")} />
              <Toggle checked={options.randomFileNames} onChange={(value) => patchOptions({ randomFileNames: value })} title={t("随机化文件名")} description={t("使用任务与来源地址生成稳定随机名，断点恢复不会重复产生文件。")} />
            </div>
          </Section>

          <Section title={t("3. 图片地址替换（可选）")}>
            <p className="mb-3 text-sm leading-6 text-slate-500">{t("每行一条“原前缀 => 新前缀”，替换后仍会重新校验为 HTTP/HTTPS 地址。")}</p>
            <textarea value={rulesText} onChange={(event) => setRulesText(event.target.value)} rows="9" placeholder={'https://old-cdn.example/ => https://new-cdn.example/'} className="focus-ring w-full resize-y rounded border border-slate-300 px-3 py-2 font-mono text-xs text-ink" />
            <div className="mt-3 rounded border border-blue-200 bg-blue-50 p-3 text-xs leading-5 text-blue-900"><ShieldCheck className="mr-1 inline" size={14} />{t("采集器会拒绝 localhost、局域网地址、非标准端口、超大响应和非图片内容。")}</div>
          </Section>
        </div>

        <button disabled={(!file && !manualUrls.trim()) || Boolean(busy)} className="focus-ring inline-flex items-center gap-2 rounded bg-mint px-5 py-2.5 text-sm font-semibold text-white hover:bg-teal-800 disabled:opacity-50">{busy === 'create' ? <LoaderCircle className="animate-spin" size={18} /> : <FileSpreadsheet size={18} />}{t("创建可恢复采集任务")}</button>
        <p className="text-xs leading-5 text-slate-500">{t('提交前先保存一份成员私有的待确认草稿；取得任务 ID 后清除草稿。中断后不要重复导入，在本页继续原请求即可。')}</p>
        </fieldset>
      </form>}

      {job && <>
        <span hidden data-current-collection-job={job.id} />
        {manifestNotice && <section data-collection-manifest-recovery className="space-y-3 rounded border border-amber-300 bg-amber-50 p-4 text-sm"><p>{manifestNotice}</p><p>{t('请先预览并确认修复采集主清单，再继续下载或浏览器回传。修复保留损坏副本，不处理图片、不重建 ZIP，也不自动继续任务。')}</p><div className="flex flex-wrap gap-3"><a data-collection-manifest className="btn-secondary" href={api.workbenchManifestUrl(job.id)} download>{t('下载完整清单')}</a>{canRepairCollectionManifest(job, account?.user?.role) && <button data-collection-manifest-repair type="button" className="btn-secondary" disabled={Boolean(busy)} onClick={repairManifest}>{t('预览并修复主清单')}</button>}</div></section>}
        <section data-collection-next-step={nextStep.kind} className="space-y-3 rounded-lg border-2 border-teal-600 bg-teal-50 p-4">
          <h2 className="font-semibold text-teal-950">{t(nextStep.title)}</h2>
          <p className="text-sm leading-6 text-teal-950">{t(nextStep.description)}</p>
          {summary.downloadedCount > 0 && collectionPackLink(job.id) && <Link data-collection-pack-direct className="btn-primary inline-flex" to={collectionPackLink(job.id)}>{t('使用本任务图片整理图包')}</Link>}
          <div className="flex flex-wrap gap-3">{job.downloadUrl && <a data-collection-download className="btn-primary" href={`${ASSET_BASE}${job.downloadUrl}`} download>{t('下载当前 ZIP')}</a>}<Link to="/workbench/sku-pack" className="btn-secondary">{t('进入 SKU 图包处理')}</Link><Link to="/task-center" className="btn-secondary">{t('返回统一任务中心')}</Link></div>
        </section>
        <Section title={t('已收到的图片预览')}>
          <p className="mb-3 text-xs text-slate-500">{t('这里只预览当前任务已保存的本地图片，不重新访问 Temu 或图片源站；无法显示时请下载 ZIP 核对原图。')}</p>
          <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-4">{previews.images.map(image=><figure data-collection-preview key={`${image.url}-${image.sha256}`} className="rounded border border-slate-200 bg-white p-2"><img loading="lazy" className="h-36 w-full object-contain" src={`${ASSET_BASE}${image.url}`} alt={image.file||image.sku||t('处理结果')} /><figcaption className="mt-2 break-all text-xs text-slate-600">{image.sku} · {image.file}</figcaption></figure>)}</div>
          {!previews.total && <p className="text-sm text-slate-600">{t('尚无可预览图片。请检查回传状态并刷新任务，不要重复创建。')}</p>}
          {previews.total>0 && <div className="mt-3 flex items-center gap-3 text-sm"><button data-collection-preview-prev type="button" className="btn-secondary" disabled={previews.page<=1} onClick={()=>setPreviewPage(previews.page-1)}>{t('上一页')}</button><span>{t('第 {page} / {pages} 页 · 共 {total} 条',{page:previews.page,pages:previews.pages,total:previews.total})}</span><button data-collection-preview-next type="button" className="btn-secondary" disabled={previews.page>=previews.pages} onClick={()=>setPreviewPage(previews.page+1)}>{t('下一页')}</button></div>}
        </Section>
        <Section title={t("任务进度")} actions={<button type="button" onClick={refresh} disabled={Boolean(busy)} className="focus-ring inline-flex items-center gap-1 rounded px-2 py-1 text-xs text-slate-500 hover:text-mint"><RefreshCw size={14} />{" " + t("刷新")}</button>}>
          <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-7">
            {[['状态', t(collectionStatusLabel(job.status))], ['总数', summary.inputCount || 0], ['完成', summary.completedCount || 0], ['有警告', summary.warningCount || 0], ['失败', summary.failedCount || 0], ['跳过', summary.skippedCount || 0], ['已下载', summary.downloadedCount || 0]].map(([label, value]) => <div key={label} className="rounded-lg border border-slate-200 bg-slate-50 p-3"><div className="text-xs text-slate-500">{t(label)}</div><div className="mt-1 text-lg font-semibold text-ink">{value}</div></div>)}
          </div>
          <div className="mt-4 flex flex-wrap gap-2">
            {summary.pendingCount > 0 && <button data-collection-run-all type="button" onClick={runContinuously} disabled={Boolean(busy) || readOnly} className="focus-ring inline-flex items-center gap-2 rounded bg-mint px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">{busy === 'all' ? <LoaderCircle className="animate-spin" size={17} /> : <Play size={17} />}{t("连续处理全部")}</button>}
            {summary.pendingCount > 0 && <button data-collection-run-batch type="button" onClick={() => runBatch()} disabled={Boolean(busy) || readOnly} className="focus-ring inline-flex items-center gap-2 rounded bg-ink px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">{busy === 'run' ? <LoaderCircle className="animate-spin" size={17} /> : <Play size={17} />}{t("处理下一批 10 个商品")}</button>}
            {retryable && <button data-collection-retry type="button" onClick={() => runBatch({ retryFailed: true })} disabled={Boolean(busy) || readOnly} className="focus-ring inline-flex items-center gap-2 rounded border border-amber-300 bg-amber-50 px-4 py-2 text-sm font-semibold text-amber-900 disabled:opacity-50">{busy === 'retry' ? <LoaderCircle className="animate-spin" size={17} /> : <RefreshCw size={17} />}{t("重试失败项")}</button>}
            {job.downloadUrl && <a href={`${ASSET_BASE}${job.downloadUrl}`} className="focus-ring inline-flex items-center gap-2 rounded bg-emerald-700 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-800"><Download size={17} />{t("下载当前 ZIP")}</a>}
            <button type="button" onClick={() => { setJob(null); setFile(null); setManualUrls(''); setError(''); }} disabled={Boolean(busy)} className="focus-ring rounded border border-slate-300 px-4 py-2 text-sm text-slate-600">{t("新建任务")}</button>
          </div>
          <p className="mt-3 text-xs leading-5 text-slate-500">{t("每处理一张图片和一个商品都会更新 manifest；浏览器关闭后，可通过最近任务重新打开并继续。")}</p>
        </Section>

        <Section title={t("商品明细")}>
          <div className="mb-3 flex flex-wrap items-center gap-3">
            <input data-collection-item-search aria-label={t('搜索采集商品')} placeholder={t('SKU、标题、链接或错误原因')} value={itemQuery.q} onChange={event => setItemQuery(current => ({ ...current, q: event.target.value, page: 1 }))} className="focus-ring min-w-60 flex-1 rounded border p-2 text-sm" />
            <select data-collection-item-status aria-label={t('商品处理状态')} value={itemQuery.status} onChange={event => setItemQuery(current => ({ ...current, status: event.target.value, page: 1 }))} className="rounded border p-2 text-sm"><option value="">{t('全部状态')}</option>{Object.entries(collectionStatuses).map(([status, label]) => <option key={status} value={status}>{t(label)}</option>)}</select>
            <select data-collection-item-size aria-label={t('每页商品数')} value={itemQuery.pageSize} onChange={event => setItemQuery(current => ({ ...current, pageSize: Number(event.target.value), page: 1 }))} className="rounded border p-2 text-sm">{[25, 50, 100].map(size => <option key={size} value={size}>{t('每页 {count} 条', { count: size })}</option>)}</select>
            <button data-collection-item-export type="button" className="btn-secondary" onClick={exportItems}>{t('导出筛选商品 CSV')}</button>
          </div>
          <p className="mb-3 text-xs text-slate-500">{t('CSV 包含全部筛选结果，不限当前页；状态代码和原始错误保留，公式样式文本添加安全前缀。')}</p>
          <div className="max-h-[540px] overflow-auto"><table data-collection-items className="min-w-full text-left text-sm"><thead className="sticky top-0 bg-white"><tr className="border-b border-slate-200 text-xs text-slate-500"><th className="px-3 py-2">SKU</th><th className="px-3 py-2">{t("标题")}</th><th className="px-3 py-2">{t("销量")}</th><th className="px-3 py-2">{t("状态")}</th><th className="px-3 py-2">{t("图片")}</th><th className="px-3 py-2">{t("说明")}</th></tr></thead><tbody>{itemPage.items.map((item) => <tr data-collection-item={item.id} key={item.id} className="border-b border-slate-100"><td className="px-3 py-3 font-medium text-ink">{item.sku}</td><td className="max-w-xs truncate px-3 py-3 text-slate-600" title={item.title || ''}>{item.title || '-'}</td><td className="px-3 py-3 text-slate-600">{item.sales ?? '-'}</td><td className="px-3 py-3"><span className={item.status === 'completed' ? 'text-emerald-700' : item.status === 'failed' ? 'text-red-700' : item.status === 'skipped' ? 'text-slate-500' : 'text-amber-700'}>{Object.hasOwn(collectionStatuses, item.status) ? t(collectionStatusLabel(item.status)) : item.status}</span></td><td className="px-3 py-3 text-slate-600">{(item.images || []).filter((image) => image.status === 'success').length}/{item.imageUrls?.length || 0}</td><td className="max-w-xs px-3 py-3 text-xs text-slate-500">{item.error?.message || item.pageWarning?.message || (item.status === 'completed' ? <span className="inline-flex items-center gap-1 text-emerald-700"><CheckCircle2 size={13} />{t("完成")}</span> : '-')}</td></tr>)}</tbody></table></div>
          {!itemPage.total && <p data-collection-items-empty className="p-3 text-sm text-slate-500">{t('没有符合筛选条件的商品。')}</p>}
          <div className="mt-3 flex items-center gap-3 text-sm"><button data-collection-item-prev type="button" className="btn-secondary" disabled={itemPage.page <= 1} onClick={() => setItemQuery(current => ({ ...current, page: itemPage.page - 1 }))}>{t('上一页')}</button><span data-collection-item-pagination>{t('第 {page} / {pages} 页 · 共 {total} 条', { page: itemPage.page, pages: itemPage.pages, total: itemPage.total })}</span><button data-collection-item-next type="button" className="btn-secondary" disabled={itemPage.page >= itemPage.pages} onClick={() => setItemQuery(current => ({ ...current, page: itemPage.page + 1 }))}>{t('下一页')}</button></div>
        </Section>
      </>}
    </div>
  );
}
