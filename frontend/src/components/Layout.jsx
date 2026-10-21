import { Link, useLocation } from 'react-router-dom';
import { useAccount, roleNames } from './AuthGate.jsx';
import LanguageSwitcher from './LanguageSwitcher.jsx';
import { useLocale } from '../i18n/LocaleProvider.jsx';
import { Activity, Boxes, ClipboardCheck, Database, DatabaseBackup, Gauge, ImagePlus, Layers, Monitor, Scissors, Settings, Sparkles, Trash2 } from 'lucide-react';

const navItems = [
  { to: '/workbench', label: '运营工作台', icon: Sparkles, primary: true },
  { to: '/batches', label: '批量任务', icon: Layers },
  { to: '/matting', label: '主体抠图', icon: Scissors },
  { to: '/upload', label: '新建任务', icon: ImagePlus },
  { to: '/settings', label: '设置', icon: Settings }
];

const moreItems = [
  { to: '/support', label: '技术支持诊断', icon: Activity },
  { to: '/connections', label: '店铺与 ERP 授权', icon: Settings },
  { to: '/sync', label: '设备绑定与同步', icon: Monitor },
  { to: '/task-center', label: '统一任务中心', icon: Layers },
  { to: '/products', label: '商品中心', icon: Boxes },
  { to: '/userSpace', label: '个人空间', icon: Database },
  { to: '/studio', label: '创作工作室', icon: Sparkles },
  { to: '/account', label: '个人与团队', icon: Settings },
  { to: '/announcements', label: '公告与帮助', icon: ClipboardCheck },
  { to: '/desktop', label: '客户端与恢复', icon: Monitor },
  { to: '/stress-test', label: '批量压测', icon: Gauge },
  { to: '/final-acceptance', label: '最终验收', icon: ClipboardCheck },
  { to: '/health', label: '系统诊断', icon: Activity },
  { to: '/storage', label: '存储', icon: Database },
  { to: '/snapshots', label: '备份', icon: DatabaseBackup },
  { to: '/cleanup', label: '数据清理', icon: Trash2 }
];

function NavLink({ item, location }) {
  const { t } = useLocale();
  const Icon = item.icon;
  const active = location.pathname === item.to || location.pathname.startsWith(`${item.to}/`);
  const base = 'focus-ring inline-flex items-center gap-2 rounded px-3 py-2 text-sm font-medium transition';
  const style = item.primary
    ? (active ? 'bg-teal-800 text-white' : 'bg-ink text-white hover:bg-slate-700')
    : (active ? 'border border-teal-200 bg-teal-50 text-mint' : 'border border-slate-300 bg-white text-slate-700 hover:border-mint hover:text-mint');
  return <Link to={item.to} className={`${base} ${style}`}><Icon size={17} />{t(item.label)}</Link>;
}

export default function Layout({ children }) {
  const { t } = useLocale();
  const location = useLocation();
  const account = useAccount();
  const support = account?.user?.role === 'support';
  const primaryNavigation = support ? [{ to: '/support', label: '技术支持诊断', icon: Activity, primary: true }] : navItems;
  const secondaryNavigation = support ? moreItems.filter((item) => ['/account', '/announcements'].includes(item.to)) : moreItems.filter((item) => item.to !== '/support' || account?.user?.role === 'admin');
  return (
    <div className="min-h-screen">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-4 px-5 py-4">
          <Link to="/" className="flex items-center gap-3 font-semibold text-ink">
            <span className="grid h-9 w-9 place-items-center rounded bg-mint text-white"><Boxes size={20} /></span>
            <span>{t('跨境商品图片助手')}</span>
          </Link>
          <nav className="flex flex-wrap items-center gap-2">
            <LanguageSwitcher />
            <Link to="/account" className="text-xs text-slate-500">{account?.user?.displayName} · {t(roleNames[account?.user?.role] || '本地')}</Link>
            {primaryNavigation.map((item) => <NavLink key={item.to} item={item} location={location} />)}
            <details className="relative">
              <summary className="focus-ring cursor-pointer list-none rounded border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 hover:border-mint hover:text-mint">{t('更多')}</summary>
              <div className="absolute right-0 z-20 mt-2 grid min-w-40 gap-1 rounded border border-slate-200 bg-white p-2 shadow-lg">
                {secondaryNavigation.map((item) => {
                  const Icon = item.icon;
                  return <Link key={item.to} to={item.to} className="flex items-center gap-2 rounded px-3 py-2 text-sm text-slate-700 hover:bg-slate-50 hover:text-mint"><Icon size={16} />{t(item.label)}</Link>;
                })}
              </div>
            </details>
          </nav>
        </div>
      </header>
      <main className="mx-auto max-w-7xl px-5 py-6">
        {location.pathname !== '/' && (
          <div className="mb-5 text-sm text-slate-500">
            <Link to="/" className="font-medium text-mint hover:text-teal-800">{t('任务首页')}</Link>
            <span className="mx-2">/</span><span>{t('功能页面')}</span>
          </div>
        )}
        {children}
      </main>
    </div>
  );
}
