import { useLocale } from '../i18n/LocaleProvider.jsx';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Archive, ArrowLeft, CheckCircle2, Download, FileImage, FolderOpen, GripVertical, LoaderCircle } from 'lucide-react';
import Section from '../components/Section.jsx';
import { ASSET_BASE, api } from '../services/api.js';
import { collectionPackFiles, collectionPackPayload, approveSkuPackMatting } from '../utils/collectionPack.js';
import { skuResultStatuses, skuResultsPage, skuResultsCsv } from '../utils/skuPackResults.js';

const DEFAULT_OPTIONS = {
  name: '',
  orderMode: 'name',
  randomSeed: 'xingya-pack-seed',
  namingTemplate: '{sku}-{role}-{index}',
  randomFileNames: false,
  format: 'jpeg',
  quality: 88,
  targetKilobytes: 0,
  maxDimension: 2000,
  squareSize: 1600,
  background: '#ffffff',
  preserveOriginals: true,
  preprocessOriginals: false,
  generateSquare: true,
  matteImages: false,
  mattingProvider: 'sharp',
  confirmPaidMatting: false,
  mattingFallbackToSharp: true,
  deduplicateImages: false,
  duplicateThreshold: 4,
  visualRoleRecognition: false
};

const ROLE_LABELS = {
  main: '主图',
  additional: '附图',
  square: '方形图',
  swatch: '色块图',
  detail: '细节图',
  variant: '变种图',
  general: '通用图'
};

function formatBytes(value = 0) {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

function relativePathOf(file) {
  return (file.webkitRelativePath || file.name || '').replaceAll('\\', '/');
}

function estimateSkus(files) {
  const paths = files.map(relativePathOf).filter(Boolean);
  if (!paths.length) return [];
  const parts = paths.map((value) => value.split('/').filter(Boolean));
  const commonRoot = parts[0]?.[0];
  const stripRoot = commonRoot && parts.every((item) => item.length >= 3 && item[0].toLowerCase() === commonRoot.toLowerCase());
  return [...new Set(parts.map((item) => (stripRoot ? item[1] : (item.length > 1 ? item[0] : 'UNGROUPED'))))];
}

function parseMetadata(text) {
  const metadata = {};
  for (const [lineIndex, rawLine] of String(text || '').split(/\r?\n/).entries()) {
    if (!rawLine.trim()) continue;
    const cells = rawLine.split(rawLine.includes('\t') ? '\t' : '|').map((value) => value.trim());
    if (lineIndex === 0 && cells[0]?.toLowerCase() === 'sku') continue;
    if (!cells[0]) continue;
    metadata[cells[0]] = cells.length >= 5
      ? { spu: cells[1] || '', spec: cells[2] || '', variantSku: cells[3] || '', title: cells[4] || '' }
      : { spu: cells[1] || '', spec: '', variantSku: cells[2] || '', title: cells[3] || '' };
  }
  return metadata;
}

function parseRoleOverrides(text) {
  const roleAliases = { 主图: 'main', 附图: 'additional', 方图: 'square', 方形图: 'square', 色块图: 'swatch', 细节图: 'detail', 变种图: 'variant', 通用图: 'general' };
  const valid = new Set(Object.keys(ROLE_LABELS));
  return Object.fromEntries(String(text || '').split(/\r?\n/).map((line) => {
    const [filePath, rawRole] = line.split('|').map((value) => value.trim());
    const role = roleAliases[rawRole] || rawRole;
    return [filePath, valid.has(role) ? role : ''];
  }).filter(([filePath, role]) => filePath && role));
}

function Field({ label, children }) {
  return <label className="block text-sm text-slate-600"><span>{label}</span>{children}</label>;
}

function Toggle({ checked, onChange, title, description }) {
  return (
    <label className="flex cursor-pointer gap-3 rounded-lg border border-slate-200 bg-white p-3">
      <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} className="mt-0.5 h-4 w-4 shrink-0 accent-teal-700" />
      <span><span className="block text-sm font-medium text-ink">{title}</span><span className="mt-0.5 block text-xs leading-5 text-slate-500">{description}</span></span>
    </label>
  );
}

export default function SkuPackPage() {
  const { t } = useLocale();
  const [files, setFiles] = useState([]);
  const [inputKey, setInputKey] = useState(0);
  const [options, setOptions] = useState(DEFAULT_OPTIONS);
  const [metadataText, setMetadataText] = useState('');
  const [roleText, setRoleText] = useState('');
  const [mattingConfig, setMattingConfig] = useState(null);
  const [metadataBusy, setMetadataBusy] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState(null);
  const [resultQuery, setResultQuery] = useState({ q: '', status: '', page: 1, pageSize: 25 });
  const resultPage = skuResultsPage(result, resultQuery);
  useEffect(() => { setResultQuery({ q: '', status: '', page: 1, pageSize: 25 }); }, [result?.id]);
  const [dragIndex, setDragIndex] = useState(null);
  const [keepDuplicates, setKeepDuplicates] = useState([]);
  const [searchParams, setSearchParams] = useSearchParams();
  const collectionJobId = searchParams.get('collectionJobId') || '';
  const [sourcePreview, setSourcePreview] = useState(null);
  const [sourceLoading, setSourceLoading] = useState(false);
  const [confirmPartial, setConfirmPartial] = useState(false);
  const [sourceRevision, setSourceRevision] = useState(0);
  const submitting = useRef(false);
  const selectedBytes = useMemo(() => files.reduce((sum, file) => sum + (file.size || 0), 0), [files]);
  const skuNames = useMemo(() => estimateSkus(files), [files]);
  const metadataCount = useMemo(() => Object.keys(parseMetadata(metadataText)).length, [metadataText]);

  useEffect(() => {
    let active = true;
    setSourcePreview(null); setConfirmPartial(false); setFiles([]); setResult(null); setError(''); setKeepDuplicates([]);
    if (!collectionJobId) { setSourceLoading(false); return; }
    setSourceLoading(true);
    api.previewCollectionPack(collectionJobId).then(preview => {
      if (!active) return;
      const inputs = collectionPackFiles(preview);
      setSourcePreview(preview); setFiles(inputs);
    }).catch(error => { if (active) setError(error.message); }).finally(() => { if (active) setSourceLoading(false); });
    return () => { active = false; };
  }, [collectionJobId, sourceRevision]);

  useEffect(() => {
    let active = true;
    api.getMattingConfig().then((config) => { if (active) setMattingConfig(config); }).catch(() => {});
    return () => { active = false; };
  }, []);

  function patchOptions(patch) {
    setOptions((current) => ({ ...current, ...patch }));
  }

  function chooseFiles(event) {
    const selected = Array.from(event.target.files || []).filter((file) => /^image\/(jpeg|png|webp)$/i.test(file.type));
    setFiles(selected);
    setKeepDuplicates([]);
    setResult(null);
    setError(selected.length > 300 ? t("单次最多处理 300 张图片，请拆分文件夹后重试。") : '');
  }

  function moveFile(fromIndex, toIndex) {
    if (fromIndex === null || fromIndex === toIndex || fromIndex < 0 || toIndex < 0 || toIndex >= files.length) return;
    setFiles((current) => {
      const next = [...current];
      const [moved] = next.splice(fromIndex, 1);
      next.splice(toIndex, 0, moved);
      return next;
    });
    patchOptions({ orderMode: 'manual' });
    setDragIndex(null);
  }

  async function submit(event) {
    event.preventDefault();
    if (!files.length || files.length > 300 || submitting.current || sourceLoading) return;
    if (collectionJobId && (!sourcePreview || (sourcePreview.partial && !confirmPartial) || !window.confirm(t('确认使用本任务已验证的本地图片生成图包？原采集图片不修改，相同来源和规则重试会返回原图包。')))) return;
    submitting.current = true;
    setBusy(true);
    setError('');
    setResult(null);
    try {
      const packOptions = {
        ...options,
        keepDuplicates,
        manualOrder: files.map(relativePathOf),
        metadata: { ...(sourcePreview?.metadata || {}), ...parseMetadata(metadataText) },
        roleOverrides: parseRoleOverrides(roleText)
      };
      if (!await approveSkuPackMatting(api, packOptions, { target: options.name || collectionJobId || t('SKU 文件夹图包处理'), count: files.length }, t, message => window.confirm(message))) return;
      const created = collectionJobId
        ? await api.createCollectionPack(collectionJobId, collectionPackPayload(sourcePreview, packOptions, confirmPartial))
        : await api.createSkuPack(files, packOptions);
      setResult(created);
    } catch (submitError) {
      setError(submitError.message);
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }

  function reset() {
    setFiles([]);
    setInputKey((value) => value + 1);
    setResult(null);
    setError('');
  }

  function exportResults() {
    const url = URL.createObjectURL(new Blob([skuResultsCsv(result, resultQuery)], { type: 'text/csv;charset=utf-8' }));
    const link = document.createElement('a'); link.href = url; link.download = `sku-pack-${result.id.replace(/[^A-Za-z0-9_-]/g, '_')}-results.csv`;
    document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  async function importMetadata(event) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    setMetadataBusy(true); setError('');
    try {
      const imported = await api.importSkuMetadata(file);
      setMetadataText(imported.records.map((record) => [record.sku, record.spu, record.spec, record.variantSku, record.title].join(' | ')).join('\n'));
    } catch (importError) { setError(importError.message); }
    finally { setMetadataBusy(false); }
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <a href="/workbench" className="focus-ring inline-flex items-center gap-1 text-sm text-slate-500 hover:text-mint"><ArrowLeft size={16} />{" " + t("返回运营工作台")}</a>
          <h1 className="mt-2 text-2xl font-semibold text-ink">{t("SKU 文件夹图包处理")}</h1>
          <p className="mt-1 text-sm text-slate-500">{t("整目录导入，按 SKU 分组、识别图片角色、压缩改名并生成可下载 ZIP。")}</p>
        </div>
        <div className="rounded-lg border border-teal-200 bg-teal-50 px-4 py-2 text-sm text-teal-800">{t("本地 Sharp 处理，不上传店铺")}</div>
      </div>

      {error && <div role="alert" className="rounded border border-red-200 bg-red-50 p-3 text-sm text-red-700">{error}</div>}

      {collectionJobId && <section data-collection-pack-source className="space-y-3 rounded-lg border-2 border-teal-600 bg-teal-50 p-4">
        <h2 className="font-semibold">{t('使用采集任务的本地图片')}</h2>
        <p className="break-all text-sm">{sourcePreview?.name || collectionJobId}</p>
        <p className="text-sm">{t('无需下载、解压或重新上传图片；先核对来源与下方规则，点击生成并确认后才开始处理。')}</p>
        {sourceLoading && <p role="status">{t('正在校验来源图片与散列…')}</p>}
        {sourcePreview && <p data-collection-pack-count>{t('已验证 {count} 张图片 · {skus} 个 SKU', { count: sourcePreview.imageCount, skus: sourcePreview.skuCount })}</p>}
        {sourcePreview?.partial && <label className="flex gap-2 text-sm text-amber-950"><input data-collection-pack-partial type="checkbox" checked={confirmPartial} disabled={busy} onChange={event => setConfirmPartial(event.target.checked)} />{t('采集尚未全部成功；我确认仅处理本次已收到并通过校验的图片。')}</label>}
        <div className="flex flex-wrap gap-3"><button data-collection-pack-refresh type="button" disabled={busy || sourceLoading} className="btn-secondary" onClick={() => setSourceRevision(value => value + 1)}>{t('重新校验来源')}</button><button type="button" disabled={busy} className="btn-secondary" onClick={() => setSearchParams({})}>{t('改为手动选择文件夹')}</button><Link to={`/workbench/collection?jobId=${encodeURIComponent(collectionJobId)}`} className="btn-secondary">{t('返回来源采集任务')}</Link></div>
      </section>}

      <form onSubmit={submit} className="space-y-5">
        <fieldset disabled={busy || sourceLoading} className="space-y-5 disabled:opacity-60">
        <Section title={t("1. 选择 SKU 根文件夹")}>
          {!collectionJobId && <label className="block cursor-pointer rounded-xl border-2 border-dashed border-slate-300 bg-slate-50 px-6 py-8 text-center hover:border-mint hover:bg-teal-50/50">
            <FolderOpen className="mx-auto text-mint" size={34} />
            <div className="mt-2 font-medium text-ink">{t("选择包含多个 SKU 子文件夹的目录")}</div>
            <div className="mt-1 text-xs text-slate-500">{t("目录结构示例：图包根目录 / SKU-001 / 主图1.jpg、详情1.jpg")}</div>
            <input key={inputKey} type="file" accept="image/jpeg,image/png,image/webp" multiple webkitdirectory="" directory="" className="sr-only" onChange={chooseFiles} />
          </label>}
          {files.length > 0 && (
            <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-slate-200 bg-white p-4 text-sm">
              <div className="flex items-center gap-3"><FileImage className="text-mint" size={22} /><div><div className="font-medium text-ink">{files.length}{" " + t("张图片 ·") + " "}{formatBytes(selectedBytes)}</div><div className="text-xs text-slate-500">{t("识别到") + " "}{skuNames.length}{" " + t("个 SKU：")}{skuNames.slice(0, 5).join('、')}{skuNames.length > 5 ? '…' : ''}</div></div></div>
              {!collectionJobId && <button type="button" onClick={reset} className="focus-ring rounded border border-slate-300 px-3 py-1.5 text-xs text-slate-600 hover:text-mint">{t("重新选择")}</button>}
            </div>
          )}
        </Section>

        <div className="grid gap-5 xl:grid-cols-2">
          <Section title={t("2. 排序与命名")}>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label={t("任务名称")}><input value={options.name} onChange={(event) => patchOptions({ name: event.target.value })} placeholder={t("例如：秋季女装图包")} className="focus-ring mt-1 w-full rounded border border-slate-300 px-3 py-2 text-ink" /></Field>
              <Field label={t("图片排序")}><select value={options.orderMode} onChange={(event) => patchOptions({ orderMode: event.target.value })} className="focus-ring mt-1 w-full rounded border border-slate-300 px-3 py-2 text-ink"><option value="name">{t("按文件名自然排序")}</option><option value="upload">{t("按浏览器读取顺序")}</option><option value="random">{t("可复现随机顺序")}</option><option value="manual">{t("手工拖拽顺序")}</option></select></Field>
              {options.orderMode === 'random' && <Field label={t("随机种子")}><input value={options.randomSeed} onChange={(event) => patchOptions({ randomSeed: event.target.value })} className="focus-ring mt-1 w-full rounded border border-slate-300 px-3 py-2 text-ink" /></Field>}
              <Field label={t("文件名模板")}><input value={options.namingTemplate} disabled={options.randomFileNames} onChange={(event) => patchOptions({ namingTemplate: event.target.value })} className="focus-ring mt-1 w-full rounded border border-slate-300 px-3 py-2 font-mono text-xs text-ink disabled:bg-slate-100" /></Field>
            </div>
            <div className="mt-3 rounded bg-slate-50 p-3 text-xs leading-5 text-slate-500">{t("占位符：")}{'{sku}'}、{'{spu}'}、{'{spec}'}、{'{variantSku}'}、{'{title}'}、{'{role}'}、{'{index}'}、{'{random}'}</div>
            {options.orderMode === 'manual' && files.length > 0 && (
              <div className="mt-3 max-h-64 space-y-1 overflow-auto rounded-lg border border-slate-200 bg-slate-50 p-2">
                <div className="px-2 pb-1 text-xs text-slate-500">{t("拖动图片调整顺序；后端会在每个 SKU 内按此顺序处理。")}</div>
                {files.map((file, index) => (
                  <div
                    key={`${relativePathOf(file)}-${file.lastModified}`}
                    draggable
                    onDragStart={() => setDragIndex(index)}
                    onDragOver={(event) => event.preventDefault()}
                    onDrop={() => moveFile(dragIndex, index)}
                    onDragEnd={() => setDragIndex(null)}
                    className={`flex cursor-grab items-center gap-2 rounded border bg-white px-2 py-2 text-xs ${dragIndex === index ? 'border-mint opacity-60' : 'border-slate-200'}`}
                  >
                    <GripVertical size={15} className="shrink-0 text-slate-400" />
                    <span className="w-7 shrink-0 text-right font-mono text-slate-400">{index + 1}</span>
                    <span className="truncate font-mono text-slate-700" title={relativePathOf(file)}>{relativePathOf(file)}</span>
                  </div>
                ))}
              </div>
            )}
            <div className="mt-3"><Toggle checked={options.randomFileNames} onChange={(value) => patchOptions({ randomFileNames: value })} title={t("使用随机文件名")} description={t("同一随机种子和同一输入会生成相同名称，便于复跑核对。")} /></div>
            <div className="mt-3"><Toggle checked={options.visualRoleRecognition} onChange={(value) => patchOptions({ visualRoleRecognition: value })} title={t("图像内容辅助识别角色")} description={t("对没有命名提示的图片分析尺寸、比例和视觉熵，识别强特征色块图/细节图；结果会记录依据和置信度，手工角色仍优先。")} /></div>
          </Section>

          <Section title={t("3. 图片输出")}>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label={t("输出格式")}><select value={options.format} onChange={(event) => patchOptions({ format: event.target.value })} className="focus-ring mt-1 w-full rounded border border-slate-300 px-3 py-2 text-ink"><option value="jpeg">JPG</option><option value="png">PNG</option><option value="webp">WebP</option></select></Field>
              <Field label={t("画质（40–100）")}><input type="number" min="40" max="100" value={options.quality} onChange={(event) => patchOptions({ quality: event.target.value })} className="focus-ring mt-1 w-full rounded border border-slate-300 px-3 py-2 text-ink" /></Field>
              <Field label={t("目标体积 KB（0=关闭）")}><input type="number" min="0" max="5000" value={options.targetKilobytes} onChange={(event) => patchOptions({ targetKilobytes: event.target.value })} className="focus-ring mt-1 w-full rounded border border-slate-300 px-3 py-2 text-ink" /></Field>
              <Field label={t("普通图最长边")}><input type="number" min="320" max="6000" value={options.maxDimension} onChange={(event) => patchOptions({ maxDimension: event.target.value })} className="focus-ring mt-1 w-full rounded border border-slate-300 px-3 py-2 text-ink" /></Field>
              <Field label={t("方图尺寸")}><input type="number" min="320" max="6000" value={options.squareSize} onChange={(event) => patchOptions({ squareSize: event.target.value })} className="focus-ring mt-1 w-full rounded border border-slate-300 px-3 py-2 text-ink" /></Field>
              {options.format === 'jpeg' && <Field label={t("方图补边颜色")}><input type="color" value={options.background} onChange={(event) => patchOptions({ background: event.target.value })} className="mt-1 h-10 w-full rounded border border-slate-300 bg-white p-1" /></Field>}
            </div>
            <div className="mt-4 grid gap-3">
              <Toggle checked={options.preserveOriginals} onChange={(value) => patchOptions({ preserveOriginals: value })} title={t("保留原图")} description={t("在每个 SKU 的 originals 目录中复制一份原始文件。")} />
              <Toggle checked={options.preprocessOriginals} onChange={(value) => patchOptions({ preprocessOriginals: value })} title={t("预处理原图")} description={t("自动旋转方向、限制最长边并按目标格式输出到 preprocessed。")} />
              <Toggle checked={options.generateSquare} onChange={(value) => patchOptions({ generateSquare: value })} title={t("额外生成方图")} description={t("取该 SKU 的首张有效主图，补边生成 square 目录图片。")} />
              <Toggle checked={options.deduplicateImages} onChange={(value) => patchOptions({ deduplicateImages: value })} title={t("感知去重")} description={t("识别相同或近似图片并跳过重复项；manifest 会记录原图路径和感知距离。")} />
            </div>
          </Section>
        </div>

        <Section title={t("4. SKU 替换字段（可选）")}>
          <div className="mb-3 flex flex-wrap items-center justify-between gap-3"><p className="text-sm leading-6 text-slate-500">{t("每行填写：SKU | 货号/SPU | 规格 | 变种 SKU | 商品标题；也可直接导入表格。")}</p><label className="focus-ring cursor-pointer rounded border border-slate-300 bg-white px-3 py-2 text-xs font-medium text-slate-700 hover:border-mint hover:text-mint">{metadataBusy ? t("正在读取…") : t("导入 CSV/XLSX")}<input type="file" accept=".csv,.tsv,.txt,.xlsx" disabled={metadataBusy} onChange={importMetadata} className="sr-only" /></label></div>
          <textarea value={metadataText} onChange={(event) => setMetadataText(event.target.value)} rows="6" placeholder={t("SKU-001 | SPU-100 | 红色/L | RED-L | 红色连衣裙\nSKU-002 | SPU-100 | 蓝色/M | BLUE-M | 蓝色连衣裙")} className="focus-ring w-full resize-y rounded border border-slate-300 px-3 py-2 font-mono text-xs text-ink" />
          <div className="mt-2 text-xs text-slate-500">{t("已读取") + " "}{metadataCount}{" " + t("条替换数据；只有命名模板引用对应占位符时才会使用。")}</div>
        </Section>

        <div className="grid gap-5 xl:grid-cols-2">
          <Section title={t("5. 手工图片角色（可选）")}>
            <p className="mb-3 text-sm leading-6 text-slate-500">{t("每行填写“相对路径 | 角色”。角色支持 main、additional、square、swatch、detail、variant、general，或对应中文名称。手工设置优先于文件名识别。")}</p>
            <textarea value={roleText} onChange={(event) => setRoleText(event.target.value)} rows="7" placeholder={t("图包根目录/SKU-001/正面.jpg | 主图\n图包根目录/SKU-001/面料.jpg | 细节图")} className="focus-ring w-full resize-y rounded border border-slate-300 px-3 py-2 font-mono text-xs text-ink" />
            {files.length > 0 && <div className="mt-2 max-h-24 overflow-auto rounded bg-slate-50 p-2 font-mono text-[11px] text-slate-500">{files.slice(0, 12).map((file) => <div key={relativePathOf(file)}>{relativePathOf(file)}</div>)}</div>}
          </Section>

          <Section title={t("6. 批量抠图（可选）")}>
            <Toggle checked={options.matteImages} onChange={(value) => patchOptions({ matteImages: value, mattingProvider: value ? options.mattingProvider : 'sharp', confirmPaidMatting: false })} title={t("处理前先抠图")} description={t("逐图输出透明主体后再执行压缩、角色归类与方图生成。")} />
            {options.matteImages && <div className="mt-4 space-y-3">
              <Field label={t("抠图方式")}><select value={options.mattingProvider} onChange={(event) => patchOptions({ mattingProvider: event.target.value, confirmPaidMatting: false })} className="focus-ring mt-1 w-full rounded border border-slate-300 px-3 py-2 text-ink"><option value="sharp">{t("Sharp 本地抠图（免费，适合纯色背景）")}</option><option value="rembg" disabled={!mattingConfig?.localAiAvailable}>{t("rembg 本地 AI 高清抠图")}</option><option value="external" disabled={!mattingConfig?.externalConfigured}>{t("外部高清抠图 API")}</option><option value="image2" disabled={!mattingConfig?.image2Available}>{t("Image2 实验抠图")}</option></select></Field>
              {['external', 'image2'].includes(options.mattingProvider) && <Toggle checked={options.confirmPaidMatting} onChange={(value) => patchOptions({ confirmPaidMatting: value })} title={t("我确认可能产生 API 费用")} description={t("未勾选时后端会拒绝执行；不会因为配置了密钥就自动调用。")} />}
              {options.mattingProvider !== 'sharp' && <Toggle checked={options.mattingFallbackToSharp} onChange={(value) => patchOptions({ mattingFallbackToSharp: value })} title={t("失败时回退到 Sharp")} description={t("外部服务单图失败后尝试本地抠图，并在 manifest 中记录 fallback。")} />}
              <div className="rounded border border-amber-200 bg-amber-50 p-3 text-xs leading-5 text-amber-900">{options.mattingProvider === 'rembg' ? mattingConfig?.localAiNotice : t("本地 Sharp 是浅色/纯色背景启发式抠图；复杂背景要使用本地 AI 或已配置的高清服务，并人工复核边缘。")}</div>
            </div>}
          </Section>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <button data-sku-pack-submit disabled={busy || sourceLoading || !files.length || files.length > 300 || (collectionJobId && (!sourcePreview || (sourcePreview.partial && !confirmPartial)))} className="focus-ring inline-flex items-center gap-2 rounded bg-mint px-5 py-2.5 text-sm font-semibold text-white hover:bg-teal-800 disabled:cursor-not-allowed disabled:opacity-50">{busy ? <LoaderCircle className="animate-spin" size={18} /> : <Archive size={18} />}{busy ? t("正在处理并打包…") : t("生成 SKU 图包")}</button>
          <span className="text-xs text-slate-500">{t("单次最多 300 张、总计 500MB；单张最大 15MB。")}</span>
        </div>
        </fieldset>
      </form>

      {result && (
        <Section title={t("处理结果")}>
          {result.source?.type === 'collection-job' && <div data-sku-pack-provenance className="mb-3 space-y-2 rounded bg-teal-50 p-3 text-sm"><p>{t('图包已记录来源采集任务、图片相对路径和散列；原采集结果保持不变。')}</p>{result.transfer?.replayed && <p>{t('已找回相同来源和规则的原图包，没有重复处理。')}</p>}<Link to={`/workbench/collection?jobId=${encodeURIComponent(result.source.jobId)}`} className="mr-4 text-mint underline">{t('返回来源采集任务')}</Link><Link to={`/results/${encodeURIComponent(result.id)}`} className="text-mint underline">{t('查看任务结果与断点')}</Link></div>}
          {result.summary.duplicateSkippedCount > 0 && <div className="mb-4 space-y-2 rounded border border-amber-200 bg-amber-50 p-3 text-sm"><p>{t("重复判断可人工恢复：勾选需要保留的文件，再点上方“生成 SKU 图包”建立新结果包；原图与旧图包均不修改。")}</p>{result.skuResults.flatMap((sku) => sku.items).filter((item) => item.skipReason === 'DUPLICATE_IMAGE').map((item) => <label className="block" key={item.sourceRelativePath}><input type="checkbox" checked={keepDuplicates.includes(item.sourceRelativePath)} onChange={(event) => setKeepDuplicates((current) => event.target.checked ? [...current, item.sourceRelativePath] : current.filter((value) => value !== item.sourceRelativePath))} /> {item.sourceRelativePath} · {item.deduplicationMethod === 'exact-byte-hash' ? t("字节散列一致") : t("感知相似（距离 {value0}）", { value0: (item.perceptualDistance) })}{" " + t("· 对照") + " "}{item.duplicateOf}</label>)}</div>}
          <div className="flex flex-wrap items-center justify-between gap-4 rounded-lg border border-emerald-200 bg-emerald-50 p-4">
            <div className="flex items-center gap-3"><CheckCircle2 className="text-emerald-600" size={24} /><div><div className="font-medium text-emerald-900">{result.status === 'completed' ? t("图包处理完成") : result.status === 'completed_with_errors' ? t("图包已完成，但有单图失败") : t('图包尚未全部处理完成，请检查断点与错误。')}</div><div className="mt-1 text-xs text-emerald-800">{result.summary.skuCount}{" " + t("个 SKU · 成功输出") + " "}{result.summary.outputCount}{" " + t("张 · 跳过重复") + " "}{result.summary.duplicateSkippedCount || 0}{" " + t("张 · 失败") + " "}{result.summary.failedCount}{" " + t("张 · 自动方图") + " "}{result.summary.generatedSquareCount}{" " + t("张 · 抠图") + " "}{result.summary.mattedCount || 0}{" " + t("张")}</div></div></div>
            {result.downloadUrl && <a href={`${ASSET_BASE}${result.downloadUrl}`} className="focus-ring inline-flex items-center gap-2 rounded bg-emerald-700 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-800"><Download size={17} />{" " + t("下载 ZIP")}</a>}
          </div>
          <div className="mt-4 flex flex-wrap items-center gap-3"><input data-sku-result-search aria-label={t('搜索 SKU 图包结果')} placeholder={t('SKU、角色、文件名或错误原因')} value={resultQuery.q} onChange={event => setResultQuery(current => ({ ...current, q: event.target.value, page: 1 }))} className="focus-ring min-w-60 flex-1 rounded border p-2 text-sm" /><select data-sku-result-status aria-label={t('SKU 结果状态')} value={resultQuery.status} onChange={event => setResultQuery(current => ({ ...current, status: event.target.value, page: 1 }))} className="rounded border p-2 text-sm"><option value="">{t('全部状态')}</option>{Object.entries(skuResultStatuses).map(([status, label]) => <option key={status} value={status}>{t(label)}</option>)}</select><select data-sku-result-size aria-label={t('每页 SKU 数')} value={resultQuery.pageSize} onChange={event => setResultQuery(current => ({ ...current, pageSize: Number(event.target.value), page: 1 }))} className="rounded border p-2 text-sm">{[25, 50, 100].map(size => <option key={size} value={size}>{t('每页 {count} 条', { count: size })}</option>)}</select><button data-sku-result-export type="button" className="btn-secondary" onClick={exportResults}>{t('导出筛选 SKU 结果 CSV')}</button></div>
          <p className="mt-2 text-xs text-slate-500">{t('仅列出已经形成断点的 SKU 汇总；CSV 包含全部筛选结果，不限当前页，原始错误和角色代码保留。')}</p>
          <div className="mt-3 overflow-x-auto"><table data-sku-results className="w-full min-w-[850px] text-left text-sm"><thead><tr className="border-b border-slate-200 text-xs text-slate-500">{['SKU', '状态', '输入', '成功', '失败', '跳过', '角色', '说明'].map(label => <th key={label} className="px-3 py-2">{label === 'SKU' ? label : t(label)}</th>)}</tr></thead><tbody>{resultPage.rows.map(row => <tr data-sku-result-row={row.sku} key={row.sku} className="border-b border-slate-100"><td className="px-3 py-3 font-medium">{row.sku}</td><td className="px-3 py-3">{t(skuResultStatuses[row.status])}</td><td className="px-3 py-3">{row.inputCount}</td><td className="px-3 py-3 text-emerald-700">{row.successCount}</td><td className="px-3 py-3 text-red-600">{row.failedCount}</td><td className="px-3 py-3">{row.skippedCount}</td><td className="px-3 py-3">{row.roles.map(role => Object.hasOwn(ROLE_LABELS, role) ? t(ROLE_LABELS[role]) : role).join('、') || '-'}</td><td className="max-w-xs break-words px-3 py-3 text-xs">{row.messages.join(' · ') || '-'}</td></tr>)}</tbody></table></div>
          {!resultPage.total && <p data-sku-results-empty className="p-3 text-sm text-slate-500">{t('没有符合筛选条件的 SKU 结果。')}</p>}
          <div className="mt-3 flex items-center gap-3 text-sm"><button data-sku-result-prev className="btn-secondary" disabled={resultPage.page <= 1} onClick={() => setResultQuery(current => ({ ...current, page: resultPage.page - 1 }))}>{t('上一页')}</button><span data-sku-result-pagination>{t('第 {page} / {pages} 页 · 共 {total} 条', { page: resultPage.page, pages: resultPage.pages, total: resultPage.total })}</span><button data-sku-result-next className="btn-secondary" disabled={resultPage.page >= resultPage.pages} onClick={() => setResultQuery(current => ({ ...current, page: resultPage.page + 1 }))}>{t('下一页')}</button></div>
        </Section>
      )}

      <Section title={t("角色识别规则")}>
        <p className="text-sm leading-6 text-slate-600">{t("文件名包含 main/主图、additional/附图、square/方图、swatch/色块、detail/细节、variant/变种、general/通用时会自动归类。未标记的第一张作为主图，其余作为附图；识别结果和失败原因都会写入 manifest.json。")}</p>
      </Section>
    </div>
  );
}
