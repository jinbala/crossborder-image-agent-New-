import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, CheckCircle2, ClipboardCopy, RefreshCw, XCircle } from 'lucide-react';
import Section from '../components/Section.jsx';
import { api } from '../services/api.js';
import { ErrorMessage } from './pageUtils.jsx';

const statusLabels = {
  healthy: '正常',
  warning: '有警告',
  error: '有错误'
};

const statusStyles = {
  healthy: 'border-teal-200 bg-teal-50 text-teal-800',
  warning: 'border-amber-200 bg-amber-50 text-amber-800',
  error: 'border-red-200 bg-red-50 text-red-800'
};

const categoryLabels = {
  env: '基础环境',
  provider: 'Provider',
  storage: '存储目录',
  database: '数据库',
  snapshot: '快照',
  queue: '批量队列',
  import: '导入扫描',
  network: '前后端地址',
  security: '安全'
};

function StatusIcon({ status }) {
  if (status === 'error') return <XCircle size={18} />;
  if (status === 'warning') return <AlertTriangle size={18} />;
  return <CheckCircle2 size={18} />;
}

function groupChecks(checks = []) {
  return checks.reduce((groups, check) => {
    const key = check.category || 'other';
    groups[key] = groups[key] || [];
    groups[key].push(check);
    return groups;
  }, {});
}

export default function HealthPage() {
  const [health, setHealth] = useState(null);
  const [markdown, setMarkdown] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');

  const groupedChecks = useMemo(() => groupChecks(health?.checks || []), [health]);

  async function load() {
    setLoading(true);
    setError('');
    setMessage('');
    try {
      const result = await api.getFullHealth();
      setHealth(result.health);
      setMarkdown(result.markdown || '');
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  async function copyReport() {
    try {
      await navigator.clipboard.writeText(markdown);
      setMessage('诊断报告已复制，可直接发给 ChatGPT / Codex 排查问题。');
    } catch {
      setError('复制失败，请手动选择页面中的诊断报告内容。');
    }
  }

  const overall = health?.overallStatus || 'warning';

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-ink">系统健康检查</h1>
          <p className="mt-1 text-sm text-slate-500">集中检查后端、Provider、目录权限、数据库、快照、批量队列和安全配置。不会显示真实密钥，也不会调用真实 AI。</p>
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={copyReport}
            disabled={!markdown}
            className="focus-ring inline-flex items-center gap-2 rounded border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 disabled:opacity-60"
          >
            <ClipboardCopy size={16} />
            复制诊断报告
          </button>
          <button
            type="button"
            onClick={load}
            disabled={loading}
            className="focus-ring inline-flex items-center gap-2 rounded bg-mint px-3 py-2 text-sm font-semibold text-white disabled:opacity-60"
          >
            <RefreshCw size={16} />
            {loading ? '检查中...' : '重新检查'}
          </button>
        </div>
      </div>

      <ErrorMessage error={error} />
      {message && <div className="rounded border border-teal-200 bg-teal-50 px-4 py-3 text-sm text-teal-800">{message}</div>}

      {health && (
        <div className={`rounded border px-4 py-3 ${statusStyles[overall]}`}>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2 text-lg font-semibold">
              <StatusIcon status={overall} />
              总体状态：{statusLabels[overall]}
            </div>
            <div className="text-sm">
              正常 {health.summary?.healthyCount || 0} / 警告 {health.summary?.warningCount || 0} / 错误 {health.summary?.errorCount || 0}
            </div>
          </div>
          <div className="mt-1 text-xs opacity-80">检查时间：{new Date(health.checkedAt).toLocaleString()}</div>
        </div>
      )}

      {loading && !health ? (
        <div className="text-sm text-slate-500">正在运行完整健康检查...</div>
      ) : (
        Object.entries(categoryLabels).map(([category, label]) => {
          const checks = groupedChecks[category] || [];
          if (!checks.length) return null;
          return (
            <Section key={category} title={label}>
              <div className="space-y-3">
                {checks.map((check) => (
                  <div key={check.id} className={`rounded border p-3 ${statusStyles[check.status] || statusStyles.warning}`}>
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div>
                        <div className="flex items-center gap-2 font-semibold">
                          <StatusIcon status={check.status} />
                          {check.title}
                        </div>
                        <p className="mt-1 text-sm">{check.message}</p>
                        {check.fixSuggestion && (
                          <p className="mt-2 rounded bg-white/60 px-3 py-2 text-sm">
                            修复建议：{check.fixSuggestion}
                          </p>
                        )}
                      </div>
                      <span className="rounded bg-white/70 px-2 py-1 text-xs font-semibold">{statusLabels[check.status] || check.status}</span>
                    </div>
                    {check.details && Object.keys(check.details).length > 0 && (
                      <details className="mt-2">
                        <summary className="cursor-pointer text-xs font-semibold">查看脱敏详情</summary>
                        <pre className="mt-2 max-h-56 overflow-auto rounded bg-white/80 p-3 text-xs text-slate-700">{JSON.stringify(check.details, null, 2)}</pre>
                      </details>
                    )}
                  </div>
                ))}
              </div>
            </Section>
          );
        })
      )}

      {markdown && (
        <Section title="诊断报告预览">
          <pre className="max-h-96 overflow-auto rounded bg-slate-950 p-4 text-xs text-slate-100">{markdown}</pre>
        </Section>
      )}
    </div>
  );
}
