import { useLocale } from '../i18n/LocaleProvider.jsx';
const styles = {
  new: 'bg-emerald-50 text-emerald-700',
  uploaded: 'bg-slate-100 text-slate-700',
  recognized: 'bg-sky-100 text-sky-800',
  confirmed: 'bg-blue-100 text-blue-800',
  rules_selected: 'bg-indigo-100 text-indigo-800',
  planned: 'bg-amber-100 text-amber-800',
  generated: 'bg-cyan-100 text-cyan-800',
  reviewed: 'bg-emerald-100 text-emerald-800',
  review_passed: 'bg-emerald-100 text-emerald-800',
  review_failed: 'bg-red-100 text-red-800',
  exported: 'bg-purple-100 text-purple-800',
  failed: 'bg-red-100 text-red-800',
  partial_failed: 'bg-red-100 text-red-800',
  waiting_confirm: 'bg-sky-100 text-sky-800',
  completed: 'bg-emerald-100 text-emerald-800'
};

const labels = {
  new: 'new',
  uploaded: '已上传',
  recognized: '已识别',
  confirmed: '已确认',
  rules_selected: '已选规则',
  planned: '已生成方案',
  generated: '已生成图片',
  reviewed: '已审核',
  review_passed: '审核通过',
  review_failed: '审核失败',
  exported: '已导出',
  failed: '失败',
  partial_failed: '部分失败',
  waiting_confirm: '等待确认',
  completed: '已完成',
  draft: '草稿',
  idle: '空闲',
  queued: '排队中',
  pending: '待处理',
  running: '运行中',
  waiting_user: '等待人工处理',
  paused: '已暂停',
  partial: '部分完成',
  cancelled: '已取消',
  cancelling: '正在取消'
};

export default function StatusBadge({ status }) {
  const { t } = useLocale();
  return (
    <span className={`inline-flex rounded px-2.5 py-1 text-xs font-semibold ${styles[status] || styles.uploaded}`}>
      {Object.hasOwn(labels, status) ? t(labels[status]) : status || t('新任务')}
    </span>
  );
}
