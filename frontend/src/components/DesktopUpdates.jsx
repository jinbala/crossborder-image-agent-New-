import { useLocale } from '../i18n/LocaleProvider.jsx';
import { useEffect, useState } from 'react';
import Section from './Section.jsx';

export default function DesktopUpdates() {
  const { t } = useLocale();
  const [info, setInfo] = useState(null), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const bridge = window.desktop;
  useEffect(() => { bridge?.updateInfo().then(setInfo).catch((err) => setError(err.message)); }, []);
  async function run(fn) { setBusy(true); setError(''); try { setInfo(await fn()); } catch (err) { setError(err.message); } finally { setBusy(false); } }
  if (!bridge) return null;
  return <Section title={t("签名更新与历史版本回退")}><div className="space-y-3 text-sm"><p>{t("只有受信任发布者签名、大小和 SHA-256 全部验证通过的安装包可以执行。下载失败不修改当前版本；可以延后安装。安装新版本前必须先保存当前版本的签名回退包。回退不自动降级数据库，请先在备份页保存快照。")}</p>{error && <p className="text-red-700" role="alert">{error}</p>}{info?.configured ? <div className="flex flex-wrap gap-3"><button className="btn-secondary" disabled={busy} onClick={() => run(() => bridge.updateCheck())}>{t("检查更新")}</button><button className="btn-secondary" disabled={busy} onClick={() => run(() => bridge.updateImport())}>{t("导入签名回退包（不执行）")}</button></div> : <p className="text-amber-700">{t("尚未配置发布者公钥和 HTTPS 更新源。自动更新关闭，请使用手动交付的安装包。")}</p>}{info?.available && <div className="rounded border p-3"><p className="font-medium">{t("可用版本") + " "}{info.available.version}</p><p className="my-3 whitespace-pre-wrap">{info.available.notes}</p><button className="btn-primary" disabled={busy} onClick={() => { if (window.confirm(t("确认下载更新包？验证完成后仍需单独批准安装。"))) run(() => bridge.updateStage()); }}>{t("下载并校验")}</button></div>}{info?.staged.map((item) => <div className="flex items-center justify-between gap-3 rounded border p-3" key={item.version}><p>{t("已验证版本") + " "}{item.version}</p><button disabled={busy} className="btn-secondary" onClick={() => run(async () => { await bridge.updateInstall(item.version); return bridge.updateInfo(); })}>{t("安装 / 回退到此版本")}</button></div>)}</div></Section>;
}
