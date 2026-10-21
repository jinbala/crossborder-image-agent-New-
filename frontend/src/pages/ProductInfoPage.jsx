import { useLocale } from '../i18n/LocaleProvider.jsx';
import { approvePaidOperation } from '../utils/paidOperationApproval.js';
import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Copy, Download } from 'lucide-react';
import StepNav from '../components/StepNav.jsx';
import TaskProgress from '../components/TaskProgress.jsx';
import Section from '../components/Section.jsx';
import StatusBadge from '../components/StatusBadge.jsx';
import { ASSET_BASE, api } from '../services/api.js';
import { ErrorMessage, Field, PrimaryButton, TextArea, TextInput, taskImageUrl, useTask, DisabledReason } from './pageUtils.jsx';
import { actionDisabledReason, canRunAction } from '../utils/taskWorkflow.js';
import {
  buildRecognitionQualitySoftWarning,
  downloadRecognitionQualityJson,
  recognitionQualityDisplaySections,
  recognitionQualityFieldLabel,
  recognitionQualityStatusLabel,
  recognitionQualityWarningText
} from '../utils/recognitionQuality.js';

const emptyProduct = {
  sku: '',
  name: '',
  category: '',
  brand: '',
  model: '',
  color: '',
  dimensions: '',
  capacity: '',
  material: '',
  interfaceType: '',
  compatibleDevices: [],
  certifications: [],
  warranty: '',
  weight: '',
  packageList: [],
  imageText: [],
  sellingPoints: [],
  visibleSpecs: [],
  riskItems: [],
  language: 'English'
};

const confidenceLabels = {
  productName: '商品名称',
  category: '类目',
  brand: '品牌',
  model: '型号',
  colors: '颜色',
  sizes: '尺寸',
  dimensions: '尺寸',
  capacity: '容量',
  material: '材质',
  interfaceType: '接口类型',
  compatibleDevices: '兼容设备',
  packageIncluded: '包装清单',
  sellingPoints: '卖点',
  visibleText: '图片文字'
};

function toLines(value) {
  return Array.isArray(value) ? value.join('\n') : '';
}

function fromLines(value) {
  return value.split('\n').map((item) => item.trim()).filter(Boolean);
}

function imageDisplayName(image, index, t) {
  return image?.displayName || image?.originalName || image?.fileName || image?.storedName || t('图片 {index}', { index: index + 1 });
}

function lowConfidenceItems(confidence = {}, t) {
  return Object.entries(confidence)
    .filter(([, value]) => Number(value) > 0 && Number(value) < 0.7)
    .map(([key, value]) => `${confidenceLabels[key] ? t(confidenceLabels[key]) : key} (${Number(value).toFixed(2)})`);
}

function groupVisibleText(items = [], sourceImages = [], t) {
  const groups = new Map();

  sourceImages.forEach((image, index) => {
    groups.set(index, {
      key: index,
      title: t('图片 {index}：{name}', { index: index + 1, name: imageDisplayName(image, index, t) }),
      items: []
    });
  });

  items.forEach((item, fallbackIndex) => {
    const normalized = typeof item === 'string' ? { text: item } : item || {};
    const index = Number.isInteger(normalized.imageIndex) ? normalized.imageIndex : -1;
    const key = index >= 0 ? index : `unknown-${fallbackIndex}`;

    if (!groups.has(key)) {
      groups.set(key, {
        key,
        title: index >= 0
          ? t('图片 {index}：{name}', { index: index + 1, name: normalized.imageName || imageDisplayName(sourceImages[index], index, t) })
          : normalized.imageName || t('未标注图片'),
        items: []
      });
    }

    groups.get(key).items.push(normalized);
  });

  return Array.from(groups.values()).filter((group) => group.items.length > 0);
}

function VisibleTextGroups({ items = [], sourceImages = [], notes = [] }) {
  const { t } = useLocale();
  const [expanded, setExpanded] = useState({});
  const groups = groupVisibleText(items, sourceImages, t);
  const allText = items.map((item) => (typeof item === 'string' ? item : item?.text)).filter(Boolean).join('\n');
  const isTruncated = notes.some((note) => /visibleText truncated|OCR text summarized/i.test(note));

  async function copyAll() {
    if (!allText) return;
    await navigator.clipboard?.writeText(allText);
  }

  if (!groups.length) {
    return <div className="text-sm text-slate-400">{t("暂未识别到图片文字。")}</div>;
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="text-sm text-slate-500">{t("共识别") + " "}{items.length}{" " + t("条文字，默认每张图显示前 4 条。")}</div>
        <button type="button" onClick={copyAll} className="focus-ring inline-flex items-center gap-1 rounded border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700">
          <Copy size={14} />{t("复制全部识别文字")}</button>
      </div>
      {isTruncated && (
        <div className="rounded border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">{t("已隐藏部分重复或低价值 OCR 文本。")}</div>
      )}
      {groups.map((group) => {
        const isExpanded = Boolean(expanded[group.key]);
        const visibleItems = isExpanded ? group.items.slice(0, 10) : group.items.slice(0, 4);

        return (
          <div key={group.key} className="rounded border border-slate-200 bg-white p-3">
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
              <div className="font-semibold text-ink">{group.title}</div>
              <div className="text-xs text-slate-500">{group.items.length}{" " + t("条")}</div>
            </div>
            <div className="space-y-2">
              {visibleItems.map((item, index) => (
                <div key={`${item.text}-${index}`} className="rounded bg-slate-50 px-3 py-2 text-sm">
                  <div className="font-medium text-slate-700">{item.text || t("空文本")}</div>
                  <div className="mt-1 text-xs text-slate-500">
                    {[item.language, item.locationHint, item.confidence != null ? `置信度 ${Number(item.confidence).toFixed(2)}` : ''].filter(Boolean).join(' / ')}
                  </div>
                </div>
              ))}
            </div>
            {group.items.length > 4 && (
              <button
                type="button"
                onClick={() => setExpanded((current) => ({ ...current, [group.key]: !isExpanded }))}
                className="mt-2 text-xs font-semibold text-mint hover:text-teal-800"
              >
                {isExpanded ? t("收起") : t("展开更多，最多显示 10 条")}
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}

function riskClass(level) {
  if (level === 'high') return 'border-red-200 bg-red-50 text-red-800';
  if (level === 'medium') return 'border-amber-200 bg-amber-50 text-amber-900';
  return 'border-slate-200 bg-slate-50 text-slate-700';
}

function RiskList({ items = [] }) {
  const { t } = useLocale();
  if (!items.length) {
    return <div className="text-sm text-slate-400">{t("暂未发现识别风险。")}</div>;
  }

  return (
    <div className="space-y-2">
      {items.map((risk, index) => (
        <div key={`${risk.type || 'risk'}-${index}`} className={`rounded border px-3 py-2 text-sm ${riskClass(risk.level)}`}>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="font-semibold">{risk.type || 'risk'}</div>
            <span className="rounded bg-white/70 px-2 py-0.5 text-xs font-semibold">{risk.level || 'medium'}</span>
          </div>
          <div className="mt-1">{risk.message || t("请人工确认该风险。")}</div>
          {risk.imageIndex != null && <div className="mt-1 text-xs">{t("来源：图片") + " "}{Number(risk.imageIndex) + 1}</div>}
          {Array.isArray(risk.evidence) && risk.evidence.length > 0 && (
            <div className="mt-1 text-xs">{t("证据：")}{risk.evidence.join(', ')}</div>
          )}
        </div>
      ))}
    </div>
  );
}

function NotesList({ notes = [] }) {
  const { t } = useLocale();
  if (!notes.length) {
    return <div className="text-sm text-slate-400">{t("暂无 AI 备注。")}</div>;
  }

  return (
    <ul className="space-y-2 text-sm text-slate-700">
      {notes.slice(0, 10).map((note, index) => (
        <li key={`${note}-${index}`} className="rounded bg-slate-50 px-3 py-2">{note}</li>
      ))}
    </ul>
  );
}

function InferredCandidatesList({ items = [] }) {
  const { t } = useLocale();
  if (!items.length) {
    return <div className="text-sm text-slate-400">{t("暂无 AI 推测候选项。")}</div>;
  }

  return (
    <div className="space-y-2 text-sm text-slate-700">
      {items.slice(0, 12).map((item, index) => (
        <div key={`${item.field}-${item.value}-${index}`} className="rounded border border-red-100 bg-red-50 px-3 py-2 text-red-800">
          <div className="font-semibold">{item.field || 'unknown'}：{item.value || '-'}</div>
          <div className="mt-1 text-xs">{item.reason || t("缺少图片证据，不建议直接使用。")}</div>
        </div>
      ))}
    </div>
  );
}

function hasDisplayValue(value) {
  if (Array.isArray(value)) return value.length > 0;
  return value !== null && value !== undefined && String(value).trim() !== '';
}

function evidenceSources(evidence = []) {
  return [...new Set(evidence.map((item) => item.source).filter(Boolean))];
}

function hasVisibleTextEvidence(evidence = []) {
  return evidence.some((item) => item.source === 'visible_text');
}

function onlyVisualEvidence(evidence = []) {
  return evidence.length > 0 && evidence.every((item) => item.source === 'visual');
}

function onlyInferredEvidence(evidence = []) {
  return evidence.length > 0 && evidence.every((item) => item.source === 'inferred');
}

function evidenceRiskLevel(field, value, evidence = [], inferred = []) {
  if (inferred.length && !evidence.length) return 'inferred';
  if (!hasDisplayValue(value)) return 'none';
  if (['capacity', 'certifications', 'warranty'].includes(field) && !hasVisibleTextEvidence(evidence)) return 'high';
  if (field === 'material' && onlyVisualEvidence(evidence)) return 'medium';
  if (field === 'compatibleDevices' && (!evidence.length || onlyInferredEvidence(evidence))) return 'medium';
  if (!evidence.length) return 'medium';
  return 'low';
}

function EvidenceStatus({ task, field, value }) {
  const { t } = useLocale();
  const evidence = task?.fieldEvidence?.[field] || [];
  const inferred = (task?.inferredCandidates || []).filter((item) => item.field === field);
  if (!evidence.length && !inferred.length && !hasDisplayValue(value)) return null;

  const risk = evidenceRiskLevel(field, value, evidence, inferred);
  let label = '需人工确认';
  let className = 'border-amber-200 bg-amber-50 text-amber-800';
  if (risk === 'low') {
    label = '有图片证据';
    className = 'border-emerald-200 bg-emerald-50 text-emerald-800';
  }
  if (risk === 'high') {
    label = '需人工确认';
    className = 'border-red-200 bg-red-50 text-red-700';
  }
  if (risk === 'inferred') {
    label = 'AI 推测，不建议直接使用';
    className = 'border-red-200 bg-red-50 text-red-700';
  }

  return (
    <details className="mt-1">
      <summary className={`inline-flex cursor-pointer rounded border px-2 py-0.5 text-xs font-semibold ${className}`}>
        {t(label)}
      </summary>
      <div className="mt-2 rounded border border-slate-200 bg-slate-50 p-2 text-xs font-normal text-slate-600">
        {evidence.length > 0 && evidence.slice(0, 3).map((item, index) => (
          <div key={`${field}-evidence-${index}`}>
            {item.source === 'visible_text' ? t("文字证据") : item.source === 'visual' ? t("视觉证据") : t("证据")}{" " + t("/ 图片") + " "}{item.imageIndex != null ? Number(item.imageIndex) + 1 : '-'} {item.imageName || ''}：
            {item.text || item.reason || item.value || '-'}{t("，置信度") + " "}{Number(item.confidence || 0).toFixed(2)}
          </div>
        ))}
        {inferred.length > 0 && inferred.slice(0, 3).map((item, index) => (
          <div key={`${field}-inferred-${index}`}>{t("推测值：")}{item.value}。{item.reason || t("缺少图片证据")}</div>
        ))}
        {!evidence.length && !inferred.length && <div>{t("该字段当前没有图片证据，请人工核对。")}</div>}
      </div>
    </details>
  );
}

function fieldValueForCheck(draft, field) {
  const map = {
    productName: draft.name,
    category: draft.category,
    capacity: draft.capacity,
    certifications: draft.certifications,
    warranty: draft.warranty,
    material: draft.material,
    compatibleDevices: draft.compatibleDevices,
    packageIncluded: draft.packageList,
    sellingPoints: draft.sellingPoints
  };
  return map[field];
}

function buildPrecheckWarnings(task, draft, t) {
  const warnings = [];
  const evidence = task?.fieldEvidence || {};
  const highRiskFields = [
    ['capacity', '容量'],
    ['certifications', '认证标志'],
    ['warranty', '保修']
  ];

  highRiskFields.forEach(([field, label]) => {
    const value = fieldValueForCheck(draft, field);
    if (hasDisplayValue(value) && !hasVisibleTextEvidence(evidence[field] || [])) {
      warnings.push(t('{field}有值但缺少图片文字证据，建议人工确认后继续。', { field: t(label) }));
    }
  });

  if (hasDisplayValue(draft.material) && onlyVisualEvidence(evidence.material || [])) {
    warnings.push(t('材质仅来自视觉判断，建议人工确认后继续。'));
  }
  if (hasDisplayValue(draft.compatibleDevices) && (!(evidence.compatibleDevices || []).length || onlyInferredEvidence(evidence.compatibleDevices || []))) {
    warnings.push(t('兼容设备缺少可靠图片证据，建议人工确认后继续。'));
  }

  [
    ['name', '商品名称'],
    ['category', '类目'],
    ['packageList', '包装清单'],
    ['sellingPoints', '卖点']
  ].forEach(([field, label]) => {
    if (!hasDisplayValue(draft[field])) warnings.push(t('{field}为空，建议补充后继续。', { field: t(label) }));
  });

  return warnings;
}

function PrecheckWarnings({ warnings = [] }) {
  const { t } = useLocale();
  if (!warnings.length) return null;
  return (
    <div className="rounded border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
      <div className="font-semibold">{t("保存前检查")}</div>
      <ul className="mt-2 list-disc space-y-1 pl-5">
        {warnings.map((warning, index) => <li key={`${warning}-${index}`}>{warning}</li>)}
      </ul>
    </div>
  );
}

function EvidenceField({ label, field, value, task, children }) {
  return (
    <label className="block">
      <span className="mb-1 block text-sm font-medium text-slate-700">
        {label}
        <EvidenceStatus task={task} field={field} value={value} />
      </span>
      {children}
    </label>
  );
}

function DebugInfo({ task, recognitionMeta }) {
  const { t } = useLocale();
  return (
    <details className="rounded border border-slate-200 bg-white p-4">
      <summary className="cursor-pointer text-sm font-semibold text-ink">{t("识别调试信息")}</summary>
      <div className="mt-3 grid gap-2 text-sm text-slate-600 md:grid-cols-2">
        <div>provider：{recognitionMeta?.provider || 'unknown'}</div>
        <div>model：{recognitionMeta?.model || 'unknown'}</div>
        <div>durationMs：{recognitionMeta?.durationMs ?? 0}</div>
        <div>batchCount：{recognitionMeta?.batchCount || '-'}</div>
        <div>batchSize：{recognitionMeta?.batchSize || '-'}</div>
        <div>partialSuccess：{recognitionMeta?.partialSuccess ? 'yes' : 'no'}</div>
        <div>{t("visibleText 数量：")}{task.visibleText?.length || 0}</div>
        <div>{t("risks 数量：")}{task.risks?.length || 0}</div>
        <div>{t("notes 数量：")}{task.productInfoRaw?.notes?.length || 0}</div>
        <div>rawResponsePreview：{recognitionMeta?.rawResponsePreview ? t("存在") : t("无")}</div>
        <div className="md:col-span-2">confidence：{JSON.stringify(task.confidence || {})}</div>
      </div>
    </details>
  );
}

function RecognitionQualityReview({ task }) {
  const { t } = useLocale();
  const report = task?.recognitionQuality;
  const sections = recognitionQualityDisplaySections(report);
  const exportButton = (
    <button
      type="button"
      onClick={() => downloadRecognitionQualityJson(task)}
      disabled={!report}
      title={!report ? t("暂无可导出的识别质量报告，请先完成商品识别。") : t("导出识别质量报告")}
      className="focus-ring inline-flex items-center gap-1 rounded border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 disabled:cursor-not-allowed disabled:opacity-50"
    >
      <Download size={14} />{t("导出识别质量报告")}</button>
  );
  if (!report) {
    return (
      <Section title={t("识别质量复查")} actions={exportButton}>
        <div className="text-sm text-slate-500">{sections.emptyText}</div>
        <div className="mt-2 text-xs text-slate-400">{t("暂无可导出的识别质量报告，请先完成商品识别。")}</div>
      </Section>
    );
  }

  const riskClassName = sections.risk?.level === 'high'
    ? 'border-red-200 bg-red-50 text-red-800'
    : sections.risk?.level === 'medium'
      ? 'border-amber-200 bg-amber-50 text-amber-900'
      : 'border-emerald-200 bg-emerald-50 text-emerald-800';

  return (
    <Section title={t("识别质量复查")} actions={exportButton}>
      <div className="space-y-4 text-sm">
        <div className={`rounded border p-3 ${riskClassName}`}>
          <div className="font-semibold">{t("总览")}</div>
          <div className="mt-1">{sections.overviewText}</div>
        </div>
        <div className="rounded border border-amber-200 bg-amber-50 p-3 text-amber-900">
          {recognitionQualityWarningText(report)}
        </div>

        <div className="rounded border border-red-200 bg-red-50 p-3 text-red-800">
          <div className="font-semibold">{t("需要人工重点检查")}</div>
          <div className="mt-1">{sections.focusText}</div>
          <div className="mt-2 text-xs">{t("冲突字段：")}{sections.conflictText}</div>
          <div className="mt-1 text-xs">{t("高风险缺证据字段：")}{sections.missingEvidenceText}</div>
        </div>

        <details className="rounded border border-slate-200 p-3" open>
          <summary className="cursor-pointer font-semibold text-ink">{t("AI 推测字段")}</summary>
          <div className="mt-2 text-slate-600">{sections.inferredText}</div>
        </details>

        <details className="rounded border border-slate-200 p-3">
          <summary className="cursor-pointer font-semibold text-ink">{t("证据字段")}</summary>
          <div className="mt-2 text-slate-600">{sections.evidenceFieldsText}</div>
        </details>

        <div className="rounded border border-slate-200 p-3">
          <div className="font-semibold text-ink">{t("证据来源摘要")}</div>
          <div className="mt-1 text-slate-600">{sections.evidenceSummaryText}</div>
        </div>
        {report.fields?.length > 0 && (
          <details className="rounded border border-slate-200 p-3">
            <summary className="cursor-pointer font-semibold text-ink">{t("查看字段明细")}</summary>
            <div className="mt-3 grid gap-2">
              {report.fields.filter((field) => field.status !== 'empty').slice(0, 20).map((field) => (
                <div key={field.field} className="flex flex-wrap items-center justify-between gap-2 rounded bg-slate-50 px-3 py-2">
                  <span className="font-medium text-slate-700">
                    {t(field.label || recognitionQualityFieldLabel(field.field))}
                    {field.field && <span className="ml-2 text-xs font-normal text-slate-400">{field.field}</span>}
                  </span>
                  <span className="text-xs text-slate-500">
                    {recognitionQualityStatusLabel(field.status)}{" " + t("/ 证据") + " "}{field.evidenceCount || 0}{" " + t("条")}</span>
                </div>
              ))}
            </div>
          </details>
        )}
      </div>
    </Section>
  );
}

export default function ProductInfoPage() {
  const { t } = useLocale();
  const { taskId } = useParams();
  const navigate = useNavigate();
  const { task, setTask, loading, error, setError, refresh } = useTask(taskId);
  const [busy, setBusy] = useState(false);
  const [precheckWarnings, setPrecheckWarnings] = useState([]);
  const [qualityWarning, setQualityWarning] = useState(null);
  const [riskConfirmedForSave, setRiskConfirmedForSave] = useState(false);

  const product = useMemo(() => task?.productInfo || emptyProduct, [task]);
  const [draft, setDraft] = useState(emptyProduct);

  useEffect(() => {
    if (task?.productInfo) {
      setDraft({ ...emptyProduct, ...task.productInfo });
    }
  }, [task?.id, task?.productInfo]);

  function update(field, value) {
    setRiskConfirmedForSave(false);
    setDraft((current) => ({ ...current, [field]: value }));
  }

  async function recognize() {
    setBusy(true);
    setError('');
    try {
      const approval = await approvePaidOperation(api, { kinds: ['vision'], target: taskId, count: task?.sourceImages?.length || 1, allowMock: true }, t, (message) => window.confirm(message));
      if (!approval) return;
      const result = await api.recognize(taskId, approval);
      setTask(result.task);
      setDraft({ ...emptyProduct, ...result.task.productInfo });
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function save({ riskConfirmed = riskConfirmedForSave } = {}) {
    const softWarning = buildRecognitionQualitySoftWarning(task?.recognitionQuality);
    if (softWarning.shouldWarn && !riskConfirmed) {
      setQualityWarning(softWarning);
      return;
    }

    const warnings = buildPrecheckWarnings(task, draft, t);
    setPrecheckWarnings(warnings);
    if (warnings.length) {
      const message = t('以下字段建议人工确认后继续：\n\n{warnings}\n\n仍然保存并继续吗？', { warnings: warnings.join('\n') });
      if (typeof window !== 'undefined' && !window.confirm(message)) return;
    }

    setBusy(true);
    setError('');
    try {
      const payload = {
        ...draft,
        packageList: fromLines(toLines(draft.packageList)),
        imageText: fromLines(toLines(draft.imageText)),
        sellingPoints: fromLines(toLines(draft.sellingPoints)),
        compatibleDevices: fromLines(toLines(draft.compatibleDevices)),
        certifications: fromLines(toLines(draft.certifications)),
        visibleSpecs: fromLines(toLines(draft.visibleSpecs)),
        riskItems: fromLines(toLines(draft.riskItems))
      };
      const result = await api.saveProduct(taskId, payload);
      setTask(result.task);
      setRiskConfirmedForSave(false);
      navigate(`/tasks/${taskId}/rules`);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  function returnToQualityCheck() {
    setQualityWarning(null);
    setRiskConfirmedForSave(false);
  }

  async function continueAfterQualityWarning() {
    setQualityWarning(null);
    setRiskConfirmedForSave(true);
    await save({ riskConfirmed: true });
  }

  if (loading) return <div className="text-sm text-slate-500">{t("正在加载商品信息...")}</div>;
  if (!task) return <div className="space-y-3"><h1 className="text-2xl font-semibold text-ink">{t('确认商品信息')}</h1><ErrorMessage error={error || t('任务不存在或当前账号无权访问。')} /><p className="text-sm text-slate-500">{t('无法读取商品任务，请检查连接或返回任务中心，不会写入商品信息。')}</p><button type="button" data-product-retry className="btn-secondary" onClick={refresh}>{t('重新读取任务')}</button><button type="button" className="btn-secondary" onClick={() => navigate('/task-center')}>{t('返回任务中心')}</button></div>;

  const sourceImages = task.sourceImages?.length ? task.sourceImages : [task.originalImage].filter(Boolean);
  const canRecognize = canRunAction(task.status, 'recognize');
  const canConfirm = canRunAction(task.status, 'confirmProduct');
  const confirmReason = !draft.name ? t('商品名称必填。') : actionDisabledReason(task.status, 'confirmProduct');
  const recognitionMeta = task.recognitionMeta || task.recognitionProvider;
  const lowConfidence = lowConfidenceItems(task.confidence, t);
  const notes = task.productInfoRaw?.notes || [];

  return (
    <div className="space-y-5">
      <StepNav taskId={taskId} />
      <TaskProgress task={task} />
      <ErrorMessage error={error} />
      {qualityWarning?.shouldWarn && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 px-4">
          <div className="w-full max-w-xl rounded border border-amber-200 bg-white p-5 shadow-lg">
            <h2 className="text-lg font-semibold text-ink">{t(qualityWarning.title || '识别质量存在需要人工确认的字段')}</h2>
            <p className="mt-2 text-sm text-slate-600">{t(qualityWarning.body)}</p>
            <ul className="mt-4 list-disc space-y-2 pl-5 text-sm text-amber-900">
              {qualityWarning.risks.map((risk) => <li key={risk}>{risk}</li>)}
            </ul>
            {qualityWarning.moreText && (
              <div className="mt-3 rounded border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
                {qualityWarning.moreText}
              </div>
            )}
            <div className="mt-5 flex flex-wrap justify-end gap-2">
              <button type="button" onClick={returnToQualityCheck} className="focus-ring rounded border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-700">{t("返回检查")}</button>
              <button type="button" onClick={continueAfterQualityWarning} className="focus-ring rounded bg-mint px-4 py-2 text-sm font-semibold text-white">{t("我已确认，继续保存")}</button>
            </div>
          </div>
        </div>
      )}
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold text-ink">{t("确认商品信息")}</h1>
        <StatusBadge status={task?.status} />
      </div>

      <div className="grid gap-5 lg:grid-cols-[340px_1fr]">
        <div className="space-y-5">
          <Section title={t("已上传图片（{value0} 张）", { value0: (sourceImages.length) })}>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-1">
              {sourceImages.map((image, index) => (
                <div key={image.id || image.url || index} className="rounded border border-slate-200 bg-slate-50 p-2">
                  <img src={`${ASSET_BASE}${image.previewUrl || image.url || taskImageUrl(task)}`} alt={t("已上传商品图 {value0}", { value0: (index + 1) })} className="h-36 w-full rounded object-contain" />
                  <div className="mt-2 truncate text-xs text-slate-500">{index + 1}. {imageDisplayName(image, index, t)}</div>
                </div>
              ))}
            </div>
          </Section>

          <Section title={t("识别服务")}>
            {recognitionMeta ? (
              <div className="grid gap-2 text-sm text-slate-600">
                <div>Provider：{recognitionMeta.provider || 'unknown'}</div>
                <div>{t("模型：")}{recognitionMeta.model || 'unknown'}</div>
                <div>{t("耗时：")}{recognitionMeta.durationMs ?? 0} ms</div>
                {recognitionMeta.recognitionMode && (
                  <div>{t("识别模式：")}{recognitionMeta.recognitionMode}{t("，已发送") + " "}{recognitionMeta.imageCountSent ?? '-'} / {recognitionMeta.imageCountOriginal ?? '-'}{" " + t("张图片")}</div>
                )}
                {recognitionMeta.batchCount && (
                  <div>{t("分批：")}{recognitionMeta.batchCount}{" " + t("批，每批最多") + " "}{recognitionMeta.batchSize || '-'}{" " + t("张，重试") + " "}{recognitionMeta.retryCount ?? 0}{" " + t("次")}</div>
                )}
              </div>
            ) : (
              <div className="text-sm text-slate-400">{t("尚未识别。")}</div>
            )}
            <div className="mt-3 rounded border border-slate-200 bg-slate-50 p-3 text-sm text-slate-600">{t("多图真实识别可能需要 1-5 分钟，请等待识别结果返回。")}</div>
            <div className="mt-2 rounded border border-slate-200 bg-white p-3 text-sm text-slate-600">{t("真实识别模式：fast / balanced / full。fast 更快但可能漏少量字段，full 更完整但更慢。")}</div>
            {recognitionMeta?.partialSuccess && (
              <div className="mt-3 rounded border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">{t("部分图片识别失败，已返回可用结果，请人工复核。")}</div>
            )}
            {lowConfidence.length > 0 && (
              <div className="mt-3 rounded border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">{t("建议人工确认低置信度字段：")}{lowConfidence.join(', ')}
              </div>
            )}
          </Section>
        </div>

        <div className="space-y-5">
          <Section
            title={t("商品核心信息")}
            actions={!product.name && (
              <div>
                <PrimaryButton busy={busy} disabled={!canRecognize} onClick={recognize}>{t("重新识别")}</PrimaryButton>
                <DisabledReason reason={!canRecognize ? actionDisabledReason(task.status, 'recognize') : ''} />
              </div>
            )}
          >
            <PrecheckWarnings warnings={precheckWarnings} />
            <div className="grid gap-4 md:grid-cols-2">
              <Field label="SKU"><TextInput value={draft.sku || ''} onChange={(e) => update('sku', e.target.value)} /></Field>
              <EvidenceField label={t("商品名称")} field="productName" value={draft.name} task={task}><TextInput value={draft.name || ''} onChange={(e) => update('name', e.target.value)} /></EvidenceField>
              <EvidenceField label={t("类目")} field="category" value={draft.category} task={task}><TextInput value={draft.category || ''} onChange={(e) => update('category', e.target.value)} /></EvidenceField>
              <EvidenceField label={t("品牌")} field="brand" value={draft.brand} task={task}><TextInput value={draft.brand || ''} onChange={(e) => update('brand', e.target.value)} /></EvidenceField>
              <EvidenceField label={t("型号")} field="model" value={draft.model} task={task}><TextInput value={draft.model || ''} onChange={(e) => update('model', e.target.value)} /></EvidenceField>
              <Field label={t("颜色")}><TextInput value={draft.color || ''} onChange={(e) => update('color', e.target.value)} /></Field>
              <EvidenceField label={t("容量")} field="capacity" value={draft.capacity} task={task}><TextInput value={draft.capacity || ''} onChange={(e) => update('capacity', e.target.value)} /></EvidenceField>
              <EvidenceField label={t("尺寸/规格")} field="dimensions" value={draft.dimensions} task={task}><TextInput value={draft.dimensions || ''} onChange={(e) => update('dimensions', e.target.value)} /></EvidenceField>
              <EvidenceField label={t("接口类型")} field="interfaceType" value={draft.interfaceType} task={task}><TextInput value={draft.interfaceType || ''} onChange={(e) => update('interfaceType', e.target.value)} /></EvidenceField>
              <EvidenceField label={t("材质")} field="material" value={draft.material} task={task}><TextInput value={draft.material || ''} onChange={(e) => update('material', e.target.value)} /></EvidenceField>
              <Field label={t("重量")}><TextInput value={draft.weight || ''} onChange={(e) => update('weight', e.target.value)} /></Field>
              <EvidenceField label={t("保修")} field="warranty" value={draft.warranty} task={task}><TextInput value={draft.warranty || ''} onChange={(e) => update('warranty', e.target.value)} /></EvidenceField>
              <EvidenceField label={t("兼容设备")} field="compatibleDevices" value={draft.compatibleDevices} task={task}><TextArea value={toLines(draft.compatibleDevices)} onChange={(e) => update('compatibleDevices', fromLines(e.target.value))} /></EvidenceField>
              <EvidenceField label={t("认证标志")} field="certifications" value={draft.certifications} task={task}><TextArea value={toLines(draft.certifications)} onChange={(e) => update('certifications', fromLines(e.target.value))} /></EvidenceField>
              <EvidenceField label={t("包装清单")} field="packageIncluded" value={draft.packageList} task={task}><TextArea value={toLines(draft.packageList)} onChange={(e) => update('packageList', fromLines(e.target.value))} /></EvidenceField>
              <EvidenceField label={t("可见规格")} field="visibleSpecs" value={draft.visibleSpecs} task={task}><TextArea value={toLines(draft.visibleSpecs)} onChange={(e) => update('visibleSpecs', fromLines(e.target.value))} /></EvidenceField>
              <EvidenceField label={t("卖点")} field="sellingPoints" value={draft.sellingPoints} task={task}><TextArea value={toLines(draft.sellingPoints)} onChange={(e) => update('sellingPoints', fromLines(e.target.value))} /></EvidenceField>
              <Field label={t("风险项")}><TextArea value={toLines(draft.riskItems)} onChange={(e) => update('riskItems', fromLines(e.target.value))} /></Field>
            </div>
            <div className="mt-5">
              <PrimaryButton busy={busy} disabled={!draft.name || !canConfirm} onClick={save}>{t("保存并继续")}</PrimaryButton>
              <DisabledReason reason={!draft.name || !canConfirm ? confirmReason : ''} />
            </div>
          </Section>

          <RecognitionQualityReview task={task} />

          <details className="rounded border border-slate-200 bg-white p-4">
            <summary className="cursor-pointer text-sm font-semibold text-ink">{t("图片文字识别结果")}</summary>
            <div className="mt-3">
              <VisibleTextGroups items={task.visibleText || []} sourceImages={sourceImages} notes={notes} />
            </div>
          </details>

          <div className="grid gap-5 lg:grid-cols-2">
            <Section title={t("识别风险提示")}>
              <RiskList items={task.risks || []} />
            </Section>
            <Section title={t("AI 备注 / 推测候选项")}>
              <NotesList notes={notes} />
              <div className="mt-4">
                <InferredCandidatesList items={task.inferredCandidates || []} />
              </div>
            </Section>
          </div>

          <DebugInfo task={task} recognitionMeta={recognitionMeta} />
        </div>
      </div>
    </div>
  );
}
