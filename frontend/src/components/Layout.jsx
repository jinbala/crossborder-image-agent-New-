import { Link, useLocation } from 'react-router-dom';
import { Activity, Boxes, ClipboardCheck, Database, DatabaseBackup, Gauge, ImagePlus, Layers, Scissors, Settings, Trash2 } from 'lucide-react';

export default function Layout({ children }) {
  const location = useLocation();
  return (
    <div className="min-h-screen">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-7xl items-center justify-between gap-4 px-5 py-4">
          <Link to="/" className="flex items-center gap-3 font-semibold text-ink">
            <span className="grid h-9 w-9 place-items-center rounded bg-mint text-white">
              <Boxes size={20} />
            </span>
            <span>跨境商品图片助手</span>
          </Link>
          <div className="flex flex-wrap items-center gap-2">
            <Link to="/batches" className="focus-ring inline-flex items-center gap-2 rounded border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 hover:border-mint hover:text-mint">
              <Layers size={17} />
              批量任务
            </Link>
            <Link to="/stress-test" className="focus-ring inline-flex items-center gap-2 rounded border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 hover:border-mint hover:text-mint">
              <Gauge size={17} />
              批量压测
            </Link>
            <Link to="/matting" className="focus-ring inline-flex items-center gap-2 rounded border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 hover:border-mint hover:text-mint">
              <Scissors size={17} />
              主体抠图
            </Link>
            <Link to="/final-acceptance" className="focus-ring inline-flex items-center gap-2 rounded border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 hover:border-mint hover:text-mint">
              <ClipboardCheck size={17} />
              最终验收
            </Link>
            <Link to="/upload" className="focus-ring inline-flex items-center gap-2 rounded bg-ink px-3 py-2 text-sm font-medium text-white hover:bg-slate-700">
              <ImagePlus size={17} />
              新建任务
            </Link>
            <Link to="/settings" className="focus-ring inline-flex items-center gap-2 rounded border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 hover:border-mint hover:text-mint">
              <Settings size={17} />
              设置中心
            </Link>
            <Link to="/health" className="focus-ring inline-flex items-center gap-2 rounded border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 hover:border-mint hover:text-mint">
              <Activity size={17} />
              系统诊断
            </Link>
            <Link to="/storage" className="focus-ring inline-flex items-center gap-2 rounded border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 hover:border-mint hover:text-mint">
              <Database size={17} />
              存储
            </Link>
            <Link to="/snapshots" className="focus-ring inline-flex items-center gap-2 rounded border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 hover:border-mint hover:text-mint">
              <DatabaseBackup size={17} />
              备份
            </Link>
            <Link to="/cleanup" className="focus-ring inline-flex items-center gap-2 rounded border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 hover:border-mint hover:text-mint">
              <Trash2 size={17} />
              数据清理
            </Link>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-7xl px-5 py-6">
        {location.pathname !== '/' && (
          <div className="mb-5 text-sm text-slate-500">
            <Link to="/" className="font-medium text-mint hover:text-teal-800">任务首页</Link>
            <span className="mx-2">/</span>
            <span>任务流程</span>
          </div>
        )}
        {children}
      </main>
    </div>
  );
}
