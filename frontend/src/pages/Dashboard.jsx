import { useLocale } from '../i18n/LocaleProvider.jsx';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight, Layers, RefreshCw, Search } from 'lucide-react';
import Section from '../components/Section.jsx';
import StatusBadge from '../components/StatusBadge.jsx';
import { api } from '../services/api.js';
import { ErrorMessage } from './pageUtils.jsx';
import { getBatchGuideState } from '../utils/batchWorkflowGuide.js';
import { formatCleanupBytes } from '../utils/cleanup.js';
import { cleanupDashboardErrorMessage, cleanupRefreshStatusText } from '../utils/dashboardCleanup.js';

function nextRoute(task) {
  if (!task.productInfo) return `/tasks/${task.id}/product`;
  if (!task.imagePlans?.length && task.status !== 'rules_selected') return `/tasks/${task.id}/rules`;
  if (!task.imagePlans?.length) return `/tasks/${task.id}/plans`;
  if (!task.generatedImages?.length) return `/tasks/${task.id}/generate`;
  if (!task.review) return `/tasks/${task.id}/review`;
  return `/tasks/${task.id}/export`;
}

export default function Dashboard() {
  const { t, dateTime } = useLocale();
  const [tasks, setTasks] = useState([]);
  const [batches, setBatches] = useState([]);
  const [batchSummary, setBatchSummary] = useState(null);
  const [cleanupSummary, setCleanupSummary] = useState(null);
  const [cleanupLoading, setCleanupLoading] = useState(false);
  const [cleanupError, setCleanupError] = useState('');
  const [cleanupLastRefreshedAt, setCleanupLastRefreshedAt] = useState(null);
  const [effectiveSettings, setEffectiveSettings] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  async function loadCleanupSummary() {
    setCleanupLoading(true);
    try {
      const cleanupResult = await api.getCleanupSummary();
      setCleanupSummary(cleanupResult);
      setCleanupError('');
      setCleanupLastRefreshedAt(new Date());
    } catch (err) {
      setCleanupError(cleanupDashboardErrorMessage(err));
    } finally {
      setCleanupLoading(false);
    }
  }

  async function load() {
    setLoading(true);
    setError('');
    const cleanupPromise = loadCleanupSummary();
    try {
      const [taskResult, analyticsSummary, batchList, settingsResult] = await Promise.all([
        api.listTasks(),
        api.getBatchAnalyticsSummary(),
        api.listBatches(),
        api.getEffectiveSettings()
      ]);
      setTasks(taskResult.tasks || []);
      setBatchSummary(analyticsSummary);
      setBatches(batchList.batchTasks || []);
      setEffectiveSettings(settingsResult);
    } catch (err) {
      setError(err.message);
    } finally {
      await cleanupPromise;
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-ink">{t("任务首页")}</h1>
          <p className="mt-1 text-sm text-slate-500">{t("管理跨境电商商品图片识别、方案生成、审核和导出任务。")}</p>
        </div>
        <button disabled={loading} onClick={load} className="focus-ring inline-flex items-center gap-2 rounded border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700">
          <RefreshCw size={16} />{t("刷新")}</button>
      </div>

      <ErrorMessage error={error} />

      {(cleanupSummary || cleanupError || cleanupLoading) && (
        <Section title={t("运行文件占用")}>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <div className="text-2xl font-semibold text-ink">{formatCleanupBytes(cleanupSummary?.totalBytes || 0)}</div>
              <div className="mt-1 text-sm text-slate-500">{t("当前统计") + " "}{cleanupSummary?.totalFiles || 0}{" " + t("个运行文件，可进入清理页先预览再手动清理。")}</div>
              <div className="mt-1 text-xs text-slate-500">
                {cleanupRefreshStatusText({ refreshing: cleanupLoading, lastRefreshedAt: cleanupLastRefreshedAt }, t, dateTime)}
              </div>
              {cleanupError && <div className="mt-2 text-sm text-red-700">{t(cleanupError)}</div>}
            </div>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={loadCleanupSummary}
                disabled={cleanupLoading}
                className="focus-ring inline-flex items-center gap-2 rounded border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-700 disabled:opacity-60"
              >
                <RefreshCw size={16} />{t("刷新占用")}</button>
              <Link to="/cleanup" className="focus-ring rounded border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-700">{t("进入数据清理")}</Link>
            </div>
          </div>
        </Section>
      )}

      <div className="flex flex-wrap gap-3">
        <Link to="/upload" className="focus-ring rounded bg-mint px-4 py-2 text-sm font-semibold text-white">{t("新建单 SKU 任务")}</Link>
        <Link to="/batches" className="focus-ring inline-flex items-center gap-2 rounded border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-700">
          <Layers size={16} />{t("新建批量 SKU 任务")}</Link>
        <Link to="/batches" className="focus-ring inline-flex items-center gap-2 rounded border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-700">
          <Search size={16} />{t("扫描导入目录")}</Link>
        <a href={api.generalSopDownloadUrl()} className="focus-ring inline-flex items-center gap-2 rounded border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-700">{t("查看操作手册")}</a>
        <Link to="/settings" className="focus-ring rounded border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-700">{t("设置中心")}</Link>
        <Link to="/health" className="focus-ring rounded border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-700">{t("系统健康检查")}</Link>
        <Link to="/snapshots" className="focus-ring rounded border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-700">{t("备份与恢复")}</Link>
      </div>

      {effectiveSettings && (
        <Section title={t("设置摘要")}>
          <div className="grid gap-3 text-sm md:grid-cols-5">
            <div className="rounded border border-slate-200 p-3"><div className="text-xs text-slate-500">{t("默认模板")}</div><div className="mt-1 font-semibold text-ink">{effectiveSettings.userSettings?.defaults?.workflowTemplateId || t("未设置")}</div></div>
            <div className="rounded border border-slate-200 p-3"><div className="text-xs text-slate-500">{t("识别 Provider")}</div><div className="mt-1 font-semibold text-ink">{effectiveSettings.userSettings?.providers?.visionProvider}</div></div>
            <div className="rounded border border-slate-200 p-3"><div className="text-xs text-slate-500">{t("批量并发")}</div><div className="mt-1 font-semibold text-ink">{effectiveSettings.userSettings?.defaults?.batchConcurrency}</div></div>
            <div className="rounded border border-slate-200 p-3"><div className="text-xs text-slate-500">{t("Key 状态")}</div><div className="mt-1 font-semibold text-ink">G {effectiveSettings.envSummary?.hasGeminiKey ? t("已配") : t("未配")} / O {effectiveSettings.envSummary?.hasOpenAIKey ? t("已配") : t("未配")} / Q {effectiveSettings.envSummary?.hasQwenKey ? t("已配") : t("未配")}</div></div>
            <div className="rounded border border-slate-200 p-3"><div className="text-xs text-slate-500">{t("导入扫描")}</div><div className="mt-1 font-semibold text-ink">{effectiveSettings.envSummary?.importScanEnabled ? t("已开启") : t("未开启")}</div></div>
          </div>
        </Section>
      )}

      <div className="rounded border border-slate-200 bg-slate-50 p-3 text-sm text-slate-600">
        <Link to="/workflow-templates" className="mr-3 font-semibold text-mint hover:text-teal-800">{t("工作流模板")}</Link>{t("可快速填充批量任务的平台、Provider、并发和重试策略；模板不会保存 API Key，也不会自动跳过人工确认。")}</div>

      {batches.length > 0 && (
        <Section title={t("推荐操作")}>
          <div className="grid gap-3 md:grid-cols-2">
            {batches
              .filter((batch) => !['completed', 'exported'].includes(batch.status))
              .slice(0, 4)
              .map((batch) => {
                const guide = getBatchGuideState(batch);
                const current = guide.steps.find((step) => step.id === guide.currentStepId);
                return (
                  <Link key={batch.id} to={`/batches/${batch.id}`} className="rounded border border-slate-200 bg-white p-3 text-sm hover:border-mint">
                    <div className="flex flex-wrap justify-between gap-2">
                      <span className="font-semibold text-ink">{batch.name}</span>
                      <span className="text-mint">{t(current?.title)}</span>
                    </div>
                    <div className="mt-1 text-xs text-slate-500">{t('共 {total} 个 SKU；待确认 {waiting}，失败 {failed}', { total: guide.counts.total, waiting: guide.counts.waitingConfirm, failed: guide.counts.failed })}</div>
                    <div className="mt-2 text-xs text-slate-500">{t("待确认") + " "}{batch.summary?.waitingConfirmSku || 0}{" " + t("/ 失败") + " "}{batch.summary?.failedSku || 0}{" " + t("/ 队列") + " "}{batch.queue?.status || 'idle'}
                    </div>
                  </Link>
                );
              })}
          </div>
        </Section>
      )}

      {batchSummary && (
        <Section title={t("批量任务总览")}>
          <div className="grid gap-3 md:grid-cols-6">
            <div className="rounded border border-slate-200 p-3"><div className="text-xs text-slate-500">{t("batch 总数")}</div><div className="mt-1 font-semibold text-ink">{batchSummary.batchCount || 0}</div></div>
            <div className="rounded border border-slate-200 p-3"><div className="text-xs text-slate-500">{t("总 SKU")}</div><div className="mt-1 font-semibold text-ink">{batchSummary.totalSku || 0}</div></div>
            <div className="rounded border border-slate-200 p-3"><div className="text-xs text-slate-500">{t("已完成 SKU")}</div><div className="mt-1 font-semibold text-ink">{batchSummary.completedSku || 0}</div></div>
            <div className="rounded border border-slate-200 p-3"><div className="text-xs text-slate-500">{t("失败 SKU")}</div><div className="mt-1 font-semibold text-red-700">{batchSummary.failedSku || 0}</div></div>
            <div className="rounded border border-slate-200 p-3"><div className="text-xs text-slate-500">{t("高风险 batch")}</div><div className="mt-1 font-semibold text-amber-700">{batchSummary.highRiskBatchCount || 0}</div></div>
            <div className="rounded border border-slate-200 p-3"><div className="text-xs text-slate-500">{t("预估成本")}</div><div className="mt-1 font-semibold text-ink">USD {Number(batchSummary.estimatedTotalCost || 0).toFixed(4)}</div></div>
          </div>
          <div className="mt-3 grid gap-2">
            {(batchSummary.recentBatches || []).slice(0, 5).map((batch) => (
              <Link key={batch.id} to={`/batches/${batch.id}`} className="rounded border border-slate-200 bg-white p-3 text-sm hover:border-mint">
                <div className="flex flex-wrap justify-between gap-2">
                  <span className="font-semibold text-ink">{batch.name}</span>
                  <StatusBadge status={batch.status} />
                </div>
                <div className="mt-1 text-xs text-slate-500">
                  SKU {batch.totalSku}{" " + t("/ 失败") + " "}{batch.failedSku} / high risk {batch.highRiskCount}{" " + t("/ 预估 USD") + " "}{Number(batch.estimatedCost || 0).toFixed(4)}
                </div>
              </Link>
            ))}
          </div>
        </Section>
      )}

      <Section title={t("任务列表")}>
        {loading ? (
          <div className="text-sm text-slate-500">{t("正在加载任务...")}</div>
        ) : tasks.length === 0 ? (
          <div className="flex flex-col items-start gap-3 py-8">
            <p className="text-sm text-slate-500">{t("暂无任务。")}</p>
            <Link to="/upload" className="focus-ring rounded bg-mint px-4 py-2 text-sm font-semibold text-white">{t("上传商品图片")}</Link>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[760px] border-collapse text-sm">
              <thead>
                <tr className="border-b border-slate-200 text-left text-slate-500">
                  <th className="py-3 pr-4 font-medium">SKU</th>
                  <th className="py-3 pr-4 font-medium">{t("商品")}</th>
                  <th className="py-3 pr-4 font-medium">{t("平台")}</th>
                  <th className="py-3 pr-4 font-medium">{t("状态")}</th>
                  <th className="py-3 pr-4 font-medium">{t("更新时间")}</th>
                  <th className="py-3 text-right font-medium">{t("操作")}</th>
                </tr>
              </thead>
              <tbody>
                {tasks.map((task) => (
                  <tr key={task.id} className="border-b border-slate-100">
                    <td className="py-3 pr-4 font-medium text-ink">{task.productInfo?.sku || task.sku}</td>
                    <td className="py-3 pr-4 text-slate-700">{task.productInfo?.name || task.sourceImages?.[0]?.displayName || task.originalImage?.fileName}</td>
                    <td className="py-3 pr-4 text-slate-700">
                      {task.targets?.length > 1 ? t("{value0} 个平台", { value0: (task.targets.length) }) : task.targets?.[0]?.platformName || task.platform}
                    </td>
                    <td className="py-3 pr-4"><StatusBadge status={task.status} /></td>
                    <td className="py-3 pr-4 text-slate-500">{dateTime(task.updatedAt)}</td>
                    <td className="py-3 text-right">
                      <Link to={nextRoute(task)} className="inline-flex items-center gap-1 font-semibold text-mint hover:text-teal-800">{t("继续") + " "}<ArrowRight size={15} />
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>
    </div>
  );
}
