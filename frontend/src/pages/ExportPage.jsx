import { useEffect, useState } from 'react';
import { ArrowRight, Download, ListChecks } from 'lucide-react';
import { Link, useParams } from 'react-router-dom';
import StepNav from '../components/StepNav.jsx';
import TaskProgress from '../components/TaskProgress.jsx';
import Section from '../components/Section.jsx';
import StatusBadge from '../components/StatusBadge.jsx';
import { api } from '../services/api.js';
import { DisabledReason, ErrorMessage, useTask } from './pageUtils.jsx';
import { actionDisabledReason, canRunAction } from '../utils/taskWorkflow.js';
import { getImageSourceStatus, imageSourceNotice, summarizeImageSources } from '../utils/imageSourceStatus.js';
import { buildExportFollowupNavigation } from '../utils/exportFollowupNavigation.js';

const imageTypeLabels = {
  main_image: '平台主图',
  feature_image: '核心卖点图',
  size_image: '尺寸/规格图',
  compatibility_image: '兼容设备图',
  package_image: '包装清单图',
  lifestyle_image: '使用场景图',
  detail_image: '细节图',
  variant_image: '容量/颜色/规格变体图'
};

function imageTitle(image) {
  return imageTypeLabels[image.type] || image.title || image.type;
}

function summarizeGenerationQuality(images = []) {
  return images.reduce((summary, image) => {
    const level = image.preserveQuality?.qualityLevel || 'unknown';
    const selectedMode = image.generationStrategy?.selectedMode || image.realGenerationMode || (image.isMockPreview ? 'mock' : 'unknown');
    if (level === 'good') summary.goodCount += 1;
    else if (level === 'medium') summary.mediumCount += 1;
    else if (level === 'poor') summary.poorCount += 1;
    else summary.unknownCount += 1;
    if (selectedMode === 'subject_composite') summary.subjectCompositeCount += 1;
    else if (selectedMode === 'image_edit') summary.imageEditCount += 1;
    else if (selectedMode === 'text_to_image') summary.textToImageCount += 1;
    else if (selectedMode === 'mock') summary.mockCount += 1;
    return summary;
  }, {
    goodCount: 0,
    mediumCount: 0,
    poorCount: 0,
    unknownCount: 0,
    subjectCompositeCount: 0,
    imageEditCount: 0,
    textToImageCount: 0,
    mockCount: 0
  });
}

function targetLabel(target = {}) {
  return `${target.platformName || target.platform || target.platformId || '平台'} / ${target.site || 'US'} / ${target.language || 'English'}`;
}

function groupImagesByTarget(task = {}) {
  const targets = task.targets?.length
    ? task.targets
    : [{
        id: 'legacy-target',
        targetId: 'legacy-target',
        platformId: task.platformId || task.platform,
        platformName: task.platform,
        site: task.site,
        language: task.language
      }];
  const groups = targets.map((target) => {
    const images = (task.generatedImages || []).filter((image) =>
      image.targetId === target.id ||
      image.targetId === target.targetId ||
      image.platformId === target.platformId
    );
    const reviewResults = (task.reviewResults || []).filter((review) =>
      review.targetId === target.id ||
      review.targetId === target.targetId ||
      review.platformId === target.platformId ||
      images.some((image) => image.id === review.imageId)
    );
    const sourceSummary = summarizeImageSources(images);
    const qualitySummary = summarizeGenerationQuality(images);
    const riskSummary = reviewResults.reduce((summary, item) => {
      if (item.status === 'passed') summary.passCount += 1;
      else summary.failCount += 1;
      if (item.riskLevel === 'high') summary.highRiskCount += 1;
      else if (item.riskLevel === 'medium') summary.mediumRiskCount += 1;
      else if (item.riskLevel) summary.lowRiskCount += 1;
      return summary;
    }, { passCount: 0, failCount: 0, highRiskCount: 0, mediumRiskCount: 0, lowRiskCount: 0 });
    return { target, images, reviewResults, sourceSummary, qualitySummary, riskSummary };
  }).filter((group) => group.images.length > 0 || targets.length <= 1);
  return groups;
}

export default function ExportPage() {
  const { taskId } = useParams();
  const { task, loading, error } = useTask(taskId);
  const [followupNavigation, setFollowupNavigation] = useState(null);
  const [followupError, setFollowupError] = useState('');

  useEffect(() => {
    if (!task?.id) return undefined;
    let cancelled = false;
    setFollowupError('');
    api.listBatches()
      .then((result) => {
        if (cancelled) return;
        setFollowupNavigation(buildExportFollowupNavigation({
          task,
          batches: result.batchTasks || []
        }));
      })
      .catch((err) => {
        if (cancelled) return;
        setFollowupError(err.message || 'batch queue load failed');
        setFollowupNavigation(buildExportFollowupNavigation({ task, batches: [] }));
      });
    return () => {
      cancelled = true;
    };
  }, [task?.id, task?.batchId]);

  if (loading) return <div className="text-sm text-slate-500">正在加载导出页面...</div>;

  const canExport = canRunAction(task.status, 'exportImages');
  const sourceSummary = summarizeImageSources(task.generatedImages || []);
  const qualitySummary = summarizeGenerationQuality(task.generatedImages || []);
  const targetSummaries = groupImagesByTarget(task || {});
  const sourceNotice = imageSourceNotice(sourceSummary);

  return (
    <div className="max-w-5xl space-y-5">
      <StepNav taskId={taskId} />
      <TaskProgress task={task} />
      <ErrorMessage error={error} />
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-ink">导出图片包</h1>
          <p className="mt-1 text-sm text-slate-500">图片会按平台、SKU、序号和图片类型自动命名。</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {followupNavigation?.nextPendingUrl && (
            <Link
              to={followupNavigation.nextPendingUrl}
              className="focus-ring inline-flex items-center gap-2 rounded bg-blue-600 px-3 py-2 text-sm font-semibold text-white hover:bg-blue-700"
            >
              <ArrowRight size={16} />
              继续确认下一个 SKU
            </Link>
          )}
          {followupNavigation?.pendingQueueUrl && (
            <Link
              to={followupNavigation.pendingQueueUrl}
              className="focus-ring inline-flex items-center gap-2 rounded border border-blue-200 bg-blue-50 px-3 py-2 text-sm font-semibold text-blue-700 hover:bg-blue-100"
            >
              <ListChecks size={16} />
              返回待确认队列
              {followupNavigation.pendingCount > 0 ? `（${followupNavigation.pendingCount}）` : ''}
            </Link>
          )}
          <StatusBadge status={task.status} />
        </div>
      </div>
      {followupError && (
        <div className="rounded border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          待确认队列读取失败，仍可继续下载当前 SKU 图片包。{followupError}
        </div>
      )}
      <Section title="图片包内容">
        {sourceNotice && (
          <div className={`mb-4 rounded border p-3 text-sm ${sourceSummary.fallbackMockCount ? 'border-red-200 bg-red-50 text-red-800' : 'border-amber-200 bg-amber-50 text-amber-800'}`}>
            {sourceNotice}
          </div>
        )}
        <div className="mb-5 grid gap-3 md:grid-cols-3">
          <div className="rounded border border-slate-200 p-4">
            <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">平台</div>
            <div className="mt-1 font-semibold text-ink">{task.targets?.length ? `${task.targets.length} 个目标平台` : task.platform}</div>
          </div>
          <div className="rounded border border-slate-200 p-4">
            <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">SKU</div>
            <div className="mt-1 font-semibold text-ink">{task.productInfo?.sku}</div>
          </div>
          <div className="rounded border border-slate-200 p-4">
            <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">图片数量</div>
            <div className="mt-1 font-semibold text-ink">{sourceSummary.totalImages}</div>
          </div>
        </div>
        {targetSummaries.length > 1 && (
          <div className="mb-5 space-y-3">
            <div className="text-sm font-semibold text-ink">按平台导出</div>
            {targetSummaries.map(({ target, images, sourceSummary: targetSource, riskSummary }) => (
              <div key={target.id || target.targetId || target.platformId} className="flex flex-wrap items-center justify-between gap-3 rounded border border-slate-200 bg-slate-50 p-3 text-sm">
                <div>
                  <div className="font-semibold text-ink">{targetLabel(target)}</div>
                  <div className="mt-1 text-xs text-slate-500">
                    图片：{images.length} / mock：{targetSource.mockPreviewCount} / real：{targetSource.realGeneratedCount} / fallback：{targetSource.fallbackMockCount}
                    {' '} / 审核通过：{riskSummary.passCount} / 高风险：{riskSummary.highRiskCount}
                  </div>
                </div>
                {canExport && (
                  <a
                    href={api.exportUrl(taskId, target.id || target.targetId)}
                    className="focus-ring inline-flex items-center gap-2 rounded border border-coral bg-white px-3 py-2 text-xs font-semibold text-coral hover:bg-red-50"
                  >
                    <Download size={15} />
                    下载该平台 ZIP
                  </a>
                )}
              </div>
            ))}
          </div>
        )}
        <div className="mb-5 grid gap-3 md:grid-cols-4">
          <div className="rounded border border-slate-200 p-3">
            <div className="text-xs text-slate-500">mock 预览图</div>
            <div className="mt-1 font-semibold text-ink">{sourceSummary.mockPreviewCount}</div>
          </div>
          <div className="rounded border border-slate-200 p-3">
            <div className="text-xs text-slate-500">真实生成图</div>
            <div className="mt-1 font-semibold text-ink">{sourceSummary.realGeneratedCount}</div>
          </div>
          <div className="rounded border border-slate-200 p-3">
            <div className="text-xs text-slate-500">fallback mock</div>
            <div className="mt-1 font-semibold text-ink">{sourceSummary.fallbackMockCount}</div>
          </div>
          <div className="rounded border border-slate-200 p-3">
            <div className="text-xs text-slate-500">Provider</div>
            <div className="mt-1 font-semibold text-ink">{sourceSummary.providers.join(', ') || '-'}</div>
          </div>
        </div>
        <div className="mb-5 grid gap-3 md:grid-cols-4">
          <div className="rounded border border-slate-200 p-3">
            <div className="text-xs text-slate-500">主体保留 good</div>
            <div className="mt-1 font-semibold text-ink">{qualitySummary.goodCount}</div>
          </div>
          <div className="rounded border border-slate-200 p-3">
            <div className="text-xs text-slate-500">主体保留 medium / poor</div>
            <div className="mt-1 font-semibold text-ink">{qualitySummary.mediumCount + qualitySummary.poorCount}</div>
          </div>
          <div className="rounded border border-slate-200 p-3">
            <div className="text-xs text-slate-500">subject_composite / image_edit</div>
            <div className="mt-1 font-semibold text-ink">{qualitySummary.subjectCompositeCount} / {qualitySummary.imageEditCount}</div>
          </div>
          <div className="rounded border border-slate-200 p-3">
            <div className="text-xs text-slate-500">text_to_image / mock</div>
            <div className="mt-1 font-semibold text-ink">{qualitySummary.textToImageCount} / {qualitySummary.mockCount}</div>
          </div>
        </div>
        <div className="space-y-2">
          {(task.generatedImages || []).map((image) => {
            const sourceStatus = getImageSourceStatus(image);
            return (
              <div key={image.id} className="flex flex-wrap items-center justify-between gap-2 rounded bg-slate-50 px-3 py-2 text-sm">
                <span className="font-medium text-slate-700">{imageTitle(image)}</span>
                <span className={`rounded border px-2 py-1 text-xs ${sourceStatus.className}`}>{sourceStatus.label}</span>
                <span className="text-slate-500">v{image.version || 1}</span>
                <span className="break-all text-slate-500">{image.fileName}</span>
              </div>
            );
          })}
        </div>
        {canExport ? (
          <a
            href={api.exportUrl(taskId)}
            className="focus-ring mt-5 inline-flex items-center gap-2 rounded bg-coral px-4 py-2 text-sm font-semibold text-white hover:bg-red-700"
          >
            <Download size={17} />
            下载 ZIP
          </a>
        ) : (
          <div className="mt-5">
            <button disabled className="inline-flex cursor-not-allowed items-center gap-2 rounded bg-slate-300 px-4 py-2 text-sm font-semibold text-white">
              <Download size={17} />
              下载 ZIP
            </button>
            <DisabledReason reason={actionDisabledReason(task.status, 'exportImages')} />
          </div>
        )}
      </Section>
    </div>
  );
}
