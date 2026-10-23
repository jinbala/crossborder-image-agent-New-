import { useLocale } from '../i18n/LocaleProvider.jsx';
import { useEffect, useRef, useState } from 'react';
import { useAccount } from '../components/AuthGate.jsx';
import { createRecoveryLoader, recoveryIndexPending } from '../utils/desktopRecovery.js';
import { Link, useNavigate } from 'react-router-dom';
import Section from '../components/Section.jsx';
import DesktopUpdates from '../components/DesktopUpdates.jsx';
import { api } from '../services/api.js';
import { Pager } from './WorkspacePages.jsx';

const names = { data: '任务数据', uploads: '导入图片', outputs: '处理结果', backups: '备份', logs: '运行日志', cache: '临时文件', models: '本地模型' };

export default function DesktopPage() {
  const { t } = useLocale();
  const actorId = useAccount()?.user?.id || 'local';
  const recoveryLoader = useRef(null);
  const [info, setInfo] = useState(null);
  const [runtime, setRuntime] = useState(null);
  const [recoveryPage, setRecoveryPage] = useState(1);
  const [error, setError] = useState('');
  const [recoveryError, setRecoveryError] = useState(null);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [log, setLog] = useState('');
  const [logQuery, setLogQuery] = useState({ taskId: '', from: '', to: '' });
  const [directory, setDirectory] = useState('');
  const [pairing, setPairing] = useState(null);
  const navigate = useNavigate();
  const bridge = window.desktop;

  async function refresh() {
    return recoveryLoader.current?.load(recoveryPage);
  }
  useEffect(() => {
    setRuntime(null); setRecoveryError(null);
    const loader = createRecoveryLoader({
      getInfo: () => bridge?.info(),
      getRuntime: (page, options) => api.getDesktopRuntime({ page, pageSize: 50 }, options),
      onData: ({ info, runtime }) => { setInfo(info || null); setRuntime(runtime); setRecoveryError(null); },
      onError: setRecoveryError
    });
    recoveryLoader.current = loader;
    void loader.load(recoveryPage);
    return () => { loader.dispose(); if (recoveryLoader.current === loader) recoveryLoader.current = null; };
  }, [recoveryPage, actorId]);
  async function run(action) {
    setBusy(true); setError(''); setMessage('');
    try { await action(); } catch (err) { setError(err.message); } finally { setBusy(false); }
  }
  async function importDirectory(selected) {
    if (!selected) return;
    setDirectory(selected);
    const result = await bridge.importDirectory(selected);
    if (result?.batchTask?.id) navigate(`/batches/${result.batchTask.id}`);
  }
  return (
    <div className="space-y-6">
      <div><h1 className="text-2xl font-semibold text-ink">{t("客户端与恢复")}</h1><p className="mt-2 text-sm text-slate-600">{t("查看本地运行状态、导入 SKU 文件夹、恢复未完成任务和导出诊断信息。")}</p></div>
      {error && <p role="alert" className="rounded border border-red-200 bg-red-50 p-3 text-red-700">{error}</p>}
      {recoveryError && <div role="alert" data-recovery-error className="rounded border border-red-200 bg-red-50 p-3 text-sm text-red-700"><p>{recoveryError.code === 'RECOVERY_INVALID_RESPONSE' ? t('恢复接口返回无效，请点击刷新状态重试。') : recoveryError.message}</p><p className="mt-1">{t('请确认账号权限和本地服务状态，再点击刷新状态重试。不会自动继续任何业务任务。')}</p></div>}
      {message && <p role="status" className="rounded bg-teal-50 p-3 text-teal-800">{message}</p>}
      {info?.startupRecovery && <p role="status" data-startup-recovery className="rounded bg-amber-50 p-3 text-sm text-amber-900">{t('上次客户端未正常退出，已进入恢复页。请核对恢复点后手动继续；不会自动重复付费调用或平台写入。')}</p>}
      <Section title={t("本地运行状态")}>
        <div className="space-y-3 text-sm">
          <p>{info ? t('Windows 客户端 v{version}', { version: info.version }) : t("当前通过浏览器使用本地工作台")}</p>
          <p>{t("存储：")}{runtime?.storageDriver || t("读取中")}{" " + t("· 未完成任务：")}{runtime?.recoveryPagination?.total ?? '—'}</p>
          {info && <><p className="break-all">{t("服务：")}{info.serviceUrl}</p><p className="break-all">{t("数据目录：")}{info.dataRoot}</p></>}
          <div className="flex flex-wrap gap-2">
            <button className="btn-secondary" disabled={busy} onClick={() => run(refresh)}>{t("刷新状态")}</button>
            <button className="btn-secondary" disabled={busy} onClick={() => run(async () => { const result = await api.pauseAllQueues(); setMessage(result.message); await refresh(); })}>{t("暂停全部队列")}</button>
            {bridge && <button className="btn-secondary" disabled={busy} onClick={() => run(async () => { if (window.confirm(t('重启本地服务会中断当前执行，请先暂停队列。是否继续？'))) await bridge.restartService(); })}>{t("重启本地服务")}</button>}
            <Link className="btn-secondary" to="/health">{t("环境诊断")}</Link>
            {bridge && <button className="btn-secondary" disabled={busy} onClick={() => run(() => bridge.configureRembg())}>{t("配置本地 rembg 依赖与模型目录")}</button>}
          </div>
        </div>
      </Section>
      <Section title={t("SKU 文件夹导入")}>
        {bridge ? <div className="space-y-3" onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); const selected = bridge.droppedPaths(event.dataTransfer.files)[0]; run(() => importDirectory(selected)); }}>
          <div className="rounded border-2 border-dashed border-slate-300 p-8 text-center text-slate-600">{t("将包含 SKU 子文件夹的根目录拖到这里，或点击选择目录。")}</div>
          <button className="btn-primary" disabled={busy} onClick={() => run(async () => importDirectory(await bridge.chooseDirectory()))}>{t("选择目录并导入")}</button>
          {directory && <p className="break-all text-sm text-slate-500">{directory}</p>}
        </div> : <p className="text-sm text-slate-600">{t("原生目录选择和拖放在 Windows 客户端中可用。也可以使用") + " "}<Link className="text-mint underline" to="/workbench/sku-pack">{t("网页 SKU 图包上传")}</Link>。</p>}
      </Section>
      <Section title={t("未完成任务")}>
        {recoveryIndexPending(runtime) && <p className="mb-3 rounded bg-blue-50 p-3 text-sm text-blue-800">{t('正在后台整理历史任务索引：{processed} / {total}。列表会自动刷新，原任务文件不变。', { processed: runtime.indexStatus.processed, total: runtime.indexStatus.total ?? t('检测中') })}</p>}
        {runtime?.indexStatus?.status === 'failed' && <p role="alert" className="mb-3 rounded bg-amber-50 p-3 text-sm text-amber-800">{t('历史任务索引未完成，当前列表可能不齐全。请到任务中心重建索引或重试刷新。')}</p>}
        {runtime?.indexStatus?.failed > 0 && <p className="mb-3 text-sm text-amber-800">{t('{count} 个历史清单损坏、超出索引体积限制或路径不合法，未自动纳入；请检查备份。其余任务不受影响。', { count: runtime.indexStatus.failed })}</p>}
        {runtime?.indexStatus?.recovered > 0 && <p data-recovery-snapshot-count className="mb-3 text-sm text-amber-800">{t('{count} 个历史任务从备份或结果包只读纳入索引；主清单未修复，任务未执行。', { count: runtime.indexStatus.recovered })}</p>}
        <p className="mb-3 text-sm text-slate-600">{t("恢复前先查看任务详情。涉及付费生成或平台操作的任务由你确认后继续。")}</p>
        <div data-recovery-index-status={runtime?.indexStatus?.status || 'loading'} data-recovery-loaded-page={runtime?.recoveryPagination?.page || 0} className="space-y-2">{runtime?.recovery?.map((item) => <div data-recovery-id={item.id} key={`${item.type}:${item.id}`} className="flex flex-wrap items-center justify-between gap-3 rounded border border-slate-200 p-3">
          <div><p className="font-medium">{item.name} <span className="text-sm text-slate-500">{item.state}</span></p><p className="text-sm text-slate-500">{item.manifestRecovery?.readOnly === true ? t('此任务从恢复快照只读列出；请先查看详情并确认修复，不要直接继续。') : item.hint}</p></div><Link to={item.href} className="btn-secondary">{t("查看任务")}</Link>
        </div>)}{runtime && !runtime.recovery.length && <p className="text-sm text-slate-500">{t("没有需要恢复的任务。")}</p>}</div>
        <div data-recovery-pager><Pager pagination={runtime?.recoveryPagination} onPage={setRecoveryPage} /></div>
      </Section>
      {bridge && <Section title={t("连接浏览器扩展")}>
        <div className="space-y-3 text-sm"><p>{t("打开扩展的“客户端连接”，填写下面的服务地址和一次性配对码。客户端重启后重新配对。")}</p><p className="break-all">{t("服务地址：")}{info?.serviceUrl || t("读取中")}</p>
          <button className="btn-secondary" disabled={busy} onClick={() => run(async () => setPairing(await api.createExtensionPairingCode()))}>{t("生成一次性配对码")}</button>
          {pairing && <p>{t("配对码：")}<code className="select-all rounded bg-teal-50 px-3 py-1 font-mono text-lg text-teal-900">{pairing.code}</code> <span className="text-slate-500">{t("5 分钟内有效")}</span></p>}
        </div>
      </Section>}
      {bridge && <>
        <DesktopUpdates />
        <Section title={t("本地目录")}>
          <div className="flex flex-wrap gap-2">{Object.keys(names).map((key) => <button key={key} className="btn-secondary" disabled={busy} onClick={() => run(() => bridge.openDirectory(key))}>{t(names[key])}</button>)}<button className="btn-secondary" disabled={busy} onClick={() => run(() => bridge.openDirectory('extension'))}>{t("浏览器扩展")}</button></div>
        </Section>
        <Section title={t("运行日志与支持包")}>
          <p className="mb-3 text-sm text-slate-600">{t("支持包包含环境和脱敏日志，不包含原图、数据库和账号凭据。")}</p>
          <div className="mb-3 grid gap-3 md:grid-cols-3"><label className="text-sm">{t("任务 ID")}<input className="mt-1 w-full rounded border p-2" value={logQuery.taskId} onChange={(event) => setLogQuery({ ...logQuery, taskId: event.target.value })} /></label>{[['from', '开始时间'], ['to', '结束时间']].map(([key, title]) => <label key={key} className="text-sm">{t(title)}<input type="datetime-local" className="mt-1 w-full rounded border p-2" value={logQuery[key]} onChange={(event) => setLogQuery({ ...logQuery, [key]: event.target.value })} /></label>)}</div>
          <p className="mb-3 text-xs text-slate-500">{t("筛选当前日志最近 128 KB；完整轮转日志可从“运行日志”目录查看。")}</p>
          <div className="mb-3 flex gap-2"><button className="btn-secondary" disabled={busy} onClick={() => run(async () => setLog(await bridge.readLog(logQuery)))}>{t("读取筛选日志")}</button><button className="btn-primary" disabled={busy} onClick={() => run(async () => { const result = await bridge.exportSupport(); if (result.saved) setMessage(t('已导出 {name}', { name: result.fileName })); })}>{t("导出诊断包")}</button></div>
          {log && <pre className="max-h-96 overflow-auto rounded bg-slate-900 p-4 text-xs text-slate-100">{log}</pre>}
        </Section>
      </>}
    </div>
  );
}
