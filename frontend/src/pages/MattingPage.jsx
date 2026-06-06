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
  sanitizeMattingDisplay
} from '../utils/matting.js';

function imageName(image = {}, index = 0) {
  return image.displayName || image.originalName || image.fileName || image.id || `图片 ${index + 1}`;
}

function taskImages(task = {}) {
  return task.sourceImages?.length ? task.sourceImages : [task.originalImage].filter(Boolean);
}

function ResultCard({ title, imageUrl, statusText, metaText = '', qualityText, warnings = [], outputType }) {
  const outputWarning = mattingOutputTypeWarning(outputType);
  return (
    <div className="rounded border border-slate-200 bg-white p-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <div className="font-semibold text-ink">{title}</div>
        <div className="text-xs text-slate-500">{statusText}</div>
      </div>
      <div className="grid aspect-[4/3] place-items-center rounded bg-slate-50">
        {imageUrl ? (
          <img src={`${ASSET_BASE}${imageUrl}`} alt={title} className="max-h-full max-w-full object-contain" />
        ) : (
          <div className="text-sm text-slate-400">暂无图片</div>
        )}
      </div>
      {metaText && <div className="mt-2 text-xs text-slate-500">{metaText}</div>}
      {outputWarning && <div className="mt-2 rounded border border-amber-200 bg-amber-50 p-2 text-xs text-amber-900">{outputWarning}</div>}
      {qualityText && <div className="mt-2 text-sm font-medium text-slate-700">质量评分：{qualityText.replace(/^质量评分：/, '')}</div>}
      {warnings.length > 0 && (
        <ul className="mt-2 list-disc space-y-1 pl-5 text-xs text-amber-800">
          {warnings.map((warning, index) => <li key={`${warning}-${index}`}>{warning}</li>)}
        </ul>
      )}
    </div>
  );
}

function SingleResult({ result }) {
  if (!result) return null;
  const safe = sanitizeMattingDisplay(result);
  return (
    <Section title="本次抠图结果">
      <div className="grid gap-4 lg:grid-cols-2">
        <ResultCard
          title="原图"
          imageUrl={safe.originalImage?.previewUrl}
          statusText={safe.originalImage?.displayName || '原图'}
        />
        <ResultCard
          title={`${safe.providerUsed || 'sharp'} 抠图结果`}
          imageUrl={safe.mattedImage?.previewUrl}
          statusText={safe.status || 'unknown'}
          metaText={`requestedProvider=${safe.requestedProvider || '-'} / providerUsed=${safe.providerUsed || '-'} / outputType=${safe.outputType || '-'} / fallbackUsed=${Boolean(safe.fallbackUsed)} / fallbackReason=${safe.fallbackReason || '-'}`}
          outputType={safe.outputType}
          qualityText={mattingQualityLabel(safe.qualityScore)}
          warnings={safe.qualityScore?.warnings || []}
        />
      </div>
      <div className="mt-3 rounded border border-slate-200 bg-slate-50 p-3 text-sm text-slate-700">
        fallback 状态：{mattingFallbackText(safe)}
      </div>
    </Section>
  );
}

function CompareResult({ result }) {
  if (!result) return null;
  const safe = sanitizeMattingDisplay(result);
  const cards = mattingCompareCards(safe);
  return (
    <Section title="对比抠图结果">
      <div className="grid gap-4 lg:grid-cols-4">
        {cards.map((card) => <ResultCard key={card.title} {...card} outputType={card.outputType} />)}
      </div>
      <div className="mt-3 rounded border border-slate-200 bg-slate-50 p-3 text-sm text-slate-700">
        fallback 状态：{mattingFallbackText(safe.image2 || safe.external)}
        {safe.recommendation?.provider && <div className="mt-1">推荐：{safe.recommendation.provider}。{safe.recommendation.reason}</div>}
      </div>
    </Section>
  );
}

export default function MattingPage() {
  const [tasks, setTasks] = useState([]);
  const [config, setConfig] = useState(null);
  const [taskId, setTaskId] = useState('');
  const [imageId, setImageId] = useState('');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [singleResult, setSingleResult] = useState(null);
  const [compareResult, setCompareResult] = useState(null);

  useEffect(() => {
    let active = true;
    Promise.all([api.listTasks(), api.getMattingConfig()])
      .then(([taskList, mattingConfig]) => {
        if (!active) return;
        const list = Array.isArray(taskList) ? taskList : [];
        setTasks(list);
        setConfig(mattingConfig);
        const firstTask = list.find((task) => taskImages(task).length > 0);
        if (firstTask) {
          setTaskId(firstTask.id);
          setImageId(taskImages(firstTask)[0]?.id || '');
        }
      })
      .catch((err) => {
        if (active) setError(err.message);
      });
    return () => { active = false; };
  }, []);

  const selectedTask = useMemo(() => tasks.find((task) => task.id === taskId) || null, [tasks, taskId]);
  const images = taskImages(selectedTask || {});
  const selectedImage = images.find((image) => image.id === imageId) || images[0] || null;
  const externalEnabled = externalMattingEnabled(config || {});
  const image2Enabled = image2MattingEnabled(config || {});

  function changeTask(nextTaskId) {
    const nextTask = tasks.find((task) => task.id === nextTaskId);
    setTaskId(nextTaskId);
    setImageId(taskImages(nextTask || {})[0]?.id || '');
    setSingleResult(null);
    setCompareResult(null);
  }

  async function run(provider) {
    setBusy(provider);
    setError('');
    setCompareResult(null);
    try {
      const result = await api.runMatting({ taskId, imageId, provider });
      setSingleResult(result);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy('');
    }
  }

  async function compare() {
    setBusy('compare');
    setError('');
    setSingleResult(null);
    try {
      const result = await api.compareMatting({ taskId, imageId });
      setCompareResult(result);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy('');
    }
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold text-ink">主体抠图测试</h1>
        <div className="inline-flex items-center gap-2 rounded border border-slate-200 bg-white px-3 py-2 text-sm text-slate-600">
          <Scissors size={16} />
          默认 provider：sharp
        </div>
      </div>

      {error && <div className="rounded border border-red-200 bg-red-50 p-3 text-sm text-red-700">{error}</div>}

      <Section title="选择商品图片">
        <div className="grid gap-4 lg:grid-cols-[1fr_260px]">
          <div className="grid gap-3 md:grid-cols-2">
            <label className="block text-sm">
              <span className="mb-1 block font-medium text-slate-700">任务</span>
              <select value={taskId} onChange={(event) => changeTask(event.target.value)} className="w-full rounded border border-slate-300 bg-white px-3 py-2">
                {tasks.map((task) => (
                  <option key={task.id} value={task.id}>{task.sku || task.id}</option>
                ))}
              </select>
            </label>
            <label className="block text-sm">
              <span className="mb-1 block font-medium text-slate-700">商品图</span>
              <select value={imageId} onChange={(event) => setImageId(event.target.value)} className="w-full rounded border border-slate-300 bg-white px-3 py-2">
                {images.map((image, index) => (
                  <option key={image.id || index} value={image.id}>{imageName(image, index)}</option>
                ))}
              </select>
            </label>
          </div>
          <div className="grid aspect-[4/3] place-items-center rounded border border-slate-200 bg-slate-50">
            {selectedImage ? (
              <img src={`${ASSET_BASE}${selectedImage.previewUrl || selectedImage.url}`} alt={imageName(selectedImage)} className="max-h-full max-w-full object-contain" />
            ) : (
              <div className="text-sm text-slate-400">暂无可测试图片</div>
            )}
          </div>
        </div>
      </Section>

      <Section title="抠图操作">
        <div className="rounded border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
          {mattingConfigNotice(config || {})}
        </div>
        <div className="mt-3 rounded border border-blue-200 bg-blue-50 p-3 text-sm text-blue-900">
          {mattingImage2Notice(config || {})}
        </div>
        <div className="mt-2 text-sm text-slate-600">
          当前可用 provider：sharp（本地）{image2Enabled ? ' / Image2（实验性抠图）' : ''}
        </div>
        <div className="mt-4 flex flex-wrap gap-2">
          <button type="button" disabled={!selectedImage || Boolean(busy)} onClick={() => run('sharp')} className="focus-ring rounded bg-ink px-4 py-2 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50">
            {busy === 'sharp' ? '处理中...' : '使用 sharp 抠图测试'}
          </button>
          <button type="button" disabled={!selectedImage || !externalEnabled || Boolean(busy)} onClick={() => run('external')} title="第三方抠图 API 可能产生费用，请确认后再调用。" className="focus-ring rounded border border-amber-300 bg-white px-4 py-2 text-sm font-semibold text-amber-900 disabled:cursor-not-allowed disabled:opacity-50">
            {busy === 'external' ? '处理中...' : '使用第三方抠图测试'}
          </button>
          <button type="button" disabled={!selectedImage || !image2Enabled || Boolean(busy)} onClick={() => run('image2')} title="Image2 抠图测试可能产生 API 成本，仅在你点击对应按钮时才会调用。" className="focus-ring rounded border border-blue-300 bg-white px-4 py-2 text-sm font-semibold text-blue-900 disabled:cursor-not-allowed disabled:opacity-50">
            {busy === 'image2' ? '处理中...' : '使用 Image2 抠图测试（可能产生费用）'}
          </button>
          <button type="button" disabled={!selectedImage || Boolean(busy)} onClick={compare} className="focus-ring rounded border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-700 disabled:cursor-not-allowed disabled:opacity-50">
            {busy === 'compare' ? '对比中...' : '对比 sharp 与 Image2'}
          </button>
        </div>
        <div className="mt-3 text-xs text-slate-500">
          对比 sharp 与 Image2 时，如果 Image2 已配置，将调用一次 Image2 抠图测试，可能产生 API 成本。Image2 结果为实验性抠图输出，仅用于小样本验证。
        </div>
        {externalEnabled && (
          <div className="mt-3 rounded border border-red-200 bg-red-50 p-3 text-sm text-red-800">
            第三方抠图 API 可能产生费用，请确认后再调用。
          </div>
        )}
        {!externalEnabled && (
          <div className="mt-3 text-sm text-slate-500">第三方抠图 API 未配置，第三方按钮已禁用。</div>
        )}
        {!image2Enabled && (
          <div className="mt-2 text-sm text-slate-500">Image2 未配置，当前仅可使用 sharp 本地抠图。</div>
        )}
      </Section>

      <SingleResult result={singleResult} />
      <CompareResult result={compareResult} />
    </div>
  );
}
