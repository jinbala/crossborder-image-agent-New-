import { useLocale } from '../i18n/LocaleProvider.jsx';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import Section from '../components/Section.jsx';
import { api } from '../services/api.js';
import { ErrorBox } from './WorkspacePages.jsx';

const states = { draft: '草稿', queued: '排队', running: '运行中', waiting_user: '等待人工', paused: '已暂停', completed: '完成', partial: '部分完成', failed: '失败', cancelled: '已取消' };
export default function WorkspaceHomePage() {
  const { t } = useLocale();
  const [data, setData] = useState(null), [error, setError] = useState('');
  async function load() { try { setData(await api.getWorkspace()); setError(''); } catch (err) { setError(err.message); } }
  useEffect(() => { load(); }, []);
  return <div className="space-y-5"><div className="flex items-center justify-between gap-4"><div><h1 className="text-2xl font-semibold">{data?.workspace.name || t("跨境图片工作台")}</h1><p className="mt-2 text-sm text-slate-500">{t("采集 → 图包 → 素材 → 模板 → 预检。所有数字来自实际任务索引。")}</p></div><button className="btn-secondary" onClick={load}>{t("刷新")}</button></div><ErrorBox error={error} />
    <div className="grid grid-cols-2 gap-3 md:grid-cols-5">{[['running', '正在运行'], ['waiting_user', '等待人工确认'], ['paused', '暂停 / 可恢复'], ['failed', '失败需处理'], ['partial', '部分完成']].map(([key, title]) => <Link to={`/task-center?state=${key}`} className="rounded border bg-white p-4 hover:border-teal-600" key={key}><p className="text-xs text-slate-500">{t(title)}</p><p className="mt-2 text-3xl font-semibold">{data?.tasks.counts[key] || 0}</p></Link>)}</div>
    <Section title={t("快速开始")}><div className="grid gap-3 sm:grid-cols-3">{[['图片采集', '/workbench/collection', '导入表格、当前页采集、断点下载'], ['SKU 图包', '/workbench/sku-pack', '排序、角色、命名、去重、方图'], ['素材与模板', '/workbench/materials', '素材 ID、字段映射、安全副本回填'], ['创作工作室', '/studio', '灵感规划、场景合成、增强'], ['POD 工作区', '/pod', '印花、透明底、尺寸、模板套图'], ['刊登与调价', '/workbench/commerce', '本地草稿、规则与价格变动预览']].map(([title, href, description]) => <Link className="rounded border p-4 hover:border-teal-600" to={href} key={href}><p className="font-medium">{t(title)}</p><p className="mt-2 text-xs text-slate-500">{t(description)}</p></Link>)}</div></Section>
    <div className="grid gap-5 lg:grid-cols-2"><Section title={t("最近任务")} actions={<Link className="text-sm text-mint underline" to="/task-center">{t("全部任务")}</Link>}><div className="space-y-3">{data?.tasks.records.map((item) => <Link className="block rounded border p-3 text-sm hover:border-teal-600" key={item.id} to={item.href}><p>{item.title}</p><p className="mt-1 text-xs text-slate-500">{t(states[item.state] || item.state)} · {item.sku || item.kind}</p></Link>)}{data && !data.tasks.records.length && <p className="text-sm text-slate-500">{t("还没有任务，从上方任一流程开始。")}</p>}</div></Section><Section title={t("运行环境与能力")}><div className="space-y-3 text-sm"><p>{t("版本：")}{data?.version || t("读取中")}</p><p>{t("存储：")}{data?.storage.driver || t("读取中")}{" " + t("· 可用磁盘") + " "}{data?.storage.availableBytes == null ? t("检测不可用") : `${(data.storage.availableBytes / 1024 ** 3).toFixed(1)} GB`}</p><p>{t("商品识别：")}{data?.providers.selectedVisionProvider || t("读取中")}</p><p>{t("图片生成：")}{data?.providers.selectedImageProvider || t("读取中")}{" " + t("· 背景：")}{data?.providers.selectedBackgroundProvider || t("读取中")}</p><p>{t("主体抠图：")}{data?.providers.selectedMattingProvider || t("读取中")}</p><p className="rounded bg-amber-50 p-3 text-xs leading-6">{t("mock 表示模拟服务，不是真实 AI 效果。外部 Provider 需要凭据和明确批准。遇到验证码只暂停，由人工完成。")}</p><div className="flex flex-wrap gap-3"><Link className="text-mint underline" to="/health">{t("诊断")}</Link><Link className="text-mint underline" to="/sync">{t("设备同步")}</Link><Link className="text-mint underline" to="/announcements">{t("公告与帮助")}</Link></div></div></Section></div>
  </div>;
}
