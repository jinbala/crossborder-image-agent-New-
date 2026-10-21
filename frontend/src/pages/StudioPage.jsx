import { useLocale } from '../i18n/LocaleProvider.jsx';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import Section from '../components/Section.jsx';
import { ErrorBox, Pager } from './WorkspacePages.jsx';
import { api, ASSET_BASE } from '../services/api.js';
import { useAccount } from '../components/AuthGate.jsx';

const defaults = { mode: 'scene', name: '商品场景图', width: 1600, height: 1600, format: 'jpeg', quality: 90, background: '#ffffff', sharpen: false, normalize: false, placement: { x: 0.2, y: 0.2, width: 0.6, height: 0.6 }, brief: '' };
export default function StudioPage() {
  const { t } = useLocale();
  const account = useAccount();
  const writable = account.user.role !== 'viewer';
  const [options, setOptions] = useState({ ...defaults, ...(window.location.pathname === '/pod' ? { mode: 'pod', format: 'png', width: 2400, height: 3000 } : {}) });
  const [templates, setTemplates] = useState(null);
  const [selected, setSelected] = useState(null);
  const [history, setHistory] = useState([]);
  const [messages, setMessages] = useState([]);
  const [conversation, setConversation] = useState(null);
  const [message, setMessage] = useState('');
  const [plan, setPlan] = useState(null);
  const [files, setFiles] = useState([]);
  const [background, setBackground] = useState(null);
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [taskId, setTaskId] = useState('');
  async function load(page = 1) { setTemplates(await api.listPlatformRecords('preset', { page })); }
  useEffect(() => { load().catch((err) => setError(err.message)); }, []);
  async function run(fn) { setBusy(true); setError(''); try { await fn(); } catch (err) { setError(err.message); } finally { setBusy(false); } }
  async function chat(event) {
    event.preventDefault();
    await run(async () => {
      const next = [...messages, { role: 'user', content: message }];
      const response = await api.planCreativeBrief({ messages: next });
      next.push({ role: 'assistant', content: response.response });
      const saved = await api.savePlatformRecord('conversation', { data: { title: response.plan.title, messages: next, plan: response.plan }, baseVersion: conversation?.version }, conversation?.id);
      setConversation(saved); setMessages(next); setPlan(response.plan); setMessage('');
    });
  }
  async function saveTemplate(copy = false) {
    await run(async () => {
      const saved = await api.savePlatformRecord('preset', { data: { name: `${options.name}${copy ? ' 副本' : ''}`, parameters: options, category: options.mode }, baseVersion: copy ? undefined : selected?.version }, copy ? null : selected?.id);
      setSelected(saved); await load(); setNotice(t("模板已保存：v{value0}，历史版本可查看并重新采用。", { value0: (saved.version) }));
    });
  }
  return <div className="space-y-5"><h1 className="text-2xl font-semibold">{t("创作工作室")}</h1><p className="text-sm leading-7 text-slate-600">{t("灵感规划、场景合成、POD 套图与图片增强。当前专页使用本地规则规划和 Sharp 合成，不冒充 AI 生成；需要真实 AI 生图时，进入已有图片任务，按 Provider 页面单独确认费用与数据去向。")}</p><ErrorBox error={error} />{notice && <p className="rounded bg-teal-50 p-3 text-sm">{notice}</p>}
    <Section title={t("灵感对话 → 结构化图片计划")}><div className="max-h-72 space-y-2 overflow-auto">{messages.map((item, i) => <p key={i} className={`rounded p-3 text-sm ${item.role === 'user' ? 'bg-teal-50' : 'bg-slate-50'}`}>{item.role === 'user' ? t("你") : t("本地规划器")}：{item.content}</p>)}</div>{writable && <form onSubmit={chat} className="mt-3 flex flex-wrap gap-3"><input required className="focus-ring min-w-64 flex-1 rounded border p-2" placeholder={t("例如：运动长裤，白底主图，突出面料细节…")} value={message} onChange={(event) => setMessage(event.target.value)} /><button disabled={busy} className="btn-primary">{t("整理要求（不收费）")}</button></form>}{plan && <div className="mt-4 space-y-3"><pre className="max-h-56 overflow-auto rounded bg-slate-50 p-3 text-xs">{JSON.stringify(plan, null, 2)}</pre><button className="btn-secondary" onClick={() => { setOptions({ ...defaults, ...plan.parameters, mode: plan.mode, name: plan.title, brief: plan.requirements }); setSelected(null); setNotice(t("已采用图片计划，请选择图片并检查参数。")); }}>{t("确认计划并转入制作")}</button></div>}<div className="mt-3 flex flex-wrap gap-3"><button className="text-sm text-mint underline" onClick={() => run(async () => { const data = await api.listPlatformRecords('conversation'); if (!data.records.length) { setNotice(t("暂无已保存对话。")); return; } const record = data.records[0]; setConversation(record); setMessages(record.data.messages || []); setPlan(record.data.plan); })}>{t("恢复最近对话")}</button><button className="text-sm text-mint underline" onClick={() => { setConversation(null); setMessages([]); setPlan(null); }}>{t("新对话")}</button><Link className="text-sm text-mint underline" to="/upload">{t("进入 AI 图片任务")}</Link></div></Section>
    {writable && <Section title={t("把创作要求转入现有 AI 图片计划")}><p className="mb-3 text-sm text-slate-500">{t("先在图片任务中确认商品与平台规则并生成计划；这里只修改场景图目标，不触发付费生成、不改主图和合规规则。")}</p><form className="flex flex-wrap gap-3" onSubmit={(event) => { event.preventDefault(); if (window.confirm(t("确认将当前创作要求应用到该任务的场景图计划？不会触发图片生成。"))) run(async () => { const { task } = await api.getTask(taskId.trim()); const targets = (task.imagePlans || []).filter((item) => item.type === 'lifestyle_image'); if (!targets.length) throw new Error(t("任务还没有场景图计划，请先完成商品确认、平台规则和方案生成。")); const results = []; for (const item of targets) { try { await api.updateImagePlan(task.id, item.id, { goal: `${item.goal || ''}\n创作要求：${options.brief || plan?.requirements || options.name}` }); results.push({ status: 'success' }); } catch (err) { results.push({ status: 'failed', reason: err.message }); } } setNotice(t("计划更新：成功 {value0}，失败 {value1}。{value2}", { value0: (results.filter((item) => item.status === 'success').length), value1: (results.filter((item) => item.status === 'failed').length), value2: (results.filter((item) => item.reason).map((item) => item.reason).join('；')) })); }); }}><input required className="focus-ring min-w-64 flex-1 rounded border p-2" placeholder={t("已生成图片计划的任务 ID")} value={taskId} onChange={(event) => setTaskId(event.target.value)} /><button disabled={busy} className="btn-secondary">{t("确认并应用创作要求")}</button>{taskId && <Link className="btn-secondary" to={`/tasks/${encodeURIComponent(taskId.trim())}/plans`}>{t("打开图片计划")}</Link>}</form></Section>}
    <Section title={t("场景模板（保存、复制与版本记录）")}><div className="grid gap-3 sm:grid-cols-3">{templates?.records.map((item) => <button className="rounded border p-3 text-left hover:border-teal-600" key={item.id} onClick={() => { setSelected(item); setOptions({ ...defaults, ...item.data.parameters }); setHistory([]); }}><p>{item.data.name}</p><p className="text-xs text-slate-500">v{item.version} · {item.data.category}</p></button>)}</div><Pager pagination={templates?.pagination} onPage={(page) => run(() => load(page))} />{selected && <div className="mt-3 flex flex-wrap gap-3"><p className="text-sm">{t("当前：")}{selected.data.name} v{selected.version}</p><button className="text-sm text-mint underline" onClick={() => run(async () => setHistory((await api.recordHistory(selected.id)).records))}>{t("查看历史")}</button><button className="text-sm text-mint underline" onClick={() => { setSelected(null); setHistory([]); }}>{t("作为新模板")}</button></div>}{history.map((item) => <button key={item.version} className="btn-secondary mr-2 mt-3" onClick={() => { setOptions({ ...defaults, ...item.data.parameters }); setNotice(t("已采用历史 v{value0} 参数；保存会生成新版本，不会覆盖历史。", { value0: (item.version) })); }}>{t("采用 v")}{item.version}</button>)}</Section>
    <Section title={t("本地场景 / POD / 增强制作")}><form className="space-y-4" onSubmit={(event) => { event.preventDefault(); if (window.confirm(t("确认处理 {value0} 张图片？将写入独立输出目录，保留原图，不调用外部付费服务。", { value0: (files.length) }))) run(async () => setResult(await api.renderStudio(files, background, { ...options, templateId: selected?.id, templateVersion: selected?.version, confirm: true }))); }}>
      <div className="grid gap-3 md:grid-cols-3"><label className="text-sm">{t("工作模式")}<select className="mt-1 w-full rounded border p-2" value={options.mode} onChange={(event) => setOptions({ ...options, mode: event.target.value })}><option value="scene">{t("场景图（用户底图 + 商品合成）")}</option><option value="pod">{t("POD 印花（透明底 / 模板套用）")}</option><option value="enhance">{t("增强 / 白底补边（不做主体分割）")}</option></select></label><label className="text-sm">{t("模板 / 任务名称")}<input required className="mt-1 w-full rounded border p-2" value={options.name} onChange={(event) => setOptions({ ...options, name: event.target.value })} /></label><label className="text-sm">{t("输出格式")}<select className="mt-1 w-full rounded border p-2" value={options.format} onChange={(event) => setOptions({ ...options, format: event.target.value })}>{['png', 'jpeg', 'webp'].map((format) => <option key={format}>{format}</option>)}</select></label>{[['width', '宽度', 320, 6000], ['height', '高度', 320, 6000], ['quality', '质量', 40, 100]].map(([key, title, min, max]) => <label className="text-sm" key={key}>{t(title)}<input required type="number" min={min} max={max} className="mt-1 w-full rounded border p-2" value={options[key]} onChange={(event) => setOptions({ ...options, [key]: Number(event.target.value) })} /></label>)}</div>
      <div className="flex flex-wrap items-center gap-4 text-sm"><label>{t("底色") + " "}<input type="color" value={options.background} onChange={(event) => setOptions({ ...options, background: event.target.value })} /></label>{[['sharpen', '锐化'], ['normalize', '对比度归一化']].map(([key, title]) => <label key={key}><input type="checkbox" checked={options[key]} onChange={(event) => setOptions({ ...options, [key]: event.target.checked })} /> {t(title)}</label>)}<Link className="text-mint underline" to="/matting">{t("需要先抠图？进入主体抠图")}</Link></div>
      {options.mode !== 'enhance' && <div className="grid gap-3 sm:grid-cols-4">{[['x', '放置左边距'], ['y', '放置上边距'], ['width', '放置宽度'], ['height', '放置高度']].map(([key, title]) => <label key={key} className="text-sm">{t(title)}（0–1）<input required type="number" step="0.01" min={key === 'x' || key === 'y' ? 0 : 0.05} max={1} className="mt-1 w-full rounded border p-2" value={options.placement[key]} onChange={(event) => setOptions({ ...options, placement: { ...options.placement, [key]: Number(event.target.value) } })} /></label>)}</div>}
      <textarea aria-label={t("创作要求")} className="focus-ring w-full rounded border p-3" rows={3} value={options.brief} onChange={(event) => setOptions({ ...options, brief: event.target.value })} placeholder={t("创作要求（随输出 manifest 保存）")} />
      <div className="space-y-3 text-sm"><label className="block">{t("商品 / 印花图片（1–100 张）")}<input type="file" className="ml-3" accept="image/png,image/jpeg,image/webp" multiple onChange={(event) => setFiles(Array.from(event.target.files || []))} /></label><label className="block">{t("可选场景 / POD 模板底图")}<input type="file" className="ml-3" accept="image/png,image/jpeg,image/webp" onChange={(event) => setBackground(event.target.files?.[0] || null)} /></label></div>
      {writable && <div className="flex flex-wrap gap-3"><button disabled={busy || !files.length} className="btn-primary">{busy ? t("处理中…") : t("确认并批量制作")}</button><button type="button" disabled={busy} className="btn-secondary" onClick={() => saveTemplate()}>{t("保存模板")}{selected ? t("新版本") : ''}</button>{selected && <button type="button" disabled={busy} className="btn-secondary" onClick={() => saveTemplate(true)}>{t("复制模板")}</button>}</div>}
    </form></Section>
    {result && <Section title={t("制作结果")}><p className="mb-3 text-sm">{t("成功") + " "}{result.summary.successCount}{" " + t("· 失败") + " "}{result.summary.failedCount}{" " + t("· 原文件未修改")}</p><a className="btn-primary inline-block" download href={`${ASSET_BASE}${result.downloadUrl}`}>{t("下载图片与清单 ZIP")}</a><div className="mt-4 grid gap-3 sm:grid-cols-4">{result.items.slice(0, 40).map((item) => <div className="rounded border p-3" key={item.index}>{item.url ? <img className="h-36 w-full object-contain" alt={item.sourceName} src={`${ASSET_BASE}${item.url}`} /> : <p className="text-sm text-red-700">{item.reason}</p>}<p className="mt-2 truncate text-xs">{item.sourceName}</p></div>)}</div></Section>}
  </div>;
}
