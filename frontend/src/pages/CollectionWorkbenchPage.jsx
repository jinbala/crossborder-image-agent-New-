import { useLocale } from '../i18n/LocaleProvider.jsx';
import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, CheckCircle2, Download, FileSpreadsheet, LoaderCircle, Play, RefreshCw, ShieldCheck } from 'lucide-react';
import Section from '../components/Section.jsx';
import { ASSET_BASE, api } from '../services/api.js';
import { useAccount } from '../components/AuthGate.jsx';
import { assertCollectionDraftContext, recoverCollectionDraft } from '../utils/collectionDraft.js';
import { Link } from 'react-router-dom';
import { collectionResultGuide, collectionPreviewPage } from '../utils/collectionResults.js';

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

const STATUS_TEXT = {
  queued: '等待执行',
  running: '执行中',
  paused: '已保存断点',
  completed: '已完成',
  completed_with_errors: '完成但有失败',
  pending: '待处理',
  failed: '失败',
  skipped: '已跳过'
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
  const [draftContext, setDraftContext] = useState(null);
  const [draftLoading, setDraftLoading] = useState(true);
  const creating = useRef(false);

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
    if (!job) return;
    setBusy(retryFailed ? 'retry' : 'run'); setError('');
    try { setJob(await api.runCollectionJob(job.id, { limit: 10, retryFailed })); }
    catch (runError) { setError(runError.message); }
    finally { setBusy(''); }
  }

  async function runContinuously() {
    if (!job) return;
    setBusy('all'); setError('');
    try {
      let current = job;
      for (let batch = 0; batch < 500 && (current.summary?.pendingCount || 0) > 0; batch += 1) {
        const before = current.summary?.pendingCount || 0;
        current = await api.runCollectionJob(current.id, { limit: 10 });
        setJob(current);
        if ((current.summary?.pendingCount || 0) >= before) break;
      }
    } catch (runError) { setError(runError.message); }
    finally { setBusy(''); }
  }

  async function refresh() {
    if (!job) return;
    setBusy('refresh'); setError('');
    try { setJob(await api.getCollectionJob(job.id)); }
    catch (refreshError) { setError(refreshError.message); }
    finally { setBusy(''); }
  }

  const summary = job?.summary || {};
  const nextStep = collectionResultGuide(job);
  const previews = collectionPreviewPage(job, previewPage);
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
        <section data-collection-next-step={nextStep.kind} className="space-y-3 rounded-lg border-2 border-teal-600 bg-teal-50 p-4">
          <h2 className="font-semibold text-teal-950">{t(nextStep.title)}</h2>
          <p className="text-sm leading-6 text-teal-950">{t(nextStep.description)}</p>
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
            {[['状态', t(STATUS_TEXT[job.status] || job.status)], ['总数', summary.inputCount || 0], ['完成', summary.completedCount || 0], ['有警告', summary.warningCount || 0], ['失败', summary.failedCount || 0], ['跳过', summary.skippedCount || 0], ['已下载', summary.downloadedCount || 0]].map(([label, value]) => <div key={label} className="rounded-lg border border-slate-200 bg-slate-50 p-3"><div className="text-xs text-slate-500">{t(label)}</div><div className="mt-1 text-lg font-semibold text-ink">{value}</div></div>)}
          </div>
          <div className="mt-4 flex flex-wrap gap-2">
            {summary.pendingCount > 0 && <button type="button" onClick={runContinuously} disabled={Boolean(busy)} className="focus-ring inline-flex items-center gap-2 rounded bg-mint px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">{busy === 'all' ? <LoaderCircle className="animate-spin" size={17} /> : <Play size={17} />}{t("连续处理全部")}</button>}
            {summary.pendingCount > 0 && <button type="button" onClick={() => runBatch()} disabled={Boolean(busy)} className="focus-ring inline-flex items-center gap-2 rounded bg-ink px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">{busy === 'run' ? <LoaderCircle className="animate-spin" size={17} /> : <Play size={17} />}{t("处理下一批 10 个商品")}</button>}
            {retryable && <button type="button" onClick={() => runBatch({ retryFailed: true })} disabled={Boolean(busy)} className="focus-ring inline-flex items-center gap-2 rounded border border-amber-300 bg-amber-50 px-4 py-2 text-sm font-semibold text-amber-900 disabled:opacity-50">{busy === 'retry' ? <LoaderCircle className="animate-spin" size={17} /> : <RefreshCw size={17} />}{t("重试失败项")}</button>}
            {job.downloadUrl && <a href={`${ASSET_BASE}${job.downloadUrl}`} className="focus-ring inline-flex items-center gap-2 rounded bg-emerald-700 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-800"><Download size={17} />{t("下载当前 ZIP")}</a>}
            <button type="button" onClick={() => { setJob(null); setFile(null); setManualUrls(''); setError(''); }} disabled={Boolean(busy)} className="focus-ring rounded border border-slate-300 px-4 py-2 text-sm text-slate-600">{t("新建任务")}</button>
          </div>
          <p className="mt-3 text-xs leading-5 text-slate-500">{t("每处理一张图片和一个商品都会更新 manifest；浏览器关闭后，可通过最近任务重新打开并继续。")}</p>
        </Section>

        <Section title={t("商品明细")}>
          <div className="max-h-[540px] overflow-auto"><table className="min-w-full text-left text-sm"><thead className="sticky top-0 bg-white"><tr className="border-b border-slate-200 text-xs text-slate-500"><th className="px-3 py-2">SKU</th><th className="px-3 py-2">{t("标题")}</th><th className="px-3 py-2">{t("销量")}</th><th className="px-3 py-2">{t("状态")}</th><th className="px-3 py-2">{t("图片")}</th><th className="px-3 py-2">{t("说明")}</th></tr></thead><tbody>{job.items.map((item) => <tr key={item.id} className="border-b border-slate-100"><td className="px-3 py-3 font-medium text-ink">{item.sku}</td><td className="max-w-xs truncate px-3 py-3 text-slate-600">{item.title || '-'}</td><td className="px-3 py-3 text-slate-600">{item.sales ?? '-'}</td><td className="px-3 py-3"><span className={item.status === 'completed' ? 'text-emerald-700' : item.status === 'failed' ? 'text-red-700' : item.status === 'skipped' ? 'text-slate-500' : 'text-amber-700'}>{t(STATUS_TEXT[item.status] || item.status)}</span></td><td className="px-3 py-3 text-slate-600">{(item.images || []).filter((image) => image.status === 'success').length}/{item.imageUrls?.length || 0}</td><td className="max-w-xs px-3 py-3 text-xs text-slate-500">{item.error?.message || item.pageWarning?.message || (item.status === 'completed' ? <span className="inline-flex items-center gap-1 text-emerald-700"><CheckCircle2 size={13} />{t("完成")}</span> : '-')}</td></tr>)}</tbody></table></div>
        </Section>
      </>}
    </div>
  );
}
