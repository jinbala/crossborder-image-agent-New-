import { useLocale } from '../i18n/LocaleProvider.jsx';
import { useEffect, useMemo, useState } from 'react';
import { Scissors } from 'lucide-react';
import Section from '../components/Section.jsx';
import { ASSET_BASE, api } from '../services/api.js';
import {
  externalMattingEnabled,
  image2MattingEnabled,
  mattingCompareCards,
  mattingConfigNotice,
  mattingFallbackText,
  mattingImage2Notice,
  mattingOutputTypeWarning,
  mattingQualityLabel,
  mattingTaskList,
  mattingSelectionFor,
  sanitizeMattingDisplay
} from '../utils/matting.js';

function imageName(image = {}, index = 0, t) {
  return image.displayName || image.originalName || image.fileName || image.id || t('图片 {index}', { index: index + 1 });
}

function taskImages(task = {}) {
  return task.sourceImages?.length ? task.sourceImages : [task.originalImage].filter(Boolean);
}

function ResultCard({ title, imageUrl, statusText, metaText = '', qualityText, warnings = [], outputType }) {
  const { t } = useLocale();
  const outputWarning = mattingOutputTypeWarning(outputType);
  return (
    <div className="rounded border border-slate-200 bg-white p-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <div className="font-semibold text-ink">{t(title)}</div>
        <div className="text-xs text-slate-500">{statusText}</div>
      </div>
      <div className="grid aspect-[4/3] place-items-center rounded bg-slate-50">
        {imageUrl ? (
          <img src={`${ASSET_BASE}${imageUrl}`} alt={title} className="max-h-full max-w-full object-contain" />
        ) : (
          <div className="text-sm text-slate-400">{t("暂无图片")}</div>
        )}
      </div>
      {metaText && <div className="mt-2 text-xs text-slate-500">{metaText}</div>}
      {outputWarning && <div className="mt-2 rounded border border-amber-200 bg-amber-50 p-2 text-xs text-amber-900">{t(outputWarning)}</div>}
      {qualityText && <div className="mt-2 text-sm font-medium text-slate-700">{qualityText}</div>}
      {warnings.length > 0 && (
        <ul className="mt-2 list-disc space-y-1 pl-5 text-xs text-amber-800">
          {warnings.map((warning, index) => <li key={`${warning}-${index}`}>{warning}</li>)}
        </ul>
      )}
    </div>
  );
}

function SingleResult({ result }) {
  const { t } = useLocale();
  if (!result) return null;
  const safe = sanitizeMattingDisplay(result);
  return (
    <Section title={t("本次抠图结果")}>
      <div className="grid gap-4 lg:grid-cols-2">
        <ResultCard
          title={t("原图")}
          imageUrl={safe.originalImage?.previewUrl}
          statusText={safe.originalImage?.displayName || '原图'}
        />
        <ResultCard
          title={t("{value0} 抠图结果", { value0: (safe.providerUsed || 'sharp') })}
          imageUrl={safe.mattedImage?.previewUrl}
          statusText={safe.status || 'unknown'}
          metaText={`requestedProvider=${safe.requestedProvider || '-'} / providerUsed=${safe.providerUsed || '-'} / outputType=${safe.outputType || '-'} / fallbackUsed=${Boolean(safe.fallbackUsed)} / fallbackReason=${safe.fallbackReason || '-'}`}
          outputType={safe.outputType}
          qualityText={mattingQualityLabel(safe.qualityScore, t)}
          warnings={safe.qualityScore?.warnings || []}
        />
      </div>
      <div className="mt-3 rounded border border-slate-200 bg-slate-50 p-3 text-sm text-slate-700">{t("fallback 状态：")}{mattingFallbackText(safe)}
      </div>
    </Section>
  );
}

function CompareResult({ result }) {
  const { t } = useLocale();
  if (!result) return null;
  const safe = sanitizeMattingDisplay(result);
  const cards = mattingCompareCards(safe, t);
  return (
    <Section title={t("对比抠图结果")}>
      <div className="grid gap-4 lg:grid-cols-4">
        {cards.map((card) => <ResultCard key={card.title} {...card} outputType={card.outputType} />)}
      </div>
      <div className="mt-3 rounded border border-slate-200 bg-slate-50 p-3 text-sm text-slate-700">{t("fallback 状态：")}{mattingFallbackText(safe.image2 || safe.external)}
        {safe.recommendation?.provider && <div className="mt-1">{t("推荐：")}{safe.recommendation.provider}。{safe.recommendation.reason}</div>}
      </div>
    </Section>
  );
}

export default function MattingPage() {
  const { t } = useLocale();
  const [tasks, setTasks] = useState([]);
  const [config, setConfig] = useState(null);
  const [taskId, setTaskId] = useState('');
  const [imageId, setImageId] = useState('');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [singleResult, setSingleResult] = useState(null);
  const [compareResult, setCompareResult] = useState(null);
  const [adoptionResult, setAdoptionResult] = useState(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    setLoading(true); setError(''); setAdoptionResult(null);
    Promise.all([api.listTasks(), api.getMattingConfig()])
      .then(([taskList, mattingConfig]) => {
        if (!active) return;
        const list = mattingTaskList(taskList);
        setTasks(list);
        setConfig(mattingConfig);
        const firstTask = list.find((task) => task.id === taskId && taskImages(task).length > 0) || list.find((task) => taskImages(task).length > 0);
        if (firstTask) {
          setTaskId(firstTask.id);
          setImageId(taskImages(firstTask).find((image) => image.id === imageId)?.id || taskImages(firstTask)[0]?.id || '');
        } else { setTaskId(''); setImageId(''); }
        setSingleResult(null); setCompareResult(null);
      })
      .catch((err) => {
        if (active) setError(err.message);
      }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [refreshKey]);

  const selectedTask = useMemo(() => tasks.find((task) => task.id === taskId) || null, [tasks, taskId]);
  const images = taskImages(selectedTask || {});
  const selectedImage = images.find((image) => image.id === imageId) || images[0] || null;
  const visibleSelection = mattingSelectionFor(selectedTask, selectedImage?.id, adoptionResult);
  const externalEnabled = externalMattingEnabled(config || {});
  const image2Enabled = image2MattingEnabled(config || {});

  function changeTask(nextTaskId) {
    const nextTask = tasks.find((task) => task.id === nextTaskId);
    setTaskId(nextTaskId);
    setImageId(taskImages(nextTask || {})[0]?.id || '');
    setSingleResult(null);
    setCompareResult(null);
    setAdoptionResult(null);
  }

  async function run(provider) {
    if (loading || busy || !selectedImage) return;
    const external = ['external', 'image2'].includes(provider) || (provider === 'auto' && externalEnabled);
    if (external && !window.confirm(t("确认上传任务 {value0} 的所选原图并调用 {value1}？\n数据去向：{value2}\n可能产生费用，失败也可能由服务商计费。", { value0: (taskId), value1: (provider), value2: ((config?.dataDestinations || []).filter((item) => provider === 'auto' || item.provider === provider).map((item) => `${item.origin}（${item.cost}）`).join('；') || '配置的外部 Provider') }))) return;
    setBusy(provider);
    setError('');
    setCompareResult(null);
    try {
      const result = await api.runMatting({ taskId, imageId, provider, confirmExternal: external, confirmDataTransfer: external });
      setSingleResult(result);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy('');
    }
  }

  async function compare() {
    if (loading || busy || !selectedImage) return;
    const remote = externalEnabled || image2Enabled;
    if (remote && !window.confirm(t("本次对比会上传任务 {value0} 的原图并分别调用已配置外部服务，可能多次计费。\n{value1}\n是否批准此次调用？", { value0: (taskId), value1: ((config?.dataDestinations || []).map((item) => `${item.provider} → ${item.origin}：${item.cost}`).join('\n')) }))) return;
    setBusy('compare');
    setError('');
    setSingleResult(null);
    try {
      const result = await api.compareMatting({ taskId, imageId, confirmExternal: remote, confirmDataTransfer: remote });
      setCompareResult(result);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy('');
    }
  }

  async function adopt(item) {
    if (loading || busy || !selectedImage) return;
    if (!window.confirm(t('确认采用 {provider} 的抠图结果？只记录采用项，不覆盖原图。', { provider: item.providerUsed }))) return;
    setBusy('adopt'); setError('');
    try {
      const result = await api.adoptMatting({ taskId, imageId, provider: item.providerUsed, url: item.mattedImage.previewUrl });
      setAdoptionResult({ ...result, taskId });
      setTasks((current) => current.map((task) => task.id === taskId ? { ...task, mattingSelection: result.selection } : task));
    }
    catch (err) { setError(err.message); } finally { setBusy(''); }
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold text-ink">{t("主体抠图测试")}</h1>
        <button type="button" data-matting-refresh disabled={loading || Boolean(busy)} className="btn-secondary" onClick={() => setRefreshKey((value) => value + 1)}>{t('刷新任务与配置')}</button>
        <div className="inline-flex items-center gap-2 rounded border border-slate-200 bg-white px-3 py-2 text-sm text-slate-600">
          <Scissors size={16} />{t("默认 provider：sharp")}</div>
      </div>

      {error && <div role="alert" className="rounded border border-red-200 bg-red-50 p-3 text-sm text-red-700">{error}</div>}
      {visibleSelection && <div data-matting-adopted className="rounded border border-teal-200 bg-teal-50 p-3 text-sm text-teal-900">{t('已采用 {provider} 结果，原图和其他结果保持不变。', { provider: visibleSelection.provider })}<a className="ml-3 underline" download href={`${ASSET_BASE}${visibleSelection.previewUrl}`}>{t('下载采用图 PNG')}</a></div>}

      <Section title={t("选择商品图片")}>
        <div className="grid gap-4 lg:grid-cols-[1fr_260px]">
          <div className="grid gap-3 md:grid-cols-2">
            <label className="block text-sm">
              <span className="mb-1 block font-medium text-slate-700">{t("任务")}</span>
              <select disabled={loading || Boolean(busy)} value={taskId} onChange={(event) => changeTask(event.target.value)} className="w-full rounded border border-slate-300 bg-white px-3 py-2">
                {tasks.map((task) => (
                  <option key={task.id} value={task.id}>{task.sku || task.id}</option>
                ))}
              </select>
            </label>
            <label className="block text-sm">
              <span className="mb-1 block font-medium text-slate-700">{t("商品图")}</span>
              <select disabled={loading || Boolean(busy)} value={imageId} onChange={(event) => { setImageId(event.target.value); setSingleResult(null); setCompareResult(null); setAdoptionResult(null); }} className="w-full rounded border border-slate-300 bg-white px-3 py-2">
                {images.map((image, index) => (
                  <option key={image.id || index} value={image.id}>{imageName(image, index, t)}</option>
                ))}
              </select>
            </label>
          </div>
          <div className="grid aspect-[4/3] place-items-center rounded border border-slate-200 bg-slate-50">
            {selectedImage ? (
              <img src={`${ASSET_BASE}${selectedImage.previewUrl || selectedImage.url}`} alt={imageName(selectedImage, 0, t)} className="max-h-full max-w-full object-contain" />
            ) : (
              <div className="text-sm text-slate-400">{t("暂无可测试图片")}</div>
            )}
          </div>
        </div>
      </Section>

      <Section title={t("抠图操作")}>
        <div className="mb-3 rounded border bg-teal-50 p-3 text-sm text-teal-900">{t("本地 AI：")}{config?.localAiNotice || t("读取中")}{t("。本地 AI 只有依赖、权重和许可全部就绪后才启用。")}</div>
        <div className="rounded border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
          {t(mattingConfigNotice(config || {}))}
        </div>
        <div className="mt-3 rounded border border-blue-200 bg-blue-50 p-3 text-sm text-blue-900">
          {t(mattingImage2Notice(config || {}))}
        </div>
        <div className="mt-2 text-sm text-slate-600">{t("当前可用 provider：sharp（本地）")}{image2Enabled ? t(" / Image2（实验性抠图）") : ''}
        </div>
        <div className="mt-4 flex flex-wrap gap-2">
          <button type="button" data-matting-sharp disabled={!selectedImage || loading || Boolean(busy)} onClick={() => run('sharp')} className="focus-ring rounded bg-ink px-4 py-2 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50">
            {busy === 'sharp' ? t("处理中...") : t("使用 sharp 抠图测试")}
          </button>
          <button type="button" disabled={!selectedImage || !config?.localAiAvailable || Boolean(busy)} onClick={() => run('rembg')} className="btn-secondary">{busy === 'rembg' ? t("本地 AI 处理中…") : t("使用 rembg 本地 AI 抠图")}</button>
          <button type="button" disabled={!selectedImage || !externalEnabled || Boolean(busy)} onClick={() => run('external')} title={t("第三方抠图 API 可能产生费用，请确认后再调用。")} className="focus-ring rounded border border-amber-300 bg-white px-4 py-2 text-sm font-semibold text-amber-900 disabled:cursor-not-allowed disabled:opacity-50">
            {busy === 'external' ? t("处理中...") : t("使用第三方抠图测试")}
          </button>
          <button type="button" disabled={!selectedImage || !image2Enabled || Boolean(busy)} onClick={() => run('image2')} title={t("Image2 抠图测试可能产生 API 成本，仅在你点击对应按钮时才会调用。")} className="focus-ring rounded border border-blue-300 bg-white px-4 py-2 text-sm font-semibold text-blue-900 disabled:cursor-not-allowed disabled:opacity-50">
            {busy === 'image2' ? t("处理中...") : t("使用 Image2 抠图测试（可能产生费用）")}
          </button>
          <button type="button" disabled={!selectedImage || Boolean(busy)} onClick={compare} className="focus-ring rounded border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-700 disabled:cursor-not-allowed disabled:opacity-50">
            {busy === 'compare' ? t("对比中...") : t("对比 sharp 与 Image2")}
          </button>
        </div>
        <div className="mt-3 text-xs text-slate-500">{t("对比 sharp 与 Image2 时，如果 Image2 已配置，将调用一次 Image2 抠图测试，可能产生 API 成本。Image2 结果为实验性抠图输出，仅用于小样本验证。")}</div>
        {externalEnabled && (
          <div className="mt-3 rounded border border-red-200 bg-red-50 p-3 text-sm text-red-800">{t("第三方抠图 API 可能产生费用，请确认后再调用。")}</div>
        )}
        {!externalEnabled && (
          <div className="mt-3 text-sm text-slate-500">{t("第三方抠图 API 未配置，第三方按钮已禁用。")}</div>
        )}
        {!image2Enabled && (
          <div className="mt-2 text-sm text-slate-500">{t(config?.localAiAvailable ? 'Image2 未配置；本地 rembg 与 sharp 可用，不会调用第三方 API。' : 'Image2 未配置，当前仅可使用 sharp 本地抠图。')}</div>
        )}
      </Section>

      <SingleResult result={singleResult} />
      <CompareResult result={compareResult} />
      {(singleResult || compareResult) && <Section title={t("选择采用结果（保留原图）")}><div className="flex flex-wrap gap-3">{(singleResult ? [singleResult] : [compareResult.sharp, compareResult.external, compareResult.image2]).filter((item) => item?.status === 'success' && item.mattedImage?.previewUrl).map((item, index) => <button data-matting-adopt className="btn-secondary" disabled={Boolean(busy)} key={`${item.providerUsed}-${index}`} onClick={() => adopt(item)}>{t('采用 {provider} 结果', { provider: item.providerUsed })}</button>)}</div><p className="mt-3 text-xs text-slate-500">{t("采用项保存在图片任务中，可下载其 PNG 后在创作工作室继续套图；不会自动改变已有生成图。")}</p></Section>}
    </div>
  );
}
