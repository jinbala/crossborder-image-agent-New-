import { useLocale } from '../i18n/LocaleProvider.jsx';
import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { AlertTriangle, CheckCircle2, Save, WandSparkles } from 'lucide-react';
import StepNav from '../components/StepNav.jsx';
import TaskProgress from '../components/TaskProgress.jsx';
import Section from '../components/Section.jsx';
import TextLayoutEditor from '../components/TextLayoutEditor.jsx';
import { api } from '../services/api.js';
import { approveImageGeneration } from '../utils/imageGenerationApproval.js';
import { ErrorMessage, PrimaryButton, useTask, DisabledReason } from './pageUtils.jsx';
import { actionDisabledReason, canRunAction } from '../utils/taskWorkflow.js';
import {
  downloadTemplateAuditJson,
  templateAuditDisplaySections,
  templateAuditExportNotice
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

function planTitle(plan, index, t) {
  return `${index + 1}. ${imageTypeLabels[plan.type] ? t(imageTypeLabels[plan.type]) : plan.title}`;
}

function riskClass(level) {
  if (level === 'high') return 'border-red-200 bg-red-50 text-red-700';
  if (level === 'medium') return 'border-amber-200 bg-amber-50 text-amber-700';
  return 'border-slate-200 bg-slate-50 text-slate-600';
}

function blocksToText(blocks = []) {
  return blocks.map((block) => block.text).filter(Boolean).join('\n');
}

function risksToText(risks = []) {
  return risks.map((risk) => risk.message || String(risk)).filter(Boolean).join('\n');
}

function notesToText(notes = []) {
  return notes.filter(Boolean).join('\n');
}

function textToBlocks(text, existing = []) {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line, index) => ({
      id: existing[index]?.id || `user-text-${index + 1}`,
      label: existing[index]?.label || '图片文案',
      text: line,
      sourceFields: existing[index]?.sourceFields || []
    }));
}

function textToRisks(text, existing = []) {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line, index) => ({
      field: existing[index]?.field || 'manual_note',
      level: existing[index]?.level || 'medium',
      message: line
    }));
}

function targetLabel(target = {}, t) {
  return `${target.platformName || target.platform || target.platformId || t('平台')} / ${target.site || 'US'} / ${target.language || 'English'}`;
}

function targetRuleSummary(target = {}, t) {
  const rule = target.platformRuleSnapshot?.imageTypes?.main_image || target.rulesSnapshot?.imageTypes?.main_image;
  const textAllowed = rule?.text?.allowed;
  const background = rule?.background?.recommended || t('简洁背景');
  const forbidden = (rule?.forbiddenElements || []).slice(0, 5).join('、');
  return t('主图{rule}；推荐背景：{background}；禁止：{forbidden}', { rule: t(textAllowed ? '允许说明文字' : '禁止文字'), background, forbidden: forbidden || t('价格、促销、水印等') });
}

function plansByTarget(task = {}) {
  const targets = task.targets?.length
    ? task.targets
    : [{
        id: 'legacy-target',
        targetId: 'legacy-target',
        platformId: task.platformId || task.platform,
        platformName: task.platform,
        site: task.site,
        language: task.language,
        categoryId: task.category
      }];
  const targetMap = Object.fromEntries(targets.map((target) => [target.id || target.targetId || target.platformId, target]));
  const groups = targets.map((target) => ({
    target,
    plans: (task.imagePlans || []).filter((plan) => plan.targetId === target.id || plan.targetId === target.targetId || plan.platformId === target.platformId)
  }));
  const groupedPlanIds = new Set(groups.flatMap((group) => group.plans.map((plan) => plan.id)));
  const orphanPlans = (task.imagePlans || []).filter((plan) => !groupedPlanIds.has(plan.id));
  if (orphanPlans.length) {
    groups.push({
      target: targetMap[orphanPlans[0]?.targetId] || {
        id: 'unknown-target',
        platformName: orphanPlans[0]?.platform || orphanPlans[0]?.platformId || '未分组平台',
        site: orphanPlans[0]?.site,
        language: orphanPlans[0]?.language,
        categoryId: orphanPlans[0]?.categoryId
      },
      plans: orphanPlans
    });
  }
  return groups.filter((group) => group.plans.length > 0);
}

function PlanCard({ plan, index, draft, onDraftChange, onSave, saving, onSaveTextLayout, onRestoreTextLayout, savingLayout }) {
  const { t } = useLocale();
  const risks = Array.isArray(plan.riskWarnings) ? plan.riskWarnings : [];
  const usedFields = Array.isArray(plan.usedConfirmedFields) ? plan.usedConfirmedFields : [];
  const excluded = Array.isArray(plan.excludedUnconfirmedFields) ? plan.excludedUnconfirmedFields : [];
  const requestSummary = plan.generationRequestSummary;
  const textLayout = plan.textLayout;

  return (
    <Section title={planTitle(plan, index, t)}>
      <div className="grid gap-4 lg:grid-cols-[1.1fr_1fr]">
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className="rounded border border-slate-200 bg-slate-50 px-2 py-1 text-slate-600">{plan.platform} / {plan.language}</span>
            <span className="rounded border border-slate-200 bg-slate-50 px-2 py-1 text-slate-600">{plan.size}</span>
            <span className="rounded border border-slate-200 bg-slate-50 px-2 py-1 text-slate-600">{t("版本") + " "}{plan.version || 1}</span>
            {plan.editedByUser && (
              <span className="rounded border border-blue-200 bg-blue-50 px-2 py-1 text-blue-700">{t("该图片方案已手动编辑")}</span>
            )}
            {plan.canGenerate ? (
              <span className="inline-flex items-center gap-1 rounded border border-emerald-200 bg-emerald-50 px-2 py-1 text-emerald-700">
                <CheckCircle2 size={14} />{" " + t("可直接生成")}</span>
            ) : (
              <span className="inline-flex items-center gap-1 rounded border border-amber-200 bg-amber-50 px-2 py-1 text-amber-700">
                <AlertTriangle size={14} />{" " + t("需要补充信息")}</span>
            )}
          </div>

          <div>
            <label className="mb-1 block text-sm font-medium text-slate-700">{t("方案标题")}</label>
            <input
              data-plan-title={plan.id}
              className="w-full rounded border border-slate-200 px-3 py-2 text-sm"
              value={draft.title}
              onChange={(event) => onDraftChange(plan.id, { title: event.target.value })}
            />
          </div>

          <div>
            <label className="mb-1 block text-sm font-medium text-slate-700">{t("图片目标")}</label>
            <textarea
              className="min-h-20 w-full rounded border border-slate-200 px-3 py-2 text-sm"
              value={draft.goal}
              onChange={(event) => onDraftChange(plan.id, { goal: event.target.value })}
            />
          </div>

          <div>
            <label className="mb-1 block text-sm font-medium text-slate-700">{t("布局说明")}</label>
            <textarea
              className="min-h-20 w-full rounded border border-slate-200 px-3 py-2 text-sm"
              value={draft.layout}
              onChange={(event) => onDraftChange(plan.id, { layout: event.target.value })}
            />
          </div>

          <div>
            <label className="mb-1 block text-sm font-medium text-slate-700">{t("文字内容")}</label>
            <textarea
              className="min-h-24 w-full rounded border border-slate-200 px-3 py-2 text-sm"
              placeholder={plan.type === 'main_image' ? t("主图通常不允许文字") : t("每行一条图片文案")}
              value={draft.textBlocksText}
              onChange={(event) => onDraftChange(plan.id, { textBlocksText: event.target.value })}
            />
          </div>

          <div>
            <label className="mb-1 block text-sm font-medium text-slate-700">{t("风险备注")}</label>
            <textarea
              className="min-h-20 w-full rounded border border-slate-200 px-3 py-2 text-sm"
              placeholder={t("每行一条风险备注")}
              value={draft.riskWarningsText}
              onChange={(event) => onDraftChange(plan.id, { riskWarningsText: event.target.value })}
            />
          </div>

          <div>
            <label className="mb-1 block text-sm font-medium text-slate-700">{t("合规备注")}</label>
            <textarea
              className="min-h-20 w-full rounded border border-slate-200 px-3 py-2 text-sm"
              placeholder={t("每行一条合规备注")}
              value={draft.complianceNotesText}
              onChange={(event) => onDraftChange(plan.id, { complianceNotesText: event.target.value })}
            />
          </div>

          {plan.editedByUser && (
            <div className="rounded border border-blue-200 bg-blue-50 p-3 text-sm text-blue-700">{t("修改方案后建议回到生成页，点击“重新生成此图”查看最新预览。")}</div>
          )}

          <button
            type="button"
            onClick={() => onSave(plan)}
            disabled={saving}
            className="inline-flex items-center gap-2 rounded bg-ink px-3 py-2 text-sm font-medium text-white disabled:cursor-not-allowed disabled:opacity-60"
          >
            <Save size={15} />
            {saving ? t("保存中...") : t("保存方案修改")}
          </button>
        </div>

        <div className="space-y-3 text-sm">
          <div>
            <div className="mb-1 font-medium text-slate-700">{t("布局说明")}</div>
            <div className="rounded border border-slate-200 bg-slate-50 p-3 text-slate-600">{plan.layout}</div>
          </div>

          {textLayout && (
            <details>
              <summary className="cursor-pointer text-sm font-medium text-slate-700">{t("打开排版编辑器 / 程序化排版预览信息")}</summary>
              <div className="mt-2 space-y-2 rounded border border-slate-200 bg-slate-50 p-3 text-xs leading-5 text-slate-600">
                <div className="grid grid-cols-3 gap-2">
                  <div className="rounded bg-white p-2">{t("文字元素：")}{textLayout.textElements?.length || 0}</div>
                  <div className="rounded bg-white p-2">{t("图标元素：")}{textLayout.iconElements?.length || 0}</div>
                  <div className="rounded bg-white p-2">{t("线条元素：")}{textLayout.lineElements?.length || 0}</div>
                </div>
                {textLayout.blockingIssues?.length > 0 && (
                  <div className="rounded border border-red-200 bg-red-50 p-2 text-red-700">{t("阻塞项：")}{textLayout.blockingIssues.map((item) => item.message || item.code).join('；')}
                  </div>
                )}
                {textLayout.warnings?.length > 0 && (
                  <div className="rounded border border-amber-200 bg-amber-50 p-2 text-amber-700">{t("警告：")}{textLayout.warnings.map((item) => item.message || item.code).join('；')}
                  </div>
                )}
                {textLayout.excludedTextBlocks?.length > 0 && (
                  <div className="rounded border border-slate-200 bg-white p-2">{t("已排除文案：")}{textLayout.excludedTextBlocks.map((item) => `${item.text} (${item.reason})`).join('；')}
                  </div>
                )}
                <TextLayoutEditor
                  layout={textLayout}
                  saving={savingLayout}
                  onSave={(nextLayout) => onSaveTextLayout(plan.id, nextLayout)}
                  onRestore={() => onRestoreTextLayout(plan.id)}
                />
              </div>
            </details>
          )}

          <div>
            <div className="mb-1 font-medium text-slate-700">{t("使用到的确认字段")}</div>
            {usedFields.length ? (
              <div className="flex flex-wrap gap-2">
                {usedFields.map((item, itemIndex) => (
                  <span key={`${item.field}-${itemIndex}`} className="rounded border border-emerald-200 bg-emerald-50 px-2 py-1 text-emerald-700">
                    {item.field}: {Array.isArray(item.value) ? item.value.join(', ') : item.value}
                  </span>
                ))}
              </div>
            ) : (
              <div className="rounded border border-slate-200 bg-slate-50 p-3 text-slate-500">{t("没有使用图片文案字段。")}</div>
            )}
          </div>

          <div>
            <div className="mb-1 font-medium text-slate-700">{t("被排除的未确认字段")}</div>
            {excluded.length ? (
              <div className="space-y-2">
                {excluded.map((item, itemIndex) => (
                  <div key={`${item.field}-${itemIndex}`} className="rounded border border-slate-200 bg-slate-50 p-2 text-slate-600">
                    {item.field}：{item.reason || t("未确认，不进入图片文案")}
                  </div>
                ))}
              </div>
            ) : (
              <div className="rounded border border-slate-200 bg-slate-50 p-3 text-slate-500">{t("暂无被排除字段。")}</div>
            )}
          </div>

          <div>
            <div className="mb-1 font-medium text-slate-700">{t("风险提示")}</div>
            {risks.length ? (
              <div className="space-y-2">
                {risks.map((risk, riskIndex) => (
                  <div key={`${risk.field}-${riskIndex}`} className={`rounded border p-2 ${riskClass(risk.level)}`}>
                    <span className="font-medium">{risk.level || 'medium'} / {risk.field || 'general'}：</span>
                    {risk.message || String(risk)}
                  </div>
                ))}
              </div>
            ) : (
              <div className="rounded border border-emerald-200 bg-emerald-50 p-3 text-emerald-700">{t("暂无明显风险。")}</div>
            )}
          </div>

          <details>
            <summary className="cursor-pointer text-sm font-medium text-slate-700">{t("查看生成 Prompt")}</summary>
            <div className="mt-2 max-h-72 overflow-auto rounded border border-slate-200 bg-slate-50 p-3 text-xs leading-5 text-slate-600">
              {plan.prompt}
            </div>
          </details>

          {requestSummary && (
            <details>
              <summary className="cursor-pointer text-sm font-medium text-slate-700">{t("真实生图请求预览")}</summary>
              <div className="mt-2 space-y-2 rounded border border-slate-200 bg-slate-50 p-3 text-xs leading-5 text-slate-600">
                <div>safeForRealGeneration：{requestSummary.safeForRealGeneration ? t("可接入真实生图") : t("暂不建议真实生图")}</div>
                <div>preferredMode：{requestSummary.preferredMode}</div>
                {requestSummary.blockingIssues?.length > 0 && (
                  <div>blockingIssues：{requestSummary.blockingIssues.join('；')}</div>
                )}
                <div>positivePrompt：{requestSummary.positivePrompt?.slice(0, 260)}</div>
                <div>negativePrompt：{requestSummary.negativePrompt?.slice(0, 260)}</div>
                <div>textBlocks：{(requestSummary.textBlocks || []).map((block) => block.text).join('；') || t("无")}</div>
                <div>forbiddenElements：{(requestSummary.forbiddenElements || []).slice(0, 10).join('，')}</div>
                {requestSummary.categoryRuleSnapshot && (
                  <div className="rounded border border-blue-200 bg-blue-50 p-2 text-blue-800">{t("类目规则：")}{requestSummary.categoryRuleSnapshot.categoryName || requestSummary.categoryRuleSnapshot.categoryId}{t("； 高风险字段：")}{(requestSummary.categoryRuleSnapshot.highRiskFields || []).slice(0, 8).join('、') || t("无")}{t("； 需要证据：")}{Object.keys(requestSummary.categoryRuleSnapshot.evidenceRequiredFields || {}).slice(0, 8).join('、') || t("无")}
                  </div>
                )}
              </div>
            </details>
          )}
        </div>
      </div>
    </Section>
  );
}

export default function ImagePlanPage() {
  const { t } = useLocale();
  const { taskId } = useParams();
  const navigate = useNavigate();
  const { task, setTask, loading, error, setError } = useTask(taskId);
  const [busy, setBusy] = useState(false);
  const [savingPlanId, setSavingPlanId] = useState('');
  const [savingLayoutPlanId, setSavingLayoutPlanId] = useState('');
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
  const [drafts, setDrafts] = useState({});
  const groupedPlans = useMemo(() => plansByTarget(task || {}), [task?.targets, task?.imagePlans]);
  const templateAuditSections = useMemo(() => templateAuditDisplaySections(templateAudit, t), [templateAudit, t]);
  const singleImageSections = useMemo(() => singleImageAcceptanceReportSections(singleImageReport, t), [singleImageReport, t]);
  const sourceImages = useMemo(() => (Array.isArray(task?.sourceImages) ? task.sourceImages : []), [task?.sourceImages]);
  const threeSampleSections = useMemo(() => threeSampleGenerationSections(threeSampleReport, t), [threeSampleReport, t]);
  const selectedThreeSamples = useMemo(() => threeSampleDrafts.slice(0, 3).map((sample, index) => ({
    ...sample,
    imageId: sample.imageId || sourceImages[index]?.id || sourceImages[0]?.id || ''
  })).filter((sample) => sample.imageId), [threeSampleDrafts, sourceImages]);
  const threeSampleRunState = threeSampleCanRun({ confirmPaidApi: threeSampleConfirm, samples: selectedThreeSamples }, t);

  useEffect(() => {
    const nextDrafts = {};
    for (const plan of task?.imagePlans || []) {
      nextDrafts[plan.id] = {
        title: plan.title || '',
        goal: plan.goal || '',
        layout: plan.layout || '',
        textBlocksText: blocksToText(plan.textBlocks),
        riskWarningsText: risksToText(plan.riskWarnings),
        complianceNotesText: notesToText(plan.complianceNotes)
      };
    }
    setDrafts(nextDrafts);
  }, [task?.imagePlans]);

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
  }, [taskId, loading, task?.updatedAt, task?.imagePlans?.length, task?.generatedImages?.length]);

  async function createPlans() {
    setBusy(true);
    setError('');
    try {
      const result = await api.createPlans(taskId);
      setTask(result.task);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  function updateDraft(planId, patch) {
    setDrafts((current) => ({
      ...current,
      [planId]: {
        ...current[planId],
        ...patch
      }
    }));
  }

  async function savePlan(plan) {
    const draft = drafts[plan.id];
    if (!draft) return;
    setSavingPlanId(plan.id);
    setError('');
    try {
      const result = await api.updatePlan(taskId, plan.id, {
        title: draft.title,
        goal: draft.goal,
        layout: draft.layout,
        textBlocks: textToBlocks(draft.textBlocksText, plan.textBlocks),
        riskWarnings: textToRisks(draft.riskWarningsText, plan.riskWarnings),
        complianceNotes: draft.complianceNotesText.split('\n').map((line) => line.trim()).filter(Boolean)
      });
      setTask(result.task);
    } catch (err) {
      setError(err.message);
    } finally {
      setSavingPlanId('');
    }
  }

  async function saveTextLayout(planId, textLayoutOverride) {
    setSavingLayoutPlanId(planId);
    setError('');
    try {
      const result = await api.updateTextLayout(taskId, planId, textLayoutOverride);
      setTask(result.task);
    } catch (err) {
      setError(err.message);
    } finally {
      setSavingLayoutPlanId('');
    }
  }

  async function restoreTextLayout(planId) {
    setSavingLayoutPlanId(planId);
    setError('');
    try {
      const result = await api.restoreTextLayout(taskId, planId);
      setTask(result.task);
    } catch (err) {
      setError(err.message);
    } finally {
      setSavingLayoutPlanId('');
    }
  }

  function downloadRuleAuditJson() {
    if (!templateAudit) return;
    downloadTemplateAuditJson(templateAudit, { t });
  }

  async function runSingleImageGeneration() {
    setSingleImageBusy(true);
    setSingleImageError('');
    try {
      if (!await approveImageGeneration(api, { taskId, mattingProvider: singleMattingProvider }, t, (message) => window.confirm(message))) return;
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
    const runState = threeSampleCanRun({ confirmPaidApi: threeSampleConfirm, samples: selectedThreeSamples }, t);
    if (!runState.canRun) {
      setThreeSampleError(runState.reason);
      return;
    }
    setThreeSampleBusy(true);
    setThreeSampleError('');
    try {
      if (!await approveImageGeneration(api, { taskId, mattingProvider: singleMattingProvider, count: 3 }, t, (message) => window.confirm(message))) return;
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

  if (loading) return <div className="text-sm text-slate-500">{t("正在加载图片方案...")}</div>;

  if (!task) {
    return (
      <div className="space-y-4">
        <StepNav taskId={taskId} />
        <ErrorMessage error={error || '图片方案加载失败，请刷新或返回上一步重试。'} />
        <div className="rounded border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">{t("图片方案加载失败，请刷新或返回上一步重试。")}</div>
      </div>
    );
  }

  const canCreatePlans = canRunAction(task.status, 'createPlans');

  return (
    <div className="space-y-5">
      <StepNav taskId={taskId} />
      <TaskProgress task={task} />
      <ErrorMessage error={error} />
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-ink">{t("图片方案生成")}</h1>
          <p className="mt-1 text-sm text-slate-500">{t("多平台目标：")}{task.targets?.length || 1}{" " + t("个 /") + " "}{task.productInfo?.name}
          </p>
          <p className="mt-1 text-sm text-slate-500">{t("方案只使用已确认商品信息；AI 推测候选项不会自动进入图片文案。")}</p>
        </div>
        <div>
          <PrimaryButton busy={busy} disabled={!canCreatePlans} onClick={createPlans}>
            <WandSparkles size={17} />{t("生成图片方案")}</PrimaryButton>
          <DisabledReason reason={!canCreatePlans ? actionDisabledReason(task.status, 'createPlans') : ''} />
        </div>
      </div>

      <Section title={t("规则审计 JSON 导出")}>
        <div className="space-y-3 text-sm">
          {templateAuditError && (
            <div className="rounded border border-amber-200 bg-amber-50 p-3 text-amber-700">{t("规则审计报告加载失败：")}{templateAuditError}
            </div>
          )}
          <div className="rounded border border-blue-200 bg-blue-50 p-3 text-xs text-blue-800">
            {t(templateAuditExportNotice)}
          </div>
          {templateAuditSections.ruleAuditEmptyText ? (
            <div className="rounded border border-slate-200 bg-slate-50 p-3 text-slate-500">
              {templateAuditSections.ruleAuditEmptyText}
            </div>
          ) : (
            <div className="rounded border border-slate-200 bg-slate-50 p-3 text-slate-600">
              {templateAuditSections.ruleAuditText}
            </div>
          )}
          <button
            type="button"
            onClick={downloadRuleAuditJson}
            disabled={!templateAudit}
            className="rounded border border-slate-300 bg-white px-3 py-2 text-xs font-medium text-slate-700 disabled:cursor-not-allowed disabled:opacity-60"
          >{t("导出规则审计 JSON")}</button>
        </div>
      </Section>

      <Section title={t("单 SKU 小样本生成真实生图")}>
        <div className="space-y-4 text-sm">
          <div className="rounded border border-blue-200 bg-blue-50 p-3 text-blue-800">
            <div className="font-semibold text-ink">{t("单 SKU 小样本真实生图 / 真实生图验收报告")}</div>
            {t(singleImageGenerationNotice)}
            <div className="mt-1 text-xs">{t(singleImageGenerationWarningText)}</div>
          </div>
          {singleImageError && <div className="rounded border border-red-200 bg-red-50 p-3 text-red-700">{singleImageError}</div>}
          <div className="grid gap-3 md:grid-cols-3">
            <label className="block">
              <span className="mb-1 block text-xs font-semibold text-slate-500">{t("生成图片类型")}</span>
              <select value={singleImageType} onChange={(event) => setSingleImageType(event.target.value)} className="w-full rounded border border-slate-300 bg-white px-3 py-2 text-sm">
                {singleImageGenerationOptions.map((option) => (
                  <option key={option.value} value={option.value}>{t(option.label)}</option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="mb-1 block text-xs font-semibold text-slate-500">{t("抠图 Provider")}</span>
              <select value={singleMattingProvider} onChange={(event) => setSingleMattingProvider(event.target.value)} className="w-full rounded border border-slate-300 bg-white px-3 py-2 text-sm">
                <option value="sharp">{t("sharp 本地抠图")}</option>
                <option value="image2">{t("Image2 实验抠图")}</option>
              </select>
            </label>
            <div className="flex items-end gap-2">
              <div className="text-xs font-medium text-slate-500">{t("导出真实生图验收报告")}</div>
              <button type="button" data-single-real onClick={runSingleImageGeneration} disabled={!task.imagePlans?.length || singleImageBusy} className="rounded bg-coral px-3 py-2 text-sm font-medium text-white disabled:opacity-60">
                {singleImageBusy ? t("正在生成...") : t("运行单图真实生成")}
              </button>
              <button type="button" onClick={downloadSingleImageReport} disabled={!singleImageReport} className="rounded border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 disabled:opacity-60">{t("下载生成结果 JSON")}</button>
            </div>
          </div>
          {singleImageSections.emptyText ? (
            <div className="rounded border border-slate-200 bg-slate-50 p-3 text-slate-500">{singleImageSections.emptyText}</div>
          ) : (
            <div className="space-y-3">
              <div>
                <div className="font-semibold text-ink">{singleImageSections.title}</div>
                <div className="mt-1 text-xs text-slate-500">{t("manualChecklist 默认未检查，请人工打开图片后逐项确认。")}</div>
              </div>
              <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-6">
                {singleImageSections.cards.map((card) => (
                  <div key={card.label} className="rounded border border-slate-200 bg-slate-50 p-3">
                    <div className="text-xs font-semibold text-slate-500">{t(card.label)}</div>
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
            </div>
          )}
          <div className="border-t border-slate-200 pt-4">
            <div className="font-semibold text-ink">{t("三张小样本对比")}</div>
            <div className="mt-1 rounded border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800">{t("本次最多生成 3 张真实小样本，可能产生 API 成本。请确认后继续。")}</div>
            <div className="mt-3 grid gap-3 lg:grid-cols-3">
              {threeSampleDrafts.map((sample, index) => (
                <div key={sample.sampleId} className="rounded border border-slate-200 bg-slate-50 p-3">
                  <div className="mb-2 text-xs font-semibold text-slate-500">{sample.sampleId}</div>
                  <select value={sample.imageId} onChange={(event) => updateThreeSampleDraft(index, { imageId: event.target.value })} className="mb-2 w-full rounded border border-slate-300 bg-white px-2 py-1 text-xs">
                    <option value="">{t("自动选择样本图片")}</option>
                    {sourceImages.slice(0, 8).map((source) => (
                      <option key={source.id} value={source.id}>{source.displayName || source.fileName || source.id}</option>
                    ))}
                  </select>
                  <select value={sample.imageType} onChange={(event) => updateThreeSampleDraft(index, { imageType: event.target.value })} className="w-full rounded border border-slate-300 bg-white px-2 py-1 text-xs">
                    {singleImageGenerationOptions.map((option) => (
                      <option key={option.value} value={option.value}>{t(option.label)}</option>
                    ))}
                  </select>
                </div>
              ))}
            </div>
            <label className="mt-3 flex items-start gap-2 text-xs text-slate-700">
              <input type="checkbox" checked={threeSampleConfirm} onChange={(event) => setThreeSampleConfirm(event.target.checked)} />
              <span>{t("我确认这是小样本测试，并接受可能产生的 API 成本。")}</span>
            </label>
            {threeSampleError && <div className="mt-3 rounded border border-red-200 bg-red-50 p-3 text-red-700">{threeSampleError}</div>}
            <div className="mt-3 flex flex-wrap gap-2">
              <button type="button" onClick={runThreeSampleGeneration} disabled={!threeSampleRunState.canRun || threeSampleBusy} className="rounded bg-coral px-3 py-2 text-sm font-medium text-white disabled:opacity-60">
                {threeSampleBusy ? t("正在生成三张小样本...") : t("开始三张小样本对比")}
              </button>
              <button type="button" onClick={downloadThreeSampleReport} disabled={!threeSampleReport} className="rounded border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 disabled:opacity-60">{t("导出三张小样本 JSON")}</button>
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
                      <div className="font-semibold text-ink">{card.sampleId} / {card.imageTypeLabel}</div>
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

      <div className="grid gap-5">
        {!groupedPlans.length && (
          <div className="rounded border border-slate-200 bg-slate-50 p-4 text-sm text-slate-600">{t("暂无图片方案，请先生成图片方案。")}</div>
        )}
        {groupedPlans.map(({ target, plans }) => (
          <section key={target.id || target.targetId || target.platformId} className="rounded border border-slate-200 bg-white p-4">
            <details open>
              <summary className="cursor-pointer list-none">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <div className="text-lg font-semibold text-ink">{targetLabel(target, t)}</div>
                    <div className="mt-1 text-sm text-slate-500">{t("类目：")}{target.categoryId || target.category || 'general'}{" " + t("/ 图片方案：")}{plans.length}{" " + t("张")}</div>
                    <div className="mt-2 rounded border border-slate-200 bg-slate-50 p-2 text-xs text-slate-600">
                      {targetRuleSummary(target, t)}
                    </div>
                  </div>
                  <span className="rounded border border-slate-200 bg-slate-50 px-2 py-1 text-xs text-slate-500">
                    targetId: {target.id || target.targetId}
                  </span>
                </div>
              </summary>
              <div className="mt-4 grid gap-4">
                {plans.map((plan, index) => (
                  <PlanCard
                    key={plan.id}
                    plan={plan}
                    index={index}
                    draft={drafts[plan.id] || {
                      title: plan.title || '',
                      goal: plan.goal || '',
                      layout: plan.layout || '',
                      textBlocksText: blocksToText(plan.textBlocks),
                      riskWarningsText: risksToText(plan.riskWarnings),
                      complianceNotesText: notesToText(plan.complianceNotes)
                    }}
                    onDraftChange={updateDraft}
                    onSave={savePlan}
                    saving={savingPlanId === plan.id}
                    onSaveTextLayout={saveTextLayout}
                    onRestoreTextLayout={restoreTextLayout}
                    savingLayout={savingLayoutPlanId === plan.id}
                  />
                ))}
              </div>
            </details>
          </section>
        ))}
      </div>

      {task.imagePlans?.length > 0 && (
        <PrimaryButton onClick={() => navigate(`/tasks/${taskId}/generate`)}>{t("继续生成图片")}</PrimaryButton>
      )}
    </div>
  );
}
