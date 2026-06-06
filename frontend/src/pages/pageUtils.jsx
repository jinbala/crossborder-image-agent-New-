import { useEffect, useState } from 'react';
import { api } from '../services/api.js';

export function useTask(taskId) {
  const [task, setTask] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  async function refresh() {
    setLoading(true);
    setError('');
    try {
      const result = await api.getTask(taskId);
      setTask(result.task);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    refresh();
  }, [taskId]);

  return { task, setTask, loading, error, refresh, setError };
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
  return (
    <button
      {...props}
      disabled={busy || props.disabled}
      className="focus-ring inline-flex items-center justify-center gap-2 rounded bg-mint px-4 py-2 text-sm font-semibold text-white hover:bg-teal-800 disabled:cursor-not-allowed disabled:opacity-60"
    >
      {busy ? '处理中...' : children}
    </button>
  );
}

export function DisabledReason({ reason }) {
  if (!reason) return null;
  return <div className="mt-2 text-xs font-medium text-slate-500">{reason}</div>;
}

export function ErrorMessage({ error }) {
  if (!error) return null;
  return <div className="mb-4 rounded border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>;
}
