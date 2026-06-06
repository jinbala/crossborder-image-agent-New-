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
  const metadata = snapshot.metadata || {};
  return (
    <div className="grid gap-2 text-xs text-slate-600 md:grid-cols-6">
      <div>任务 {metadata.dbSummary?.taskCount ?? '-'}</div>
      <div>批量 {metadata.dbSummary?.batchTaskCount ?? '-'}</div>
      <div>模板 {metadata.dbSummary?.workflowTemplateCount ?? '-'}</div>
      <div>uploads {metadata.fileSummary?.uploadsCount ?? '-'}</div>
      <div>outputs {metadata.fileSummary?.outputsCount ?? '-'}</div>
      <div>大小 {formatSize(snapshot.size || metadata.fileSummary?.totalSize || 0)}</div>
    </div>
  );
}

export default function SnapshotPage() {
  const [snapshots, setSnapshots] = useState([]);
  const [options, setOptions] = useState({
    includeUploads: true,
    includeOutputs: true,
    includeDocs: true,
    note: ''
  });
  const [restoreOptions, setRestoreOptions] = useState({
    restoreDb: true,
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
    if (!window.confirm('确定删除这个快照吗？删除后无法通过系统恢复。')) return;
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
    const confirmed = window.confirm('恢复快照将覆盖当前 db/uploads/outputs（按勾选项执行），不会恢复 .env 或 API Key。建议保持“恢复前自动创建快照”开启。确定继续吗？');
    if (!confirmed) return;
    setBusy(`restore-${snapshotId}`);
    setError('');
    setRestoreReport(null);
    try {
      const result = await api.restoreSnapshot(snapshotId, {
        ...restoreOptions,
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
        <h1 className="text-2xl font-semibold text-ink">项目快照 / 备份恢复</h1>
        <p className="mt-1 text-sm text-slate-500">手动创建本地 zip 快照，保护 db、上传原图、生成图和报告。快照不会包含 .env、API Key、node_modules 或临时目录。</p>
      </div>

      <ErrorMessage error={error} />
      {restoreReport && (
        <div className="rounded border border-teal-200 bg-teal-50 p-3 text-sm text-teal-800">
          恢复完成：db {restoreReport.restored?.db ? '已恢复' : '未恢复'} / uploads {restoreReport.restored?.uploads ? '已恢复' : '未恢复'} / outputs {restoreReport.restored?.outputs ? '已恢复' : '未恢复'}。
          {restoreReport.preRestoreSnapshotId && <span> 恢复前快照：{restoreReport.preRestoreSnapshotId}</span>}
        </div>
      )}

      <Section title="创建新快照">
        <div className="grid gap-3 md:grid-cols-4">
          <label className="flex items-center gap-2 text-sm text-slate-700"><input type="checkbox" checked={options.includeUploads} onChange={(event) => updateOption('includeUploads', event.target.checked)} />包含 uploads 原图</label>
          <label className="flex items-center gap-2 text-sm text-slate-700"><input type="checkbox" checked={options.includeOutputs} onChange={(event) => updateOption('includeOutputs', event.target.checked)} />包含 outputs 生成图</label>
          <label className="flex items-center gap-2 text-sm text-slate-700"><input type="checkbox" checked={options.includeDocs} onChange={(event) => updateOption('includeDocs', event.target.checked)} />包含 docs 报告</label>
          <div className="text-xs text-slate-500">默认排除 .env / node_modules / .vision-tmp / backups / test-results</div>
        </div>
        <label className="mt-3 block">
          <span className="mb-1 block text-sm font-medium text-slate-700">备注</span>
          <input value={options.note} onChange={(event) => updateOption('note', event.target.value)} className="w-full rounded border border-slate-300 px-3 py-2 text-sm" placeholder="例如：真实识别稳定版、恢复前备份、交付前备份" />
        </label>
        <div className="mt-3">
          <PrimaryButton busy={busy === 'create'} onClick={create}>创建快照</PrimaryButton>
        </div>
      </Section>

      <Section title="恢复选项">
        <div className="grid gap-2 md:grid-cols-5">
          <label className="flex items-center gap-2 text-sm text-slate-700"><input type="checkbox" checked={restoreOptions.restoreDb} onChange={(event) => updateRestoreOption('restoreDb', event.target.checked)} />恢复 db.json</label>
          <label className="flex items-center gap-2 text-sm text-slate-700"><input type="checkbox" checked={restoreOptions.restoreUploads} onChange={(event) => updateRestoreOption('restoreUploads', event.target.checked)} />恢复 uploads</label>
          <label className="flex items-center gap-2 text-sm text-slate-700"><input type="checkbox" checked={restoreOptions.restoreOutputs} onChange={(event) => updateRestoreOption('restoreOutputs', event.target.checked)} />恢复 outputs</label>
          <label className="flex items-center gap-2 text-sm text-slate-700"><input type="checkbox" checked={restoreOptions.restoreDocs} onChange={(event) => updateRestoreOption('restoreDocs', event.target.checked)} />恢复 docs</label>
          <label className="flex items-center gap-2 text-sm text-slate-700"><input type="checkbox" checked={restoreOptions.createBackupBeforeRestore} onChange={(event) => updateRestoreOption('createBackupBeforeRestore', event.target.checked)} />恢复前自动备份</label>
        </div>
        <p className="mt-2 text-xs text-amber-700">恢复会覆盖当前数据，必须手动确认；不会恢复 .env，也不会恢复任何 API Key。</p>
      </Section>

      <Section title="快照列表">
        {snapshots.length === 0 ? (
          <div className="text-sm text-slate-500">暂无快照。</div>
        ) : (
          <div className="space-y-3">
            {snapshots.map((snapshot) => (
              <div key={snapshot.snapshotId} className="rounded border border-slate-200 bg-white p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <div className="font-semibold text-ink">{snapshot.snapshotId}</div>
                    <div className="mt-1 text-xs text-slate-500">{new Date(snapshot.createdAt || snapshot.metadata?.createdAt).toLocaleString()}</div>
                    {snapshot.metadata?.notes?.length > 0 && <div className="mt-1 text-sm text-slate-600">{snapshot.metadata.notes.join('；')}</div>}
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <a href={api.snapshotDownloadUrl(snapshot.snapshotId)} className="rounded border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700">下载</a>
                    <button type="button" disabled={Boolean(busy)} onClick={() => restore(snapshot.snapshotId)} className="rounded border border-amber-300 bg-white px-3 py-2 text-sm font-medium text-amber-700 disabled:opacity-60">恢复</button>
                    <button type="button" disabled={Boolean(busy)} onClick={() => remove(snapshot.snapshotId)} className="rounded border border-red-300 bg-white px-3 py-2 text-sm font-medium text-red-700 disabled:opacity-60">删除</button>
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
