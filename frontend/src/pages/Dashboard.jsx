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
          <h1 className="text-2xl font-semibold text-ink">任务首页</h1>
          <p className="mt-1 text-sm text-slate-500">管理跨境电商商品图片识别、方案生成、审核和导出任务。</p>
        </div>
        <button onClick={load} className="focus-ring inline-flex items-center gap-2 rounded border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700">
          <RefreshCw size={16} />
          刷新
        </button>
      </div>

      <ErrorMessage error={error} />

      {(cleanupSummary || cleanupError || cleanupLoading) && (
        <Section title="运行文件占用">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <div className="text-2xl font-semibold text-ink">{formatCleanupBytes(cleanupSummary?.totalBytes || 0)}</div>
              <div className="mt-1 text-sm text-slate-500">当前统计 {cleanupSummary?.totalFiles || 0} 个运行文件，可进入清理页先预览再手动清理。</div>
              <div className="mt-1 text-xs text-slate-500">
                {cleanupRefreshStatusText({ refreshing: cleanupLoading, lastRefreshedAt: cleanupLastRefreshedAt })}
              </div>
              {cleanupError && <div className="mt-2 text-sm text-red-700">{cleanupError}</div>}
            </div>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={loadCleanupSummary}
                disabled={cleanupLoading}
                className="focus-ring inline-flex items-center gap-2 rounded border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-700 disabled:opacity-60"
              >
                <RefreshCw size={16} />
                刷新占用
              </button>
              <Link to="/cleanup" className="focus-ring rounded border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-700">
                进入数据清理
              </Link>
            </div>
          </div>
        </Section>
      )}

      <div className="flex flex-wrap gap-3">
        <Link to="/upload" className="focus-ring rounded bg-mint px-4 py-2 text-sm font-semibold text-white">新建单 SKU 任务</Link>
        <Link to="/batches" className="focus-ring inline-flex items-center gap-2 rounded border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-700">
          <Layers size={16} />
          新建批量 SKU 任务
        </Link>
        <Link to="/batches" className="focus-ring inline-flex items-center gap-2 rounded border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-700">
          <Search size={16} />
          扫描导入目录
        </Link>
        <a href={api.generalSopDownloadUrl()} className="focus-ring inline-flex items-center gap-2 rounded border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-700">
          查看操作手册
        </a>
        <Link to="/settings" className="focus-ring rounded border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-700">设置中心</Link>
        <Link to="/health" className="focus-ring rounded border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-700">系统健康检查</Link>
        <Link to="/snapshots" className="focus-ring rounded border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-700">备份与恢复</Link>
      </div>

      {effectiveSettings && (
        <Section title="设置摘要">
          <div className="grid gap-3 text-sm md:grid-cols-5">
            <div className="rounded border border-slate-200 p-3"><div className="text-xs text-slate-500">默认模板</div><div className="mt-1 font-semibold text-ink">{effectiveSettings.userSettings?.defaults?.workflowTemplateId || '未设置'}</div></div>
            <div className="rounded border border-slate-200 p-3"><div className="text-xs text-slate-500">识别 Provider</div><div className="mt-1 font-semibold text-ink">{effectiveSettings.userSettings?.providers?.visionProvider}</div></div>
            <div className="rounded border border-slate-200 p-3"><div className="text-xs text-slate-500">批量并发</div><div className="mt-1 font-semibold text-ink">{effectiveSettings.userSettings?.defaults?.batchConcurrency}</div></div>
            <div className="rounded border border-slate-200 p-3"><div className="text-xs text-slate-500">Key 状态</div><div className="mt-1 font-semibold text-ink">G {effectiveSettings.envSummary?.hasGeminiKey ? '已配' : '未配'} / O {effectiveSettings.envSummary?.hasOpenAIKey ? '已配' : '未配'} / Q {effectiveSettings.envSummary?.hasQwenKey ? '已配' : '未配'}</div></div>
            <div className="rounded border border-slate-200 p-3"><div className="text-xs text-slate-500">导入扫描</div><div className="mt-1 font-semibold text-ink">{effectiveSettings.envSummary?.importScanEnabled ? '已开启' : '未开启'}</div></div>
          </div>
        </Section>
      )}

      <div className="rounded border border-slate-200 bg-slate-50 p-3 text-sm text-slate-600">
        <Link to="/workflow-templates" className="mr-3 font-semibold text-mint hover:text-teal-800">工作流模板</Link>
        可快速填充批量任务的平台、Provider、并发和重试策略；模板不会保存 API Key，也不会自动跳过人工确认。
      </div>

      {batches.length > 0 && (
        <Section title="推荐操作">
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
                      <span className="text-mint">{current?.title}</span>
                    </div>
                    <div className="mt-1 text-xs text-slate-500">{current?.progressText}</div>
                    <div className="mt-2 text-xs text-slate-500">
                      待确认 {batch.summary?.waitingConfirmSku || 0} / 失败 {batch.summary?.failedSku || 0} / 队列 {batch.queue?.status || 'idle'}
                    </div>
                  </Link>
                );
              })}
          </div>
        </Section>
      )}

      {batchSummary && (
        <Section title="批量任务总览">
          <div className="grid gap-3 md:grid-cols-6">
            <div className="rounded border border-slate-200 p-3"><div className="text-xs text-slate-500">batch 总数</div><div className="mt-1 font-semibold text-ink">{batchSummary.batchCount || 0}</div></div>
            <div className="rounded border border-slate-200 p-3"><div className="text-xs text-slate-500">总 SKU</div><div className="mt-1 font-semibold text-ink">{batchSummary.totalSku || 0}</div></div>
            <div className="rounded border border-slate-200 p-3"><div className="text-xs text-slate-500">已完成 SKU</div><div className="mt-1 font-semibold text-ink">{batchSummary.completedSku || 0}</div></div>
            <div className="rounded border border-slate-200 p-3"><div className="text-xs text-slate-500">失败 SKU</div><div className="mt-1 font-semibold text-red-700">{batchSummary.failedSku || 0}</div></div>
            <div className="rounded border border-slate-200 p-3"><div className="text-xs text-slate-500">高风险 batch</div><div className="mt-1 font-semibold text-amber-700">{batchSummary.highRiskBatchCount || 0}</div></div>
            <div className="rounded border border-slate-200 p-3"><div className="text-xs text-slate-500">预估成本</div><div className="mt-1 font-semibold text-ink">USD {Number(batchSummary.estimatedTotalCost || 0).toFixed(4)}</div></div>
          </div>
          <div className="mt-3 grid gap-2">
            {(batchSummary.recentBatches || []).slice(0, 5).map((batch) => (
              <Link key={batch.id} to={`/batches/${batch.id}`} className="rounded border border-slate-200 bg-white p-3 text-sm hover:border-mint">
                <div className="flex flex-wrap justify-between gap-2">
                  <span className="font-semibold text-ink">{batch.name}</span>
                  <span className="text-slate-500">{batch.status}</span>
                </div>
                <div className="mt-1 text-xs text-slate-500">
                  SKU {batch.totalSku} / 失败 {batch.failedSku} / high risk {batch.highRiskCount} / 预估 USD {Number(batch.estimatedCost || 0).toFixed(4)}
                </div>
              </Link>
            ))}
          </div>
        </Section>
      )}

      <Section title="任务列表">
        {loading ? (
          <div className="text-sm text-slate-500">正在加载任务...</div>
        ) : tasks.length === 0 ? (
          <div className="flex flex-col items-start gap-3 py-8">
            <p className="text-sm text-slate-500">暂无任务。</p>
            <Link to="/upload" className="focus-ring rounded bg-mint px-4 py-2 text-sm font-semibold text-white">上传商品图片</Link>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[760px] border-collapse text-sm">
              <thead>
                <tr className="border-b border-slate-200 text-left text-slate-500">
                  <th className="py-3 pr-4 font-medium">SKU</th>
                  <th className="py-3 pr-4 font-medium">商品</th>
                  <th className="py-3 pr-4 font-medium">平台</th>
                  <th className="py-3 pr-4 font-medium">状态</th>
                  <th className="py-3 pr-4 font-medium">更新时间</th>
                  <th className="py-3 text-right font-medium">操作</th>
                </tr>
              </thead>
              <tbody>
                {tasks.map((task) => (
                  <tr key={task.id} className="border-b border-slate-100">
                    <td className="py-3 pr-4 font-medium text-ink">{task.productInfo?.sku || task.sku}</td>
                    <td className="py-3 pr-4 text-slate-700">{task.productInfo?.name || task.sourceImages?.[0]?.displayName || task.originalImage?.fileName}</td>
                    <td className="py-3 pr-4 text-slate-700">
                      {task.targets?.length > 1 ? `${task.targets.length} 个平台` : task.targets?.[0]?.platformName || task.platform}
                    </td>
                    <td className="py-3 pr-4"><StatusBadge status={task.status} /></td>
                    <td className="py-3 pr-4 text-slate-500">{new Date(task.updatedAt).toLocaleString()}</td>
                    <td className="py-3 text-right">
                      <Link to={nextRoute(task)} className="inline-flex items-center gap-1 font-semibold text-mint hover:text-teal-800">
                        继续 <ArrowRight size={15} />
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
