import { useLocale } from '../i18n/LocaleProvider.jsx';
import { useEffect, useState } from 'react';
import Section from '../components/Section.jsx';
import { api } from '../services/api.js';
import { ErrorMessage, PrimaryButton } from './pageUtils.jsx';

function formatSize(bytes = 0) {
  if (!bytes) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

function SnapshotSummary({ snapshot }) {
  const { t } = useLocale();
  const metadata = snapshot.metadata || {};
  return (
    <div className="grid gap-2 text-xs text-slate-600 md:grid-cols-6">
      <div>{t("任务") + " "}{metadata.dbSummary?.taskCount ?? '-'}</div>
      <div>{t("批量") + " "}{metadata.dbSummary?.batchTaskCount ?? '-'}</div>
      <div>{t("模板") + " "}{metadata.dbSummary?.workflowTemplateCount ?? '-'}</div>
      <div>uploads {metadata.fileSummary?.uploadsCount ?? '-'}</div>
      <div>outputs {metadata.fileSummary?.outputsCount ?? '-'}</div>
      <div>{t("大小") + " "}{formatSize(snapshot.size || metadata.fileSummary?.totalSize || 0)}</div>
    </div>
  );
}

export default function SnapshotPage() {
  const { t, dateTime } = useLocale();
  const [snapshots, setSnapshots] = useState([]);
  const [options, setOptions] = useState({
    includeUploads: true,
    includeOutputs: true,
    includeDocs: true,
    includePlatformDb: true,
    note: ''
  });
  const [restoreOptions, setRestoreOptions] = useState({
    restoreDb: true,
    restoreSqliteDb: false,
    restorePlatformDb: false,
    restoreMaterials: true,
    restoreUploads: true,
    restoreOutputs: true,
    restoreDocs: false,
    createBackupBeforeRestore: true
  });
  const [restoreReport, setRestoreReport] = useState(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');

  async function load() {
    setError('');
    try {
      const result = await api.listSnapshots();
      setSnapshots(result.snapshots || []);
    } catch (err) {
      setError(err.message);
    }
  }

  useEffect(() => {
    load();
    api.getStorageStatus().then((result) => { if (result.storageDriver === 'sqlite') setRestoreOptions((current) => ({ ...current, restoreDb: false, restoreSqliteDb: true })); }).catch((err) => setError(err.message));
  }, []);

  function updateOption(key, value) {
    setOptions((current) => ({ ...current, [key]: value }));
  }

  function updateRestoreOption(key, value) {
    setRestoreOptions((current) => ({ ...current, [key]: value }));
  }

  async function create() {
    setBusy('create');
    setError('');
    setRestoreReport(null);
    try {
      await api.createSnapshot(options);
      setOptions((current) => ({ ...current, note: '' }));
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy('');
    }
  }

  async function remove(snapshotId) {
    if (!window.confirm(t("确定删除这个快照吗？删除后无法通过系统恢复。"))) return;
    setBusy(`delete-${snapshotId}`);
    setError('');
    try {
      await api.deleteSnapshot(snapshotId, true);
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy('');
    }
  }

  async function restore(snapshotId) {
    const confirmed = window.confirm(t('恢复快照将覆盖勾选的 db/uploads/outputs，不恢复 .env 或明文 Provider 密钥。建议保持“恢复前自动创建快照”开启。确定继续吗？'));
    if (!confirmed) return;
    if (restoreOptions.restorePlatformDb && !window.confirm(t("恢复账号工作空间会撤销当前所有会话，停用设备、ERP 与店铺授权；需用备份中的账号重新登录并重新授权。加密密钥不在快照中，请单独保管。确认恢复？"))) return;
    setBusy(`restore-${snapshotId}`);
    setError('');
    setRestoreReport(null);
    try {
      const result = await api.restoreSnapshot(snapshotId, {
        ...restoreOptions,
        confirmRevokeAuthorizations: restoreOptions.restorePlatformDb,
        confirm: true
      });
      setRestoreReport(result.report);
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy('');
    }
  }

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-semibold text-ink">{t("项目快照 / 备份恢复")}</h1>
        <p className="mt-1 text-sm text-slate-500">{t("手动创建本地 zip 快照，保护任务、素材、原图和结果。包含工作空间时会备份账号密码散列与加密授权数据，请私密保管，不要作为诊断包公开。不会备份 .env、明文 API Key 或凭据加密密钥。")}</p>
      </div>

      <ErrorMessage error={error} />
      {restoreReport && (
        <div className="rounded border border-teal-200 bg-teal-50 p-3 text-sm text-teal-800">{t('恢复完成：db {db} / uploads {uploads} / outputs {outputs}。', { db: t(restoreReport.restored?.db ? '已恢复' : '未恢复'), uploads: t(restoreReport.restored?.uploads ? '已恢复' : '未恢复'), outputs: t(restoreReport.restored?.outputs ? '已恢复' : '未恢复') })}
          {restoreReport.preRestoreSnapshotId && <span>{" " + t("恢复前快照：")}{restoreReport.preRestoreSnapshotId}</span>}
        </div>
      )}

      <Section title={t("创建新快照")}>
        <div className="grid gap-3 md:grid-cols-4">
          <label className="flex items-center gap-2 text-sm text-slate-700"><input type="checkbox" checked={options.includeUploads} onChange={(event) => updateOption('includeUploads', event.target.checked)} />{t("包含 uploads 原图")}</label>
          <label className="flex items-center gap-2 text-sm text-slate-700"><input type="checkbox" checked={options.includeOutputs} onChange={(event) => updateOption('includeOutputs', event.target.checked)} />{t("包含 outputs 生成图")}</label>
          <label className="flex items-center gap-2 text-sm text-slate-700"><input type="checkbox" checked={options.includeDocs} onChange={(event) => updateOption('includeDocs', event.target.checked)} />{t("包含 docs 报告")}</label>
          <label className="flex items-center gap-2 text-sm text-slate-700"><input type="checkbox" checked={options.includePlatformDb} onChange={(event) => updateOption('includePlatformDb', event.target.checked)} />{t("包含账号、模板与工作空间")}</label>
          <div className="text-xs text-slate-500">{t("默认排除 .env / node_modules / .vision-tmp / backups / test-results")}</div>
        </div>
        <label className="mt-3 block">
          <span className="mb-1 block text-sm font-medium text-slate-700">{t("备注")}</span>
          <input value={options.note} onChange={(event) => updateOption('note', event.target.value)} className="w-full rounded border border-slate-300 px-3 py-2 text-sm" placeholder={t("例如：真实识别稳定版、恢复前备份、交付前备份")} />
        </label>
        <div className="mt-3">
          <PrimaryButton busy={busy === 'create'} onClick={create}>{t("创建快照")}</PrimaryButton>
        </div>
      </Section>

      <Section title={t("恢复选项")}>
        <div className="grid gap-2 md:grid-cols-5">
          <label className="flex items-center gap-2 text-sm text-slate-700"><input type="checkbox" checked={restoreOptions.restoreDb} onChange={(event) => updateRestoreOption('restoreDb', event.target.checked)} />{t("恢复 db.json")}</label>
          <label className="flex items-center gap-2 text-sm text-slate-700"><input type="checkbox" checked={restoreOptions.restoreSqliteDb} onChange={(event) => updateRestoreOption('restoreSqliteDb', event.target.checked)} />{t("恢复 SQLite 任务库")}</label>
          <label className="flex items-center gap-2 text-sm text-slate-700"><input type="checkbox" checked={restoreOptions.restorePlatformDb} onChange={(event) => updateRestoreOption('restorePlatformDb', event.target.checked)} />{t("恢复工作空间（撤销旧授权）")}</label>
          <label className="flex items-center gap-2 text-sm text-slate-700"><input type="checkbox" checked={restoreOptions.restoreMaterials} onChange={(event) => updateRestoreOption('restoreMaterials', event.target.checked)} />{t("恢复素材台账")}</label>
          <label className="flex items-center gap-2 text-sm text-slate-700"><input type="checkbox" checked={restoreOptions.restoreUploads} onChange={(event) => updateRestoreOption('restoreUploads', event.target.checked)} />{t("恢复 uploads")}</label>
          <label className="flex items-center gap-2 text-sm text-slate-700"><input type="checkbox" checked={restoreOptions.restoreOutputs} onChange={(event) => updateRestoreOption('restoreOutputs', event.target.checked)} />{t("恢复 outputs")}</label>
          <label className="flex items-center gap-2 text-sm text-slate-700"><input type="checkbox" checked={restoreOptions.restoreDocs} onChange={(event) => updateRestoreOption('restoreDocs', event.target.checked)} />{t("恢复 docs")}</label>
          <label className="flex items-center gap-2 text-sm text-slate-700"><input type="checkbox" checked={restoreOptions.createBackupBeforeRestore} onChange={(event) => updateRestoreOption('createBackupBeforeRestore', event.target.checked)} />{t("恢复前自动备份")}</label>
        </div>
        <p className="mt-2 text-xs text-amber-700">{t('恢复会覆盖勾选的数据，必须手动确认；不恢复 .env、明文 Provider 密钥或凭据加密主密钥。工作空间恢复会停用旧授权。')}</p>
      </Section>

      <Section title={t("快照列表")}>
        {snapshots.length === 0 ? (
          <div className="text-sm text-slate-500">{t("暂无快照。")}</div>
        ) : (
          <div className="space-y-3">
            {snapshots.map((snapshot) => (
              <div key={snapshot.snapshotId} data-snapshot-id={snapshot.snapshotId} className="rounded border border-slate-200 bg-white p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <div className="font-semibold text-ink">{snapshot.snapshotId}</div>
                    <div className="mt-1 text-xs text-slate-500">{dateTime(snapshot.createdAt || snapshot.metadata?.createdAt)}</div>
                    {snapshot.metadata?.notes?.length > 0 && <div className="mt-1 text-sm text-slate-600">{snapshot.metadata.notes.join('；')}</div>}
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <a href={api.snapshotDownloadUrl(snapshot.snapshotId)} className="rounded border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700">{t("下载")}</a>
                    <button type="button" disabled={Boolean(busy)} onClick={() => restore(snapshot.snapshotId)} className="rounded border border-amber-300 bg-white px-3 py-2 text-sm font-medium text-amber-700 disabled:opacity-60">{t("恢复")}</button>
                    <button type="button" disabled={Boolean(busy)} onClick={() => remove(snapshot.snapshotId)} className="rounded border border-red-300 bg-white px-3 py-2 text-sm font-medium text-red-700 disabled:opacity-60">{t("删除")}</button>
                  </div>
                </div>
                <div className="mt-3">
                  <SnapshotSummary snapshot={snapshot} />
                </div>
              </div>
            ))}
          </div>
        )}
      </Section>
    </div>
  );
}
