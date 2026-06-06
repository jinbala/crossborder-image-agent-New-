import { NavLink } from 'react-router-dom';

const steps = [
  ['product', '商品信息'],
  ['rules', '平台规则'],
  ['plans', '图片方案'],
  ['generate', '生成预览'],
  ['review', '合规审核'],
  ['export', '导出']
];

export default function StepNav({ taskId }) {
  return (
    <nav className="mb-5 flex flex-wrap gap-2">
      {steps.map(([key, label]) => (
        <NavLink
          key={key}
          to={`/tasks/${taskId}/${key}`}
          className={({ isActive }) =>
            [
              'rounded border px-3 py-2 text-sm font-medium',
              isActive
                ? 'border-mint bg-teal-50 text-mint'
                : 'border-slate-200 bg-white text-slate-600 hover:border-slate-300'
            ].join(' ')
          }
        >
          {label}
        </NavLink>
      ))}
    </nav>
  );
}
