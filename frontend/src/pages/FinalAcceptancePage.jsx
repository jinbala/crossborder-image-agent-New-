import { useMemo, useState } from 'react';
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
  return (
    <div className="flex min-w-[220px] flex-col gap-2">
      <select
        value={value.status || 'pending'}
        onChange={(event) => onChange({ status: event.target.value })}
        className="rounded border border-slate-300 bg-white px-2 py-1 text-xs text-slate-700"
      >
        {MANUAL_STATUS_OPTIONS.map(([status, label]) => (
          <option key={status} value={status}>{label}</option>
        ))}
      </select>
      <input
        value={value.reviewer || ''}
        onChange={(event) => onChange({ reviewer: event.target.value })}
        placeholder="验收人"
        className="rounded border border-slate-300 px-2 py-1 text-xs text-slate-700"
      />
      <input
        value={value.notes || ''}
        onChange={(event) => onChange({ notes: event.target.value })}
        placeholder="人工结论 / 备注"
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
  const [report, setReport] = useState(null);
  const [realApiReport, setRealApiReport] = useState(null);
  const [realApiForm, setRealApiForm] = useState(DEFAULT_REAL_API_FORM);
  const [issueForm, setIssueForm] = useState(EMPTY_ISSUE_FORM);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const display = useMemo(() => getFinalAcceptanceDisplayModel(report), [report]);
  const realApiDisplay = useMemo(() => getRealApiAcceptanceDisplayModel(realApiReport), [realApiReport]);
  const realApiPayload = useMemo(() => normalizeRealApiAcceptancePayload(realApiForm), [realApiForm]);

  async function loadTemplate() {
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
    setReport((current) => deleteFinalAcceptanceIssue(current, issueId));
  }

  return (
    <div className="space-y-6">
      <div>
        <p className="text-sm font-semibold text-mint">v6.3 issue log</p>
        <h1 className="text-2xl font-bold text-ink">最终验收</h1>
        <p className="mt-2 max-w-4xl text-sm text-slate-600">{finalAcceptanceNotice}</p>
      </div>

      {error && <ErrorMessage message={error} />}

      <Section title="验收操作">
        <div className="flex flex-wrap gap-2">
          <button type="button" disabled={Boolean(busy)} onClick={loadTemplate} className="rounded border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 disabled:opacity-60">
            生成 10 SKU 验收模板
          </button>
          <button type="button" disabled={Boolean(busy)} onClick={loadPrefilledReport} className="rounded border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 disabled:opacity-60">
            预填 10 SKU 多批次验收报告
          </button>
          <button type="button" disabled={!report || Boolean(busy)} onClick={exportJson} className="rounded bg-ink px-3 py-2 text-sm font-semibold text-white disabled:opacity-60">
            导出 JSON
          </button>
          <button type="button" disabled={!report || Boolean(busy)} onClick={exportCsv} className="rounded bg-ink px-3 py-2 text-sm font-semibold text-white disabled:opacity-60">
            导出 CSV
          </button>
          <button type="button" disabled={!report || Boolean(busy)} onClick={exportIssuesCsv} className="rounded bg-ink px-3 py-2 text-sm font-semibold text-white disabled:opacity-60">
            导出问题 CSV
          </button>
        </div>
        <div className="mt-3 rounded border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
          {display.emptyText || display.notice}
        </div>
      </Section>

      <Section title="1 SKU 真实 API 验收">
        <div className="rounded border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
          单 SKU 小样本真实 API 验收只用于人工检查：最多 3 次真实 API 调用，可能产生 API 成本，不会上传平台，不会写入数据库。
        </div>
        <div className="mt-4 grid gap-3 md:grid-cols-3">
          <input
            value={realApiForm.taskId}
            onChange={(event) => patchRealApiForm({ taskId: event.target.value })}
            placeholder="当前 SKU taskId"
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
            <input type="checkbox" checked={realApiForm.enableVision !== false} onChange={(event) => patchRealApiForm({ enableVision: event.target.checked })} />
            真实识别
          </label>
          {['main_image', 'feature_image', 'detail_image'].map((imageType) => (
            <label key={imageType} className="flex items-center gap-2">
              <input type="checkbox" checked={realApiPayload.imageTypes.includes(imageType)} onChange={() => toggleRealApiImageType(imageType)} />
              {imageType}
            </label>
          ))}
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={realApiPayload.enableReview} onChange={(event) => patchRealApiForm({ enableReview: event.target.checked })} />
            真实审核（可选）
          </label>
        </div>
        <div className="mt-3 grid gap-2 text-sm text-slate-700 md:grid-cols-3">
          <label className="flex items-center gap-2 rounded border border-slate-200 px-3 py-2">
            <input type="checkbox" checked={realApiForm.confirmRealApi} onChange={(event) => patchRealApiForm({ confirmRealApi: event.target.checked })} />
            我确认这是 1 SKU 真实 API 小样本验收
          </label>
          <label className="flex items-center gap-2 rounded border border-slate-200 px-3 py-2">
            <input type="checkbox" checked={realApiForm.confirmPaidApi} onChange={(event) => patchRealApiForm({ confirmPaidApi: event.target.checked })} />
            我接受可能产生的 API 成本
          </label>
          <label className="flex items-center gap-2 rounded border border-slate-200 px-3 py-2">
            <input type="checkbox" checked={realApiForm.confirmNoPlatformUpload} onChange={(event) => patchRealApiForm({ confirmNoPlatformUpload: event.target.checked })} />
            我确认不会上传平台
          </label>
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          <button type="button" disabled={!canRunRealApiAcceptance(realApiForm) || Boolean(busy)} onClick={runRealApiAcceptance} className="rounded bg-ink px-3 py-2 text-sm font-semibold text-white disabled:opacity-60">
            运行 1 SKU 真实 API 验收
          </button>
          <button type="button" disabled={!realApiReport || Boolean(busy)} onClick={exportRealApiJson} className="rounded border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 disabled:opacity-60">
            导出 real-api-acceptance-report JSON
          </button>
        </div>
        {realApiDisplay.emptyText ? (
          <div className="mt-3 rounded border border-slate-200 bg-white p-3 text-sm text-slate-600">{realApiDisplay.emptyText}</div>
        ) : (
          <div className="mt-4 space-y-3">
            <div className="grid gap-3 md:grid-cols-7">
              {realApiDisplay.summaryCards.map((card) => (
                <div key={card.label} className="rounded border border-slate-200 bg-white p-3">
                  <div className="text-xs text-slate-500">{card.label}</div>
                  <div className="mt-1 text-lg font-semibold text-ink">{card.value}</div>
                </div>
              ))}
            </div>
            <div className="rounded border border-slate-200 bg-white p-3 text-xs text-slate-700">
              <div className="font-semibold text-ink">API 调用记录</div>
              {realApiDisplay.apiCallRows.length ? realApiDisplay.apiCallRows.map((call, index) => (
                <div key={`${call.apiType}-${index}`} className="mt-1">
                  {call.apiType} / {call.provider} / {call.model || '-'} / {call.durationMs || 0}ms / fallback: {String(Boolean(call.fallbackUsed))}
                </div>
              )) : <div className="mt-1">暂无调用记录</div>}
            </div>
            <div className="rounded border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
              {realApiDisplay.warningText || realApiDisplay.nextSuggestedAction || '请人工检查真实生成图片质量。'}
            </div>
          </div>
        )}
      </Section>

      {!display.emptyText && (
        <>
          <Section title="总览">
            <div className="grid gap-3 md:grid-cols-7">
              {display.summaryCards.map((card) => (
                <div key={card.label} className="rounded border border-slate-200 bg-white p-3">
                  <div className="text-xs text-slate-500">{card.label}</div>
                  <div className="mt-1 text-lg font-semibold text-ink">{card.value}</div>
                </div>
              ))}
            </div>
            <div className="mt-4 grid gap-3 md:grid-cols-3">
              <div className="rounded border border-red-200 bg-red-50 p-3 text-xs text-red-800">
                <div className="mb-1 font-semibold">阻断问题</div>
                {display.blockingText || display.issueBlockingText || '暂无'}
              </div>
              <div className="rounded border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800">
                <div className="mb-1 font-semibold">提醒</div>
                {display.warningText || '暂无'}
              </div>
              <div className="rounded border border-blue-200 bg-blue-50 p-3 text-xs text-blue-800">
                <div className="mb-1 font-semibold">建议</div>
                {display.recommendationText || display.nextSuggestedAction || '暂无'}
              </div>
            </div>
          </Section>

          <Section title="验收问题记录 Issue Log">
            <div className="rounded border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
              {finalAcceptanceIssueNotice} issue log is kept in the exported report only.
            </div>
            <div className="mt-3 grid gap-3 md:grid-cols-7">
              {display.issueSummaryCards.map((card) => (
                <div key={card.label} className="rounded border border-slate-200 bg-white p-3">
                  <div className="text-xs text-slate-500">{card.label}</div>
                  <div className="mt-1 text-lg font-semibold text-ink">{card.value}</div>
                </div>
              ))}
            </div>
            {display.issueBlockingText && (
              <div className="mt-3 rounded border border-red-200 bg-red-50 p-3 text-sm font-medium text-red-800">
                存在 open blocker 问题，报告不会显示为 passed。
              </div>
            )}

            <div className="mt-4 grid gap-3 md:grid-cols-2">
              <input className="rounded border border-slate-300 px-3 py-2 text-sm" placeholder="问题标题" value={issueForm.title} onChange={(event) => setIssueForm({ ...issueForm, title: event.target.value })} />
              <input className="rounded border border-slate-300 px-3 py-2 text-sm" placeholder="关联 SKU" value={issueForm.relatedSku} onChange={(event) => setIssueForm({ ...issueForm, relatedSku: event.target.value })} />
              <input className="rounded border border-slate-300 px-3 py-2 text-sm" placeholder="关联 taskId" value={issueForm.relatedTaskId} onChange={(event) => setIssueForm({ ...issueForm, relatedTaskId: event.target.value })} />
              <input className="rounded border border-slate-300 px-3 py-2 text-sm" placeholder="关联 batchId" value={issueForm.relatedBatchId} onChange={(event) => setIssueForm({ ...issueForm, relatedBatchId: event.target.value })} />
              <select className="rounded border border-slate-300 bg-white px-3 py-2 text-sm" value={issueForm.moduleKey} onChange={(event) => setIssueForm({ ...issueForm, moduleKey: event.target.value })}>
                {finalAcceptanceIssueModules.map((moduleKey) => <option key={moduleKey} value={moduleKey}>{moduleKey}</option>)}
              </select>
              <input className="rounded border border-slate-300 px-3 py-2 text-sm" placeholder="关联步骤 stepKey" value={issueForm.stepKey} onChange={(event) => setIssueForm({ ...issueForm, stepKey: event.target.value })} />
              <select className="rounded border border-slate-300 bg-white px-3 py-2 text-sm" value={issueForm.severity} onChange={(event) => setIssueForm({ ...issueForm, severity: event.target.value })}>
                {ISSUE_SEVERITIES.map((severity) => <option key={severity} value={severity}>{severity}</option>)}
              </select>
              <select className="rounded border border-slate-300 bg-white px-3 py-2 text-sm" value={issueForm.status} onChange={(event) => setIssueForm({ ...issueForm, status: event.target.value })}>
                {ISSUE_STATUSES.map((status) => <option key={status} value={status}>{status}</option>)}
              </select>
              <label className="flex items-center gap-2 rounded border border-slate-300 px-3 py-2 text-sm text-slate-700">
                <input type="checkbox" checked={issueForm.isBlockingFinalRelease} onChange={(event) => setIssueForm({ ...issueForm, isBlockingFinalRelease: event.target.checked })} />
                阻断最终版
              </label>
              <textarea className="md:col-span-2 rounded border border-slate-300 px-3 py-2 text-sm" placeholder="问题描述" value={issueForm.description} onChange={(event) => setIssueForm({ ...issueForm, description: event.target.value })} />
              <textarea className="rounded border border-slate-300 px-3 py-2 text-sm" placeholder="复现步骤，每行一步" value={issueForm.reproduceSteps} onChange={(event) => setIssueForm({ ...issueForm, reproduceSteps: event.target.value })} />
              <textarea className="rounded border border-slate-300 px-3 py-2 text-sm" placeholder="期望结果" value={issueForm.expectedResult} onChange={(event) => setIssueForm({ ...issueForm, expectedResult: event.target.value })} />
              <textarea className="rounded border border-slate-300 px-3 py-2 text-sm" placeholder="实际结果" value={issueForm.actualResult} onChange={(event) => setIssueForm({ ...issueForm, actualResult: event.target.value })} />
              <textarea className="rounded border border-slate-300 px-3 py-2 text-sm" placeholder="处理建议 / 备注" value={issueForm.suggestedFix} onChange={(event) => setIssueForm({ ...issueForm, suggestedFix: event.target.value })} />
            </div>
            <button type="button" disabled={!report || !issueForm.title.trim()} onClick={addIssueLog} className="mt-3 rounded bg-ink px-3 py-2 text-sm font-semibold text-white disabled:opacity-60">
              新增问题
            </button>

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
                      <input type="checkbox" checked={issue.isBlockingFinalRelease} onChange={(event) => updateIssue(issue.issueId, { isBlockingFinalRelease: event.target.checked })} />
                      阻断最终版
                    </label>
                    <button type="button" onClick={() => deleteIssue(issue.issueId)} className="rounded border border-red-300 px-2 py-1 text-xs font-medium text-red-700">删除</button>
                  </div>
                  <div className="mt-2 grid gap-2 md:grid-cols-3">
                    <input className="rounded border border-slate-300 px-2 py-1 text-xs" value={issue.relatedSku} placeholder="SKU" onChange={(event) => updateIssue(issue.issueId, { relatedSku: event.target.value })} />
                    <select className="rounded border border-slate-300 bg-white px-2 py-1 text-xs" value={issue.moduleKey} onChange={(event) => updateIssue(issue.issueId, { moduleKey: event.target.value })}>
                      {finalAcceptanceIssueModules.map((moduleKey) => <option key={moduleKey} value={moduleKey}>{moduleKey}</option>)}
                    </select>
                    <input className="rounded border border-slate-300 px-2 py-1 text-xs" value={issue.stepKey} placeholder="stepKey" onChange={(event) => updateIssue(issue.issueId, { stepKey: event.target.value })} />
                  </div>
                  <textarea className="mt-2 w-full rounded border border-slate-300 px-2 py-1 text-xs" value={issue.description} placeholder="问题描述" onChange={(event) => updateIssue(issue.issueId, { description: event.target.value })} />
                </div>
              )) : (
                <div className="rounded border border-slate-200 bg-white p-3 text-sm text-slate-600">暂无问题记录。</div>
              )}
            </div>
          </Section>

          <Section title="多批次验收概览">
            {display.batchRows.length ? (
              <div className="grid gap-3 md:grid-cols-2">
                {display.batchRows.map((row) => (
                  <div key={row.batchId} className="rounded border border-slate-200 bg-white p-3 text-sm">
                    <div className="font-semibold text-ink">{row.batchName || row.batchId}</div>
                    <div className="mt-1 text-xs text-slate-500">{row.batchId}</div>
                    <div className="mt-2 text-xs text-slate-700">
                      SKU: {row.skuCount || 0} / passed: {row.passedSku || 0} / pending: {row.pendingSku || 0} / blocked: {row.blockedSku || 0}
                    </div>
                    <div className="mt-1 text-xs text-slate-700">状态：{row.status || 'pending'}</div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="rounded border border-slate-200 bg-white p-3 text-sm text-slate-600">暂无多批次数据，可先生成模板或预填报告。</div>
            )}
          </Section>

          <Section title="10 SKU 验收表">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[1200px] border-collapse text-xs">
                <thead>
                  <tr className="border-b border-slate-200 text-left text-slate-500">
                    <th className="py-2 pr-3">SKU</th>
                    <th className="py-2 pr-3">商品名</th>
                    <th className="py-2 pr-3">素材</th>
                    <th className="py-2 pr-3">自动状态</th>
                    <th className="py-2 pr-3">步骤状态</th>
                    <th className="py-2 pr-3">风险摘要</th>
                    <th className="py-2 pr-3">下一步</th>
                    <th className="py-2 pr-3">人工结论</th>
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

          <Section title="模块验收表">
            <div className="grid gap-3 md:grid-cols-3">
              {display.moduleRows.map((row) => (
                <div key={row.moduleKey} className="rounded border border-slate-200 bg-white p-3 text-sm">
                  <div className="font-semibold text-ink">{row.moduleName}</div>
                  <div className="mt-1 text-xs text-slate-500">{row.moduleKey}</div>
                  <div className="mt-2 text-xs text-slate-700">状态：{row.status}</div>
                  <div className="mt-1 text-xs text-slate-600">issues：{Array.isArray(row.issues) && row.issues.length ? row.issues.join(' / ') : '暂无'}</div>
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
    </div>
  );
}
