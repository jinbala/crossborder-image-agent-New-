import { useLocale } from '../i18n/LocaleProvider.jsx';
import { useEffect, useState } from 'react';
import { AlertTriangle, ArrowLeft, CheckCircle2, Download, FileSpreadsheet, LoaderCircle, Percent, ShieldCheck } from 'lucide-react';
import { Link, useNavigate } from 'react-router-dom';
import Section from '../components/Section.jsx';
import { ASSET_BASE, api } from '../services/api.js';

const PLATFORM_OPTIONS = [
  ['temu', 'Temu'], ['amazon', 'Amazon'], ['aliexpress', 'AliExpress'], ['tiktok', 'TikTok Shop'],
  ['shopee', 'Shopee'], ['shein', 'Shein'], ['ozon', 'Ozon'], ['mercado', 'Mercado Libre']
];

const LISTING_SAMPLE = [
  'SKU-001|女式高腰直筒休闲裤|29.99|100|420|material-or-image-001|material-002;material-003',
  'SKU-002|男式轻量速干运动长裤|35.50|80|380|material-or-image-004|'
].join('\n');
const PRICE_SAMPLE = ['SKU-001|29.99', 'SKU-002|35.50', 'SKU-003|42.00'].join('\n');
const RULE_SAMPLE = ['percent|-5', 'fixed|-1'].join('\n');

function splitLines(value) {
  return value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

function parseListingRows(value) {
  return splitLines(value).map((line) => {
    const [sku = '', title = '', price = '', stock = '', weightGrams = '', mainImageRef = '', additionalImageRefs = ''] = line.split('|').map((part) => part.trim());
    return { sku, title, price, stock, weightGrams, mainImageRef, additionalImageRefs };
  });
}

function parsePriceItems(value) {
  return splitLines(value).map((line) => {
    const [sku = '', price = ''] = line.split('|').map((part) => part.trim());
    return { sku, price };
  });
}

function parseRules(value) {
  return splitLines(value).map((line) => {
    const [type = '', amount = ''] = line.split('|').map((part) => part.trim());
    return { type, value: amount };
  });
}

function SummaryCards({ summary, pricing = false, currency = 'USD' }) {
  const { t, dateTime } = useLocale();
  const cards = pricing
    ? [
        ['输入 SKU', summary.inputCount], ['可直接采用', summary.readyCount], ['需要复核', summary.warningCount],
        ['已阻止', summary.blockedCount], ['调整前合计', `${currency} ${summary.totalBefore}`], ['调整后合计', `${currency} ${summary.totalAfter}`]
      ]
    : [['输入商品', summary.inputCount], ['可继续', summary.readyCount], ['需要复核', summary.warningCount], ['已阻止', summary.blockedCount]];
  return <div className={`grid gap-3 ${pricing ? 'sm:grid-cols-3' : 'sm:grid-cols-4'}`}>{cards.map(([label, value]) => <div key={t(label)} className="rounded border border-slate-200 bg-slate-50 p-3"><div className="text-xs text-slate-500">{t(label)}</div><div className="mt-1 text-lg font-semibold text-ink">{value ?? 0}</div></div>)}</div>;
}

function StatusPill({ status }) {
  const { t, dateTime } = useLocale();
  const styles = status === 'ready' ? 'bg-emerald-50 text-emerald-700' : status === 'warning' ? 'bg-amber-50 text-amber-700' : 'bg-red-50 text-red-700';
  const label = status === 'ready' ? '可继续' : status === 'warning' ? '需复核' : '已阻止';
  return <span className={`rounded-full px-2 py-1 text-xs font-medium ${styles}`}>{t(label)}</span>;
}

function DownloadLink({ result }) {
  const { t, dateTime } = useLocale();
  if (!result?.downloadUrl) return null;
  return <a href={`${ASSET_BASE}${result.downloadUrl}`} className="focus-ring inline-flex items-center gap-2 rounded bg-mint px-3 py-2 text-sm font-semibold text-white hover:bg-teal-800"><Download size={16} />{t("下载 CSV")}</a>;
}

export default function CommerceWorkbenchPage() {
  const { t, dateTime } = useLocale();
  const navigate = useNavigate();
  async function sandbox(sourceId) {
    if (!window.confirm(t("创建本地模拟沙箱？只验证审批、逐项写入和恢复机制，不连接任何真实店铺。"))) return;
    try { navigate(`/commerce-sandbox/${(await api.createCommerceSandbox(sourceId)).id}`); } catch (err) { setError(err.message); }
  }
  const [platformId, setPlatformId] = useState('temu');
  const [listingName, setListingName] = useState('');
  const [listingText, setListingText] = useState(LISTING_SAMPLE);
  const [listingBusy, setListingBusy] = useState(false);
  const [listingResult, setListingResult] = useState(null);
  const [priceName, setPriceName] = useState('');
  const [priceText, setPriceText] = useState(PRICE_SAMPLE);
  const [ruleText, setRuleText] = useState(RULE_SAMPLE);
  const [rounding, setRounding] = useState('cent');
  const [pricingBusy, setPricingBusy] = useState(false);
  const [pricingResult, setPricingResult] = useState(null);
  const [error, setError] = useState('');
  const [currency, setCurrency] = useState('USD');
  const [scope, setScope] = useState('all');
  const [savedRules, setSavedRules] = useState([]);
  const [ruleNotice, setRuleNotice] = useState('');
  async function loadRules() { setSavedRules((await api.listPlatformRecords('pricing-rule', { pageSize: 100 })).records); }
  useEffect(() => { loadRules().catch((err) => setError(err.message)); }, []);
  async function saveRule() {
    try {
      await api.savePlatformRecord('pricing-rule', { data: { name: priceName || '调价规则', formatVersion: 1, currency, rounding, scope, rules: parseRules(ruleText) } });
      await loadRules(); setRuleNotice('规则已保存，可导出备份或在其他工作空间导入。');
    } catch (err) { setError(err.message); }
  }

  async function submitListing(event) {
    event.preventDefault();
    setListingBusy(true); setError(''); setListingResult(null);
    try {
      setListingResult(await api.createListingDryRun({ name: listingName, platformId, rows: parseListingRows(listingText) }));
    } catch (err) { setError(err.message); } finally { setListingBusy(false); }
  }

  async function submitPricing(event) {
    event.preventDefault();
    setPricingBusy(true); setError(''); setPricingResult(null);
    try {
      setPricingResult(await api.createPricingPreview({ name: priceName, currency, scope, rounding, items: parsePriceItems(priceText), rules: parseRules(ruleText) }));
    } catch (err) { setError(err.message); } finally { setPricingBusy(false); }
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <Link to="/workbench" className="mb-2 inline-flex items-center gap-1 text-sm font-medium text-mint hover:text-teal-800"><ArrowLeft size={15} />{t("返回运营工作台")}</Link>
          <h1 className="text-2xl font-semibold text-ink">{t("刊登预演与调价预览")}</h1>
          <p className="mt-2 text-sm text-slate-600">{t("先在本地发现缺字段、异常价格和高风险变动，再决定是否进入人工操作。")}</p>
        </div>
        <div className="inline-flex items-center gap-2 rounded border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800"><ShieldCheck size={17} />{t("零店铺写入 · 零自动发布")}</div>
      </div>

      {error && <div className="rounded border border-red-200 bg-red-50 p-3 text-sm text-red-700">{error}</div>}

      <Section title={t("多平台刊登预演")} actions={<DownloadLink result={listingResult} />}>
        <form onSubmit={submitListing} className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="text-sm text-slate-600">{t("目标平台")}<select value={platformId} onChange={(event) => setPlatformId(event.target.value)} className="focus-ring mt-1 w-full rounded border border-slate-300 px-3 py-2 text-ink">{PLATFORM_OPTIONS.map(([id, label]) => <option key={id} value={id}>{t(label)}</option>)}</select></label>
            <label className="text-sm text-slate-600">{t("任务名称")}<input value={listingName} onChange={(event) => setListingName(event.target.value)} placeholder={t("例如：Temu 秋季裤装首轮")} className="focus-ring mt-1 w-full rounded border border-slate-300 px-3 py-2 text-ink" /></label>
          </div>
          <div className="rounded border border-blue-200 bg-blue-50 p-3 text-xs leading-5 text-blue-800">{t("每行格式：SKU | 标题 | 价格 | 库存 | 重量克数 | 主图素材ID/URL | 附图ID/URL（分号隔开）。Temu 会把主图列按素材 ID 检查，其他平台按图片 URL 检查。")}</div>
          <textarea value={listingText} onChange={(event) => setListingText(event.target.value)} rows="7" className="focus-ring w-full resize-y rounded border border-slate-300 px-3 py-2 font-mono text-xs leading-6 text-ink" />
          <button disabled={listingBusy || !listingText.trim()} className="focus-ring inline-flex items-center gap-2 rounded bg-ink px-4 py-2.5 text-sm font-semibold text-white hover:bg-slate-700 disabled:opacity-50">{listingBusy ? <LoaderCircle size={17} className="animate-spin" /> : <FileSpreadsheet size={17} />}{listingBusy ? t("正在检查…") : t("生成刊登预演")}</button>
        </form>

        {listingResult && <div className="mt-6 space-y-4 border-t border-slate-200 pt-5">
          <div className="flex items-center gap-2 text-sm text-slate-700"><AlertTriangle size={16} className="text-amber-600" />{listingResult.notice}</div>
          <SummaryCards summary={listingResult.summary} />
          <button className="btn-secondary" onClick={() => sandbox(listingResult.id)}>{t("进入本地刊登模拟沙箱")}</button>
          <div className="overflow-x-auto rounded border border-slate-200">
            <table className="w-full min-w-[720px] text-left text-sm">
              <thead className="bg-slate-50 text-xs text-slate-500"><tr><th className="px-3 py-2">SKU</th><th className="px-3 py-2">{t("标题")}</th><th className="px-3 py-2">{t("价格")}</th><th className="px-3 py-2">{t("库存")}</th><th className="px-3 py-2">{t("状态")}</th><th className="px-3 py-2">{t("问题")}</th></tr></thead>
              <tbody>{listingResult.rows.slice(0, 50).map((row) => <tr key={`${row.index}-${row.sku}`} className="border-t border-slate-100"><td className="px-3 py-2 font-mono text-xs">{row.sku || '-'}</td><td className="max-w-xs truncate px-3 py-2">{row.title || '-'}</td><td className="px-3 py-2">{row.price ?? '-'}</td><td className="px-3 py-2">{row.stock ?? '-'}</td><td className="px-3 py-2"><StatusPill status={row.status} /></td><td className="px-3 py-2 text-xs text-slate-500">{row.issues.map((issue) => issue.message).join('；') || t("无")}</td></tr>)}</tbody>
            </table>
          </div>
        </div>}
      </Section>

      <Section title={t("多轮调价预览")} actions={<DownloadLink result={pricingResult} />}>
        <div className="mb-4 space-y-3 rounded border p-3"><div className="flex flex-wrap gap-3"><label className="text-sm">{t("币种")}<input className="ml-2 w-24 rounded border p-2" maxLength={3} value={currency} onChange={(event) => setCurrency(event.target.value.toUpperCase())} /></label><label className="text-sm">{t("适用范围")}<input className="ml-2 rounded border p-2" value={scope} onChange={(event) => setScope(event.target.value)} placeholder={t("all 或 SKU 前缀")} /></label><select aria-label={t("已保存调价规则")} className="rounded border p-2" defaultValue="" onChange={(event) => { const record = savedRules.find((item) => item.id === event.target.value); if (!record) return; const data = record.data; setPriceName(data.name); setCurrency(data.currency); setScope(data.scope || 'all'); setRounding(data.rounding); setRuleText(data.rules.map((rule) => `${rule.type}|${rule.value}`).join('\n')); }}><option value="">{t("选择已保存规则")}</option>{savedRules.map((item) => <option key={item.id} value={item.id}>{item.data.name} · {item.data.currency} · v{item.version}</option>)}</select></div><div className="flex flex-wrap items-center gap-3 text-sm"><button type="button" className="btn-secondary" onClick={saveRule}>{t("保存当前规则")}</button><a className="text-mint underline" href={api.platformExportUrl('pricing-rule')} download>{t("导出规则 JSON")}</a><label>{t("导入规则")}<input type="file" accept=".json" className="ml-2" onChange={async (event) => { const file = event.target.files?.[0]; if (!file) return; try { const result = await api.importPlatformRecords('pricing-rule', JSON.parse(await file.text())); await loadRules(); setRuleNotice(`导入成功 ${result.successCount}，失败 ${result.failedCount}。${result.results.filter((item) => item.status === 'failed').map((item) => item.reason).join('；')}`); } catch (err) { setError(err.message); } }} /></label></div>{ruleNotice && <p className="text-sm text-teal-800">{ruleNotice}</p>}</div>
        <form onSubmit={submitPricing} className="space-y-4">
          <div className="grid gap-4 md:grid-cols-3">
            <label className="text-sm text-slate-600">{t("任务名称")}<input value={priceName} onChange={(event) => setPriceName(event.target.value)} placeholder={t("例如：活动前降价")} className="focus-ring mt-1 w-full rounded border border-slate-300 px-3 py-2 text-ink" /></label>
            <label className="text-sm text-slate-600">{t("尾数规则")}<select value={rounding} onChange={(event) => setRounding(event.target.value)} className="focus-ring mt-1 w-full rounded border border-slate-300 px-3 py-2 text-ink"><option value="cent">{t("保留分位")}</option><option value="integer">{t("取整元")}</option><option value="ending99">{t("调整为 .99")}</option></select></label>
            <div className="rounded border border-slate-200 bg-slate-50 p-3 text-xs leading-5 text-slate-600"><Percent size={16} className="mb-1 text-mint" />{t("规则按从上到下顺序执行；负数降价，正数涨价。")}</div>
          </div>
          <div className="grid gap-4 lg:grid-cols-2">
            <label className="text-sm text-slate-600">{t("SKU 与原价（SKU | 价格）")}<textarea value={priceText} onChange={(event) => setPriceText(event.target.value)} rows="7" className="focus-ring mt-1 w-full resize-y rounded border border-slate-300 px-3 py-2 font-mono text-xs leading-6 text-ink" /></label>
            <label className="text-sm text-slate-600">{t("调价步骤（percent/fixed | 数值）")}<textarea value={ruleText} onChange={(event) => setRuleText(event.target.value)} rows="7" className="focus-ring mt-1 w-full resize-y rounded border border-slate-300 px-3 py-2 font-mono text-xs leading-6 text-ink" /></label>
          </div>
          <button disabled={pricingBusy || !priceText.trim() || !ruleText.trim()} className="focus-ring inline-flex items-center gap-2 rounded bg-mint px-4 py-2.5 text-sm font-semibold text-white hover:bg-teal-800 disabled:opacity-50">{pricingBusy ? <LoaderCircle size={17} className="animate-spin" /> : <Percent size={17} />}{pricingBusy ? t("正在计算…") : t("计算调价预览")}</button>
        </form>

        {pricingResult && <div className="mt-6 space-y-4 border-t border-slate-200 pt-5">
          <div className="flex items-center gap-2 text-sm text-slate-700"><CheckCircle2 size={16} className="text-emerald-600" />{pricingResult.notice}</div>
          <SummaryCards summary={pricingResult.summary} pricing currency={pricingResult.currency} />
          <button className="btn-secondary" onClick={() => sandbox(pricingResult.id)}>{t("进入本地改价模拟沙箱")}</button>
          <div className="overflow-x-auto rounded border border-slate-200">
            <table className="w-full min-w-[680px] text-left text-sm">
              <thead className="bg-slate-50 text-xs text-slate-500"><tr><th className="px-3 py-2">SKU</th><th className="px-3 py-2">{t("原价")}</th><th className="px-3 py-2">{t("新价格")}</th><th className="px-3 py-2">{t("变动")}</th><th className="px-3 py-2">{t("状态")}</th><th className="px-3 py-2">{t("计算过程")}</th></tr></thead>
              <tbody>{pricingResult.items.slice(0, 100).map((item) => <tr key={`${item.index}-${item.sku}`} className="border-t border-slate-100"><td className="px-3 py-2 font-mono text-xs">{item.sku || '-'}</td><td className="px-3 py-2">{item.originalPrice ?? '-'}</td><td className="px-3 py-2 font-semibold text-ink">{item.newPrice ?? '-'}</td><td className={`px-3 py-2 ${item.change > 0 ? 'text-red-600' : item.change < 0 ? 'text-emerald-700' : ''}`}>{item.change === null ? '-' : `${item.change > 0 ? '+' : ''}${item.change} (${item.changePercent}%)`}</td><td className="px-3 py-2"><StatusPill status={item.status} /></td><td className="px-3 py-2 text-xs text-slate-500">{item.trace.map((step) => `${step.before}→${step.after}`).join('；') || item.issues.map((issue) => issue.message).join('；')}</td></tr>)}</tbody>
            </table>
          </div>
        </div>}
      </Section>
    </div>
  );
}
