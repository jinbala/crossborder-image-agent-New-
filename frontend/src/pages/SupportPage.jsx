import { useLocale } from '../i18n/LocaleProvider.jsx';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../services/api.js';
import Section from '../components/Section.jsx';

export default function SupportPage() {
  const { t } = useLocale();
  const [report, setReport] = useState(null), [error, setError] = useState('');
  async function load() { try { setReport(await api.getSupportStatus()); setError(''); } catch (err) { setError(err.message); } }
  useEffect(() => { load(); }, []);
  function download() {
    if (!window.confirm(t('导出仅含版本、运行环境和依赖状态的脱敏诊断？不含图片、业务记录、账号清单、凭据、绝对路径或原始日志。'))) return;
    const url = URL.createObjectURL(new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' }));
    const anchor = document.createElement('a'); anchor.href = url; anchor.download = `sanitized-diagnostics-${report.version}.json`; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return <div className="space-y-5"><h1 className="text-2xl font-semibold">{t("技术支持诊断")}</h1><p className="rounded border border-blue-200 bg-blue-50 p-4 text-sm leading-7 text-blue-900">{t("当前为只读诊断视图。技术支持不能访问业务图片、任务、商品、素材或凭据，也不能绑定设备、修改配置、清理数据或执行任务。需要详细支持包时，由管理员在客户端确认后导出。")}</p>{error && <p role="alert" className="rounded bg-red-50 p-3 text-sm text-red-700">{error}</p>}<div className="flex flex-wrap gap-3"><button className="btn-secondary" onClick={load}>{t("刷新诊断")}</button><button className="btn-primary" disabled={!report} onClick={download}>{t("导出脱敏诊断 JSON")}</button><Link className="btn-secondary" to="/account">{t("自己的账号与操作记录")}</Link><Link className="btn-secondary" to="/announcements">{t("公告与帮助")}</Link></div>{report && <Section title={t("环境与依赖")}><div className="space-y-3 text-sm"><p>{t("版本：")}{report.version} · {report.runtime.platform} / {report.runtime.arch}</p><p>{t("数据库：")}{report.environment.databaseReady ? t("可用") : t("异常")} · {report.environment.storageDriver}</p><p>Sharp：{report.dependencies.sharp}{" " + t("· SQLite 驱动：")}{report.dependencies.sqlite}</p><p>{t("可用内存：")}{(report.environment.availableMemoryBytes / 1024 ** 3).toFixed(1)}{" " + t("GB · 可用磁盘：")}{report.environment.availableDiskBytes == null ? t("检测不可用") : `${(report.environment.availableDiskBytes / 1024 ** 3).toFixed(1)} GB`}</p><details><summary>{t("查看脱敏诊断字段")}</summary><pre className="mt-3 max-h-96 overflow-auto rounded bg-slate-50 p-3 text-xs">{JSON.stringify(report, null, 2)}</pre></details></div></Section>}</div>;
}
