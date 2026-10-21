import { useLocale } from '../i18n/LocaleProvider.jsx';
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../services/api.js';

export function useTask(taskId) {
  const [task, setTask] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [settledId, setSettledId] = useState(null);
  const requestScope = useRef({ taskId, generation: 0 });
  if (requestScope.current.taskId !== taskId) requestScope.current = { taskId, generation: requestScope.current.generation + 1 };

  async function refresh() {
    const scope = requestScope.current;
    const generation = ++scope.generation;
    const current = () => requestScope.current === scope && scope.generation === generation;
    setLoading(true);
    setError('');
    try {
      const result = await api.getTask(taskId);
      if (!current()) return;
      if (!result.task || result.task.id !== taskId) throw new Error('任务响应与当前页面不匹配，请重新读取任务。');
      setTask(result.task);
    } catch (err) {
      if (current()) { setTask(null); setError(err.message); }
    } finally {
      if (current()) { setSettledId(taskId); setLoading(false); }
    }
  }

  useEffect(() => {
    refresh();
    return () => { requestScope.current.generation += 1; };
  }, [taskId]);

  return { task: task?.id === taskId ? task : null, setTask, loading: loading || settledId !== taskId, error: settledId === taskId ? error : '', refresh, setError };
}

export function TaskLoadFailure({ error, onRetry }) {
  const { t } = useLocale();
  return <div data-task-load-failure className="space-y-3"><ErrorMessage error={error || t('任务不存在或当前账号无权访问。')} /><p className="text-sm text-slate-500">{t('任务读取失败，未执行写入。请检查连接或权限后重试。')}</p><button type="button" data-task-retry onClick={onRetry} className="btn-secondary">{t('重新读取任务')}</button><Link to="/task-center" className="btn-secondary inline-block">{t('返回任务中心')}</Link></div>;
}

export function taskImageUrl(task) {
  return task?.sourceImages?.[0]?.url || task?.originalImage?.url || '';
}

export function Field({ label, children }) {
  return (
    <label className="block">
      <span className="mb-1 block text-sm font-medium text-slate-700">{label}</span>
      {children}
    </label>
  );
}

export function TextInput(props) {
  return (
    <input
      {...props}
      className="focus-ring w-full rounded border border-slate-300 bg-white px-3 py-2 text-sm"
    />
  );
}

export function TextArea(props) {
  return (
    <textarea
      {...props}
      className="focus-ring min-h-24 w-full rounded border border-slate-300 bg-white px-3 py-2 text-sm"
    />
  );
}

export function PrimaryButton({ children, busy, ...props }) {
  const { t } = useLocale();
  return (
    <button
      {...props}
      disabled={busy || props.disabled}
      className="focus-ring inline-flex items-center justify-center gap-2 rounded bg-mint px-4 py-2 text-sm font-semibold text-white hover:bg-teal-800 disabled:cursor-not-allowed disabled:opacity-60"
    >
      {busy ? t("处理中...") : children}
    </button>
  );
}

export function DisabledReason({ reason }) {
  if (!reason) return null;
  return <div className="mt-2 text-xs font-medium text-slate-500">{reason}</div>;
}

export function ErrorMessage({ error }) {
  if (!error) return null;
  return <div role="alert" className="mb-4 rounded border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>;
}
