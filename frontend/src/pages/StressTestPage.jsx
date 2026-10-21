import { useLocale } from '../i18n/LocaleProvider.jsx';
import { approvePaidOperation } from '../utils/paidOperationApproval.js';
import { useEffect, useMemo, useState } from 'react';
import { Download, Gauge, Play, RefreshCw } from 'lucide-react';
import Section from '../components/Section.jsx';
import { api } from '../services/api.js';
import { ErrorMessage, PrimaryButton } from './pageUtils.jsx';
import {
  STRESS_TEST_MODE_OPTIONS,
  createStressReportDownload,
  formatStressDuration,
  normalizeStressTestPayload,
  stressReportStats,
  stressSkuStatusLabel,
  stressStatusLabel
} from '../utils/stressTest.js';

const SKU_COUNT_OPTIONS = [3, 5, 10];

function StatBox({ label, value, tone = 'text-ink' }) {
  return (
    <div className="rounded border border-slate-200 p-3">
      <div className="text-xs text-slate-500">{label}</div>
      <div className={`mt-1 text-lg font-semibold ${tone}`}>{value}</div>
    </div>
  );
}

export default function StressTestPage() {
  const { t } = useLocale();
  const [batches, setBatches] = useState([]);
  const [selectedBatchId, setSelectedBatchId] = useState('');
  const [mode, setMode] = useState('mockOnly');
  const [skuCount, setSkuCount] = useState(3);
  const [customSkuCount, setCustomSkuCount] = useState('');
  const [concurrency, setConcurrency] = useState(1);
  const [exportZip, setExportZip] = useState(false);
  const [report, setReport] = useState(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');

  const selectedMode = STRESS_TEST_MODE_OPTIONS.find((item) => item.id === mode) || STRESS_TEST_MODE_OPTIONS[0];
  const payload = useMemo(() => normalizeStressTestPayload({
    mode,
    skuCount: customSkuCount || skuCount,
    concurrency,
    exportZip,
    batchId: selectedBatchId
  }), [mode, skuCount, customSkuCount, concurrency, exportZip, selectedBatchId]);
  const stats = stressReportStats(report);

  async function loadBatches() {
    setError('');
    try {
      const result = await api.listBatches();
      const nextBatches = result.batchTasks || [];
      setBatches(nextBatches);
      setSelectedBatchId((current) => current || nextBatches[0]?.id || '');
    } catch (err) {
      setError(err.message);
    }
  }

  useEffect(() => {
    loadBatches();
  }, []);

  async function runMockStressTest() {
    if (busy || !selectedBatchId || !selectedMode.enabled) return;
    setBusy('run');
    setError('');
    try {
      const approval = mode === 'realVisionMockGenerate' ? await approvePaidOperation(api, { kinds: ['vision'], target: selectedBatchId, count: payload.skuCount }, t, (message) => window.confirm(message)) : {};
      if (!approval) return;
      setReport(await api.runStressTest({ ...payload, ...approval }));
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy('');
    }
  }

  function downloadJson() {
    if (!report) return;
    const download = createStressReportDownload(report);
    const blob = new Blob([download.content], { type: download.mimeType });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = download.fileName;
    link.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-ink">{t("批量真实压测 / 稳定性报告")}</h1>
          <p className="mt-1 max-w-4xl text-sm text-slate-500">{t('默认 mockOnly；真实识别压测需逐次确认费用与数据去向，生图和审核仍为模拟。')}</p>
        </div>
        <button type="button" onClick={loadBatches} className="focus-ring inline-flex items-center gap-2 rounded border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700">
          <RefreshCw size={16} />{t("刷新 batch")}</button>
      </div>

      <ErrorMessage error={error} />

      <Section title={t("压测配置")}>
        <div className="grid gap-5 lg:grid-cols-2">
          <div>
            <div className="text-sm font-semibold text-ink">{t("压测模式")}</div>
            <div className="mt-2 space-y-2">
              {STRESS_TEST_MODE_OPTIONS.map((option) => (
                <label key={option.id} className={`flex items-start gap-3 rounded border p-3 text-sm ${mode === option.id ? 'border-mint bg-teal-50' : 'border-slate-200 bg-white'} ${!option.enabled ? 'opacity-70' : ''}`}>
                  <input
                    type="radio"
                    checked={mode === option.id}
                    disabled={Boolean(busy) || !option.enabled}
                    onChange={() => setMode(option.id)}
                    className="mt-1"
                  />
                  <span>
                    <span className="block font-semibold text-ink">{t(option.label)}</span>
                    <span className="mt-1 block text-slate-500">{t(option.description)}</span>
                    <span className={`mt-1 block text-xs ${option.enabled ? 'text-emerald-700' : 'text-amber-700'}`}>{t(option.costWarning)}</span>
                  </span>
                </label>
              ))}
            </div>
          </div>

          <div className="space-y-4">
            <label className="block">
              <span className="mb-1 block text-sm font-semibold text-ink">{t("选择 batch")}</span>
              <select
                data-stress-batch
                value={selectedBatchId}
                onChange={(event) => setSelectedBatchId(event.target.value)}
                className="focus-ring w-full rounded border border-slate-300 bg-white px-3 py-2 text-sm"
              >
                {batches.length === 0 ? (
                  <option value="">{t("暂无 batch")}</option>
                ) : batches.map((batch) => (
                  <option key={batch.id} value={batch.id}>{batch.name || batch.id}（{batch.skuTasks?.length || 0} SKU）</option>
                ))}
              </select>
            </label>

            <div>
              <div className="text-sm font-semibold text-ink">{t("SKU 数量")}</div>
              <div className="mt-2 flex flex-wrap gap-2">
                {SKU_COUNT_OPTIONS.map((count) => (
                  <button
                    key={count}
                    type="button"
                    onClick={() => {
                      setSkuCount(count);
                      setCustomSkuCount('');
                    }}
                    className={`rounded border px-3 py-2 text-sm font-medium ${!customSkuCount && skuCount === count ? 'border-mint bg-mint text-white' : 'border-slate-300 bg-white text-slate-700'}`}
                  >
                    {count}{" " + t("个")}</button>
                ))}
                <input
                  type="number"
                  min="1"
                  max="100"
                  value={customSkuCount}
                  onChange={(event) => setCustomSkuCount(event.target.value)}
                  className="w-36 rounded border border-slate-300 px-3 py-2 text-sm"
                  placeholder={t("自定义")}
                />
              </div>
            </div>

            <label className="block">
              <span className="mb-1 block text-sm font-semibold text-ink">{t("并发")}</span>
              <select
                value={concurrency}
                onChange={(event) => setConcurrency(Number(event.target.value))}
                className="focus-ring w-40 rounded border border-slate-300 bg-white px-3 py-2 text-sm"
              >
                <option value={1}>{t("1（默认）")}</option>
                <option value={2}>2</option>
              </select>
            </label>

            <label className="flex items-center gap-2 text-sm text-slate-700">
              <input
                type="checkbox"
                checked={exportZip}
                onChange={(event) => setExportZip(event.target.checked)}
              />{t("记录模拟导出步骤")}</label>
          </div>
        </div>

        <div className="mt-5 flex flex-wrap items-center gap-3">
          <PrimaryButton data-stress-run busy={busy === 'run'} disabled={!selectedBatchId || !selectedMode.enabled} onClick={runMockStressTest}>
            <Play size={16} />{t("启动压测")}</PrimaryButton>
          {!selectedBatchId && <span className="text-sm text-slate-500">{t("请先创建或导入 batch SKU。")}</span>}
          {mode === 'realVisionMockGenerate' && selectedBatchId && (
            <span className="text-sm font-medium text-amber-700">{t("将调用真实识别，不会调用真实生图。")}</span>
          )}
          {!selectedMode.enabled && <span className="text-sm text-amber-700">{t("真实模式本阶段仅展示，不会调用 Provider。")}</span>}
        </div>
      </Section>

      {!report && (
        <Section title={t("稳定性报告")}>
          <div className="flex items-center gap-3 py-6 text-sm text-slate-500">
            <Gauge size={20} />{t("运行 mockOnly 压测后，这里会显示汇总、SKU 明细、步骤耗时和 Provider mock 统计。")}</div>
        </Section>
      )}

      {report && (
        <>
          <Section
            title={t("稳定性报告")}
            actions={(
              <button type="button" onClick={downloadJson} className="focus-ring inline-flex items-center gap-2 rounded border border-slate-300 bg-white px-3 py-2 text-sm font-semibold text-slate-700">
                <Download size={16} />{t("导出 JSON")}</button>
            )}
          >
            <div className="grid gap-3 md:grid-cols-6">
              <StatBox label={t("状态")} value={t(stressStatusLabel(report.summary?.status))} />
              <StatBox label={t("总 SKU")} value={report.summary?.totalSku || 0} />
              <StatBox label={t("成功 SKU")} value={report.summary?.successSku || 0} tone="text-emerald-700" />
              <StatBox label={t("失败 SKU")} value={report.summary?.failedSku || 0} tone={report.summary?.failedSku ? 'text-red-700' : 'text-ink'} />
              <StatBox label={t("总耗时")} value={formatStressDuration(report.summary?.durationMs || 0, t)} />
              <StatBox label={t("预估成本")} value={stats.estimatedCostText} />
            </div>
            {report.summary?.mode === 'realVisionMockGenerate' && (
              <div className="mt-3 grid gap-3 md:grid-cols-4">
                <StatBox label={t("Vision 调用")} value={stats.visionCallCount} />
                <StatBox label={t("Vision 成功")} value={stats.visionSuccessCount} tone="text-emerald-700" />
                <StatBox label={t("Vision 失败")} value={stats.visionFailureCount} tone={stats.visionFailureCount ? 'text-red-700' : 'text-ink'} />
                <StatBox label={t("平均识别耗时")} value={stats.visionAverageDurationText} />
              </div>
            )}
            <div className="mt-3 rounded border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-800">
              {report.costNotice || report.summary?.costWarning || t("mockOnly 不调用真实 Provider。")}
            </div>
            {stats.costPlaceholder && (
              <div className="mt-2 rounded border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">{t("当前成本为估算占位，尚未接入真实价格表。")}</div>
            )}
          </Section>

          <Section title={t("SKU 明细")}>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[920px] border-collapse text-sm">
                <thead>
                  <tr className="border-b border-slate-200 text-left text-slate-500">
                    <th className="py-3 pr-4 font-medium">SKU</th>
                    <th className="py-3 pr-4 font-medium">{t("状态")}</th>
                    <th className="py-3 pr-4 font-medium">{t("当前步骤")}</th>
                    <th className="py-3 pr-4 font-medium">{t("失败步骤")}</th>
                    <th className="py-3 pr-4 font-medium">{t("耗时")}</th>
                    <th className="py-3 pr-4 font-medium">{t("生成 / 审核 / 导出")}</th>
                    <th className="py-3 font-medium">{t("错误")}</th>
                  </tr>
                </thead>
                <tbody>
                  {(report.skuResults || []).map((sku) => (
                    <tr key={sku.skuId} className="border-b border-slate-100">
                      <td className="py-3 pr-4 font-semibold text-ink">{sku.skuId}</td>
                      <td className="py-3 pr-4 text-slate-700">{t(stressSkuStatusLabel(sku.status))}</td>
                      <td className="py-3 pr-4 text-slate-600">{sku.currentStep || '-'}</td>
                      <td className="py-3 pr-4 text-slate-600">{sku.failedStep || '-'}</td>
                      <td className="py-3 pr-4 text-slate-600">{formatStressDuration(sku.durationMs || 0)}</td>
                      <td className="py-3 pr-4 text-slate-600">{sku.generatedImageCount || 0} / {sku.reviewedImageCount || 0} / {sku.exportedFileCount || 0}</td>
                      <td className="py-3 text-red-700">{sku.errorMessage || '-'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Section>

          <Section title={t("步骤耗时与 Provider 统计")}>
            <div className="grid gap-4 lg:grid-cols-2">
              <div className="overflow-x-auto">
                <table className="w-full min-w-[460px] border-collapse text-sm">
                  <thead>
                    <tr className="border-b border-slate-200 text-left text-slate-500">
                      <th className="py-2 pr-4 font-medium">{t("步骤")}</th>
                      <th className="py-2 pr-4 font-medium">{t("次数")}</th>
                      <th className="py-2 pr-4 font-medium">{t("总耗时")}</th>
                      <th className="py-2 font-medium">{t("平均")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {Object.entries(report.stepDurations || {}).map(([step, item]) => (
                      <tr key={step} className="border-b border-slate-100">
                        <td className="py-2 pr-4 font-medium text-ink">{step}</td>
                        <td className="py-2 pr-4 text-slate-600">{item.count || 0}</td>
                        <td className="py-2 pr-4 text-slate-600">{formatStressDuration(item.totalMs || 0)}</td>
                        <td className="py-2 text-slate-600">{formatStressDuration(item.avgMs || 0)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[520px] border-collapse text-sm">
                  <thead>
                    <tr className="border-b border-slate-200 text-left text-slate-500">
                      <th className="py-2 pr-4 font-medium">Provider</th>
                      <th className="py-2 pr-4 font-medium">{t("类型")}</th>
                      <th className="py-2 pr-4 font-medium">{t("调用")}</th>
                      <th className="py-2 pr-4 font-medium">{t("失败")}</th>
                      <th className="py-2 font-medium">{t("成本")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(report.providerStats || []).map((provider) => (
                      <tr key={`${provider.providerType}-${provider.providerName}`} className="border-b border-slate-100">
                        <td className="py-2 pr-4 font-medium text-ink">{provider.providerName}</td>
                        <td className="py-2 pr-4 text-slate-600">{provider.providerType}</td>
                        <td className="py-2 pr-4 text-slate-600">{provider.callCount || 0}</td>
                        <td className="py-2 pr-4 text-slate-600">{provider.failureCount || 0}</td>
                        <td className="py-2 text-slate-600">USD {Number(provider.estimatedCost || 0).toFixed(4)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
            {stats.hasFailures && (
              <div className="mt-4 rounded border border-red-200 bg-red-50 p-3 text-sm text-red-700">{t("失败 SKU：")}{stats.failedSkuText}
              </div>
            )}
          </Section>
        </>
      )}
    </div>
  );
}
