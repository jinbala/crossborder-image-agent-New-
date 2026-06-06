import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Images, X } from 'lucide-react';
import StepNav from '../components/StepNav.jsx';
import TaskProgress from '../components/TaskProgress.jsx';
import Section from '../components/Section.jsx';
import TextLayoutEditor from '../components/TextLayoutEditor.jsx';
import { ASSET_BASE, api } from '../services/api.js';
import { ErrorMessage, PrimaryButton, useTask, DisabledReason } from './pageUtils.jsx';
import { actionDisabledReason, canRunAction } from '../utils/taskWorkflow.js';
import { getImageSourceStatus } from '../utils/imageSourceStatus.js';
import { normalizeClientCompositeSettings as normalizeCompositeSettingsValue } from '../utils/compositeSettings.js';
import {
  downloadTemplateAuditJson,
  templateAuditExportNotice,
  templateAuditDisplaySections
} from '../utils/templateAudit.js';
import {
  downloadSingleImageGenerationJson,
  downloadThreeSampleGenerationJson,
  singleImageAcceptanceReportSections,
  singleImageGenerationNotice,
  singleImageGenerationOptions,
  singleImageGenerationWarningText,
  threeSampleCanRun,
  threeSampleGenerationSections
} from '../utils/singleImageGeneration.js';

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

function riskClass(level) {
  if (level === 'high') return 'border-red-200 bg-red-50 text-red-700';
  if (level === 'medium') return 'border-amber-200 bg-amber-50 text-amber-700';
  return 'border-slate-200 bg-slate-50 text-slate-600';
}

function promptPreview(image, plan) {
  return image.promptPreview || image.prompt?.slice(0, 360) || plan?.prompt?.slice(0, 360) || '暂无 Prompt 预览';
}

function qualityClass(level) {
  if (level === 'good') return 'border-emerald-200 bg-emerald-50 text-emerald-700';
  if (level === 'medium') return 'border-amber-200 bg-amber-50 text-amber-700';
  if (level === 'poor') return 'border-red-200 bg-red-50 text-red-700';
  return 'border-slate-200 bg-slate-50 text-slate-600';
}

function auditToneClass(tone) {
  if (tone === 'ok') return 'border-emerald-200 bg-emerald-50 text-emerald-700';
  if (tone === 'danger') return 'border-red-200 bg-red-50 text-red-700';
  return 'border-amber-200 bg-amber-50 text-amber-700';
}

const compositePresets = [
  { id: 'desk_center', label: '桌面居中', settings: { placement: 'center', scale: 0.62, offsetX: 0, offsetY: 40, shadowEnabled: true, shadowType: 'soft_contact' } },
  { id: 'desk_bottom_center', label: '桌面底部居中', settings: { placement: 'bottom_center', scale: 0.72, offsetX: 0, offsetY: 90, shadowEnabled: true, shadowType: 'soft_contact' } },
  { id: 'hero_right', label: '右侧展示', settings: { placement: 'right', scale: 0.62, offsetX: -60, offsetY: 20, shadowEnabled: true, shadowType: 'drop_shadow' } },
  { id: 'floating_product', label: '悬浮产品展示', settings: { placement: 'center', scale: 0.56, offsetX: 0, offsetY: -80, shadowEnabled: true, shadowType: 'drop_shadow', shadowOffsetY: 34 } }
];

const defaultCompositeSettings = {
  placement: 'bottom_center',
  scale: 0.72,
  offsetX: 0,
  offsetY: 70,
  shadowEnabled: true,
  shadowType: 'soft_contact',
  shadowOpacity: 0.28,
  shadowBlur: 28,
  shadowOffsetY: 18,
  edgeFeather: 1.5,
  backgroundBlur: 0,
  colorMatch: 'none'
};

function numberOrFallback(value, fallback) {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : fallback;
}

function normalizeClientCompositeSettings(value = {}) {
  return normalizeCompositeSettingsValue(value);
}

function targetDisplayLabel(target = {}) {
  return `${target.platformName || target.platform || target.platformId || '平台'} / ${target.site || 'US'} / ${target.language || 'English'}`;
}

function groupGeneratedImages(task = {}) {
  const taskValue = task && typeof task === 'object' ? task : {};
  const taskTargets = Array.isArray(taskValue.targets) ? taskValue.targets : [];
  const taskGeneratedImages = Array.isArray(taskValue.generatedImages) ? taskValue.generatedImages : [];
  const targets = taskTargets.length
    ? taskTargets
    : [{
        id: 'legacy-target',
        targetId: 'legacy-target',
        platformId: taskValue.platformId || taskValue.platform,
        platformName: taskValue.platform,
        site: taskValue.site,
        language: taskValue.language
      }];
  const groups = targets.map((target) => ({
    kind: 'group',
    key: target.id || target.targetId || target.platformId,
    target,
    images: taskGeneratedImages.filter((image) => image.targetId === target.id || image.targetId === target.targetId || image.platformId === target.platformId)
  })).filter((group) => group.images.length > 0);
  const groupedIds = new Set(groups.flatMap((group) => group.images.map((image) => image.id)));
  const orphans = taskGeneratedImages.filter((image) => !groupedIds.has(image.id));
  if (orphans.length) {
    groups.push({
      kind: 'group',
      key: 'unknown-target',
      target: { platformName: orphans[0].platform || orphans[0].platformId || '未分组平台', site: orphans[0].site, language: orphans[0].language },
      images: orphans
    });
  }
  return groups.flatMap((group) => [
    group,
    ...group.images.map((image) => ({ kind: 'image', key: image.id, image }))
  ]);
}

export default function GeneratePage() {
  const { taskId } = useParams();
  const navigate = useNavigate();
  const { task, setTask, loading, error, setError } = useTask(taskId);
  const [busy, setBusy] = useState(false);
  const [previewImage, setPreviewImage] = useState(null);
  const [regeneratingPlanId, setRegeneratingPlanId] = useState('');
  const [referencePickerPlanId, setReferencePickerPlanId] = useState('');
  const [mattingPreviewByPlan, setMattingPreviewByPlan] = useState({});
  const [previewingMattingPlanId, setPreviewingMattingPlanId] = useState('');
  const [cardErrors, setCardErrors] = useState({});
  const [providerConfig, setProviderConfig] = useState(null);
  const [templateAudit, setTemplateAudit] = useState(null);
  const [templateAuditError, setTemplateAuditError] = useState('');
  const [singleImageType, setSingleImageType] = useState('main_image');
  const [singleMattingProvider, setSingleMattingProvider] = useState('sharp');
  const [singleImageReport, setSingleImageReport] = useState(null);
  const [singleImageBusy, setSingleImageBusy] = useState(false);
  const [singleImageError, setSingleImageError] = useState('');
  const [threeSampleDrafts, setThreeSampleDrafts] = useState([
    { sampleId: 'sample-1', imageType: 'main_image', imageId: '' },
    { sampleId: 'sample-2', imageType: 'feature_image', imageId: '' },
    { sampleId: 'sample-3', imageType: 'detail_image', imageId: '' }
  ]);
  const [threeSampleConfirm, setThreeSampleConfirm] = useState(false);
  const [threeSampleReport, setThreeSampleReport] = useState(null);
  const [threeSampleBusy, setThreeSampleBusy] = useState(false);
  const [threeSampleError, setThreeSampleError] = useState('');
  const [compositeDraftByPlan, setCompositeDraftByPlan] = useState({});
  const [compositeSavingPlanId, setCompositeSavingPlanId] = useState('');
  const [layoutSavingPlanId, setLayoutSavingPlanId] = useState('');

  const imagePlans = useMemo(() => (Array.isArray(task?.imagePlans) ? task.imagePlans : []), [task?.imagePlans]);
  const generatedImages = useMemo(() => (Array.isArray(task?.generatedImages) ? task.generatedImages : []), [task?.generatedImages]);
  const sourceImages = useMemo(() => (Array.isArray(task?.sourceImages) ? task.sourceImages : []), [task?.sourceImages]);
  const plansById = useMemo(() => Object.fromEntries(imagePlans.map((plan) => [plan.id, plan])), [imagePlans]);
  const generatedDisplayItems = useMemo(() => groupGeneratedImages(task || {}), [task?.targets, task?.generatedImages]);
  const templateAuditSections = useMemo(() => templateAuditDisplaySections(templateAudit), [templateAudit]);
  const singleImageSections = useMemo(() => singleImageAcceptanceReportSections(singleImageReport), [singleImageReport]);
  const threeSampleSections = useMemo(() => threeSampleGenerationSections(threeSampleReport), [threeSampleReport]);
  const selectedThreeSamples = useMemo(() => threeSampleDrafts.slice(0, 3).map((sample, index) => ({
    ...sample,
    imageId: sample.imageId || sourceImages[index]?.id || sourceImages[0]?.id || ''
  })).filter((sample) => sample.imageId), [threeSampleDrafts, sourceImages]);
  const threeSampleRunState = threeSampleCanRun({ confirmPaidApi: threeSampleConfirm, samples: selectedThreeSamples });

  async function generate() {
    setBusy(true);
    setError('');
    try {
      const result = await api.generateImages(taskId);
      setTask(result.task);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    api.getProviderConfig()
      .then(setProviderConfig)
      .catch(() => setProviderConfig(null));
  }, []);

  useEffect(() => {
    if (!taskId || loading || !task) return;
    let alive = true;
    setTemplateAuditError('');
    api.getTemplateAudit(taskId)
      .then((result) => {
        if (alive) setTemplateAudit(result.templateAudit || null);
      })
      .catch((err) => {
        if (alive) {
          setTemplateAudit(null);
          setTemplateAuditError(err.message);
        }
      });
    return () => {
      alive = false;
    };
  }, [taskId, loading, task?.updatedAt, generatedImages.length, imagePlans.length]);

  function downloadTemplateAudit() {
    if (!templateAudit) return;
    downloadTemplateAuditJson(templateAudit);
  }

  async function runSingleImageGeneration() {
    setSingleImageBusy(true);
    setSingleImageError('');
    try {
      const result = await api.runSingleImageGeneration({
        taskId,
        imageType: singleImageType,
        mattingProvider: singleMattingProvider,
        provider: 'openai',
        realMode: 'auto',
        confirmReal: true
      });
      setSingleImageReport(result.report);
    } catch (err) {
      setSingleImageError(err.message);
    } finally {
      setSingleImageBusy(false);
    }
  }

  function downloadSingleImageReport() {
    if (!singleImageReport) return;
    downloadSingleImageGenerationJson(singleImageReport);
  }

  function updateThreeSampleDraft(index, patch) {
    setThreeSampleDrafts((current) => current.map((sample, sampleIndex) => (
      sampleIndex === index ? { ...sample, ...patch } : sample
    )));
  }

  async function runThreeSampleGeneration() {
    const runState = threeSampleCanRun({ confirmPaidApi: threeSampleConfirm, samples: selectedThreeSamples });
    if (!runState.canRun) {
      setThreeSampleError(runState.reason);
      return;
    }
    setThreeSampleBusy(true);
    setThreeSampleError('');
    try {
      const result = await api.runThreeSampleGeneration({
        taskId,
        samples: selectedThreeSamples,
        mattingProvider: singleMattingProvider,
        generationProvider: 'openai',
        confirmPaidApi: threeSampleConfirm
      });
      setThreeSampleReport(result);
    } catch (err) {
      setThreeSampleError(err.message);
    } finally {
      setThreeSampleBusy(false);
    }
  }

  function downloadThreeSampleReport() {
    if (!threeSampleReport) return;
    downloadThreeSampleGenerationJson(threeSampleReport);
  }

  async function regenerate(planId, mode = 'mock', realMode = 'auto', extra = {}) {
    setRegeneratingPlanId(planId);
    setCardErrors((current) => ({ ...current, [planId]: '' }));
    try {
      const result = await api.regenerateImage(taskId, planId, { mode, realMode, ...extra });
      setTask(result.task);
    } catch (err) {
      setCardErrors((current) => ({ ...current, [planId]: err.message }));
    } finally {
      setRegeneratingPlanId('');
    }
  }

  function updateCompositeDraft(planId, patch) {
    setCompositeDraftByPlan((current) => ({
      ...current,
      [planId]: normalizeClientCompositeSettings({
        ...(current[planId] || plansById[planId]?.compositeSettings || {}),
        ...patch
      })
    }));
  }

  async function saveCompositeSettings(planId, settings) {
    setCompositeSavingPlanId(planId);
    setCardErrors((current) => ({ ...current, [planId]: '' }));
    try {
      const result = await api.updatePlan(taskId, planId, { compositeSettings: settings });
      setTask(result.task);
      setCompositeDraftByPlan((current) => ({ ...current, [planId]: normalizeClientCompositeSettings(settings) }));
    } catch (err) {
      setCardErrors((current) => ({ ...current, [planId]: err.message }));
    } finally {
      setCompositeSavingPlanId('');
    }
  }

  async function saveTextLayout(planId, textLayoutOverride) {
    setLayoutSavingPlanId(planId);
    setCardErrors((current) => ({ ...current, [planId]: '' }));
    try {
      const result = await api.updateTextLayout(taskId, planId, textLayoutOverride);
      setTask(result.task);
      return result.task;
    } catch (err) {
      setCardErrors((current) => ({ ...current, [planId]: err.message }));
      return null;
    } finally {
      setLayoutSavingPlanId('');
    }
  }

  async function restoreTextLayout(planId) {
    setLayoutSavingPlanId(planId);
    setCardErrors((current) => ({ ...current, [planId]: '' }));
    try {
      const result = await api.restoreTextLayout(taskId, planId);
      setTask(result.task);
    } catch (err) {
      setCardErrors((current) => ({ ...current, [planId]: err.message }));
    } finally {
      setLayoutSavingPlanId('');
    }
  }

  async function updateReference(planId, sourceImageId) {
    setCardErrors((current) => ({ ...current, [planId]: '' }));
    try {
      const result = await api.updatePlanReference(taskId, planId, sourceImageId);
      setTask(result.task);
      setReferencePickerPlanId('');
    } catch (err) {
      setCardErrors((current) => ({ ...current, [planId]: err.message }));
    }
  }

  async function previewMatting(planId, sourceImageId) {
    setPreviewingMattingPlanId(planId);
    setCardErrors((current) => ({ ...current, [planId]: '' }));
    try {
      const result = await api.previewMatting(taskId, planId, sourceImageId);
      setMattingPreviewByPlan((current) => ({ ...current, [planId]: result.preview }));
    } catch (err) {
      setCardErrors((current) => ({ ...current, [planId]: err.message }));
    } finally {
      setPreviewingMattingPlanId('');
    }
  }

  if (loading) return <div className="text-sm text-slate-500">正在加载生成工作区...</div>;

  const canGenerate = canRunAction(task.status, 'generateImages');
  const generateReason = !imagePlans.length ? '请先生成图片方案。' : actionDisabledReason(task.status, 'generateImages');

  return (
    <div className="space-y-5">
      <StepNav taskId={taskId} />
      <TaskProgress task={task} />
      <ErrorMessage error={error} />
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-ink">图片生成与预览</h1>
          <p className="mt-1 text-sm text-slate-500">当前使用 mock 生图：本地生成模板化预览图，用来检查 8 类图片结构和文案风险。</p>
          {providerConfig && (
            <p className="mt-1 text-sm text-slate-500">
              IMAGE_PROVIDER：{providerConfig.IMAGE_PROVIDER || providerConfig.selectedImageProvider} / BACKGROUND_PROVIDER：{providerConfig.BACKGROUND_PROVIDER || providerConfig.selectedBackgroundProvider}
            </p>
          )}
        </div>
        <div>
          <PrimaryButton busy={busy} disabled={!imagePlans.length || !canGenerate} onClick={generate}>
            <Images size={17} />
            生成 mock 预览图
          </PrimaryButton>
          <DisabledReason reason={!imagePlans.length || !canGenerate ? generateReason : ''} />
        </div>
      </div>

      <Section title="模板验收摘要">
        <div className="space-y-4 text-sm">
          {templateAuditError && (
            <div className="rounded border border-amber-200 bg-amber-50 p-3 text-amber-700">
              模板验收报告加载失败：{templateAuditError}
            </div>
          )}
          {templateAuditSections.emptyText ? (
            <div className="rounded border border-slate-200 bg-slate-50 p-3 text-slate-500">
              {templateAuditSections.emptyText}
            </div>
          ) : (
            <>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <div className="font-semibold text-ink">模板验收摘要</div>
                  <div className="mt-1 text-slate-500">{templateAuditSections.summaryText}</div>
                </div>
                <button
                  type="button"
                  onClick={downloadTemplateAudit}
                  className="rounded border border-slate-300 bg-white px-3 py-2 text-xs font-medium text-slate-700"
                >
                  导出 JSON
                </button>
              </div>
              <div className="rounded border border-blue-200 bg-blue-50 p-3 text-xs text-blue-800">
                {templateAuditExportNotice}
              </div>

              <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
                {templateAuditSections.summaryCards.map((card) => (
                  <div key={card.label} className={`rounded border p-3 ${auditToneClass(card.tone)}`}>
                    <div className="text-xs font-medium opacity-80">{card.label}</div>
                    <div className="mt-1 text-lg font-semibold">{card.value}</div>
                  </div>
                ))}
              </div>

              <div className="rounded border border-slate-200 bg-white p-3">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <div className="font-semibold text-slate-700">规则审计摘要</div>
                    <div className="mt-1 text-slate-500">{templateAuditSections.ruleAuditText}</div>
                    {templateAuditSections.ruleAuditContextText && (
                      <div className="mt-1 text-amber-700">{templateAuditSections.ruleAuditContextText}</div>
                    )}
                  </div>
                  {templateAuditSections.ruleAuditEmptyText && (
                    <span className="rounded border border-slate-200 bg-slate-50 px-2 py-1 text-xs text-slate-500">
                      {templateAuditSections.ruleAuditEmptyText}
                    </span>
                  )}
                </div>

                <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-6">
                  {templateAuditSections.ruleAuditCards.map((card) => (
                    <div key={`rule-${card.label}`} className={`rounded border p-2 ${auditToneClass(card.tone)}`}>
                      <div className="text-xs font-medium opacity-80">{card.label}</div>
                      <div className="mt-1 text-sm font-semibold">{card.value}</div>
                    </div>
                  ))}
                </div>

                <div className="mt-3 grid gap-3 lg:grid-cols-2">
                  <div className="rounded border border-slate-200 bg-slate-50 p-3 text-slate-600">
                    <div className="font-semibold text-slate-700">文案风险</div>
                    <div className="mt-1">{templateAuditSections.ruleAuditCopyRiskText}</div>
                  </div>
                  <div className="rounded border border-slate-200 bg-slate-50 p-3 text-slate-600">
                    <div className="font-semibold text-slate-700">Amazon 主图风险</div>
                    <div className="mt-1">{templateAuditSections.ruleAuditAmazonText}</div>
                  </div>
                </div>

                {templateAuditSections.ruleAuditFields.length > 0 && (
                  <div className="mt-3">
                    <div className="text-xs font-semibold text-slate-500">字段风险</div>
                    <div className="mt-2 flex flex-wrap gap-2">
                      {templateAuditSections.ruleAuditFields.map((field, index) => (
                        <span key={`${field.fieldKey}-${field.reason}-${index}`} className="rounded border border-amber-200 bg-amber-50 px-2 py-1 text-xs text-amber-800">
                          {field.labelText} / {field.imageTypeLabel} / {field.reason}
                        </span>
                      ))}
                    </div>
                  </div>
                )}

                {templateAuditSections.ruleAuditGroups.length > 0 && (
                  <div className="mt-3 space-y-2">
                    <div className="text-xs font-semibold text-slate-500">按图片类型分组</div>
                    {templateAuditSections.ruleAuditGroups.map((group) => (
                      <details key={`rule-group-${group.imageType}`} className="rounded border border-slate-200 bg-slate-50 p-3">
                        <summary className="cursor-pointer text-sm font-semibold text-slate-700">{group.summaryText}</summary>
                        <div className="mt-2 space-y-2 text-xs text-slate-600">
                          {group.issues.length ? group.issues.map((issue, index) => (
                            <div key={`${issue.code}-${index}`} className={`rounded border p-2 ${auditToneClass(issue.severity === 'error' ? 'danger' : 'warn')}`}>
                              <div className="font-semibold">{issue.severity} / {issue.code}</div>
                              <div className="mt-1">{issue.message}</div>
                              <div className="mt-1">{issue.suggestion}</div>
                            </div>
                          )) : (
                            <div className="rounded border border-emerald-200 bg-emerald-50 p-2 text-emerald-700">该图片类型暂无规则风险。</div>
                          )}
                        </div>
                      </details>
                    ))}
                  </div>
                )}
              </div>

              <div className="overflow-auto rounded border border-slate-200">
                <table className="min-w-full divide-y divide-slate-200 text-xs">
                  <thead className="bg-slate-50 text-left text-slate-500">
                    <tr>
                      <th className="px-3 py-2 font-medium">图片类型</th>
                      <th className="px-3 py-2 font-medium">是否存在</th>
                      <th className="px-3 py-2 font-medium">templateName</th>
                      <th className="px-3 py-2 font-medium">layoutStyle</th>
                      <th className="px-3 py-2 font-medium">variantId</th>
                      <th className="px-3 py-2 font-medium">layoutSeed</th>
                      <th className="px-3 py-2 font-medium">状态</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 bg-white">
                    {templateAuditSections.coverageRows.map((row) => (
                      <tr key={row.imageType}>
                        <td className="px-3 py-2 font-medium text-slate-700">{row.imageTypeLabel}</td>
                        <td className={`px-3 py-2 ${row.exists ? 'text-emerald-700' : 'text-red-700'}`}>{row.existsText}</td>
                        <td className="px-3 py-2 text-slate-600">{row.templateName}</td>
                        <td className="px-3 py-2 text-slate-600">{row.layoutStyle}</td>
                        <td className="px-3 py-2 text-slate-600">{row.variantId}</td>
                        <td className="px-3 py-2 text-slate-600">{row.layoutSeed}</td>
                        <td className="px-3 py-2 text-slate-500">{row.status}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <div className="grid gap-3 lg:grid-cols-2">
                <div className="rounded border border-slate-200 bg-slate-50 p-3 text-slate-600">
                  <div className="font-semibold text-slate-700">模板差异化</div>
                  <div className="mt-1">{templateAuditSections.diversityText}</div>
                </div>
                <div className="rounded border border-slate-200 bg-slate-50 p-3 text-slate-600">
                  <div className="font-semibold text-slate-700">Amazon 主图检查</div>
                  <div className="mt-1">{templateAuditSections.amazonText}</div>
                </div>
                <div className="rounded border border-slate-200 bg-slate-50 p-3 text-slate-600">
                  <div className="font-semibold text-slate-700">文案安全检查</div>
                  <div className="mt-1">{templateAuditSections.textSafetyText}</div>
                </div>
                <div className="rounded border border-slate-200 bg-slate-50 p-3 text-slate-600">
                  <div className="font-semibold text-slate-700">字段安全检查</div>
                  <div className="mt-1">{templateAuditSections.fieldSafetyText}</div>
                </div>
              </div>

              <div className="rounded border border-slate-200 bg-white p-3">
                <div className="font-semibold text-slate-700">中文建议</div>
                <ul className="mt-2 list-disc space-y-1 pl-5 text-slate-600">
                  {templateAuditSections.recommendations.map((item, index) => (
                    <li key={`${item}-${index}`}>{item}</li>
                  ))}
                </ul>
              </div>
            </>
          )}
        </div>
      </Section>

      <Section title="单 SKU 小样本生成真实生图">
        <div className="space-y-4 text-sm">
          <div className="rounded border border-blue-200 bg-blue-50 p-3 text-blue-800">
            <div className="font-semibold text-ink">单 SKU 小样本真实生图 / 真实生图验收报告</div>
            {singleImageGenerationNotice}
            <div className="mt-1 text-xs">{singleImageGenerationWarningText}</div>
          </div>
          {singleImageError && (
            <div className="rounded border border-red-200 bg-red-50 p-3 text-red-700">{singleImageError}</div>
          )}
          <div className="grid gap-3 md:grid-cols-3">
            <label className="block">
              <span className="mb-1 block text-xs font-semibold text-slate-500">生成图片类型</span>
              <select value={singleImageType} onChange={(event) => setSingleImageType(event.target.value)} className="w-full rounded border border-slate-300 bg-white px-3 py-2 text-sm">
                {singleImageGenerationOptions.map((option) => (
                  <option key={option.value} value={option.value}>{option.label}</option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="mb-1 block text-xs font-semibold text-slate-500">抠图 Provider</span>
              <select value={singleMattingProvider} onChange={(event) => setSingleMattingProvider(event.target.value)} className="w-full rounded border border-slate-300 bg-white px-3 py-2 text-sm">
                <option value="sharp">sharp 本地抠图</option>
                <option value="image2">Image2 实验抠图</option>
              </select>
            </label>
            <div className="flex items-end gap-2">
              <div className="text-xs font-medium text-slate-500">导出真实生图验收报告</div>
              <button type="button" onClick={runSingleImageGeneration} disabled={!imagePlans.length || singleImageBusy} className="rounded bg-coral px-3 py-2 text-sm font-medium text-white disabled:opacity-60">
                {singleImageBusy ? '正在生成...' : '运行单图真实生成'}
              </button>
              <button type="button" onClick={downloadSingleImageReport} disabled={!singleImageReport} className="rounded border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 disabled:opacity-60">
                下载生成结果 JSON
              </button>
            </div>
          </div>
          {singleImageSections.emptyText ? (
            <div className="rounded border border-slate-200 bg-slate-50 p-3 text-slate-500">{singleImageSections.emptyText}</div>
          ) : (
            <div className="space-y-3">
              <div>
                <div className="font-semibold text-ink">{singleImageSections.title}</div>
                <div className="mt-1 text-xs text-slate-500">manualChecklist 默认未检查，请人工打开图片后逐项确认。</div>
              </div>
              <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-6">
                {singleImageSections.cards.map((card) => (
                  <div key={card.label} className="rounded border border-slate-200 bg-slate-50 p-3">
                    <div className="text-xs font-semibold text-slate-500">{card.label}</div>
                    <div className="mt-1 font-semibold text-ink">{card.value}</div>
                  </div>
                ))}
              </div>
              <div className="rounded border border-slate-200 bg-white p-3 text-slate-600">{singleImageSections.resultText}</div>
              <div className="rounded border border-slate-200 bg-white p-3 text-slate-600">{singleImageSections.statusText}</div>
              <div className="rounded border border-slate-200 bg-white p-3 text-slate-600">{singleImageSections.providerText}</div>
              <div className="rounded border border-slate-200 bg-white p-3 text-slate-600">{singleImageSections.fallbackText}</div>
              <div className="rounded border border-slate-200 bg-white p-3 text-slate-600">{singleImageSections.auditText}</div>
              <div className="rounded border border-slate-200 bg-white p-3 text-slate-600">{singleImageSections.qualityText}</div>
              <div className="rounded border border-slate-200 bg-white p-3 text-slate-600">{singleImageSections.ruleAuditText}</div>
              <div className="rounded border border-slate-200 bg-white p-3 text-slate-600">{singleImageSections.templateAuditText}</div>
              <div className="rounded border border-slate-200 bg-white p-3 text-slate-600">{singleImageSections.manualChecklistText}</div>
              <div className="rounded border border-blue-200 bg-blue-50 p-3 text-blue-800">{singleImageSections.conclusionText}</div>
              {singleImageSections.ruleText && <div className="rounded border border-slate-200 bg-white p-3 text-slate-600">{singleImageSections.ruleText}</div>}
              {singleImageSections.warnings.length > 0 && (
                <div className="rounded border border-amber-200 bg-amber-50 p-3 text-amber-800">{singleImageSections.warnings.join('；')}</div>
              )}
            </div>
          )}
          <div className="border-t border-slate-200 pt-4">
            <div className="font-semibold text-ink">三张小样本对比</div>
            <div className="mt-1 rounded border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800">
              本次最多生成 3 张真实小样本，可能产生 API 成本。请确认后继续。
            </div>
            <div className="mt-3 grid gap-3 lg:grid-cols-3">
              {threeSampleDrafts.map((sample, index) => (
                <div key={sample.sampleId} className="rounded border border-slate-200 bg-slate-50 p-3">
                  <div className="mb-2 text-xs font-semibold text-slate-500">{sample.sampleId}</div>
                  <select value={sample.imageId} onChange={(event) => updateThreeSampleDraft(index, { imageId: event.target.value })} className="mb-2 w-full rounded border border-slate-300 bg-white px-2 py-1 text-xs">
                    <option value="">自动选择样本图片</option>
                    {sourceImages.slice(0, 8).map((source) => (
                      <option key={source.id} value={source.id}>{source.displayName || source.fileName || source.id}</option>
                    ))}
                  </select>
                  <select value={sample.imageType} onChange={(event) => updateThreeSampleDraft(index, { imageType: event.target.value })} className="w-full rounded border border-slate-300 bg-white px-2 py-1 text-xs">
                    {singleImageGenerationOptions.map((option) => (
                      <option key={option.value} value={option.value}>{option.label}</option>
                    ))}
                  </select>
                </div>
              ))}
            </div>
            <label className="mt-3 flex items-start gap-2 text-xs text-slate-700">
              <input type="checkbox" checked={threeSampleConfirm} onChange={(event) => setThreeSampleConfirm(event.target.checked)} />
              <span>我确认这是小样本测试，并接受可能产生的 API 成本。</span>
            </label>
            {threeSampleError && <div className="mt-3 rounded border border-red-200 bg-red-50 p-3 text-red-700">{threeSampleError}</div>}
            <div className="mt-3 flex flex-wrap gap-2">
              <button type="button" onClick={runThreeSampleGeneration} disabled={!threeSampleRunState.canRun || threeSampleBusy} className="rounded bg-coral px-3 py-2 text-sm font-medium text-white disabled:opacity-60">
                {threeSampleBusy ? '正在生成三张小样本...' : '开始三张小样本对比'}
              </button>
              <button type="button" onClick={downloadThreeSampleReport} disabled={!threeSampleReport} className="rounded border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 disabled:opacity-60">
                导出三张小样本 JSON
              </button>
              {!threeSampleRunState.canRun && <span className="self-center text-xs text-slate-500">{threeSampleRunState.reason}</span>}
            </div>
            {threeSampleSections.emptyText ? (
              <div className="mt-3 rounded border border-slate-200 bg-slate-50 p-3 text-slate-500">{threeSampleSections.emptyText}</div>
            ) : (
              <div className="mt-3 space-y-3">
                <div className="rounded border border-slate-200 bg-white p-3 text-slate-600">{threeSampleSections.summaryText}</div>
                <div className="rounded border border-slate-200 bg-white p-3 text-slate-600">{threeSampleSections.comparisonText}</div>
                <div className="rounded border border-blue-200 bg-blue-50 p-3 text-blue-800">{threeSampleSections.recommendationText}</div>
                <div className="grid gap-3 lg:grid-cols-3">
                  {threeSampleSections.sampleCards.map((card) => (
                    <div key={card.sampleId} className="rounded border border-slate-200 bg-white p-3 text-xs text-slate-600">
                      <div className="font-semibold text-ink">{card.sampleId} / {card.imageType}</div>
                      <div className="mt-1">{card.statusText}</div>
                      <div className="mt-1">{card.fallbackText}</div>
                      <div className="mt-1">{card.qualityText}</div>
                      <div className="mt-1">{card.warningText}</div>
                      <div className="mt-1">{card.ruleAuditText}</div>
                      <div className="mt-1 text-blue-700">{card.conclusionText}</div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      </Section>

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {generatedDisplayItems.map((entry) => {
          if (entry.kind === 'group') {
            const summary = entry.images.reduce((counts, image) => {
              if (image.isRealGenerated) counts.real += 1;
              else counts.mock += 1;
              if (image.fallbackToMock) counts.fallback += 1;
              return counts;
            }, { mock: 0, real: 0, fallback: 0 });
            return (
              <div key={`group-${entry.key}`} className="col-span-full rounded border border-slate-200 bg-white p-4">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <div className="text-lg font-semibold text-ink">{targetDisplayLabel(entry.target)}</div>
                    <div className="mt-1 text-sm text-slate-500">生成图片：{entry.images.length} 张 / mock：{summary.mock} / real：{summary.real} / fallback：{summary.fallback}</div>
                  </div>
                  <span className="rounded border border-slate-200 bg-slate-50 px-2 py-1 text-xs text-slate-500">
                    targetId: {entry.target.id || entry.target.targetId || '-'}
                  </span>
                </div>
              </div>
            );
          }
          const image = entry.image;
          const plan = plansById[image.planId] || {};
          const risks = image.riskWarnings || plan.riskWarnings || [];
          const missingInfo = image.mockPreview?.missingInfo || [];
          const regenerated = Boolean(image.regeneratedAt || (image.version || 1) > 1);
          const requestSummary = image.generationRequestSummary || plan.generationRequestSummary;
          const canTryRealBackground = image.type === 'lifestyle_image' && requestSummary?.preferredMode === 'background_replace' && requestSummary?.safeForRealGeneration;
          const sourceStatus = getImageSourceStatus(image);
          const productReference = image.productReference || image.generationRequest?.productReference;
          const realModeLabel = image.realGenerationMode || (image.subjectCompositeUsed ? 'subject_composite' : image.editAttempted ? 'image_edit' : image.isRealGenerated ? 'text_to_image' : 'mock');
          const preserveQuality = image.preserveQuality || {};
          const generationStrategy = image.generationStrategy || {};
          const referenceOverride = plan.productReferenceOverride;
          const selectedSourceImage = referenceOverride
            ? sourceImages.find((source) => source.id === referenceOverride.sourceImageId)
            : null;
          const displayReference = selectedSourceImage || productReference;
          const selectedSourceId = selectedSourceImage?.id || productReference?.sourceImageId;
          const mattingPreview = mattingPreviewByPlan[image.planId];
          const compositeSettings = normalizeClientCompositeSettings(compositeDraftByPlan[image.planId] || plan.compositeSettings || image.compositeSettings);
          const compositeQuality = image.compositeQuality || preserveQuality.compositeQuality || {};
          const textLayout = image.textLayout || plan.textLayout;
          return (
            <Section key={image.id} title={imageTitle(image)}>
              <button type="button" className="block w-full" onClick={() => setPreviewImage(image)}>
                <img
                  src={`${ASSET_BASE}${image.previewUrl || image.url}`}
                  alt={imageTitle(image)}
                  className="aspect-square w-full rounded border border-slate-200 object-cover transition hover:opacity-90"
                />
              </button>
              <div className="mt-3 space-y-3 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="rounded border border-slate-200 bg-slate-50 px-2 py-1 text-slate-600">{image.status}</span>
                  <span className="rounded border border-slate-200 bg-slate-50 px-2 py-1 text-slate-600">{image.provider}/{image.model}</span>
                  <span className="rounded border border-slate-200 bg-slate-50 px-2 py-1 text-slate-600">图片版本 {image.version || 1}</span>
                  {plan.editedByUser && <span className="rounded border border-blue-200 bg-blue-50 px-2 py-1 text-blue-700">方案已编辑</span>}
                  {regenerated && <span className="rounded border border-purple-200 bg-purple-50 px-2 py-1 text-purple-700">已重新生成</span>}
                  {image.isMockPreview && <span className="rounded border border-amber-200 bg-amber-50 px-2 py-1 text-amber-700">MOCK PREVIEW</span>}
                  {image.isRealGenerated && <span className="rounded border border-emerald-200 bg-emerald-50 px-2 py-1 text-emerald-700">REAL GENERATED</span>}
                  {image.fallbackToMock && <span className="rounded border border-red-200 bg-red-50 px-2 py-1 text-red-700">真实生成失败，已回退 mock</span>}
                  {requestSummary && (
                    <span className={`rounded border px-2 py-1 ${requestSummary.safeForRealGeneration ? 'border-emerald-200 bg-emerald-50 text-emerald-700' : 'border-amber-200 bg-amber-50 text-amber-700'}`}>
                      {requestSummary.safeForRealGeneration ? '可接入真实生图' : '暂不建议真实生图'}
                    </span>
                  )}
                </div>

                <div className={`rounded border p-3 text-xs ${sourceStatus.className}`}>
                  <div className="font-semibold">{sourceStatus.label} · {sourceStatus.title}</div>
                  <div className="mt-1">{sourceStatus.description}</div>
                  {image.isRealGenerated && (
                    <div className="mt-1">provider: {image.provider} / model: {image.model}</div>
                  )}
                  {image.fallbackToMock && image.realGenerationError && (
                    <div className="mt-1">错误：{image.realGenerationError.code} / {image.realGenerationError.message}</div>
                  )}
                </div>

                {image.type === 'lifestyle_image' && (
                  <div className="rounded border border-slate-200 bg-slate-50 p-3 text-xs text-slate-600">
                    <div className="font-semibold text-slate-700">真实生成模式：{realModeLabel}</div>
                    {realModeLabel === 'text_to_image' && (
                      <div className="mt-1">当前为 text-to-image，不会严格保留原商品主体。</div>
                    )}
                    {image.subjectCompositeUsed ? (
                      <div className="mt-1 text-emerald-700">商品主体已保留，背景由 AI 生成。</div>
                    ) : image.productReferenceUsed ? (
                      <div className="mt-1 text-amber-700">已使用商品参考图，但商品主体可能被 AI 重绘。</div>
                    ) : (
                      <div className="mt-1 text-amber-700">未使用商品参考图。</div>
                    )}
                    {image.productGeneratedByAI && (
                      <div className="mt-1 text-amber-700">商品主体可能由 AI 重新绘制，请人工核对外观、颜色、接口和纹理。</div>
                    )}
                    {image.editFailed && (
                      <div className="mt-1 text-red-700">edit 失败，已回退到 {image.fallbackMode || 'mock'}。</div>
                    )}
                    {image.subjectCompositeUsed && (
                      <div className="mt-2 rounded border border-slate-200 bg-white p-2">
                        <div>抠图 Provider：{image.mattingProvider || '-'}</div>
                        <div>抠图方法：{image.mattingMethod || image.subjectExtractionMethod || '-'}</div>
                        <div>背景类型：{image.backgroundType || '-'}</div>
                        <div>边缘质量：{image.edgeQuality || '-'}</div>
                        <div>抠图置信度：{image.mattingConfidence == null ? '-' : Math.round(image.mattingConfidence * 100) + '%'}</div>
                        {image.mattingWarnings?.length > 0 && (
                          <div className="mt-1 text-amber-700">提示：{image.mattingWarnings.join('；')}</div>
                        )}
                        {image.mattingFallbackToSharp && (
                          <div className="mt-1 font-semibold text-amber-700">
                            external matting 失败，已回退 sharp：{image.externalMattingError?.code || 'UNKNOWN'}
                          </div>
                        )}
                        {image.subjectPngPath && (
                          <div className="mt-1 break-all text-slate-500">主体 PNG：{image.subjectPngPath}</div>
                        )}
                        {image.maskPath && (
                          <div className="mt-1 break-all text-slate-500">Mask：{image.maskPath}</div>
                        )}
                        {image.edgeQuality === 'poor' && (
                          <div className="mt-1 font-semibold text-red-700">主体抠图质量较低，建议换一张白底主图或使用 image edit。</div>
                        )}
                      </div>
                    )}
                    <div className={`mt-2 rounded border p-2 ${qualityClass(preserveQuality.qualityLevel)}`}>
                      <div className="font-semibold">主体保留评估：{preserveQuality.qualityLevel || 'unknown'} / {preserveQuality.qualityScore ?? 0} 分</div>
                      <div className="mt-1">当前策略：{generationStrategy.selectedMode || realModeLabel}</div>
                      <div>推荐策略：{generationStrategy.recommendedMode || '-'}</div>
                      <div>主体保真风险：{preserveQuality.subjectPreserveRisk || '-'}</div>
                      {preserveQuality.reasons?.length > 0 && (
                        <div className="mt-1">原因：{preserveQuality.reasons.slice(0, 2).join('；')}</div>
                      )}
                      {preserveQuality.suggestions?.length > 0 && (
                        <div className="mt-1">建议：{preserveQuality.suggestions.slice(0, 2).join('；')}</div>
                      )}
                      {generationStrategy.userMessage && (
                        <div className="mt-1">{generationStrategy.userMessage}</div>
                      )}
                    </div>
                    {displayReference?.enabled !== false && (displayReference?.displayName || displayReference?.previewUrl) && (
                      <div className="mt-2 flex items-center gap-3">
                        {displayReference.previewUrl && (
                          <img
                            src={`${ASSET_BASE}${displayReference.previewUrl}`}
                            alt={displayReference.displayName}
                            className="h-14 w-14 rounded border border-slate-200 object-cover"
                          />
                        )}
                        <div>
                          <div className="font-medium text-slate-700">商品参考图：{displayReference.displayName}</div>
                          <div>选择方式：{referenceOverride ? '用户手动选择' : (productReference?.reason || productReference?.role || '自动选择')}</div>
                          {referenceOverride && <div className="text-amber-700">参考图已变更，建议重新生成此图。</div>}
                          <div className="hidden">
                          <div className="font-medium text-slate-700">参考图：{productReference.displayName}</div>
                          <div>选择原因：{productReference.reason || productReference.role || '-'}</div>
                          </div>
                        </div>
                      </div>
                    )}
                    <div className="mt-2 grid gap-2">
                      <div className="flex flex-wrap gap-2">
                        <button
                          type="button"
                          onClick={() => setReferencePickerPlanId(referencePickerPlanId === image.planId ? '' : image.planId)}
                          className="rounded border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700"
                        >
                          更换参考图
                        </button>
                        <button
                          type="button"
                          onClick={() => previewMatting(image.planId, selectedSourceId)}
                          disabled={previewingMattingPlanId === image.planId}
                          className="rounded border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 disabled:opacity-60"
                        >
                          {previewingMattingPlanId === image.planId ? '正在预览抠图...' : '预览抠图'}
                        </button>
                      </div>
                      {referencePickerPlanId === image.planId && (
                        <div className="grid grid-cols-3 gap-2 rounded border border-slate-200 bg-white p-2">
                          {sourceImages.map((source) => (
                            <button
                              key={source.id}
                              type="button"
                              onClick={() => updateReference(image.planId, source.id)}
                              className={`rounded border p-1 text-left text-[11px] ${selectedSourceId === source.id ? 'border-coral bg-red-50' : 'border-slate-200 bg-white'}`}
                            >
                              <img src={`${ASSET_BASE}${source.previewUrl || source.url}`} alt={source.displayName} className="mb-1 aspect-square w-full rounded object-cover" />
                              <div className="truncate">{source.displayName || source.fileName}</div>
                            </button>
                          ))}
                        </div>
                      )}
                      {mattingPreview && (
                        <div className="rounded border border-slate-200 bg-white p-2">
                          <div className="font-semibold text-slate-700">抠图预览：{mattingPreview.mattingProvider} / {mattingPreview.edgeQuality} / {Math.round((mattingPreview.confidence || 0) * 100)}%</div>
                          <div className="mt-1">背景类型：{mattingPreview.backgroundType}</div>
                          {mattingPreview.mattingFallbackToSharp && (
                            <div className="mt-1 text-amber-700">第三方抠图失败，已回退 sharp：{mattingPreview.externalMattingError?.code || 'UNKNOWN'}</div>
                          )}
                          {mattingPreview.warnings?.length > 0 && (
                            <div className="mt-1 text-amber-700">{mattingPreview.warnings.join('；')}</div>
                          )}
                          {mattingPreview.edgeQuality === 'poor' && (
                            <div className="mt-1 font-semibold text-red-700">建议换白底图或更清晰商品图。</div>
                          )}
                          <div className="mt-2 flex gap-2">
                            {mattingPreview.subjectPng?.previewUrl && (
                              <img src={`${ASSET_BASE}${mattingPreview.subjectPng.previewUrl}`} alt="subject preview" className="h-24 w-24 rounded border border-slate-200 object-contain" />
                            )}
                            {mattingPreview.mask?.previewUrl && (
                              <img src={`${ASSET_BASE}${mattingPreview.mask.previewUrl}`} alt="mask preview" className="h-24 w-24 rounded border border-slate-200 object-contain" />
                            )}
                          </div>
                        </div>
                      )}
                      <details className="rounded border border-slate-200 bg-white p-3">
                        <summary className="cursor-pointer font-semibold text-slate-700">主体合成设置</summary>
                        <div className="mt-3 space-y-3">
                          <div className="flex flex-wrap gap-2">
                            {compositePresets.map((preset) => (
                              <button
                                key={preset.id}
                                type="button"
                                onClick={() => updateCompositeDraft(image.planId, preset.settings)}
                                className="rounded border border-slate-300 bg-slate-50 px-2 py-1 text-[11px] font-medium text-slate-700"
                              >
                                {preset.label}
                              </button>
                            ))}
                          </div>

                          <label className="block">
                            <span className="text-xs font-medium text-slate-600">主体位置</span>
                            <select
                              value={compositeSettings.placement}
                              onChange={(event) => updateCompositeDraft(image.planId, { placement: event.target.value })}
                              className="mt-1 w-full rounded border border-slate-300 bg-white px-2 py-1 text-xs"
                            >
                              <option value="center">居中</option>
                              <option value="bottom_center">底部居中</option>
                              <option value="left">左侧</option>
                              <option value="right">右侧</option>
                              <option value="custom">自定义</option>
                            </select>
                          </label>

                          <div className="grid gap-3 sm:grid-cols-2">
                            <label className="block">
                              <span className="text-xs font-medium text-slate-600">主体大小：{Math.round(compositeSettings.scale * 100)}%</span>
                              <input type="range" min="0.4" max="1" step="0.01" value={compositeSettings.scale} onChange={(event) => updateCompositeDraft(image.planId, { scale: event.target.value })} className="mt-1 w-full" />
                            </label>
                            <label className="block">
                              <span className="text-xs font-medium text-slate-600">边缘柔化：{compositeSettings.edgeFeather}</span>
                              <input type="range" min="0" max="8" step="0.5" value={compositeSettings.edgeFeather} onChange={(event) => updateCompositeDraft(image.planId, { edgeFeather: event.target.value })} className="mt-1 w-full" />
                            </label>
                            <label className="block">
                              <span className="text-xs font-medium text-slate-600">水平偏移：{compositeSettings.offsetX}px</span>
                              <input type="range" min="-300" max="300" step="10" value={compositeSettings.offsetX} onChange={(event) => updateCompositeDraft(image.planId, { offsetX: event.target.value })} className="mt-1 w-full" />
                            </label>
                            <label className="block">
                              <span className="text-xs font-medium text-slate-600">垂直偏移：{compositeSettings.offsetY}px</span>
                              <input type="range" min="-300" max="300" step="10" value={compositeSettings.offsetY} onChange={(event) => updateCompositeDraft(image.planId, { offsetY: event.target.value })} className="mt-1 w-full" />
                            </label>
                          </div>

                          <div className="grid gap-3 sm:grid-cols-2">
                            <label className="flex items-center gap-2 text-xs font-medium text-slate-600">
                              <input type="checkbox" checked={Boolean(compositeSettings.shadowEnabled)} onChange={(event) => updateCompositeDraft(image.planId, { shadowEnabled: event.target.checked })} />
                              开启自然阴影
                            </label>
                            <label className="block">
                              <span className="text-xs font-medium text-slate-600">阴影类型</span>
                              <select
                                value={compositeSettings.shadowType}
                                onChange={(event) => updateCompositeDraft(image.planId, { shadowType: event.target.value })}
                                className="mt-1 w-full rounded border border-slate-300 bg-white px-2 py-1 text-xs"
                              >
                                <option value="soft_contact">柔和接触阴影</option>
                                <option value="drop_shadow">投影阴影</option>
                                <option value="none">无阴影</option>
                              </select>
                            </label>
                            <label className="block">
                              <span className="text-xs font-medium text-slate-600">阴影强度：{Math.round(compositeSettings.shadowOpacity * 100)}%</span>
                              <input type="range" min="0" max="0.8" step="0.02" value={compositeSettings.shadowOpacity} onChange={(event) => updateCompositeDraft(image.planId, { shadowOpacity: event.target.value })} className="mt-1 w-full" />
                            </label>
                            <label className="block">
                              <span className="text-xs font-medium text-slate-600">色彩融合</span>
                              <select
                                value={compositeSettings.colorMatch}
                                onChange={(event) => updateCompositeDraft(image.planId, { colorMatch: event.target.value })}
                                className="mt-1 w-full rounded border border-slate-300 bg-white px-2 py-1 text-xs"
                              >
                                <option value="none">不调整</option>
                                <option value="basic">基础亮度匹配</option>
                              </select>
                            </label>
                          </div>

                          {compositeQuality.level && (
                            <div className={`rounded border p-2 text-xs ${qualityClass(compositeQuality.level)}`}>
                              <div className="font-semibold">合成质量：{compositeQuality.level}</div>
                              <div>位置风险：{compositeQuality.subjectPlacementRisk || '-'} / 边缘风险：{compositeQuality.edgeBlendRisk || '-'} / 阴影风险：{compositeQuality.shadowRisk || '-'}</div>
                              {compositeQuality.suggestions?.length > 0 && <div className="mt-1">{compositeQuality.suggestions.slice(0, 2).join('；')}</div>}
                            </div>
                          )}

                          <div className="grid gap-2 sm:grid-cols-2">
                            <button
                              type="button"
                              onClick={() => saveCompositeSettings(image.planId, compositeSettings)}
                              disabled={compositeSavingPlanId === image.planId}
                              className="rounded border border-slate-300 bg-white px-3 py-2 text-xs font-medium text-slate-700 disabled:opacity-60"
                            >
                              {compositeSavingPlanId === image.planId ? '正在保存...' : '保存合成设置'}
                            </button>
                            <button
                              type="button"
                              onClick={() => regenerate(image.planId, 'real_background', 'subject_composite', { compositeSettings })}
                              disabled={regeneratingPlanId === image.planId}
                              className="rounded bg-coral px-3 py-2 text-xs font-medium text-white disabled:opacity-60"
                            >
                              使用当前合成设置重新生成
                            </button>
                          </div>
                        </div>
                      </details>
                    </div>
                  </div>
                )}

                <div className="break-all text-xs font-medium text-slate-500">{image.fileName}</div>

                {missingInfo.length > 0 && (
                  <div className="rounded border border-amber-200 bg-amber-50 p-2 text-amber-700">
                    {missingInfo.join('；')}
                  </div>
                )}

                {requestSummary?.blockingIssues?.length > 0 && (
                  <div className="rounded border border-amber-200 bg-amber-50 p-2 text-xs text-amber-700">
                    {requestSummary.blockingIssues.join('；')}
                  </div>
                )}

                {image.realGenerationSkipped && (
                  <div className="rounded border border-slate-200 bg-slate-50 p-2 text-xs text-slate-600">
                    当前类型暂不支持真实生图，继续使用 mock：{image.skipReason}
                  </div>
                )}

                {image.realGenerationError && (
                  <div className="rounded border border-red-200 bg-red-50 p-2 text-xs text-red-700">
                    真实生成错误：{image.realGenerationError.code} / {image.realGenerationError.message}
                  </div>
                )}

                {risks.length > 0 && (
                  <div className="space-y-2">
                    {risks.slice(0, 3).map((risk, index) => (
                      <div key={`${risk.field || 'risk'}-${index}`} className={`rounded border p-2 text-xs ${riskClass(risk.level)}`}>
                        {risk.message || String(risk)}
                      </div>
                    ))}
                  </div>
                )}

                {textLayout && (
                  <details open className="rounded border border-slate-200 bg-slate-50 p-3 text-xs text-slate-600">
                    <summary className="cursor-pointer font-semibold text-slate-700">程序化文字排版</summary>
                    <div className="mt-2 grid grid-cols-3 gap-2">
                      <div className="rounded bg-white p-2">文字：{textLayout.textElements?.length || 0}</div>
                      <div className="rounded bg-white p-2">图标：{textLayout.iconElements?.length || 0}</div>
                      <div className="rounded bg-white p-2">线条：{textLayout.lineElements?.length || 0}</div>
                    </div>
                    {image.renderedBy === 'programmatic_text_layout' && (
                      <div className="mt-2 rounded border border-emerald-200 bg-emerald-50 p-2 text-emerald-700">
                        已使用程序化文字排版生成，图片文字不依赖 AI 绘制。
                      </div>
                    )}
                    <div className="mt-2 rounded border border-slate-200 bg-white p-2">
                      排版来源：{(image.layoutSource || textLayout.layoutSource) === 'user_override' ? '用户编辑布局' : '自动布局'}
                      {(image.layoutEditedByUser || textLayout.layoutEditedByUser) && <span className="ml-2 text-blue-700">已手动调整</span>}
                    </div>
                    {textLayout.blockingIssues?.length > 0 && (
                      <div className="mt-2 rounded border border-red-200 bg-red-50 p-2 text-red-700">
                        需要补充信息：{textLayout.blockingIssues.map((item) => item.message || item.code).join('；')}
                      </div>
                    )}
                    {textLayout.warnings?.length > 0 && (
                      <div className="mt-2 rounded border border-amber-200 bg-amber-50 p-2 text-amber-700">
                        排版警告：{textLayout.warnings.map((item) => item.message || item.code).slice(0, 3).join('；')}
                      </div>
                    )}
                    <div className="mt-3 rounded border border-slate-200 bg-white p-3">
                      <TextLayoutEditor
                        layout={textLayout}
                        saving={layoutSavingPlanId === image.planId}
                        onSave={(nextLayout) => saveTextLayout(image.planId, nextLayout)}
                        onRestore={() => restoreTextLayout(image.planId)}
                        onRegenerate={async (nextLayout) => {
                          const savedTask = await saveTextLayout(image.planId, nextLayout);
                          if (savedTask) await regenerate(image.planId, 'mock');
                        }}
                      />
                    </div>
                  </details>
                )}

                <details>
                  <summary className="cursor-pointer text-sm font-medium text-slate-700">Prompt 预览</summary>
                  <div className="mt-2 max-h-36 overflow-auto rounded border border-slate-200 bg-slate-50 p-3 text-xs leading-5 text-slate-600">
                    {promptPreview(image, plan)}
                  </div>
                </details>

                {cardErrors[image.planId] && (
                  <div className="rounded border border-red-200 bg-red-50 p-2 text-xs text-red-700">
                    {cardErrors[image.planId]}
                  </div>
                )}

                <button
                  type="button"
                  onClick={() => regenerate(image.planId, 'mock')}
                  disabled={regeneratingPlanId === image.planId}
                  className="w-full rounded bg-ink px-3 py-2 text-sm font-medium text-white disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {regeneratingPlanId === image.planId ? '正在生成...' : '生成 mock 预览'}
                </button>
                {canTryRealBackground ? (
                  <div className="grid gap-2">
                  <button
                    type="button"
                    onClick={() => regenerate(image.planId, 'real_background', 'subject_composite', { compositeSettings })}
                    disabled={regeneratingPlanId === image.planId}
                    className="w-full rounded bg-coral px-3 py-2 text-sm font-medium text-white disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {regeneratingPlanId === image.planId ? '正在尝试真实背景生成...' : '尝试真实背景生成'}
                  </button>
                  <button
                    type="button"
                    onClick={() => regenerate(image.planId, 'real_background', 'image_edit')}
                    disabled={regeneratingPlanId === image.planId}
                    className="w-full rounded border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    使用 image edit 生成
                  </button>
                  <button
                    type="button"
                    onClick={() => regenerate(image.planId, 'real_background', 'text_to_image')}
                    disabled={regeneratingPlanId === image.planId}
                    className="w-full rounded border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    使用纯场景生成
                  </button>
                  </div>
                ) : (
                  <div className="rounded border border-slate-200 bg-slate-50 p-2 text-xs text-slate-500">
                    {image.type === 'lifestyle_image' ? '该图暂不满足真实背景生成安全条件。' : '当前类型暂不支持真实生图，继续使用 mock。'}
                  </div>
                )}
              </div>
            </Section>
          );
        })}
      </div>

      {generatedImages.length > 0 && (
        <PrimaryButton onClick={() => navigate(`/tasks/${taskId}/review`)}>继续合规审核</PrimaryButton>
      )}

      {previewImage && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/75 p-4" onClick={() => setPreviewImage(null)}>
          <div className="relative max-h-full max-w-5xl" onClick={(event) => event.stopPropagation()}>
            <button
              type="button"
              onClick={() => setPreviewImage(null)}
              className="absolute right-3 top-3 rounded-full bg-white p-2 text-slate-700 shadow"
              aria-label="关闭预览"
            >
              <X size={20} />
            </button>
            <img
              src={`${ASSET_BASE}${previewImage.previewUrl || previewImage.url}`}
              alt={imageTitle(previewImage)}
              className="max-h-[88vh] max-w-full rounded bg-white object-contain"
            />
          </div>
        </div>
      )}
    </div>
  );
}
