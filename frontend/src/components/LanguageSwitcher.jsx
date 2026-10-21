import { useLocale } from '../i18n/LocaleProvider.jsx';

export default function LanguageSwitcher() {
  const { locale, setLocale, t } = useLocale();
  return <div className="inline-flex flex-col gap-1"><label className="inline-flex items-center gap-2 text-xs text-slate-600"><span>{t('界面语言')}</span><select data-i18n-skip aria-label="Interface language / 界面语言" className="focus-ring rounded border border-slate-300 bg-white px-2 py-2 text-sm" value={locale} onChange={(event) => setLocale(event.target.value)}><option value="zh-CN" lang="zh-CN">简体中文</option><option value="en-US" lang="en-US">English</option></select></label>{locale === 'en-US' && <span className="max-w-56 text-xs text-slate-500">Translation in progress; some pages remain in Chinese.</span>}</div>;
}
