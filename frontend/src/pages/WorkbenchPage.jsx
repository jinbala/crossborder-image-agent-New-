import { useLocale } from '../i18n/LocaleProvider.jsx';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Archive, CheckCircle2, CircleDashed, ClipboardList, Download, ExternalLink, FileImage, LoaderCircle, RefreshCw, ShieldCheck } from 'lucide-react';
import Section from '../components/Section.jsx';
import { ASSET_BASE, api } from '../services/api.js';

const STATUS_STYLE = {
  available: 'border-emerald-200 bg-emerald-50 text-emerald-700',
  'available-existing': 'border-cyan-200 bg-cyan-50 text-cyan-700',
  'available-runtime-required': 'border-indigo-200 bg-indigo-50 text-indigo-700',
  planned: 'border-amber-200 bg-amber-50 text-amber-700',
  'not-connected': 'border-slate-200 bg-slate-100 text-slate-600'
};
const STATUS_TEXT = { available: '本版可用', 'available-existing': '已有能力', 'available-runtime-required': '需浏览器实测', planned: '后续开发', 'not-connected': '未接入' };

const JOB_STATUS_TEXT = {
  queued: '等待执行',
  running: '执行中',
  paused: '可续跑',
  completed: '已完成',
  completed_with_errors: '完成但有失败',
  planned: '已计划'
};

function formatBytes(value = 0) {
  if (!Number.isFinite(Number(value))) return '-';
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

function formatTime(value) {
  if (!value) return '-';
  return new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(value));
}

function StatusBadge({ module }) {
  const { t, dateTime } = useLocale();
  return <span className={`rounded-full border px-2 py-1 text-xs font-medium ${STATUS_STYLE[module.status] || STATUS_STYLE['not-connected']}`}>{t(STATUS_TEXT[module.status] || module.status)}</span>;
}

function JobRow({ job }) {
  const { t, dateTime } = useLocale();
  const isPack = job.type === 'image-pack' || job.type === 'sku-pack' || job.type === 'collection-job';
  const typeLabel = {
    'image-pack': '图包处理',
    'sku-pack': 'SKU 文件夹图包',
    'collection-plan': '采集计划',
    'collection-job': '采集下载任务',
    'listing-dry-run': '刊登预演',
    'pricing-preview': '调价预览'
  }[job.type] || job.type;
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 py-3 last:border-0">
      <div className="flex min-w-0 items-center gap-3">
        <span className={`grid h-9 w-9 shrink-0 place-items-center rounded ${isPack ? 'bg-teal-50 text-mint' : 'bg-indigo-50 text-indigo-600'}`}>
          {isPack ? <Archive size={18} /> : <ClipboardList size={18} />}
        </span>
        <div className="min-w-0">
          <div className="truncate font-medium text-ink">{job.name}</div>
          <div className="mt-0.5 text-xs text-slate-500">{t(typeLabel)} · {job.summary?.inputCount || 0}{" " + t("项 ·") + " "}{dateTime(job.createdAt)}</div>
        </div>
      </div>
      <div className="flex items-center gap-2">
        <span className="inline-flex items-center gap-1 text-xs text-emerald-700">
          {job.status === 'completed' ? <CheckCircle2 size={14} /> : <CircleDashed size={14} />}
          {t(JOB_STATUS_TEXT[job.status] || job.status)}
        </span>
        {job.downloadUrl && (
          <a href={`${ASSET_BASE}${job.downloadUrl}`} className="focus-ring inline-flex items-center gap-1 rounded border border-slate-300 px-2.5 py-1.5 text-xs font-medium text-slate-700 hover:border-mint hover:text-mint">
            <Download size={14} />{" " + t("下载")}{isPack ? ' ZIP' : ' CSV'}
          </a>
        )}
        {job.type === 'collection-job' && <a href={`/workbench/collection?jobId=${encodeURIComponent(job.id)}`} className="focus-ring rounded border border-indigo-200 px-2.5 py-1.5 text-xs font-medium text-indigo-700 hover:bg-indigo-50">{t("打开/续跑")}</a>}
        {job.manifestUrl && <a href={`${ASSET_BASE}${job.manifestUrl}`} target="_blank" rel="noreferrer" className="text-slate-400 hover:text-mint" title={t("查看任务清单")}><ExternalLink size={16} /></a>}
      </div>
    </div>
  );
}

export default function WorkbenchPage() {
  const { t, dateTime } = useLocale();
  const [overview, setOverview] = useState(null);
  const [jobs, setJobs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [packBusy, setPackBusy] = useState(false);
  const [planBusy, setPlanBusy] = useState(false);
  const [files, setFiles] = useState([]);
  const [fileInputKey, setFileInputKey] = useState(0);
  const [packOptions, setPackOptions] = useState({ name: '', prefix: 'image', format: 'jpeg', quality: 88, maxDimension: 1600, square: false, squareSize: 1600, background: '#ffffff' });
  const [planName, setPlanName] = useState('');
  const [sourceUrls, setSourceUrls] = useState('');

  const refresh = useCallback(async () => {
    const [nextOverview, nextJobs] = await Promise.all([api.getWorkbenchOverview(), api.listWorkbenchJobs()]);
    setOverview(nextOverview);
    setJobs(Array.isArray(nextJobs) ? nextJobs : []);
  }, []);

  useEffect(() => {
    let active = true;
    refresh().catch((err) => { if (active) setError(err.message); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [refresh]);

  const selectedBytes = useMemo(() => files.reduce((sum, file) => sum + file.size, 0), [files]);

  async function submitPack(event) {
    event.preventDefault();
    if (files.length === 0) return setError(t("请先选择要处理的图片。"));
    setPackBusy(true); setError(''); setNotice('');
    try {
      const result = await api.createImagePack(files, packOptions);
      setNotice(t("图包“{value0}”已完成，共输出 {value1} 张图片。", { value0: (result.name), value1: (result.summary.outputCount) }));
      setFiles([]); setFileInputKey((value) => value + 1);
      await refresh();
    } catch (err) { setError(err.message); } finally { setPackBusy(false); }
  }

  async function submitPlan(event) {
    event.preventDefault();
    const urls = sourceUrls.split(/\r?\n/).map((value) => value.trim()).filter(Boolean);
    setPlanBusy(true); setError(''); setNotice('');
    try {
      const result = await api.createCollectionPlan({ name: planName, urls });
      setNotice(t("采集计划“{value0}”已保存，共 {value1} 个来源链接。", { value0: (result.name), value1: (result.summary.inputCount) }));
      setPlanName(''); setSourceUrls('');
      await refresh();
    } catch (err) { setError(err.message); } finally { setPlanBusy(false); }
  }

  return (
    <div className="space-y-5">
      <section className="overflow-hidden rounded-xl border border-slate-200 bg-gradient-to-br from-slate-950 via-slate-900 to-teal-950 px-6 py-7 text-white shadow-sm">
        <div className="flex flex-wrap items-start justify-between gap-5">
          <div className="max-w-3xl">
            <div className="mb-3 inline-flex items-center gap-2 rounded-full border border-white/15 bg-white/10 px-3 py-1 text-xs text-teal-100"><ShieldCheck size={14} />{" " + t("Clean-room 功能复刻 · 本地优先")}</div>
            <h1 className="text-2xl font-semibold tracking-tight">{t("跨境图片运营工作台")}</h1>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-300">{t("先打通图包整理、任务清单和结果导出。当前不会登录店铺、绕过验证码，也不会自动发布商品或修改线上价格。")}</p>
          </div>
          <div className="rounded-lg border border-white/10 bg-white/5 px-4 py-3 text-right">
            <div className="text-xs text-slate-400">{t("当前里程碑")}</div>
            <div className="mt-1 font-semibold text-teal-200">{t("M4 · SKU 文件夹图包")}</div>
            <div className="mt-3 flex flex-wrap justify-end gap-2">
              <a href="/workbench/collection" className="inline-flex rounded bg-indigo-300 px-3 py-2 text-xs font-semibold text-slate-950 hover:bg-indigo-200">{t("采集下载 →")}</a>
              <a href="/workbench/sku-pack" className="inline-flex rounded bg-teal-300 px-3 py-2 text-xs font-semibold text-slate-950 hover:bg-teal-200">{t("SKU 图包 →")}</a>
              <a href="/workbench/materials" className="inline-flex rounded bg-white px-3 py-2 text-xs font-semibold text-slate-900 hover:bg-teal-50">{t("素材与模板 →")}</a>
              <a href="/workbench/commerce" className="inline-flex rounded border border-white/20 px-3 py-2 text-xs font-semibold text-white hover:bg-white/10">{t("刊登与调价 →")}</a>
            </div>
          </div>
        </div>
      </section>

      {error && <div className="rounded border border-red-200 bg-red-50 p-3 text-sm text-red-700">{error}</div>}
      {notice && <div className="rounded border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-800">{notice}</div>}

      <div className="grid gap-5 xl:grid-cols-[1.35fr_0.65fr]">
        <Section title={t("图包处理")}>
          <form onSubmit={submitPack} className="space-y-5">
            <label className="block cursor-pointer rounded-lg border-2 border-dashed border-slate-300 bg-slate-50 p-6 text-center transition hover:border-mint hover:bg-teal-50/40">
              <FileImage className="mx-auto text-mint" size={30} />
              <div className="mt-2 font-medium text-ink">{t("选择 JPG、PNG 或 WebP 图片")}</div>
              <div className="mt-1 text-xs text-slate-500">{t("最多 100 张，单张 15MB，按选择顺序编号")}</div>
              <input key={fileInputKey} type="file" accept="image/jpeg,image/png,image/webp" multiple className="sr-only" onChange={(event) => setFiles(Array.from(event.target.files || []))} />
              {files.length > 0 && <div className="mt-3 text-sm font-medium text-teal-800">{t("已选") + " "}{files.length}{" " + t("张，共") + " "}{formatBytes(selectedBytes)}</div>}
            </label>
            <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
              <label className="text-sm text-slate-600">{t("任务名称")}<input value={packOptions.name} onChange={(e) => setPackOptions({ ...packOptions, name: e.target.value })} placeholder={t("例如：秋季女装主图")} className="focus-ring mt-1 w-full rounded border border-slate-300 px-3 py-2 text-ink" /></label>
              <label className="text-sm text-slate-600">{t("文件名前缀")}<input value={packOptions.prefix} onChange={(e) => setPackOptions({ ...packOptions, prefix: e.target.value })} className="focus-ring mt-1 w-full rounded border border-slate-300 px-3 py-2 text-ink" /></label>
              <label className="text-sm text-slate-600">{t("输出格式")}<select value={packOptions.format} onChange={(e) => setPackOptions({ ...packOptions, format: e.target.value })} className="focus-ring mt-1 w-full rounded border border-slate-300 px-3 py-2 text-ink"><option value="jpeg">JPG</option><option value="png">PNG</option><option value="webp">WebP</option></select></label>
              <label className="text-sm text-slate-600">{t("画质（40–100）")}<input type="number" min="40" max="100" value={packOptions.quality} onChange={(e) => setPackOptions({ ...packOptions, quality: e.target.value })} className="focus-ring mt-1 w-full rounded border border-slate-300 px-3 py-2 text-ink" /></label>
              <label className="text-sm text-slate-600">{t("最长边（像素）")}<input type="number" min="320" max="6000" value={packOptions.maxDimension} disabled={packOptions.square} onChange={(e) => setPackOptions({ ...packOptions, maxDimension: e.target.value })} className="focus-ring mt-1 w-full rounded border border-slate-300 px-3 py-2 text-ink disabled:bg-slate-100" /></label>
              <label className="flex items-end gap-2 rounded border border-slate-200 px-3 py-2 text-sm text-slate-700"><input type="checkbox" checked={packOptions.square} onChange={(e) => setPackOptions({ ...packOptions, square: e.target.checked })} className="h-4 w-4 accent-teal-700" />{t("输出方图（")}{packOptions.squareSize}px）</label>
            </div>
            {packOptions.square && <div className="grid gap-4 rounded bg-slate-50 p-4 sm:grid-cols-2">
              <label className="text-sm text-slate-600">{t("方图尺寸")}<input type="number" min="320" max="6000" value={packOptions.squareSize} onChange={(e) => setPackOptions({ ...packOptions, squareSize: e.target.value })} className="focus-ring mt-1 w-full rounded border border-slate-300 px-3 py-2 text-ink" /></label>
              {packOptions.format === 'jpeg' && <label className="text-sm text-slate-600">{t("补边颜色")}<input type="color" value={packOptions.background} onChange={(e) => setPackOptions({ ...packOptions, background: e.target.value })} className="mt-1 h-10 w-full rounded border border-slate-300 bg-white p-1" /></label>}
            </div>}
            <button disabled={packBusy || files.length === 0} className="focus-ring inline-flex items-center gap-2 rounded bg-mint px-4 py-2.5 text-sm font-semibold text-white hover:bg-teal-800 disabled:cursor-not-allowed disabled:opacity-50">{packBusy ? <LoaderCircle className="animate-spin" size={17} /> : <Archive size={17} />}{packBusy ? t("正在处理并打包…") : t("开始处理图包")}</button>
          </form>
        </Section>

        <Section title={t("采集计划")}>
          <form onSubmit={submitPlan} className="space-y-4">
            <p className="text-sm leading-6 text-slate-600">{t("把商品页或素材页链接整理成可追踪清单。此处只保存计划，不主动抓取受限页面。")}</p>
            <label className="block text-sm text-slate-600">{t("计划名称")}<input value={planName} onChange={(e) => setPlanName(e.target.value)} placeholder={t("例如：竞品主图参考")} className="focus-ring mt-1 w-full rounded border border-slate-300 px-3 py-2 text-ink" /></label>
            <label className="block text-sm text-slate-600">{t("来源链接（每行一个）")}<textarea value={sourceUrls} onChange={(e) => setSourceUrls(e.target.value)} rows="8" placeholder={'https://example.com/product/1\nhttps://example.com/product/2'} className="focus-ring mt-1 w-full resize-y rounded border border-slate-300 px-3 py-2 font-mono text-xs text-ink" /></label>
            <button disabled={planBusy || !sourceUrls.trim()} className="focus-ring inline-flex items-center gap-2 rounded bg-ink px-4 py-2.5 text-sm font-semibold text-white hover:bg-slate-700 disabled:opacity-50">{planBusy ? <LoaderCircle className="animate-spin" size={17} /> : <ClipboardList size={17} />}{t("保存采集计划")}</button>
          </form>
        </Section>
      </div>

      <div className="grid gap-5 lg:grid-cols-2">
        <Section title={t("功能复刻地图")}>
          {loading ? <div className="text-sm text-slate-500">{t("正在加载…")}</div> : <div className="grid gap-3 sm:grid-cols-2">{(overview?.modules || []).map((module) => <div key={module.id} className="rounded-lg border border-slate-200 p-4"><div className="flex items-start justify-between gap-3"><div className="font-medium text-ink">{module.name}</div><StatusBadge module={module} /></div><p className="mt-2 text-sm leading-5 text-slate-500">{module.description}</p></div>)}</div>}
        </Section>
        <Section title={t("最近任务")} actions={<button onClick={() => refresh().catch((err) => setError(err.message))} className="focus-ring inline-flex items-center gap-1 rounded px-2 py-1 text-xs text-slate-500 hover:text-mint"><RefreshCw size={14} />{" " + t("刷新")}</button>}>
          {jobs.length === 0 ? <div className="py-8 text-center text-sm text-slate-500">{t("还没有任务，先处理一个图包或保存采集计划。")}</div> : jobs.slice(0, 8).map((job) => <JobRow key={job.id} job={job} />)}
        </Section>
      </div>
    </div>
  );
}
