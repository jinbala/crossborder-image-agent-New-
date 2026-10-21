import { useLocale } from '../i18n/LocaleProvider.jsx';
import { useEffect, useMemo, useState } from 'react';
import { RefreshCw, Trash2 } from 'lucide-react';
import Section from '../components/Section.jsx';
import { api } from '../services/api.js';
import { ErrorMessage, PrimaryButton } from './pageUtils.jsx';
import { maintenanceLabel, cleanupSafetyLabels } from '../utils/maintenanceLabels.js';
import {
  CLEANUP_GROUP_OPTIONS,
  cleanupEmptyPreviewMessage,
  cleanupPreviewStats,
  cleanupRunDisabled,
  formatCleanupBytes,
  normalizeCleanupPayload
} from '../utils/cleanup.js';

const DAY_OPTIONS = [7, 30, 90];

function RiskPill({ value }) {
  const { t } = useLocale();
  const color = value === 'safe'
    ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
    : value === 'caution'
      ? 'border-amber-200 bg-amber-50 text-amber-700'
      : 'border-red-200 bg-red-50 text-red-700';
  return <span className={`inline-flex rounded border px-2 py-1 text-xs font-semibold ${color}`}>{maintenanceLabel(value, cleanupSafetyLabels, t)}</span>;
}

function SummaryCard({ label, bytes = 0, fileCount = 0, suffix = '个文件' }) {
  const { t } = useLocale();
  return (
    <div className="rounded border border-slate-200 bg-white p-3">
      <div className="text-xs text-slate-500">{label}</div>
      <div className="mt-1 text-lg font-semibold text-ink">{formatCleanupBytes(bytes)}</div>
      <div className="mt-1 text-xs text-slate-500">{suffix === '天前' ? t('{days} 天前', { days: fileCount }) : t('文件数：{count}', { count: fileCount })}</div>
    </div>
  );
}

export default function CleanupPage() {
  const { t, dateTime } = useLocale();
  const [summary, setSummary] = useState(null);
  const [preview, setPreview] = useState(null);
  const [result, setResult] = useState(null);
  const [olderThanDays, setOlderThanDays] = useState(30);
  const [customDays, setCustomDays] = useState('');
  const [selectedGroups, setSelectedGroups] = useState(() => (
    CLEANUP_GROUP_OPTIONS.filter((option) => option.defaultChecked).map((option) => option.value)
  ));
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');

  const payload = useMemo(() => normalizeCleanupPayload({
    olderThanDays: customDays ? customDays : olderThanDays,
    groups: selectedGroups
  }), [customDays, olderThanDays, selectedGroups]);
  const stats = cleanupPreviewStats(preview);
  const emptyPreviewMessage = cleanupEmptyPreviewMessage(preview, summary, selectedGroups);

  async function loadSummary() {
    setError('');
    try {
      setSummary(await api.getCleanupSummary());
    } catch (err) {
      setError(err.message);
    }
  }

  useEffect(() => {
    loadSummary();
  }, []);

  function toggleGroup(groupName) {
    setSelectedGroups((current) => (
      current.includes(groupName)
        ? current.filter((value) => value !== groupName)
        : [...current, groupName]
    ));
    setPreview(null);
    setResult(null);
  }

  async function previewFiles() {
    setBusy('preview');
    setError('');
    setResult(null);
    try {
      setPreview(await api.previewCleanup(payload));
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy('');
    }
  }

  async function runCleanup() {
    if (cleanupRunDisabled(preview)) return;
    const confirmed = window.confirm(t("即将删除预览列表中的文件，此操作不可撤销。确认继续吗？"));
    if (!confirmed) return;
    setBusy('run');
    setError('');
    try {
      const cleanupResult = await api.runCleanup({ ...payload, confirm: true });
      setResult(cleanupResult);
      setPreview(null);
      await loadSummary();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy('');
    }
  }

  const summaryGroups = summary?.groups || [];

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-ink">{t("数据清理 / 临时文件管理")}</h1>
          <p className="mt-1 max-w-4xl text-sm text-slate-500">{t("这里用于清理运行过程中产生的临时文件、旧导出文件、旧 mock 图片和测试结果。不会删除 .env、数据库、源码和配置文件。")}</p>
        </div>
        <button type="button" onClick={loadSummary} className="focus-ring inline-flex items-center gap-2 rounded border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700">
          <RefreshCw size={16} />{t("刷新占用")}</button>
      </div>

      <ErrorMessage error={error} />

      {result && (
        <div className="rounded border border-teal-200 bg-teal-50 p-3 text-sm text-teal-800">{t('清理完成：删除 {deleted} 个文件，释放 {bytes}，跳过 {skipped} 个文件。', { deleted: result.deletedFiles, bytes: formatCleanupBytes(result.deletedBytes), skipped: result.skippedFiles })}{result.errors?.length > 0 && <span className="ml-2 text-red-700">{t('{count} 个文件删除失败。', { count: result.errors.length })}</span>}
        </div>
      )}

      <Section title={t("运行文件占用")}>
        <div className="grid gap-3 md:grid-cols-4 lg:grid-cols-7">
          <SummaryCard label={t("总占用")} bytes={summary?.totalBytes || 0} fileCount={summary?.totalFiles || 0} />
          {summaryGroups.slice(0, 6).map((group) => (
            <SummaryCard key={group.groupName} label={t(group.groupLabel)} bytes={group.bytes} fileCount={group.fileCount} />
          ))}
        </div>
      </Section>

      <Section title={t("清理条件")}>
        <div className="grid gap-5 lg:grid-cols-2">
          <div>
            <div className="text-sm font-semibold text-ink">{t("时间筛选")}</div>
            <div className="mt-2 flex flex-wrap gap-2">
              {DAY_OPTIONS.map((days) => (
                <button
                  key={days}
                  type="button"
                  onClick={() => {
                    setOlderThanDays(days);
                    setCustomDays('');
                    setPreview(null);
                  }}
                  className={`rounded border px-3 py-2 text-sm font-medium ${!customDays && olderThanDays === days ? 'border-mint bg-mint text-white' : 'border-slate-300 bg-white text-slate-700'}`}
                >
                  {t('{days} 天前', { days })}</button>
              ))}
              <input
                type="number"
                min="0"
                value={customDays}
                onChange={(event) => {
                  setCustomDays(event.target.value);
                  setPreview(null);
                }}
                className="w-36 rounded border border-slate-300 px-3 py-2 text-sm"
                placeholder={t("自定义天数")}
              />
            </div>
          </div>
          <div>
            <div className="text-sm font-semibold text-ink">{t("可清理类型")}</div>
            <div className="mt-2 grid gap-2 sm:grid-cols-2">
              {CLEANUP_GROUP_OPTIONS.map((option) => (
                <label key={option.value} className="flex items-start gap-2 rounded border border-slate-200 bg-white p-2 text-sm text-slate-700">
                  <input
                    type="checkbox"
                    checked={selectedGroups.includes(option.value)}
                    onChange={() => toggleGroup(option.value)}
                    className="mt-1"
                  />
                  <span>
                    <span className="font-medium">{t(option.label)}</span>
                    {option.caution && <span className="mt-1 block text-xs text-amber-700">{t(option.caution)}</span>}
                  </span>
                </label>
              ))}
            </div>
          </div>
        </div>
        <div className="mt-4 flex flex-wrap gap-2">
          <PrimaryButton busy={busy === 'preview'} onClick={previewFiles}>{t("预览可清理文件")}</PrimaryButton>
          <button
            type="button"
            disabled={cleanupRunDisabled(preview) || busy === 'run'}
            onClick={runCleanup}
            className="focus-ring inline-flex items-center justify-center gap-2 rounded border border-red-300 bg-white px-4 py-2 text-sm font-semibold text-red-700 hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-60"
          >
            <Trash2 size={16} />{t("确认清理预览中的文件")}</button>
        </div>
      </Section>

      {preview && (
        <Section title={t("预览结果")}>
          <div className="mb-4 grid gap-3 md:grid-cols-3">
            <SummaryCard label={t("候选文件")} bytes={preview.totalBytes || 0} fileCount={stats.totalFiles} />
            <SummaryCard label={t("可删除文件")} bytes={stats.deletableBytes} fileCount={stats.deletableFiles} />
            <SummaryCard label={t("时间阈值")} bytes={0} fileCount={preview.olderThanDays || payload.olderThanDays} suffix="天前" />
          </div>
          {emptyPreviewMessage && (
            <div className="mb-4 rounded border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-800">
              {t(emptyPreviewMessage)}
            </div>
          )}
          <div className="space-y-4">
            {(preview.groups || []).map((group) => (
              <div key={group.groupName} className="rounded border border-slate-200">
                <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 px-3 py-2">
                  <div className="font-semibold text-ink">{t(group.groupLabel)}</div>
                  <div className="text-xs text-slate-500">{t('文件数：{count}', { count: group.fileCount })} / {formatCleanupBytes(group.bytes)}</div>
                </div>
                {group.files?.length ? (
                  <div className="max-h-80 overflow-auto">
                    <table className="w-full min-w-[760px] border-collapse text-sm">
                      <thead>
                        <tr className="border-b border-slate-100 bg-slate-50 text-left text-xs text-slate-500">
                          <th className="px-3 py-2 font-medium">{t("文件")}</th>
                          <th className="px-3 py-2 font-medium">{t("大小")}</th>
                          <th className="px-3 py-2 font-medium">{t("修改时间")}</th>
                          <th className="px-3 py-2 font-medium">{t("风险")}</th>
                          <th className="px-3 py-2 font-medium">{t("原因")}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {group.files.map((file) => (
                          <tr key={file.relativePath} className="border-b border-slate-100">
                            <td className="break-all px-3 py-2 font-mono text-xs text-slate-700">{file.relativePath}</td>
                            <td className="px-3 py-2 text-slate-600">{formatCleanupBytes(file.sizeBytes)}</td>
                            <td className="px-3 py-2 text-slate-500">{dateTime(file.modifiedAt)}</td>
                            <td className="px-3 py-2"><RiskPill value={file.riskLevel} /></td>
                            <td className="px-3 py-2 text-slate-600">{t(file.reason)}{!file.deletable ? t("（不会删除）") : ''}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <div className="px-3 py-4 text-sm text-slate-500">{t("没有符合条件的文件。")}</div>
                )}
              </div>
            ))}
          </div>
        </Section>
      )}

      {result?.errors?.length > 0 && (
        <Section title={t("删除失败列表")}>
          <div className="space-y-2 text-sm">
            {result.errors.map((item) => (
              <div key={item.relativePath} className="rounded border border-red-200 bg-red-50 p-3 text-red-700">
                <span className="font-mono">{item.relativePath}</span>
                <span className="ml-2">{item.message}</span>
              </div>
            ))}
          </div>
        </Section>
      )}
    </div>
  );
}
