import { useLocale } from '../i18n/LocaleProvider.jsx';
import { approvePaidOperation } from '../utils/paidOperationApproval.js';
import { useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ShieldCheck } from 'lucide-react';
import StepNav from '../components/StepNav.jsx';
import TaskProgress from '../components/TaskProgress.jsx';
import Section from '../components/Section.jsx';
import StatusBadge from '../components/StatusBadge.jsx';
import { api } from '../services/api.js';
import { ErrorMessage, PrimaryButton, useTask, DisabledReason, TaskLoadFailure } from './pageUtils.jsx';
import { actionDisabledReason, canRunAction } from '../utils/taskWorkflow.js';
import { getImageSourceStatus, summarizeImageSources } from '../utils/imageSourceStatus.js';
import { normalizeReviewMode } from '../utils/reviewMode.js';
import { getReviewStaleNotice, mockPreviewReviewNotice, splitMockPreviewIssues } from '../utils/reviewDisplay.js';
import { downloadReviewReportJson, getReviewReportDisplayModel } from '../utils/reviewReport.js';
import {
  downloadAutoFixExecutionJson,
  downloadAutoFixPlanJson,
  getAutoFixExecutionDisplayModel,
  getAutoFixPlanDisplayModel
} from '../utils/autoFixPlan.js';

const checkLabelMap = {
  noChinese: '无中文',
  noWatermark: '无水印',
  noPrice: '无价格文字',
  noViolatingLogo: '无违规 Logo',
  noFakeCertification: '无虚假认证',
  mainImageRule: '平台主图规则'
};

const statusLabelMap = {
  passed: '通过',
  failed: '未通过'
};

function preserveReviewMessage(item = {}) {
  if (item.preserveQuality?.subjectPreserveRisk === 'high') {
    return '商品主体可能与原图不一致，需人工复核。';
  }
  if (item.edgeQuality === 'poor') {
    return '抠图边缘质量较差，建议重新选择白底或干净背景参考图。';
  }
  if (item.preserveQuality?.qualityLevel === 'good') {
    return '主体保留质量较好，但仍需人工检查外观、颜色、接口和纹理。';
  }
  return '';
}

function issueCategoryGroup(category) {
  if (category === 'platform') return '平台规则问题';
  if (category === 'text') return '图片/文字问题';
  if (category === 'evidence') return '证据/商品信息问题';
  if (category === 'source') return '生成来源问题';
  if (category === 'layout') return '排版问题';
  if (category === 'visual') return '图片内容问题';
  if (category === 'category') return '类目规则问题';
  return '';
}

function ruleSnapshotForItem(item = {}, image = {}) {
  return item.platformRuleSnapshot ||
    item.platformChecks?.platformRuleSnapshot ||
    item.metadata?.platformRuleSnapshot ||
    item.metadata?.generationRequestSummary?.platformRuleSnapshot ||
    image.platformRuleSnapshot ||
    image.generationRequestSummary?.platformRuleSnapshot ||
    image.generationRequest?.compliance?.platformRulesSnapshot ||
    null;
}

function categorySnapshotForItem(item = {}, image = {}) {
  return item.categoryRuleSnapshot ||
    item.platformChecks?.categoryRuleSnapshot ||
    item.metadata?.categoryRuleSnapshot ||
    item.metadata?.generationRequestSummary?.categoryRuleSnapshot ||
    image.categoryRuleSnapshot ||
    image.generationRequestSummary?.categoryRuleSnapshot ||
    image.generationRequest?.categoryRuleSnapshot ||
    image.generationRequest?.compliance?.categoryRuleSnapshot ||
    null;
}

function PlatformRuleSummary({ snapshot }) {
  const { t } = useLocale();
  if (!snapshot) return null;
  const severityEntries = Object.entries(snapshot.severity || {}).slice(0, 5);
  return (
    <div className="mt-3 rounded border border-slate-200 bg-slate-50 p-3 text-xs text-slate-600">
      <div className="font-semibold text-slate-800">{t("平台规则摘要")}</div>
      <div className="mt-2 grid gap-2 md:grid-cols-2">
        <div>{t("平台：")}{snapshot.platformName || snapshot.platformId || '-'}</div>
        <div>{t("图片类型：")}{snapshot.imageType || '-'}</div>
        <div>{t("目标语言：")}{snapshot.language || '-'}</div>
        <div>{t("允许文字：")}{snapshot.textAllowed ? t("允许") : t("不允许")}</div>
        <div>{t("背景要求：")}{snapshot.backgroundRule?.recommended || snapshot.backgroundRule || '-'}</div>
        <div>{t("规则版本：")}{snapshot.ruleVersion || '-'}</div>
      </div>
      {snapshot.forbiddenElements?.length > 0 && (
        <div className="mt-2">
          <span className="font-medium">{t("禁止元素：")}</span>
          {snapshot.forbiddenElements.slice(0, 10).join('、')}
        </div>
      )}
      {severityEntries.length > 0 && (
        <div className="mt-2">
          <span className="font-medium">{t("风险等级：")}</span>
          {severityEntries.map(([key, value]) => `${key}:${value}`).join(' / ')}
        </div>
      )}
    </div>
  );
}

function CategoryRuleSummary({ snapshot }) {
  const { t } = useLocale();
  if (!snapshot) return null;
  return (
    <div className="mt-3 rounded border border-blue-200 bg-blue-50 p-3 text-xs text-blue-800">
      <div className="font-semibold">{t("类目规则摘要")}</div>
      <div className="mt-2 grid gap-2 md:grid-cols-2">
        <div>{t("类目：")}{snapshot.categoryName || snapshot.categoryId || '-'}</div>
        <div>{t("图片类型：")}{snapshot.imageType || '-'}</div>
        <div>{t("关键字段：")}{(snapshot.criticalFields || []).slice(0, 8).join('、') || '-'}</div>
        <div>{t("高风险字段：")}{(snapshot.highRiskFields || []).slice(0, 8).join('、') || '-'}</div>
      </div>
      {snapshot.evidenceRequiredFields && (
        <div className="mt-2">
          <span className="font-medium">{t("需要证据：")}</span>
          {Object.entries(snapshot.evidenceRequiredFields).map(([field, rule]) => `${field}:${rule}`).join(' / ')}
        </div>
      )}
      {snapshot.riskyClaims?.length > 0 && (
        <div className="mt-2">
          <span className="font-medium">{t("类目风险词：")}</span>
          {snapshot.riskyClaims.slice(0, 10).join('、')}
        </div>
      )}
    </div>
  );
}

function targetDisplayLabel(target = {}) {
  return `${target.platformName || target.platform || target.platformId || '平台'} / ${target.site || 'US'} / ${target.language || 'English'}`;
}

function buildReviewDisplayItems(task = {}, items = [], generatedById = {}) {
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
  const groups = targets.map((target) => ({
    kind: 'group',
    key: target.id || target.targetId || target.platformId,
    target,
    items: items.filter((item) => {
      const image = generatedById[item.imageId] || {};
      return item.targetId === target.id ||
        item.targetId === target.targetId ||
        image.targetId === target.id ||
        image.targetId === target.targetId ||
        item.platformId === target.platformId ||
        image.platformId === target.platformId;
    })
  })).filter((group) => group.items.length > 0);
  const groupedIds = new Set(groups.flatMap((group) => group.items.map((item) => item.imageId)));
  const orphans = items.filter((item) => !groupedIds.has(item.imageId));
  if (orphans.length) {
    const image = generatedById[orphans[0].imageId] || {};
    groups.push({
      kind: 'group',
      key: 'unknown-target',
      target: { platformName: image.platform || image.platformId || '未分组平台', site: image.site, language: image.language },
      items: orphans
    });
  }
  return groups.flatMap((group) => [
    group,
    ...group.items.map((item) => ({ kind: 'item', key: item.imageId, item }))
  ]);
}

export default function ReviewPage() {
  const { t } = useLocale();
  const { taskId } = useParams();
  const navigate = useNavigate();
  const { task, setTask, loading, error, setError, refresh } = useTask(taskId);
  const [busy, setBusy] = useState(false);
  const [autoFixBusy, setAutoFixBusy] = useState(false);
  const [autoFixPlan, setAutoFixPlan] = useState(null);
  const [selectedAutoFixActionIds, setSelectedAutoFixActionIds] = useState([]);
  const [autoFixExecutionResult, setAutoFixExecutionResult] = useState(null);
  const [reviewMode, setReviewMode] = useState('mock');

  const generatedById = useMemo(() => Object.fromEntries((task?.generatedImages || []).map((image) => [image.id, image])), [task?.generatedImages]);
  const reviewDisplayItems = useMemo(
    () => buildReviewDisplayItems(task || {}, task?.review?.items || [], generatedById),
    [task?.targets, task?.review?.items, generatedById]
  );
  const reviewReportDisplay = useMemo(
    () => getReviewReportDisplayModel(task?.normalizedReviewReport),
    [task?.normalizedReviewReport]
  );
  const autoFixPlanDisplay = useMemo(
    () => getAutoFixPlanDisplayModel(autoFixPlan),
    [autoFixPlan]
  );
  const autoFixExecutionDisplay = useMemo(
    () => getAutoFixExecutionDisplayModel(autoFixExecutionResult),
    [autoFixExecutionResult]
  );

  async function review(mode = reviewMode) {
    const selectedMode = normalizeReviewMode(mode);
    setBusy(true);
    setError('');
    try {
      const approval = selectedMode === 'real' ? await approvePaidOperation(api, { kinds: ['review'], target: taskId, count: task?.generatedImages?.length || 0 }, t, (message) => window.confirm(message)) : {};
      if (!approval) return;
      const result = await api.review(taskId, { mode: selectedMode, ...approval });
      setTask(result.task);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  function issueText(issue) {
    if (typeof issue === 'string') return issue;
    return issue?.message || issue?.type || '审核问题';
  }

  function issueGroup(issue) {
    if (typeof issue !== 'string') {
      const byCategory = issueCategoryGroup(issue?.category);
      if (byCategory) return byCategory;
    }
    const type = typeof issue === 'string' ? issue : issue?.type || '';
    if (/main|background|platform/.test(type)) return '平台规则问题';
    if (/chinese|price|promotion|text|watermark|logo/.test(type)) return '图片/文字问题';
    if (/capacity|certification|evidence|inferred/.test(type)) return '证据/商品信息问题';
    if (/mock|fallback|subject|generation|preserve/.test(type)) return '生成来源问题';
    if (/category/.test(type)) return '类目规则问题';
    return '其它风险';
  }

  function groupedIssues(issues = []) {
    return issues.reduce((groups, issue) => {
      const group = issueGroup(issue);
      groups[group] = [...(groups[group] || []), issue];
      return groups;
    }, {});
  }

  function exportReviewReport() {
    downloadReviewReportJson({ report: task?.normalizedReviewReport, taskId });
  }

  async function generateAutoFixPlan() {
    setAutoFixBusy(true);
    setError('');
    try {
      const result = await api.getAutoFixPlan(taskId);
      setAutoFixPlan(result.autoFixPlan);
      setSelectedAutoFixActionIds([]);
      setAutoFixExecutionResult(null);
    } catch (err) {
      setError(err.message);
    } finally {
      setAutoFixBusy(false);
    }
  }

  function exportAutoFixPlan() {
    downloadAutoFixPlanJson({ plan: autoFixPlan, taskId });
  }

  function toggleAutoFixAction(actionId) {
    setSelectedAutoFixActionIds((current) => (
      current.includes(actionId)
        ? current.filter((item) => item !== actionId)
        : [...current, actionId]
    ));
  }

  async function executeSelectedAutoFixActions() {
    if (!selectedAutoFixActionIds.length) return;
    const confirmed = window.confirm(t("本次只会执行低风险文字修正，不会重新生成图片，不会调用真实 Provider。是否继续？"));
    if (!confirmed) return;
    setAutoFixBusy(true);
    setError('');
    try {
      const result = await api.executeAutoFixPlan(taskId, {
        approvedActionIds: selectedAutoFixActionIds,
        confirmExecute: true,
        mode: 'textLayoutOnly'
      });
      setAutoFixExecutionResult(result.executionResult);
    } catch (err) {
      setError(err.message);
    } finally {
      setAutoFixBusy(false);
    }
  }

  function exportAutoFixExecutionResult() {
    downloadAutoFixExecutionJson({ executionResult: autoFixExecutionResult, taskId });
  }

  async function saveAutoFixExecutionResult() {
    if (!selectedAutoFixActionIds.length || !autoFixExecutionResult?.patchedImagePlans?.length) return;
    const confirmed = window.confirm(t("本次只会保存低风险文字修正到图片方案，不会重新生成图片，不会重新审核，不会修改商品识别字段。确认继续吗？"));
    if (!confirmed) return;
    setAutoFixBusy(true);
    setError('');
    try {
      const result = await api.executeAutoFixPlan(taskId, {
        approvedActionIds: selectedAutoFixActionIds,
        confirmExecute: true,
        confirmSave: true,
        persist: true,
        mode: 'textLayoutOnly'
      });
      setAutoFixExecutionResult(result.executionResult);
      if (result.task) setTask(result.task);
    } catch (err) {
      setError(err.message);
    } finally {
      setAutoFixBusy(false);
    }
  }

  if (loading) return <div className="text-sm text-slate-500">{t("正在加载合规审核...")}</div>;
  if (!task) return <TaskLoadFailure error={error} onRetry={refresh} />;

  const canReview = canRunAction(task.status, 'reviewImages');
  const reviewReason = !task.generatedImages?.length ? t('请先生成图片后再审核。') : actionDisabledReason(task.status, 'reviewImages', t);
  const reviewStaleNotice = getReviewStaleNotice(task);
  const hasStaleReview = Boolean(reviewStaleNotice);
  const sourceSummary = summarizeImageSources(task.generatedImages || []);
  const mockNotice = mockPreviewReviewNotice(sourceSummary);
  const postFixStatus = autoFixExecutionDisplay.postFixStatus;
  const nextValidationChecklist = autoFixExecutionDisplay.nextValidationChecklist;

  return (
    <div className="space-y-5">
      <StepNav taskId={taskId} />
      <TaskProgress task={task} />
      <ErrorMessage error={error} />
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-ink">{t("合规审核")}</h1>
          <p className="mt-1 text-sm text-slate-500">{t("支持 mock 规则审核和真实视觉风险审核；结果用于辅助人工复核，不代表平台官方最终审核。")}</p>
        </div>
        <div>
          <PrimaryButton busy={busy} disabled={!task.generatedImages?.length || !canReview} onClick={() => review('mock')}>
            <ShieldCheck size={17} />{t("开始审核")}</PrimaryButton>
          <button
            type="button"
            onClick={() => review('real')}
            disabled={busy || !task.generatedImages?.length || !canReview}
            className="ml-2 rounded border border-coral px-3 py-2 text-sm font-medium text-coral disabled:opacity-60"
          >{t("真实视觉审核")}</button>
          <DisabledReason reason={!task.generatedImages?.length || !canReview ? reviewReason : ''} />
        </div>
      </div>

      <div className="rounded border border-slate-200 bg-slate-50 p-3 text-sm text-slate-600">{t("审核模式：")}<select value={reviewMode} onChange={(event) => setReviewMode(event.target.value)} className="ml-2 rounded border border-slate-300 bg-white px-2 py-1">
          <option value="mock">{t("mock 规则审核")}</option>
          <option value="real">{t("真实视觉审核")}</option>
        </select>
        <div className="mt-1 text-xs">{t("真实审核是 AI 视觉 + 规则风险检查，不代表平台官方最终审核。")}</div>
      </div>

      {mockNotice && (
        <div className="rounded border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">
          {mockNotice}
        </div>
      )}

      {sourceSummary.realGeneratedCount > 0 && (
        <div className="rounded border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-800">{t("当前包含真实生成图，但审核仍是 mock 规则审核，不代表平台最终审核结果。")}</div>
      )}

      {sourceSummary.fallbackMockCount > 0 && (
        <div className="rounded border border-red-200 bg-red-50 p-4 text-sm text-red-800">{t("部分图片是真实生成失败后的 fallback mock，不是真实生成结果。")}</div>
      )}

      {hasStaleReview && (
        <div className="rounded border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">{t("图片已重新生成，当前部分审核结果可能已过期，建议重新点击“开始审核”。")}</div>
      )}

      <Section
        title={t("结构化审核摘要")}
        actions={(
          <button
            type="button"
            onClick={exportReviewReport}
            disabled={!task.normalizedReviewReport}
            className="rounded border border-slate-300 px-3 py-2 text-sm font-medium text-slate-700 disabled:opacity-60"
          >{t("导出审核报告 JSON")}</button>
        )}
      >
        {reviewReportDisplay.emptyText ? (
          <div className="rounded border border-slate-200 bg-slate-50 p-4 text-sm text-slate-600">{t("暂无结构化审核报告，请先执行审核。")}</div>
        ) : (
          <div className="space-y-4">
            <div className="rounded border border-blue-200 bg-blue-50 p-3 text-sm text-blue-800">
              {reviewReportDisplay.nextSuggestedAction}
            </div>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              {reviewReportDisplay.summaryCards.map((card) => (
                <div key={card.label} className="rounded border border-slate-200 bg-white p-3">
                  <div className="text-xs text-slate-500">{card.label}</div>
                  <div className="mt-1 text-2xl font-semibold text-ink">{card.value}</div>
                </div>
              ))}
            </div>
            {reviewReportDisplay.complianceGroups.length > 0 && (
              <div className="space-y-2">
                <div className="text-sm font-semibold text-ink">{t("真实合规问题")}</div>
                {reviewReportDisplay.complianceGroups.map((group) => (
                  <div key={group.groupKey} className="rounded border border-red-200 bg-red-50 p-3 text-sm text-red-800">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="font-semibold">{group.title}</div>
                      <span className="rounded bg-white px-2 py-1 text-xs">{group.severity} / {group.count || 1}{" " + t("项")}</span>
                    </div>
                    {group.imageTypes?.length > 0 && (
                      <div className="mt-1 text-xs">{t("图片类型：")}{group.imageTypes.join(' / ')}</div>
                    )}
                    {group.messages?.length > 0 && (
                      <ul className="mt-2 list-disc space-y-1 pl-5">
                        {group.messages.map((message, index) => <li key={`${group.groupKey}-message-${index}`}>{message}</li>)}
                      </ul>
                    )}
                    {group.suggestion && <div className="mt-2 font-medium">{t("建议：")}{group.suggestion}</div>}
                  </div>
                ))}
              </div>
            )}
            {reviewReportDisplay.mockHintGroups.length > 0 && (
              <div className="space-y-2">
                <div className="text-sm font-semibold text-ink">{t("流程提示")}</div>
                {reviewReportDisplay.mockHintGroups.map((group) => (
                  <div key={group.groupKey} className="rounded border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
                    <div className="font-semibold">{group.title}</div>
                    <div className="mt-1 text-xs">{t("mockInfo 仅说明当前为 mock 或 fallback 流程提示，不等同于真实合规错误。")}</div>
                    {group.suggestion && <div className="mt-2">{t("建议：")}{group.suggestion}</div>}
                  </div>
                ))}
              </div>
            )}
            {reviewReportDisplay.recommendations.length > 0 && (
              <div className="rounded border border-slate-200 bg-slate-50 p-3 text-sm text-slate-700">
                <div className="font-semibold text-ink">{t("优先处理建议")}</div>
                <ul className="mt-2 list-disc space-y-1 pl-5">
                  {reviewReportDisplay.recommendations.slice(0, 6).map((item, index) => <li key={index}>{item}</li>)}
                </ul>
              </div>
            )}
          </div>
        )}
      </Section>

      <Section title={t("修正建议清单")}>
        {reviewReportDisplay.fixSummaryCards.length === 0 ? (
          <div className="rounded border border-slate-200 bg-slate-50 p-4 text-sm text-slate-600">{t("暂无修正建议，请先执行审核。")}</div>
        ) : (
          <div className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              {reviewReportDisplay.fixSummaryCards.map((card) => (
                <div key={card.label} className="rounded border border-slate-200 bg-white p-3">
                  <div className="text-xs text-slate-500">{card.label}</div>
                  <div className="mt-1 text-xl font-semibold text-ink">{card.value}</div>
                </div>
              ))}
            </div>
            {reviewReportDisplay.fixSuggestions.length > 0 && (
              <div className="space-y-2">
                {reviewReportDisplay.fixSuggestions.map((suggestion) => (
                  <div key={suggestion.suggestionId} className="rounded border border-red-200 bg-red-50 p-3 text-sm text-red-800">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="font-semibold">{suggestion.title}</div>
                      <span className="rounded bg-white px-2 py-1 text-xs">{suggestion.actionType}</span>
                    </div>
                    <div className="mt-1 text-xs">{suggestion.description}</div>
                    <div className="mt-1 text-xs">{t("字段：")}{suggestion.fieldLabel || '-'} {suggestion.fieldKey ? `(${suggestion.fieldKey})` : ''}</div>
                    <div className="mt-1 text-xs">{t("图片类型：")}{(suggestion.affectedImageTypes || []).join(' / ') || suggestion.imageType || '-'}</div>
                    <div className="mt-1 text-xs">{t("可自动修正候选：")}{suggestion.canAutoFixLater ? t("是") : t("否")}{" " + t("/ 需要人工确认：")}{suggestion.requiresManualConfirm ? t("是") : t("否")}</div>
                    {suggestion.recommendedSteps?.length > 0 && (
                      <ol className="mt-2 list-decimal space-y-1 pl-5">
                        {suggestion.recommendedSteps.map((step, index) => <li key={`${suggestion.suggestionId}-recommendedSteps-${index}`}>{step}</li>)}
                      </ol>
                    )}
                  </div>
                ))}
              </div>
            )}
            {reviewReportDisplay.mockOnlyFixSuggestions.length > 0 && (
              <div className="space-y-2">
                <div className="text-sm font-semibold text-ink">{t("流程提示")}</div>
                {reviewReportDisplay.mockOnlyFixSuggestions.map((suggestion) => (
                  <div key={suggestion.suggestionId} className="rounded border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
                    <div className="font-semibold">{suggestion.title}</div>
                    <div className="mt-1 text-xs">{suggestion.description}</div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </Section>

      <Section
        title={t("自动修正计划（预览）")}
        actions={(
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={generateAutoFixPlan}
              disabled={autoFixBusy}
              className="rounded border border-slate-300 px-3 py-2 text-sm font-medium text-slate-700 disabled:opacity-60"
            >
              {autoFixBusy ? t("正在生成...") : t("生成修正计划")}
            </button>
            <button
              type="button"
              onClick={exportAutoFixPlan}
              disabled={!autoFixPlan}
              className="rounded border border-slate-300 px-3 py-2 text-sm font-medium text-slate-700 disabled:opacity-60"
            >{t("导出修正计划 JSON")}</button>
          </div>
        )}
      >
        <div className="space-y-4">
          <div className="rounded border border-blue-200 bg-blue-50 p-3 text-sm text-blue-800">{t("当前仅生成修正计划，不会自动修改图片方案、文字排版或生成结果。需要人工确认的字段不会自动修正。真实生图相关修正不会自动执行，避免产生额外成本。")}</div>
          {autoFixPlanDisplay.emptyText && !autoFixPlan ? (
            <div className="rounded border border-slate-200 bg-slate-50 p-4 text-sm text-slate-600">
              {autoFixPlanDisplay.emptyText}
            </div>
          ) : (
            <div className="space-y-4">
              {autoFixPlanDisplay.warnings.length > 0 && (
                <div className="rounded border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
                  <ul className="list-disc space-y-1 pl-5">
                    {autoFixPlanDisplay.warnings.map((warning, index) => <li key={index}>{warning}</li>)}
                  </ul>
                </div>
              )}
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
                {autoFixPlanDisplay.summaryCards.map((card) => (
                  <div key={card.label} className="rounded border border-slate-200 bg-white p-3">
                    <div className="text-xs text-slate-500">{card.label}</div>
                    <div className="mt-1 text-xl font-semibold text-ink">{card.value}</div>
                  </div>
                ))}
              </div>
              {autoFixPlanDisplay.plannedActions.length > 0 && (
                <div className="space-y-2">
                  <div className="text-sm font-semibold text-ink">{t("可执行候选（仅预览）")}</div>
                  {autoFixPlanDisplay.plannedActions.map((action) => (
                    <div key={action.actionId} className="rounded border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-800">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <label className="flex items-center gap-2 font-semibold">
                          <input
                            type="checkbox"
                            checked={selectedAutoFixActionIds.includes(action.actionId)}
                            disabled={!action.selectable || autoFixBusy}
                            onChange={() => toggleAutoFixAction(action.actionId)}
                          />
                          {action.title}
                        </label>
                        <span className="rounded bg-white px-2 py-1 text-xs">{action.actionTypeLabel}</span>
                      </div>
                      <div className="mt-1 text-xs">{action.description}</div>
                      <div className="mt-1 text-xs">{t("图片类型：")}{action.target?.imageType || '-'}</div>
                      <div className="mt-1 text-xs">{t("风险等级：")}{action.riskLevel || '-'} / dry-run：{action.dryRunOnly ? t("是") : t("否")}</div>
                      {action.previewChange && (
                        <div className="mt-2 rounded border border-emerald-100 bg-white p-2 text-xs">{t("预览变化：")}{action.previewChange.changeType || 'flagOnly'} / before: {action.previewChange.before || '-'} / after: {action.previewChange.after || '-'}
                        </div>
                      )}
                    </div>
                  ))}
                  <div className="flex flex-wrap items-center gap-2 pt-2">
                    <button
                      type="button"
                      onClick={executeSelectedAutoFixActions}
                      disabled={!selectedAutoFixActionIds.length || autoFixBusy}
                      className="rounded bg-emerald-700 px-3 py-2 text-sm font-medium text-white disabled:opacity-60"
                    >{t("执行已选择的文字修正")}</button>
                    <span className="text-xs text-slate-500">{t("只允许 removeText / removeClaim / Amazon main_image 清空文字。")}</span>
                  </div>
                </div>
              )}
              {autoFixPlanDisplay.manualActions.length > 0 && (
                <div className="space-y-2">
                  <div className="text-sm font-semibold text-ink">{t("需要人工复查")}</div>
                  {autoFixPlanDisplay.manualActions.map((action) => (
                    <div key={action.actionId} className="rounded border border-orange-200 bg-orange-50 p-3 text-sm text-orange-800">
                      <div className="font-semibold">{action.title}</div>
                      <div className="mt-1 text-xs">{t("字段：")}{action.fieldLabel || '-'} {action.fieldKey ? `(${action.fieldKey})` : ''}</div>
                      <div className="mt-1 text-xs">{action.reason || action.description}</div>
                      {action.recommendedSteps?.length > 0 && (
                        <ol className="mt-2 list-decimal space-y-1 pl-5">
                          {action.recommendedSteps.map((step, index) => <li key={`${action.actionId}-step-${index}`}>{step}</li>)}
                        </ol>
                      )}
                    </div>
                  ))}
                </div>
              )}
              {autoFixPlanDisplay.blockedActions.length > 0 && (
                <div className="space-y-2">
                  <div className="text-sm font-semibold text-ink">{t("被阻止的自动操作")}</div>
                  {autoFixPlanDisplay.blockedActions.map((action) => (
                    <div key={action.actionId} className="rounded border border-red-200 bg-red-50 p-3 text-sm text-red-800">
                      <div className="font-semibold">{action.title}</div>
                      <div className="mt-1 text-xs">{action.reason}</div>
                      <div className="mt-1 text-xs">{t("需人工确认：")}{action.requiresManualConfirm ? t("是") : t("否")}{" " + t("/ 字段：")}{action.fieldLabel || '-'} {action.fieldKey ? `(${action.fieldKey})` : ''}</div>
                    </div>
                  ))}
                </div>
              )}
              {autoFixPlanDisplay.mockOnlyActions.length > 0 && (
                <div className="space-y-2">
                  <div className="text-sm font-semibold text-ink">{t("mock 流程提示")}</div>
                  {autoFixPlanDisplay.mockOnlyActions.map((action) => (
                    <div key={action.actionId} className="rounded border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
                      <div className="font-semibold">{action.title}</div>
                      <div className="mt-1 text-xs">{action.description}</div>
                    </div>
                  ))}
                </div>
              )}
              {autoFixPlanDisplay.noActionNeededActions.length > 0 && (
                <details className="rounded border border-slate-200 bg-slate-50 p-3 text-sm text-slate-700">
                  <summary className="cursor-pointer font-semibold">{t("无需处理项")}</summary>
                  <ul className="mt-2 list-disc space-y-1 pl-5">
                    {autoFixPlanDisplay.noActionNeededActions.map((action) => <li key={action.actionId}>{action.title}</li>)}
                  </ul>
                </details>
              )}
              <div className="rounded border border-slate-200 bg-slate-50 p-3 text-sm text-slate-700">
                {autoFixPlanDisplay.nextSuggestedAction}
              </div>
            </div>
          )}
        </div>
      </Section>

      <Section
        title={t("修正执行结果")}
        actions={(
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={saveAutoFixExecutionResult}
              disabled={!autoFixExecutionResult?.patchedImagePlans?.length || autoFixExecutionDisplay.persisted || autoFixBusy}
              className="rounded border border-emerald-600 px-3 py-2 text-sm font-medium text-emerald-700 disabled:opacity-60"
            >{t("确认保存文字修正到图片方案")}</button>
            <button
              type="button"
              onClick={exportAutoFixExecutionResult}
              disabled={!autoFixExecutionResult}
              className="rounded border border-slate-300 px-3 py-2 text-sm font-medium text-slate-700 disabled:opacity-60"
            >{t("导出执行结果 JSON")}</button>
          </div>
        )}
      >
        {autoFixExecutionDisplay.emptyText ? (
          <div className="rounded border border-slate-200 bg-slate-50 p-4 text-sm text-slate-600">
            {autoFixExecutionDisplay.emptyText}
          </div>
        ) : (
          <div className="space-y-4">
            {autoFixExecutionDisplay.warnings.length > 0 && (
              <div className="rounded border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
                <ul className="list-disc space-y-1 pl-5">
                  {autoFixExecutionDisplay.warnings.map((warning, index) => <li key={index}>{warning}</li>)}
                </ul>
              </div>
            )}
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              {autoFixExecutionDisplay.summaryCards.map((card) => (
                <div key={card.label} className="rounded border border-slate-200 bg-white p-3">
                  <div className="text-xs text-slate-500">{card.label}</div>
                  <div className="mt-1 text-xl font-semibold text-ink">{card.value}</div>
                </div>
              ))}
            </div>
            <div className="rounded border border-slate-200 bg-slate-50 p-3 text-sm text-slate-700">{t("patchedImagePlan 是否返回：")}{autoFixExecutionDisplay.hasPatchedImagePlans ? t("是") : t("否")}
            </div>
            <div className="rounded border border-slate-200 bg-slate-50 p-3 text-sm text-slate-700">{t("保存状态：")}{autoFixExecutionDisplay.persisted ? t("已保存到图片方案") : t("尚未保存")} / savedImagePlans：{autoFixExecutionDisplay.hasSavedImagePlans ? t("已返回") : t("未返回")}
            </div>
            {(autoFixExecutionDisplay.beforeSnapshot || autoFixExecutionDisplay.afterSnapshot) && (
              <div className="grid gap-3 md:grid-cols-2">
                <div className="rounded border border-slate-200 bg-white p-3 text-sm text-slate-700">
                  <div className="font-semibold text-ink">beforeSnapshot</div>
                  <div className="mt-1 text-xs">{autoFixExecutionDisplay.beforeSnapshot?.imagePlanSummary || '-'}</div>
                  <div className="mt-1 text-xs">{autoFixExecutionDisplay.beforeSnapshot?.textLayoutSummary || '-'}</div>
                </div>
                <div className="rounded border border-slate-200 bg-white p-3 text-sm text-slate-700">
                  <div className="font-semibold text-ink">afterSnapshot</div>
                  <div className="mt-1 text-xs">{autoFixExecutionDisplay.afterSnapshot?.imagePlanSummary || '-'}</div>
                  <div className="mt-1 text-xs">{autoFixExecutionDisplay.afterSnapshot?.textLayoutSummary || '-'}</div>
                </div>
              </div>
            )}
            {autoFixExecutionDisplay.diffRows.length > 0 && (
              <div className="space-y-2">
                <div className="text-sm font-semibold text-ink">{t("diff 列表")}</div>
                {autoFixExecutionDisplay.diffRows.map((row, index) => (
                  <div key={`${row.sourceActionId}-${index}`} className="rounded border border-slate-200 bg-white p-3 text-sm text-slate-700">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="font-semibold">{row.changeType}</div>
                      <span className="rounded bg-slate-100 px-2 py-1 text-xs">{row.targetType} / {row.imageType || '-'}</span>
                    </div>
                    <div className="mt-1 text-xs">{t("原因：")}{row.reason}</div>
                    <div className="mt-2 grid gap-2 md:grid-cols-2">
                      <div className="rounded bg-red-50 p-2 text-red-800">before: {row.before || '-'}</div>
                      <div className="rounded bg-emerald-50 p-2 text-emerald-800">after: {row.after || '-'}</div>
                    </div>
                  </div>
                ))}
              </div>
            )}
            {autoFixExecutionDisplay.blockedActions.length > 0 && (
              <div className="rounded border border-red-200 bg-red-50 p-3 text-sm text-red-800">
                <div className="font-semibold">{t("被阻止动作")}</div>
                <ul className="mt-2 list-disc space-y-1 pl-5">
                  {autoFixExecutionDisplay.blockedActions.map((item) => <li key={item.actionId}>{item.title || item.actionId}：{item.reason}</li>)}
                </ul>
              </div>
            )}
            {autoFixExecutionDisplay.skippedActions.length > 0 && (
              <div className="rounded border border-slate-200 bg-slate-50 p-3 text-sm text-slate-700">
                <div className="font-semibold">{t("跳过动作")}</div>
                <ul className="mt-2 list-disc space-y-1 pl-5">
                  {autoFixExecutionDisplay.skippedActions.map((item) => <li key={item.actionId}>{item.title || item.actionId}：{item.reason}</li>)}
                </ul>
              </div>
            )}
            <div className="rounded border border-blue-200 bg-blue-50 p-3 text-sm text-blue-800">
              {autoFixExecutionDisplay.nextSuggestedAction}
            </div>
            {nextValidationChecklist && (
              <div className="rounded border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-900">
                <div className="font-semibold text-ink">{t("修正后验证步骤")}</div>
                <div className="mt-1 text-xs text-emerald-800">
                  {nextValidationChecklist.statusText}
                </div>
                <div className="mt-3 grid gap-3 md:grid-cols-2">
                  <div className="rounded border border-emerald-100 bg-white p-3">
                    <div className="font-medium">{t("手动检查清单")}</div>
                    <ol className="mt-2 list-decimal space-y-1 pl-5 text-xs">
                      {nextValidationChecklist.manualSteps?.map((step, index) => <li key={`validation-step-${index}`}>{step}</li>)}
                    </ol>
                  </div>
                  <div className="rounded border border-emerald-100 bg-white p-3">
                    <div className="font-medium">{t("期望改善")}</div>
                    {nextValidationChecklist.expectedImprovements?.length ? (
                      <ul className="mt-2 list-disc space-y-1 pl-5 text-xs">
                        {nextValidationChecklist.expectedImprovements.map((item, index) => <li key={`validation-improvement-${index}`}>{item}</li>)}
                      </ul>
                    ) : (
                      <div className="mt-2 text-xs text-slate-500">{t("当前尚未保存文字修正，保存后再复查生成图和审核结果。")}</div>
                    )}
                  </div>
                </div>
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <span className="rounded bg-white px-2 py-1 text-xs">{t("需重新生成 mock：")}{postFixStatus?.needsRegenerateMock ? t("是") : t("否")}
                  </span>
                  <span className="rounded bg-white px-2 py-1 text-xs">{t("需再次执行审核：")}{postFixStatus?.needsReviewAgain ? t("是") : t("否")}
                  </span>
                  <span className="rounded bg-white px-2 py-1 text-xs">{t("生成接口触发：")}{postFixStatus?.autoRegenerateTriggered ? t("已触发") : t("未触发")}
                  </span>
                  <span className="rounded bg-white px-2 py-1 text-xs">{t("审核接口触发：")}{postFixStatus?.autoReviewTriggered ? t("已触发") : t("未触发")}
                  </span>
                </div>
                {postFixStatus?.needsRegenerateMock && (
                  <div className="mt-3 flex flex-wrap gap-2">
                    <button
                      type="button"
                      onClick={() => navigate(`/tasks/${taskId}/generate`)}
                      className="rounded bg-emerald-700 px-3 py-2 text-sm font-medium text-white"
                    >{t("前往重新生成 mock 图片")}</button>
                    <button
                      type="button"
                      onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })}
                      className="rounded border border-emerald-300 bg-white px-3 py-2 text-sm font-medium text-emerald-800"
                    >{t("再次执行审核前先查看顶部审核按钮")}</button>
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </Section>

      {task.review && (
        <Section
          title={t("审核结果")}
          actions={<StatusBadge status={task.review.overallStatus === 'passed' ? 'review_passed' : 'review_failed'} />}
        >
          <div className="grid gap-4">
            {reviewDisplayItems.map((entry) => {
              if (entry.kind === 'group') {
                const summary = entry.items.reduce((counts, item) => {
                  if (item.status === 'passed') counts.passCount += 1;
                  else counts.failCount += 1;
                  if (item.riskLevel === 'high') counts.highRiskCount += 1;
                  else if (item.riskLevel === 'medium') counts.mediumRiskCount += 1;
                  else counts.lowRiskCount += 1;
                  return counts;
                }, { passCount: 0, failCount: 0, highRiskCount: 0, mediumRiskCount: 0, lowRiskCount: 0 });
                return (
                  <div key={`group-${entry.key}`} className="rounded border border-slate-200 bg-slate-50 p-4">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div>
                        <div className="font-semibold text-ink">{targetDisplayLabel(entry.target)}</div>
                        <div className="mt-1 text-sm text-slate-500">{t("通过：")}{summary.passCount}{" " + t("/ 失败：")}{summary.failCount}{" " + t("/ 高风险：")}{summary.highRiskCount}{" " + t("/ 中风险：")}{summary.mediumRiskCount}{" " + t("/ 低风险：")}{summary.lowRiskCount}
                        </div>
                      </div>
                      <span className="rounded border border-slate-200 bg-white px-2 py-1 text-xs text-slate-500">
                        targetId: {entry.target.id || entry.target.targetId || '-'}
                      </span>
                    </div>
                  </div>
                );
              }
              const item = entry.item;
              const image = generatedById[item.imageId] || {};
              const sourceStatus = getImageSourceStatus({ ...image, ...item });
              const preserveMessage = preserveReviewMessage({ ...image, ...item });
              const platformRuleSnapshot = ruleSnapshotForItem(item, image);
              const categoryRuleSnapshot = categorySnapshotForItem(item, image);
              const { mockPreviewIssues, complianceIssues } = splitMockPreviewIssues(item.issues || []);
              return (
                <div key={item.imageId} className="rounded border border-slate-200 p-4">
                  <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <div className="font-semibold text-ink">{item.fileName}</div>
                      <div className="mt-1 text-xs text-slate-500">{t("审核来源：")}{item.isRealReview ? 'real review' : item.fallbackToMockReview ? 'fallback mock review' : 'mock review'} / {item.provider}/{item.model}{" " + t("/ 风险：")}{item.riskLevel}
                      </div>
                      <div className={`mt-1 inline-flex rounded border px-2 py-1 text-xs ${sourceStatus.className}`}>
                        {sourceStatus.label} · {sourceStatus.description}
                      </div>
                      {item.stale && (
                        <div className="mt-1 text-xs text-red-700">{t("该审核结果已过期：图片已重新生成，建议重新审核。")}</div>
                      )}
                    </div>
                    <span className={`rounded px-2 py-1 text-xs font-semibold ${item.status === 'passed' ? 'bg-emerald-100 text-emerald-800' : 'bg-red-100 text-red-800'}`}>
                      {statusLabelMap[item.status] ? t(statusLabelMap[item.status]) : item.status}
                    </span>
                  </div>
                  <div className="grid gap-2 md:grid-cols-3">
                    {Object.entries(item.checks || {}).map(([key, check]) => (
                      <div key={key} className="flex items-center justify-between rounded bg-slate-50 px-3 py-2 text-sm">
                        <span className="text-slate-600">{checkLabelMap[key] ? t(checkLabelMap[key]) : check.label}</span>
                        <span className={check.status === 'passed' ? 'font-semibold text-emerald-700' : 'font-semibold text-red-700'}>
                          {statusLabelMap[check.status] ? t(statusLabelMap[check.status]) : check.status}
                        </span>
                      </div>
                    ))}
                  </div>
                  <PlatformRuleSummary snapshot={platformRuleSnapshot} />
                  <CategoryRuleSummary snapshot={categoryRuleSnapshot} />
                  {mockPreviewIssues.length > 0 && (
                    <div className="mt-3 rounded border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
                      <div className="mb-1 font-semibold">{t("mock 预览提示")}</div>
                      <div className="mb-1 text-xs">{t("这些提示来自 mock 预览图，不等同于真实图片违规。")}</div>
                      <ul className="list-disc space-y-1 pl-5">
                        {mockPreviewIssues.map((issue, issueIndex) => <li key={`mock-${issueIndex}`}>{issueText(issue)}</li>)}
                      </ul>
                    </div>
                  )}
                  {complianceIssues.length > 0 && (
                    <div className="mt-3 space-y-2">
                      {Object.entries(groupedIssues(complianceIssues)).map(([group, issues]) => (
                        <div key={group} className="rounded border border-red-200 bg-red-50 p-3 text-sm text-red-700">
                          <div className="mb-1 font-semibold">{t(group)}</div>
                          <ul className="list-disc space-y-1 pl-5">
                            {issues.map((issue, issueIndex) => <li key={`${group}-${issueIndex}`}>{issueText(issue)}</li>)}
                          </ul>
                        </div>
                      ))}
                    </div>
                  )}
                  {item.fixSuggestions?.length > 0 && (
                    <div className="mt-3 rounded border border-blue-200 bg-blue-50 p-3 text-sm text-blue-800">
                      <div className="font-semibold">{t("修复建议")}</div>
                      <ul className="mt-1 list-disc pl-5">
                        {item.fixSuggestions.slice(0, 5).map((suggestion, index) => <li key={index}>{suggestion}</li>)}
                      </ul>
                    </div>
                  )}
                  {item.fallbackToMockReview && (
                    <div className="mt-3 rounded border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">{t("真实审核失败，已回退 mock review：")}{item.realReviewError?.code || 'UNKNOWN'} / {item.realReviewError?.message || ''}
                    </div>
                  )}
                  {preserveMessage && (
                    <div className="mt-3 rounded border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
                      {t(preserveMessage)}
                    </div>
                  )}
                  {(image.productReferenceSelectedBy === 'user' || item.productReferenceSelectedBy === 'user') && (
                    <div className="mt-3 rounded border border-blue-200 bg-blue-50 p-3 text-sm text-blue-800">{t("使用了用户选择的商品参考图。")}</div>
                  )}
                </div>
              );
            })}
          </div>
        </Section>
      )}
      {task.review && (
        <PrimaryButton onClick={() => navigate(`/tasks/${taskId}/export`)}>{t("继续导出图片包")}</PrimaryButton>
      )}
    </div>
  );
}
