import { useLocale } from '../i18n/LocaleProvider.jsx';
import { Check, Circle, Dot } from 'lucide-react';
import StatusBadge from './StatusBadge.jsx';
import { TASK_STEPS, statusIndex } from '../utils/taskWorkflow.js';

export default function TaskProgress({ task }) {
  const { t } = useLocale();
  const currentIndex = statusIndex(task?.status);
  const targetCount = task?.targets?.length || 0;

  return (
    <section className="rounded border border-slate-200 bg-white p-4">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="text-sm font-semibold text-ink">{t("任务进度")}</div>
          <div className="mt-1 text-xs text-slate-500">{t("请按顺序完成流程，避免任务状态不合法。")}</div>
          {targetCount > 1 && (
            <div className="mt-1 text-xs font-medium text-teal-700">{t("多平台目标：")}{targetCount}{" " + t("个")}</div>
          )}
        </div>
        <StatusBadge status={task?.status} />
      </div>
      <div data-task-progress-grid className="grid gap-2 md:grid-cols-4 2xl:grid-cols-8">
        {TASK_STEPS.map((step, index) => {
          const completed = currentIndex > index;
          const current = currentIndex === index;
          const pending = currentIndex < index || currentIndex === -1;

          return (
            <div
              key={step.status}
              className={[
                'flex min-h-16 min-w-0 items-center gap-2 rounded border px-3 py-2 text-sm',
                completed && 'border-emerald-200 bg-emerald-50 text-emerald-800',
                current && 'border-mint bg-teal-50 font-semibold text-mint',
                pending && 'border-slate-200 bg-slate-50 text-slate-400'
              ].filter(Boolean).join(' ')}
            >
              <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-white">
                {completed ? <Check size={14} /> : current ? <Dot size={20} /> : <Circle size={12} />}
              </span>
              <span className="min-w-0 break-words">{t(step.label)}</span>
            </div>
          );
        })}
      </div>
    </section>
  );
}
