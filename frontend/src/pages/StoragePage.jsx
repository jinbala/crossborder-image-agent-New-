import { useEffect, useState } from 'react';
import Section from '../components/Section.jsx';
import { api } from '../services/api.js';
import { ErrorMessage, PrimaryButton } from './pageUtils.jsx';

function StatusPill({ value }) {
  const status = value || 'unknown';
  const color = status === 'ready' || status === 'healthy' || status === true
    ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
    : status === 'failed' || status === false
      ? 'border-red-200 bg-red-50 text-red-700'
      : 'border-amber-200 bg-amber-50 text-amber-700';
  return <span className={`inline-flex rounded border px-2 py-1 text-xs font-semibold ${color}`}>{String(status)}</span>;
}

function ReportBlock({ title, data }) {
  if (!data) return null;
  return (
    <div className="rounded border border-slate-200 bg-slate-50 p-3">
      <div className="mb-2 text-sm font-semibold text-ink">{title}</div>
      <pre className="max-h-72 overflow-auto whitespace-pre-wrap text-xs text-slate-700">{JSON.stringify(data, null, 2)}</pre>
    </div>
  );
}

export default function StoragePage() {
  const [status, setStatus] = useState(null);
  const [preflight, setPreflight] = useState(null);
  const [migration, setMigration] = useState(null);
  const [verification, setVerification] = useState(null);
  const [rebuild, setRebuild] = useState(null);
  const [trialChecklist, setTrialChecklist] = useState(null);
  const [trialReport, setTrialReport] = useState(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');

  async function load() {
    setError('');
    try {
      const [storageStatus, checklist] = await Promise.all([
        api.getStorageStatus(),
        api.getSqliteTrialChecklist()
      ]);
      setStatus(storageStatus);
      setTrialChecklist(checklist);
    } catch (err) {
      setError(err.message);
    }
  }

  useEffect(() => {
    load();
  }, []);

  async function runAction(name, fn) {
    setBusy(name);
    setError('');
    setMessage('');
    try {
      const result = await fn();
      await load();
      return result;
    } catch (err) {
      setError(err.message);
      return null;
    } finally {
      setBusy('');
    }
  }

  async function handlePreflight() {
    const result = await runAction('preflight', api.preflightSqlite);
    if (result) setPreflight(result.report);
  }

  async function handleMigrate() {
    if (!window.confirm('迁移会创建 SQLite 元数据副本，但不会删除 db.json，也不会修改 .env。确认继续？')) return;
    const result = await runAction('migrate', () => api.migrateToSqlite({
      confirm: true,
      createSnapshotBeforeMigrate: true,
      overwriteExistingSqlite: false
    }));
    if (result) {
      setMigration(result.report);
      setMessage('迁移完成。请继续执行 SQLite 验证，验证通过后再手动修改 .env。');
    }
  }

  async function handleVerify() {
    const result = await runAction('verify', api.verifySqlite);
    if (result) {
      setVerification(result.report);
      setMessage(result.report?.success ? 'SQLite 验证通过。请按说明手动切换 .env 并重启后端。' : 'SQLite 验证失败，请继续使用 JSON 并查看报告。');
    }
  }

  async function handleRebuild() {
    const result = await runAction('rebuild', api.rebuildSqliteIndexes);
    if (result) {
      setRebuild(result.report);
      setMessage('SQLite 索引已重建。建议再次执行验证。');
    }
  }

  async function handleTrialCheck() {
    const result = await runAction('trial-check', api.runSqliteTrialCheck);
    if (result) {
      setTrialReport(result.report);
      setMessage(result.report?.recommendedAction?.message || 'SQLite 试运行验收检查已完成。');
    }
  }

  async function copyTrialReport() {
    const report = trialReport || status?.sqliteTrial?.lastTrialCheckReport;
    if (!report) return;
    try {
      await navigator.clipboard.writeText(JSON.stringify(report, null, 2));
      setMessage('SQLite 试运行验收报告已复制。');
    } catch {
      setError('复制失败，请手动选择报告内容。');
    }
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-ink">存储管理 / SQLite 试运行</h1>
          <p className="mt-1 text-sm text-slate-500">安全迁移、验证和试运行 SQLite。页面不会修改 .env，也不会删除 JSON 数据。</p>
        </div>
        <button type="button" onClick={load} className="rounded border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700">刷新状态</button>
      </div>

      <ErrorMessage error={error} />
      {message && <div className="rounded border border-teal-200 bg-teal-50 px-4 py-3 text-sm text-teal-800">{message}</div>}

      <Section title="当前存储状态">
        {status ? (
          <div className="grid gap-3 text-sm md:grid-cols-4">
            <div className="rounded border border-slate-200 p-3"><div className="text-xs text-slate-500">当前模式</div><div className="mt-2"><StatusPill value={status.storageDriver === 'sqlite' ? 'SQLite' : 'JSON'} /></div></div>
            <div className="rounded border border-slate-200 p-3"><div className="text-xs text-slate-500">db.json</div><div className="mt-2"><StatusPill value={status.jsonDbExists} /></div></div>
            <div className="rounded border border-slate-200 p-3"><div className="text-xs text-slate-500">app.sqlite</div><div className="mt-2"><StatusPill value={status.sqliteDbExists} /></div></div>
            <div className="rounded border border-slate-200 p-3"><div className="text-xs text-slate-500">索引表</div><div className="mt-2"><StatusPill value={status.indexTablesReady} /></div></div>
            <div className="rounded border border-slate-200 p-3 md:col-span-2"><div className="text-xs text-slate-500">SQLite 路径</div><div className="mt-1 break-all font-mono text-xs">{status.sqlitePath}</div></div>
            <div className="rounded border border-slate-200 p-3"><div className="text-xs text-slate-500">schemaVersion</div><div className="mt-1 font-semibold text-ink">{status.schemaVersion || '-'}</div></div>
            <div className="rounded border border-slate-200 p-3"><div className="text-xs text-slate-500">试运行状态</div><div className="mt-2"><StatusPill value={status.sqliteTrial?.status} /></div></div>
          </div>
        ) : (
          <div className="text-sm text-slate-500">正在读取存储状态...</div>
        )}
        {status?.warnings?.length > 0 && (
          <div className="mt-3 rounded border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
            {status.warnings.map((warning) => <div key={warning.code}>{warning.message}</div>)}
          </div>
        )}
      </Section>

      <Section title="SQLite 试运行操作">
        <div className="grid gap-3 md:grid-cols-4">
          <PrimaryButton busy={busy === 'preflight'} onClick={handlePreflight}>迁移前检查</PrimaryButton>
          <PrimaryButton busy={busy === 'migrate'} onClick={handleMigrate}>创建快照并迁移</PrimaryButton>
          <PrimaryButton busy={busy === 'verify'} onClick={handleVerify}>验证 SQLite</PrimaryButton>
          <PrimaryButton busy={busy === 'rebuild'} onClick={handleRebuild}>重建 SQLite 索引</PrimaryButton>
        </div>
        <div className="mt-4 rounded border border-slate-200 bg-white p-3 text-sm text-slate-600">
          <div className="font-semibold text-ink">手动切换说明</div>
          <div className="mt-2">验证通过后，请手动修改本地 <code>.env</code>，然后重启后端：</div>
          <pre className="mt-2 rounded bg-slate-950 p-3 text-xs text-slate-100">{`STORAGE_DRIVER=sqlite
SQLITE_DB_PATH=backend/data/app.sqlite`}</pre>
          <div className="mt-2">如果试运行异常，可临时改回：</div>
          <pre className="mt-2 rounded bg-slate-950 p-3 text-xs text-slate-100">STORAGE_DRIVER=json</pre>
          <div className="mt-2 text-amber-700">切换前建议关闭正在运行的批量队列；页面不会自动编辑 .env。</div>
        </div>
      </Section>

      <Section title="SQLite 试运行验收">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="text-sm text-slate-600">
            用 1 个单 SKU 和 1 个小 batch 验证 SQLite 模式。验收检查不会调用真实 AI，也不会修改 .env。
            <div className="mt-1 text-xs text-slate-500">
              最近验收：{status?.sqliteTrial?.lastTrialCheckAt ? new Date(status.sqliteTrial.lastTrialCheckAt).toLocaleString() : '暂无'}
              {' / '}
              状态：{status?.sqliteTrial?.lastTrialCheckStatus || '未开始'}
            </div>
          </div>
          <div className="flex gap-2">
            <button type="button" onClick={copyTrialReport} disabled={!(trialReport || status?.sqliteTrial?.lastTrialCheckReport)} className="rounded border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 disabled:opacity-60">复制验收报告</button>
            <PrimaryButton busy={busy === 'trial-check'} onClick={handleTrialCheck}>运行验收检查</PrimaryButton>
          </div>
        </div>
        <div className="mt-4 space-y-2">
          {(trialReport?.items || status?.sqliteTrial?.trialChecklist || trialChecklist?.items || []).map((entry) => (
            <div key={entry.id} className="flex flex-wrap items-start justify-between gap-3 rounded border border-slate-200 bg-white p-3 text-sm">
              <div>
                <div className="font-semibold text-ink">{entry.title}</div>
                <div className="mt-1 text-xs text-slate-500">{entry.message || '等待检查'}</div>
              </div>
              <StatusPill value={entry.status} />
            </div>
          ))}
        </div>
        {(trialReport || status?.sqliteTrial?.lastTrialCheckReport)?.recommendedAction && (
          <div className="mt-3 rounded border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
            推荐操作：{(trialReport || status.sqliteTrial.lastTrialCheckReport).recommendedAction.message}
          </div>
        )}
      </Section>

      <div className="grid gap-4 lg:grid-cols-2">
        <ReportBlock title="迁移前检查报告" data={preflight} />
        <ReportBlock title="迁移报告" data={migration || status?.sqliteTrial?.lastMigrationReport} />
        <ReportBlock title="验证报告" data={verification || status?.sqliteTrial?.lastVerificationReport} />
        <ReportBlock title="索引重建报告" data={rebuild} />
        <ReportBlock title="SQLite 试运行验收报告" data={trialReport || status?.sqliteTrial?.lastTrialCheckReport} />
      </div>
    </div>
  );
}
