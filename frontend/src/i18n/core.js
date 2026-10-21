import { english } from './messages.js';

export const LOCALE_KEY = 'crossborder.ui.locale';
export const SUPPORTED_LOCALES = ['zh-CN', 'en-US'];
export function normalizeLocale(value) { return SUPPORTED_LOCALES.includes(value) ? value : 'zh-CN'; }
export function readLocale(storage) { try { return normalizeLocale(storage?.getItem(LOCALE_KEY)); } catch { return 'zh-CN'; } }
export function persistLocale(storage, locale) { try { if (!storage?.setItem) return false; storage.setItem(LOCALE_KEY, normalizeLocale(locale)); return true; } catch { return false; } }
export function translate(locale, source, values = {}) {
  if (typeof source !== 'string') return source;
  const template = normalizeLocale(locale) === 'en-US' && Object.hasOwn(english, source) ? english[source] : source;
  return template.replace(/\{([A-Za-z][A-Za-z0-9_]*)\}/g, (placeholder, key) => Object.hasOwn(values, key) ? String(values[key]) : placeholder);
}
export function formatDateTime(locale, value) {
  if (value == null || value === '') return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : new Intl.DateTimeFormat(normalizeLocale(locale), { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}
