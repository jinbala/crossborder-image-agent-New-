import { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { LOCALE_KEY, normalizeLocale, persistLocale, readLocale, translate, formatDateTime } from './core.js';

function storage() { try { return window.localStorage; } catch { return null; } }
const Context = createContext({ locale: 'zh-CN', setLocale: () => {}, t: (source, values) => translate('zh-CN', source, values), dateTime: (value) => formatDateTime('zh-CN', value) });
export const useLocale = () => useContext(Context);
export default function LocaleProvider({ children }) {
  const [locale, updateLocale] = useState(() => readLocale(storage()));
  useEffect(() => {
    document.documentElement.lang = locale;
    document.title = translate(locale, '跨境商品图片助手');
  }, [locale]);
  useEffect(() => {
    const changed = (event) => { if (event.key === LOCALE_KEY || event.key === null) updateLocale(readLocale(storage())); };
    window.addEventListener('storage', changed);
    return () => window.removeEventListener('storage', changed);
  }, []);
  const value = useMemo(() => ({ locale,
    setLocale(next) { const safe = normalizeLocale(next); persistLocale(storage(), safe); updateLocale(safe); },
    t: (source, values) => translate(locale, source, values), dateTime: (input) => formatDateTime(locale, input)
  }), [locale]);
  return <Context.Provider value={value}>{children}</Context.Provider>;
}
