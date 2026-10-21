import { useLocale } from '../i18n/LocaleProvider.jsx';
import { approvePaidOperation } from '../utils/paidOperationApproval.js';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useAccount } from '../components/AuthGate.jsx';
import { acceptanceNeedsUnloadWarning, createAcceptanceWorkspace, downloadAcceptanceWorkspace } from '../utils/acceptanceWorkspace.js';
import Section from '../components/Section.jsx';
import { api } from '../services/api.js';
import {
  addFinalAcceptanceIssue,
  applyModuleManualAcceptance,
  applySkuManualAcceptance,
  canRunRealApiAcceptance,
  deleteFinalAcceptanceIssue,
  downloadFinalAcceptanceCsv,
  downloadFinalAcceptanceIssuesCsv,
  downloadFinalAcceptanceJson,
  downloadRealApiAcceptanceJson,
  finalAcceptanceIssueModules,
  finalAcceptanceIssueNotice,
  finalAcceptanceNotice,
  getFinalAcceptanceDisplayModel,
  getRealApiAcceptanceDisplayModel,
  normalizeRealApiAcceptancePayload,
  updateFinalAcceptanceIssue
} from '../utils/finalAcceptance.js';
import { ErrorMessage } from './pageUtils.jsx';

const V62_OPTIONS = { version: 'v6.2-stage2', targetSkuCount: 10, multiBatch: true };
const MANUAL_STATUS_OPTIONS = [
  ['pending', '待验收'],
  ['passed', '人工通过'],
  ['failed', '人工失败'],
  ['blocked', '人工阻断']
];
const ISSUE_SEVERITIES = ['blocker', 'high', 'medium', 'low', 'info'];
const ISSUE_STATUSES = ['open', 'investigating', 'fixed', 'verified', 'wontFix'];

const EMPTY_ISSUE_FORM = {
  title: '',
  description: '',
  relatedSku: '',
  relatedTaskId: '',
  relatedBatchId: '',
  moduleKey: 'finalAcceptance',
  stepKey: '',
  severity: 'medium',
  isBlockingFinalRelease: false,
  status: 'open',
  reproduceSteps: '',
  expectedResult: '',
  actualResult: '',
  suggestedFix: '',
  notes: ''
};

const DEFAULT_REAL_API_FORM = {
  taskId: '',
  enableVision: true,
  imageTypes: ['main_image'],
  enableReview: false,
  maxRealApiCalls: 3,
  provider: 'openai',
  mattingProvider: 'sharp',
  confirmRealApi: false,
  confirmPaidApi: false,
  confirmNoPlatformUpload: false
};

function ManualAcceptanceControls({ value = {}, onChange }) {
  const { t } = useLocale();
  return (
    <div data-acceptance-manual className="flex min-w-[220px] flex-col gap-2">
      <select
        value={value.status || 'pending'}
        onChange={(event) => onChange({ status: event.target.value })}
        className="rounded border border-slate-300 bg-white px-2 py-1 text-xs text-slate-700"
      >
        {MANUAL_STATUS_OPTIONS.map(([status, label]) => (
          <option key={status} value={status}>{t(label)}</option>
        ))}
      </select>
      <input
        value={value.reviewer || ''}
        onChange={(event) => onChange({ reviewer: event.target.value })}
        placeholder={t("验收人")}
        className="rounded border border-slate-300 px-2 py-1 text-xs text-slate-700"
      />
      <input
        value={value.notes || ''}
        onChange={(event) => onChange({ notes: event.target.value })}
        placeholder={t("人工结论 / 备注")}
        className="rounded border border-slate-300 px-2 py-1 text-xs text-slate-700"
      />
    </div>
  );
}

function issuePatchFromForm(form) {
  return {
    ...form,
    reproduceSteps: String(form.reproduceSteps || '')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
  };
}

export default function FinalAcceptancePage() {
  const { t } = useLocale();
  const account = useAccount();
  const actorId = account?.user?.id || 'local';
  const workspaceController = useRef(null);
  const [workspace, setWorkspace] = useState({ status: 'loading', context: null, error: '' });
  const [report, setReport] = useState(null);
  const [realApiReport, setRealApiReport] = useState(null);
  const [realApiForm, setRealApiForm] = useState(DEFAULT_REAL_API_FORM);
  const [issueForm, setIssueForm] = useState(EMPTY_ISSUE_FORM);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const currentDocument = useRef(null);
  currentDocument.current = { report, realApiReport, realApiForm, issueForm };
  const display = useMemo(() => getFinalAcceptanceDisplayModel(report), [report]);
  const realApiDisplay = useMemo(() => getRealApiAcceptanceDisplayModel(realApiReport), [realApiReport]);
  const realApiPayload = useMemo(() => normalizeRealApiAcceptancePayload(realApiForm), [realApiForm]);
  const workspaceEditable = workspace.context?.editable && !['loading', 'blocked', 'conflict'].includes(workspace.status);
  const workspaceLabels = { loading: '正在读取已保存验收报告…', saved: '已保存到当前成员的验收工作区', dirty: '有修改待保存，请等待或点击立即保存', saving: '正在保存验收报告…', error: '保存失败，修改已保留，请重试保存或导出副本', conflict: '报告存在版本或权限冲突，未覆盖服务器记录', blocked: '验收工作区不可读取，请重试或检查备份' };

  useEffect(() => {
    const controller = createAcceptanceWorkspace(api, {
      actorId,
      emptyDocument: { report: null, realApiReport: null, realApiForm: normalizeRealApiAcceptancePayload(DEFAULT_REAL_API_FORM), issueForm: EMPTY_ISSUE_FORM },
      journal: { getItem: key => window.sessionStorage.getItem(key), setItem: (key, value) => window.sessionStorage.setItem(key, value), removeItem: key => window.sessionStorage.removeItem(key) },
      onState: setWorkspace,
      onDocument: document => {
        setReport(document.report); setRealApiReport(document.realApiReport);
        setIssueForm({ ...EMPTY_ISSUE_FORM, ...(document.issueForm || {}) });
        setRealApiForm({ ...DEFAULT_REAL_API_FORM, ...normalizeRealApiAcceptancePayload(document.realApiForm || DEFAULT_REAL_API_FORM), confirmRealApi: false, confirmPaidApi: false, confirmNoPlatformUpload: false });
      }
    });
    workspaceController.current = controller;
    void controller.open();
    return () => { controller.dispose(); if (workspaceController.current === controller) workspaceController.current = null; };
  }, [actorId]);

  useEffect(() => {
    workspaceController.current?.change({ report, realApiReport, realApiForm, issueForm });
  }, [report, realApiReport, realApiForm, issueForm]);

  useEffect(() => {
    const protect = event => {
      if (!acceptanceNeedsUnloadWarning(workspaceController.current?.snapshot(), currentDocument.current)) return;
      event.preventDefault(); event.returnValue = '';
    };
    window.addEventListener('beforeunload', protect);
    return () => window.removeEventListener('beforeunload', protect);
  }, [actorId]);

  async function reloadWorkspace() {
    if (workspace.status !== 'saved' && !window.confirm(t('重新读取将放弃本页未保存修改和暂存请求，请先导出副本。确认继续？'))) return;
    await workspaceController.current?.open({ discardLocal: true });
  }
  async function resetWorkspace() {
    if (!window.confirm(t('重置当前成员的验收工作区？已保存报告和问题记录将移除，业务任务和已导出文件不删除。请先导出副本。'))) return;
    setBusy('workspace-reset');
    try { await workspaceController.current?.reset(); } catch (err) { setError(err.message); } finally { setBusy(''); }
  }

  async function loadTemplate() {
    if (report && !window.confirm(t('替换当前验收报告？未导出的人工结论和问题记录会丢失，请先导出 JSON。'))) return;
    setBusy('template');
    setError('');
    try {
      setReport(await api.getFinalAcceptanceTemplate(V62_OPTIONS));
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy('');
    }
  }

  async function loadPrefilledReport() {
    if (report && !window.confirm(t('替换当前验收报告？未导出的人工结论和问题记录会丢失，请先导出 JSON。'))) return;
    setBusy('report');
    setError('');
    try {
      setReport(await api.getFinalAcceptanceReport(V62_OPTIONS));
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy('');
    }
  }

  function exportJson() {
    if (report) downloadFinalAcceptanceJson({ report });
  }

  function exportCsv() {
    if (report) downloadFinalAcceptanceCsv({ report });
  }

  function exportIssuesCsv() {
    if (report) downloadFinalAcceptanceIssuesCsv({ report });
  }

  function patchRealApiForm(patch) {
    setRealApiForm((current) => normalizeRealApiAcceptancePayload({ ...current, ...patch }));
  }

  function toggleRealApiImageType(imageType) {
    setRealApiForm((current) => {
      const currentTypes = Array.isArray(current.imageTypes) ? current.imageTypes : [];
      const imageTypes = currentTypes.includes(imageType)
        ? currentTypes.filter((item) => item !== imageType)
        : [...currentTypes, imageType];
      return normalizeRealApiAcceptancePayload({ ...current, imageTypes });
    });
  }

  async function runRealApiAcceptance() {
    if (!canRunRealApiAcceptance(realApiForm)) return;
    setBusy('real-api');
    setError('');
    try {
      if (!await approvePaidOperation(api, { kinds: ['image', ...(realApiForm.enableVision ? ['vision'] : []), ...(realApiForm.enableReview ? ['review'] : [])], target: realApiForm.taskId, count: realApiForm.maxRealApiCalls }, t, (message) => window.confirm(message))) return;
      const response = await api.runRealApiAcceptance(realApiPayload);
      setRealApiReport(response.report || response);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy('');
    }
  }

  function exportRealApiJson() {
    if (realApiReport) downloadRealApiAcceptanceJson({ report: realApiReport });
  }

  function updateSkuManualAcceptance(skuOrTaskId, patch) {
    setReport((current) => applySkuManualAcceptance(current, skuOrTaskId, patch));
  }

  function updateModuleManualAcceptance(moduleKey, patch) {
    setReport((current) => applyModuleManualAcceptance(current, moduleKey, patch));
  }

  function addIssueLog() {
    if (!report) return;
    setReport((current) => addFinalAcceptanceIssue(current, issuePatchFromForm(issueForm)));
    setIssueForm(EMPTY_ISSUE_FORM);
  }

  function updateIssue(issueId, patch) {
    setReport((current) => updateFinalAcceptanceIssue(current, issueId, patch));
  }

  function deleteIssue(issueId) {
    if (!window.confirm(t('删除当前报告中的这条问题记录？未导出的记录无法在本页恢复。'))) return;
    setReport((current) => deleteFinalAcceptanceIssue(current, issueId));
  }

  return (
    <div className="space-y-6">
      <div>
        <p className="text-sm font-semibold text-mint">v6.3 issue log</p>
        <h1 className="text-2xl font-bold text-ink">{t("最终验收")}</h1>
        <p className="mt-2 max-w-4xl text-sm text-slate-600">{t(finalAcceptanceNotice)}</p>
      </div>

      {error && <ErrorMessage error={error} />}

      <Section title={t('验收报告保存与恢复')}>
        <p role="status" data-acceptance-workspace-status={workspace.status} className="text-sm text-slate-700">{t(workspaceLabels[workspace.status] || workspace.status)}</p>
        {workspace.error && <p role="alert" className="mt-2 text-sm text-red-700">{workspace.error}</p>}
        {workspace.context && <p className="mt-2 text-xs text-slate-500">{t('保存版本：')}{workspace.context.revision} · {workspace.context.editable ? t('仅当前成员可读写；管理员也不自动读取其他成员报告') : t('当前角色只读，不能保存或重置报告')}</p>}
        {workspace.journalUnavailable && <p className="mt-2 text-sm text-amber-800">{t('浏览器暂存不可用，请等待服务端保存成功再刷新；失败时先导出副本。')}</p>}
        <p className="mt-2 text-xs text-slate-500">{t('报告、人工结论、问题及表单自动保存；真实 API 的三项确认不保存，恢复后必须重新确认。已保存不等于已完成实站验收。')}</p>
        <div className="mt-3 flex flex-wrap gap-2">
          <button data-acceptance-save type="button" disabled={Boolean(busy) || !workspace.context?.editable || ['loading', 'saving', 'blocked', 'conflict'].includes(workspace.status)} onClick={() => workspaceController.current?.flush()} className="btn-secondary">{t('立即保存 / 重试保存')}</button>
          <button data-acceptance-reload type="button" disabled={Boolean(busy) || ['loading', 'saving'].includes(workspace.status)} onClick={reloadWorkspace} className="btn-secondary">{t('重新读取已保存报告')}</button>
          <button data-acceptance-workspace-export type="button" disabled={workspace.status === 'loading' || workspace.context?.unavailable || workspace.context?.corrupt} onClick={() => downloadAcceptanceWorkspace({ report, realApiReport, realApiForm, issueForm })} className="btn-secondary">{t('导出工作区副本')}</button>
          <button data-acceptance-reset type="button" disabled={Boolean(busy) || !workspace.context?.editable || ['loading', 'saving', 'conflict'].includes(workspace.status)} onClick={resetWorkspace} className="btn-secondary">{t('重置验收工作区')}</button>
        </div>
      </Section>

      <fieldset disabled={!workspaceEditable || Boolean(busy)} className="min-w-0 space-y-6">

      <Section title={t("验收操作")}>
        <div className="flex flex-wrap gap-2">
          <button type="button" data-acceptance-template disabled={Boolean(busy)} onClick={loadTemplate} className="rounded border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 disabled:opacity-60">{t("生成 10 SKU 验收模板")}</button>
          <button type="button" disabled={Boolean(busy)} onClick={loadPrefilledReport} className="rounded border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 disabled:opacity-60">{t("预填 10 SKU 多批次验收报告")}</button>
          <button type="button" data-acceptance-json disabled={!report || Boolean(busy)} onClick={exportJson} className="rounded bg-ink px-3 py-2 text-sm font-semibold text-white disabled:opacity-60">{t("导出 JSON")}</button>
          <button type="button" disabled={!report || Boolean(busy)} onClick={exportCsv} className="rounded bg-ink px-3 py-2 text-sm font-semibold text-white disabled:opacity-60">{t("导出 CSV")}</button>
          <button type="button" disabled={!report || Boolean(busy)} onClick={exportIssuesCsv} className="rounded bg-ink px-3 py-2 text-sm font-semibold text-white disabled:opacity-60">{t("导出问题 CSV")}</button>
        </div>
        <div className="mt-3 rounded border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
          {t(display.emptyText || display.notice)}
        </div>
      </Section>

      <Section title={t("1 SKU 真实 API 验收")}>
        <div className="rounded border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">{t('单 SKU 真实验收仅供人工检查：最多 3 项工作流操作，不是计费请求次数上限；内部重试和抠图预处理可能增加调用与费用。不会上传平台或写入任务数据库。')}</div>
        <div className="mt-4 grid gap-3 md:grid-cols-3">
          <input
            value={realApiForm.taskId}
            onChange={(event) => patchRealApiForm({ taskId: event.target.value })}
            placeholder={t("当前 SKU taskId")}
            className="rounded border border-slate-300 px-3 py-2 text-sm"
          />
          <input
            type="number"
            min="1"
            max="3"
            value={realApiPayload.maxRealApiCalls}
            onChange={(event) => patchRealApiForm({ maxRealApiCalls: event.target.value })}
            className="rounded border border-slate-300 px-3 py-2 text-sm"
          />
          <select
            value={realApiForm.provider || 'openai'}
            onChange={(event) => patchRealApiForm({ provider: event.target.value })}
            className="rounded border border-slate-300 bg-white px-3 py-2 text-sm"
          >
            <option value="openai">openai</option>
            <option value="qwen">qwen</option>
            <option value="gemini">gemini</option>
          </select>
        </div>
        <div className="mt-3 flex flex-wrap gap-3 text-sm text-slate-700">
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={realApiForm.enableVision !== false} onChange={(event) => patchRealApiForm({ enableVision: event.target.checked })} />{t("真实识别")}</label>
          {['main_image', 'feature_image', 'detail_image'].map((imageType) => (
            <label key={imageType} className="flex items-center gap-2">
              <input type="checkbox" checked={realApiPayload.imageTypes.includes(imageType)} onChange={() => toggleRealApiImageType(imageType)} />
              {imageType}
            </label>
          ))}
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={realApiPayload.enableReview} onChange={(event) => patchRealApiForm({ enableReview: event.target.checked })} />{t("真实审核（可选）")}</label>
        </div>
        <div className="mt-3 grid gap-2 text-sm text-slate-700 md:grid-cols-3">
          <label className="flex items-center gap-2 rounded border border-slate-200 px-3 py-2">
            <input data-acceptance-approval="real" type="checkbox" checked={realApiForm.confirmRealApi} onChange={(event) => patchRealApiForm({ confirmRealApi: event.target.checked })} />{t("我确认这是 1 SKU 真实 API 小样本验收")}</label>
          <label className="flex items-center gap-2 rounded border border-slate-200 px-3 py-2">
            <input data-acceptance-approval="paid" type="checkbox" checked={realApiForm.confirmPaidApi} onChange={(event) => patchRealApiForm({ confirmPaidApi: event.target.checked })} />{t("我接受可能产生的 API 成本")}</label>
          <label className="flex items-center gap-2 rounded border border-slate-200 px-3 py-2">
            <input data-acceptance-approval="no-upload" type="checkbox" checked={realApiForm.confirmNoPlatformUpload} onChange={(event) => patchRealApiForm({ confirmNoPlatformUpload: event.target.checked })} />{t("我确认不会上传平台")}</label>
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          <button type="button" disabled={!canRunRealApiAcceptance(realApiForm) || Boolean(busy)} onClick={runRealApiAcceptance} className="rounded bg-ink px-3 py-2 text-sm font-semibold text-white disabled:opacity-60">{t("运行 1 SKU 真实 API 验收")}</button>
          <button type="button" disabled={!realApiReport || Boolean(busy)} onClick={exportRealApiJson} className="rounded border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 disabled:opacity-60">{t("导出 real-api-acceptance-report JSON")}</button>
        </div>
        {realApiDisplay.emptyText ? (
          <div className="mt-3 rounded border border-slate-200 bg-white p-3 text-sm text-slate-600">{t(realApiDisplay.emptyText)}</div>
        ) : (
          <div className="mt-4 space-y-3">
            <div className="grid gap-3 md:grid-cols-7">
              {realApiDisplay.summaryCards.map((card) => (
                <div key={card.label} className="rounded border border-slate-200 bg-white p-3">
                  <div className="text-xs text-slate-500">{t(card.label)}</div>
                  <div className="mt-1 text-lg font-semibold text-ink">{card.value}</div>
                </div>
              ))}
            </div>
            <div className="rounded border border-slate-200 bg-white p-3 text-xs text-slate-700">
              <div className="font-semibold text-ink">{t("API 调用记录")}</div>
              {realApiDisplay.apiCallRows.length ? realApiDisplay.apiCallRows.map((call, index) => (
                <div key={`${call.apiType}-${index}`} className="mt-1">
                  {call.apiType} / {call.provider} / {call.model || '-'} / {call.durationMs || 0}ms / fallback: {String(Boolean(call.fallbackUsed))}
                </div>
              )) : <div className="mt-1">{t("暂无调用记录")}</div>}
            </div>
            <div className="rounded border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
              {realApiDisplay.warningText || realApiDisplay.nextSuggestedAction || t("请人工检查真实生成图片质量。")}
            </div>
          </div>
        )}
      </Section>

      {!display.emptyText && (
        <>
          <Section title={t("总览")}>
            <div className="grid gap-3 md:grid-cols-7">
              {display.summaryCards.map((card) => (
                <div key={card.label} className="rounded border border-slate-200 bg-white p-3">
                  <div className="text-xs text-slate-500">{t(card.label)}</div>
                  <div className="mt-1 text-lg font-semibold text-ink">{card.value}</div>
                </div>
              ))}
            </div>
            <div className="mt-4 grid gap-3 md:grid-cols-3">
              <div className="rounded border border-red-200 bg-red-50 p-3 text-xs text-red-800">
                <div className="mb-1 font-semibold">{t("阻断问题")}</div>
                {display.blockingText || display.issueBlockingText || t("暂无")}
              </div>
              <div className="rounded border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800">
                <div className="mb-1 font-semibold">{t("提醒")}</div>
                {display.warningText || t("暂无")}
              </div>
              <div className="rounded border border-blue-200 bg-blue-50 p-3 text-xs text-blue-800">
                <div className="mb-1 font-semibold">{t("建议")}</div>
                {display.recommendationText || display.nextSuggestedAction || t("暂无")}
              </div>
            </div>
          </Section>

          <Section title={t("验收问题记录 Issue Log")}>
            <div className="rounded border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
              {t(finalAcceptanceIssueNotice)}
            </div>
            <div className="mt-3 grid gap-3 md:grid-cols-7">
              {display.issueSummaryCards.map((card) => (
                <div key={card.label} className="rounded border border-slate-200 bg-white p-3">
                  <div className="text-xs text-slate-500">{t(card.label)}</div>
                  <div className="mt-1 text-lg font-semibold text-ink">{card.value}</div>
                </div>
              ))}
            </div>
            {display.issueBlockingText && (
              <div className="mt-3 rounded border border-red-200 bg-red-50 p-3 text-sm font-medium text-red-800">{t("存在 open blocker 问题，报告不会显示为 passed。")}</div>
            )}

            <div className="mt-4 grid gap-3 md:grid-cols-2">
              <input className="rounded border border-slate-300 px-3 py-2 text-sm" placeholder={t("问题标题")} value={issueForm.title} onChange={(event) => setIssueForm({ ...issueForm, title: event.target.value })} />
              <input className="rounded border border-slate-300 px-3 py-2 text-sm" placeholder={t("关联 SKU")} value={issueForm.relatedSku} onChange={(event) => setIssueForm({ ...issueForm, relatedSku: event.target.value })} />
              <input className="rounded border border-slate-300 px-3 py-2 text-sm" placeholder={t("关联 taskId")} value={issueForm.relatedTaskId} onChange={(event) => setIssueForm({ ...issueForm, relatedTaskId: event.target.value })} />
              <input className="rounded border border-slate-300 px-3 py-2 text-sm" placeholder={t("关联 batchId")} value={issueForm.relatedBatchId} onChange={(event) => setIssueForm({ ...issueForm, relatedBatchId: event.target.value })} />
              <select className="rounded border border-slate-300 bg-white px-3 py-2 text-sm" value={issueForm.moduleKey} onChange={(event) => setIssueForm({ ...issueForm, moduleKey: event.target.value })}>
                {finalAcceptanceIssueModules.map((moduleKey) => <option key={moduleKey} value={moduleKey}>{moduleKey}</option>)}
              </select>
              <input className="rounded border border-slate-300 px-3 py-2 text-sm" placeholder={t("关联步骤 stepKey")} value={issueForm.stepKey} onChange={(event) => setIssueForm({ ...issueForm, stepKey: event.target.value })} />
              <select className="rounded border border-slate-300 bg-white px-3 py-2 text-sm" value={issueForm.severity} onChange={(event) => setIssueForm({ ...issueForm, severity: event.target.value })}>
                {ISSUE_SEVERITIES.map((severity) => <option key={severity} value={severity}>{severity}</option>)}
              </select>
              <select className="rounded border border-slate-300 bg-white px-3 py-2 text-sm" value={issueForm.status} onChange={(event) => setIssueForm({ ...issueForm, status: event.target.value })}>
                {ISSUE_STATUSES.map((status) => <option key={status} value={status}>{status}</option>)}
              </select>
              <label className="flex items-center gap-2 rounded border border-slate-300 px-3 py-2 text-sm text-slate-700">
                <input type="checkbox" checked={issueForm.isBlockingFinalRelease} onChange={(event) => setIssueForm({ ...issueForm, isBlockingFinalRelease: event.target.checked })} />{t("阻断最终版")}</label>
              <textarea className="md:col-span-2 rounded border border-slate-300 px-3 py-2 text-sm" placeholder={t("问题描述")} value={issueForm.description} onChange={(event) => setIssueForm({ ...issueForm, description: event.target.value })} />
              <textarea className="rounded border border-slate-300 px-3 py-2 text-sm" placeholder={t("复现步骤，每行一步")} value={issueForm.reproduceSteps} onChange={(event) => setIssueForm({ ...issueForm, reproduceSteps: event.target.value })} />
              <textarea className="rounded border border-slate-300 px-3 py-2 text-sm" placeholder={t("期望结果")} value={issueForm.expectedResult} onChange={(event) => setIssueForm({ ...issueForm, expectedResult: event.target.value })} />
              <textarea className="rounded border border-slate-300 px-3 py-2 text-sm" placeholder={t("实际结果")} value={issueForm.actualResult} onChange={(event) => setIssueForm({ ...issueForm, actualResult: event.target.value })} />
              <textarea className="rounded border border-slate-300 px-3 py-2 text-sm" placeholder={t("处理建议 / 备注")} value={issueForm.suggestedFix} onChange={(event) => setIssueForm({ ...issueForm, suggestedFix: event.target.value })} />
            </div>
            <button type="button" disabled={!report || !issueForm.title.trim()} onClick={addIssueLog} className="mt-3 rounded bg-ink px-3 py-2 text-sm font-semibold text-white disabled:opacity-60">{t("新增问题")}</button>

            <div className="mt-4 space-y-3">
              {display.issueRows.length ? display.issueRows.map((issue) => (
                <div key={issue.issueId} className="rounded border border-slate-200 bg-white p-3 text-sm">
                  <div className="flex flex-wrap items-center gap-2">
                    <input className="min-w-[220px] flex-1 rounded border border-slate-300 px-2 py-1 text-sm font-semibold text-ink" value={issue.title} onChange={(event) => updateIssue(issue.issueId, { title: event.target.value })} />
                    <select className="rounded border border-slate-300 bg-white px-2 py-1 text-sm" value={issue.severity} onChange={(event) => updateIssue(issue.issueId, { severity: event.target.value })}>
                      {ISSUE_SEVERITIES.map((severity) => <option key={severity} value={severity}>{severity}</option>)}
                    </select>
                    <select className="rounded border border-slate-300 bg-white px-2 py-1 text-sm" value={issue.status} onChange={(event) => updateIssue(issue.issueId, { status: event.target.value })}>
                      {ISSUE_STATUSES.map((status) => <option key={status} value={status}>{status}</option>)}
                    </select>
                    <label className="flex items-center gap-1 text-xs text-slate-700">
                      <input type="checkbox" checked={issue.isBlockingFinalRelease} onChange={(event) => updateIssue(issue.issueId, { isBlockingFinalRelease: event.target.checked })} />{t("阻断最终版")}</label>
                    <button type="button" data-acceptance-delete onClick={() => deleteIssue(issue.issueId)} className="rounded border border-red-300 px-2 py-1 text-xs font-medium text-red-700">{t("删除")}</button>
                  </div>
                  <div className="mt-2 grid gap-2 md:grid-cols-3">
                    <input className="rounded border border-slate-300 px-2 py-1 text-xs" value={issue.relatedSku} placeholder="SKU" onChange={(event) => updateIssue(issue.issueId, { relatedSku: event.target.value })} />
                    <select className="rounded border border-slate-300 bg-white px-2 py-1 text-xs" value={issue.moduleKey} onChange={(event) => updateIssue(issue.issueId, { moduleKey: event.target.value })}>
                      {finalAcceptanceIssueModules.map((moduleKey) => <option key={moduleKey} value={moduleKey}>{moduleKey}</option>)}
                    </select>
                    <input className="rounded border border-slate-300 px-2 py-1 text-xs" value={issue.stepKey} placeholder="stepKey" onChange={(event) => updateIssue(issue.issueId, { stepKey: event.target.value })} />
                  </div>
                  <textarea className="mt-2 w-full rounded border border-slate-300 px-2 py-1 text-xs" value={issue.description} placeholder={t("问题描述")} onChange={(event) => updateIssue(issue.issueId, { description: event.target.value })} />
                </div>
              )) : (
                <div className="rounded border border-slate-200 bg-white p-3 text-sm text-slate-600">{t("暂无问题记录。")}</div>
              )}
            </div>
          </Section>

          <Section title={t("多批次验收概览")}>
            {display.batchRows.length ? (
              <div className="grid gap-3 md:grid-cols-2">
                {display.batchRows.map((row) => (
                  <div key={row.batchId} className="rounded border border-slate-200 bg-white p-3 text-sm">
                    <div className="font-semibold text-ink">{row.batchName || row.batchId}</div>
                    <div className="mt-1 text-xs text-slate-500">{row.batchId}</div>
                    <div className="mt-2 text-xs text-slate-700">
                      SKU: {row.skuCount || 0} / passed: {row.passedSku || 0} / pending: {row.pendingSku || 0} / blocked: {row.blockedSku || 0}
                    </div>
                    <div className="mt-1 text-xs text-slate-700">{t("状态：")}{row.status || 'pending'}</div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="rounded border border-slate-200 bg-white p-3 text-sm text-slate-600">{t("暂无多批次数据，可先生成模板或预填报告。")}</div>
            )}
          </Section>

          <Section title={t("10 SKU 验收表")}>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[1200px] border-collapse text-xs">
                <thead>
                  <tr className="border-b border-slate-200 text-left text-slate-500">
                    <th className="py-2 pr-3">SKU</th>
                    <th className="py-2 pr-3">{t("商品名")}</th>
                    <th className="py-2 pr-3">{t("素材")}</th>
                    <th className="py-2 pr-3">{t("自动状态")}</th>
                    <th className="py-2 pr-3">{t("步骤状态")}</th>
                    <th className="py-2 pr-3">{t("风险摘要")}</th>
                    <th className="py-2 pr-3">{t("下一步")}</th>
                    <th className="py-2 pr-3">{t("人工结论")}</th>
                  </tr>
                </thead>
                <tbody>
                  {display.skuRows.map((row, index) => (
                    <tr key={`${row.sku}-${index}`} className="border-b border-slate-100 align-top">
                      <td className="py-2 pr-3 font-medium text-ink">{row.sku}</td>
                      <td className="py-2 pr-3 text-slate-700">{row.productName || '-'}</td>
                      <td className="py-2 pr-3 text-slate-700">{row.testAssetStatus}</td>
                      <td className="py-2 pr-3 text-slate-700">{row.overallStatus}</td>
                      <td className="py-2 pr-3 text-slate-600">{row.stepSummary}</td>
                      <td className="py-2 pr-3 text-slate-600">{row.riskText}</td>
                      <td className="py-2 pr-3 text-slate-600">{row.nextSuggestedAction || '-'}</td>
                      <td className="py-2 pr-3">
                        <ManualAcceptanceControls value={row.manualAcceptance} onChange={(patch) => updateSkuManualAcceptance(row.sku || row.taskId, patch)} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Section>

          <Section title={t("模块验收表")}>
            <div className="grid gap-3 md:grid-cols-3">
              {display.moduleRows.map((row) => (
                <div key={row.moduleKey} className="rounded border border-slate-200 bg-white p-3 text-sm">
                  <div className="font-semibold text-ink">{row.moduleName}</div>
                  <div className="mt-1 text-xs text-slate-500">{row.moduleKey}</div>
                  <div className="mt-2 text-xs text-slate-700">{t("状态：")}{row.status}</div>
                  <div className="mt-1 text-xs text-slate-600">issues：{Array.isArray(row.issues) && row.issues.length ? row.issues.join(' / ') : t("暂无")}</div>
                  <div className="mt-1 text-xs text-slate-600">notes：{row.notes || '-'}</div>
                  <div className="mt-3">
                    <ManualAcceptanceControls value={row.manualAcceptance} onChange={(patch) => updateModuleManualAcceptance(row.moduleKey, patch)} />
                  </div>
                </div>
              ))}
            </div>
          </Section>
        </>
      )}
      </fieldset>
    </div>
  );
}
