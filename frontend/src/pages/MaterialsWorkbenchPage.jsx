import { useLocale } from '../i18n/LocaleProvider.jsx';
import { useCallback, useEffect, useState } from 'react';
import { ArrowLeft, Database, Download, FileCheck2, FileSpreadsheet, LoaderCircle, RefreshCw, ShieldCheck, Upload } from 'lucide-react';
import { Link } from 'react-router-dom';
import Section from '../components/Section.jsx';
import { api, ASSET_BASE } from '../services/api.js';

const MATERIAL_SAMPLE = [
  'SKU-001|temu|material-001|main|主图-001.jpg|Temu主图',
  'SKU-001|temu|material-002|additional|附图-001.jpg|Temu附图',
  'SKU-002|amazon|https://example.com/sku-002-main.jpg|main|sku-002-main.jpg|Amazon主图URL'
].join('\n');

const PLATFORM_OPTIONS = [['temu', 'Temu'], ['amazon', 'Amazon'], ['aliexpress', 'AliExpress'], ['tiktok', 'TikTok Shop'], ['shopee', 'Shopee'], ['shein', 'Shein'], ['ozon', 'Ozon'], ['mercado', 'Mercado Libre']];
const TYPE_LABELS = { main: '主图', additional: '附图', square: '方图', swatch: '色块图', detail: '详情图', variant: '变体图', general: '通用图' };

function parseMaterialLines(value) {
  return value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line) => {
    const [sku = '', platformId = '', materialId = '', materialType = 'general', fileName = '', notes = ''] = line.split('|').map((part) => part.trim());
    return { sku, platformId, materialId, materialType, fileName, notes };
  });
}

function MappingResult({ result }) {
  const { t, dateTime } = useLocale();
  if (!result) return null;
  const sheet = result.sheets.find((item) => item.name === result.selectedSheet) || result.sheets[0];
  return (
    <div className="mt-5 space-y-4 border-t border-slate-200 pt-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div><div className="font-semibold text-ink">{result.fileName}</div><div className="mt-1 text-xs text-slate-500">{t("识别到") + " "}{result.sheetCount}{" " + t("个工作表 · 当前：")}{result.selectedSheet}{" " + t("· 表头第") + " "}{sheet?.headerRow || '-'}{" " + t("行")}</div></div>
        <div className={`rounded-full px-3 py-1 text-xs font-medium ${result.mapping.missingRequired.length ? 'bg-amber-50 text-amber-800' : 'bg-emerald-50 text-emerald-700'}`}>{result.mapping.missingRequired.length ? t("缺少 {value0} 个必填映射", { value0: (result.mapping.missingRequired.length) }) : t("必填字段已匹配")}</div>
      </div>
      <div className="rounded border border-blue-200 bg-blue-50 p-3 text-xs leading-5 text-blue-800">{result.notice}</div>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {result.mapping.fields.map((field) => <div key={field.field} className="rounded border border-slate-200 p-3"><div className="flex items-center justify-between gap-2"><span className="font-mono text-xs font-semibold text-slate-700">{field.field}</span><span className={`text-xs ${field.matched ? 'text-emerald-700' : 'text-slate-400'}`}>{field.matched ? t("已匹配") : t("未匹配")}</span></div><div className="mt-2 truncate text-sm text-ink">{field.column || '—'}</div></div>)}
      </div>
      {result.mapping.missingRequired.length > 0 && <div className="rounded border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">{t("缺少必填字段：")}{result.mapping.missingRequired.join('、')}</div>}
      <details className="rounded border border-slate-200 bg-slate-50 p-3 text-sm"><summary className="cursor-pointer font-medium text-slate-700">{t("查看识别到的原始表头")}</summary><div className="mt-3 flex flex-wrap gap-2">{(sheet?.headers || []).filter(Boolean).map((header, index) => <span key={`${header}-${index}`} className="rounded bg-white px-2 py-1 text-xs text-slate-600 shadow-sm">{index + 1}. {header}</span>)}</div></details>
    </div>
  );
}

export default function MaterialsWorkbenchPage() {
  const { t, dateTime } = useLocale();
  const [ledger, setLedger] = useState({ summary: {}, records: [] });
  const [filters, setFilters] = useState({ sku: new URLSearchParams(window.location.search).get('sku') || '', platformId: '', materialType: '' });
  const [materialText, setMaterialText] = useState(MATERIAL_SAMPLE);
  const [importBusy, setImportBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [templateFile, setTemplateFile] = useState(null);
  const [templatePlatform, setTemplatePlatform] = useState('temu');
  const [inspectBusy, setInspectBusy] = useState(false);
  const [inspection, setInspection] = useState(null);
  const [fillRecords, setFillRecords] = useState(JSON.stringify([{ sku: 'SKU-001', title: '商品标题', price: 29.99, stock: 20 }], null, 2));
  const [fillMapping, setFillMapping] = useState({});
  const [overwriteCells, setOverwriteCells] = useState(false);
  const [fillPreview, setFillPreview] = useState(null);
  const [fillResult, setFillResult] = useState(null);
  const [fillBusy, setFillBusy] = useState(false);
  const [page, setPage] = useState(1);
  const [includeArchived, setIncludeArchived] = useState(false);
  const [editing, setEditing] = useState(null);
  const [editBusy, setEditBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const refresh = useCallback(async (nextFilters = filters, nextPage = page, archived = includeArchived) => {
    const result = await api.listMaterialRecords({ ...nextFilters, page: nextPage, pageSize: 50, includeArchived: archived });
    setLedger(result);
    setPage(result.pagination?.page || nextPage);
  }, [filters, page, includeArchived]);

  useEffect(() => {
    let active = true;
    api.listMaterialRecords({ ...filters, page: 1, pageSize: 50 }).then((result) => { if (active) setLedger(result); }).catch((err) => { if (active) setError(err.message); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, []);

  async function submitMaterials(event) {
    event.preventDefault();
    setImportBusy(true); setError(''); setNotice('');
    try {
      const result = await api.importMaterialRecords(parseMaterialLines(materialText));
      setNotice(t("素材台账已更新：新增 {value0} 条，更新 {value1} 条。", { value0: (result.createdCount), value1: (result.updatedCount) }));
      await refresh({}, 1);
      setFilters({ sku: '', platformId: '', materialType: '' });
    } catch (err) { setError(err.message); } finally { setImportBusy(false); }
  }

  async function inspectTemplate(event) {
    event.preventDefault();
    if (!templateFile) return setError(t("请先选择 XLSX 模板。"));
    setInspectBusy(true); setError(''); setInspection(null); setFillPreview(null); setFillResult(null);
    try {
      const result = await api.inspectWorkbookTemplate(templateFile, templatePlatform);
      setInspection(result);
      setFillMapping(Object.fromEntries(result.mapping.fields.filter((field) => field.matched).map((field) => [field.field, field.columnIndex])));
    }
    catch (err) { setError(err.message); }
    finally { setInspectBusy(false); }
  }

  async function applyFilters(event) {
    event.preventDefault();
    setLoading(true); setError('');
    try { await refresh(filters, 1); } catch (err) { setError(err.message); } finally { setLoading(false); }
  }

  async function previewFill() {
    setFillBusy(true); setError(''); setFillResult(null); setFillPreview(null);
    try {
      const records = JSON.parse(fillRecords);
      setFillPreview(await api.previewWorkbookFill(templateFile, { platformId: templatePlatform, records, mapping: fillMapping, overwriteCells }));
    } catch (err) { setError(err.message); } finally { setFillBusy(false); }
  }

  async function executeFill() {
    if (!fillPreview?.canExecute || !window.confirm(t("确认将预览中的 {value0} 个单元格写入模板副本？原模板保持不变。", { value0: (fillPreview.summary.changedCells) }))) return;
    setFillBusy(true); setError('');
    try { setFillResult(await api.executeWorkbookFill(fillPreview.id, { previewHash: fillPreview.previewHash, confirm: true })); }
    catch (err) { setError(err.message); } finally { setFillBusy(false); }
  }

  async function fillFromMaterials() {
    try {
      const records = JSON.parse(fillRecords);
      if (!Array.isArray(records)) throw new Error(t("请填写商品记录数组"));
      const allMaterials = (await api.listMaterialRecords({ platformId: templatePlatform })).records;
      const rows = records.map((row) => {
        const candidates = allMaterials.filter((record) => record.sku === row.sku && record.platformId === templatePlatform);
        const main = candidates.filter((record) => record.materialType === 'main');
        if (main.length > 1) throw new Error(t("{value0} 有多条主图素材，请手动选择主图 ID", { value0: (row.sku) }));
        const extra = candidates.filter((record) => record.materialType === 'additional').map((record) => record.materialId);
        return { ...row, ...(main[0] ? { [templatePlatform === 'temu' ? 'mainImageId' : 'mainImageUrl']: main[0].materialId } : {}), ...(extra.length ? { [templatePlatform === 'temu' ? 'additionalImageIds' : 'additionalImageUrls']: extra.join(';') } : {}) };
      });
      setFillRecords(JSON.stringify(rows, null, 2)); setFillPreview(null); setFillResult(null); setError('');
    } catch (err) { setError(err.message); }
  }

  async function changePage(nextPage, archived = includeArchived) {
    setLoading(true); setError(''); setEditing(null);
    try { await refresh(filters, nextPage, archived); } catch (err) { setError(err.message); } finally { setLoading(false); }
  }

  async function saveMaterial(event) {
    event.preventDefault();
    if (!editing) return;
    setEditBusy(true); setError('');
    try { setEditing(await api.updateMaterialRecord(editing.id, editing)); await refresh(); setNotice(t("素材记录已保存。")); }
    catch (err) { setError(err.message); } finally { setEditBusy(false); }
  }

  async function archiveMaterial() {
    if (!editing) return;
    const restore = editing.status === 'archived';
    if (!window.confirm(restore ? t("确认恢复此素材记录？") : t("确认归档此素材记录？之后可勾选“包含已归档”恢复。图片原文件不会删除。"))) return;
    setEditBusy(true); setError('');
    try { await api.archiveMaterialRecord(editing.id, restore); setEditing(null); await refresh(); setNotice(restore ? t("素材已恢复。") : t("素材已归档，可随时恢复。")); }
    catch (err) { setError(err.message); } finally { setEditBusy(false); }
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div><Link to="/workbench" className="mb-2 inline-flex items-center gap-1 text-sm font-medium text-mint hover:text-teal-800"><ArrowLeft size={15} />{t("返回运营工作台")}</Link><h1 className="text-2xl font-semibold text-ink">{t("素材台账与模板识别")}</h1><p className="mt-2 text-sm text-slate-600">{t("把 SKU、平台素材 ID 和图片用途串起来，并在填表前先识别 XLSX 的真实表头。")}</p></div>
        <div className="inline-flex items-center gap-2 rounded border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800"><ShieldCheck size={17} />{t("不执行宏 · 不请求外部链接")}</div>
      </div>
      {error && <div className="rounded border border-red-200 bg-red-50 p-3 text-sm text-red-700">{error}</div>}
      {notice && <div className="rounded border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-800">{notice}</div>}

      <Section title={t("批量登记素材")}>
        <form onSubmit={submitMaterials} className="space-y-4">
          <div className="rounded border border-blue-200 bg-blue-50 p-3 text-xs leading-5 text-blue-800">{t("每行格式：SKU | 平台 | 素材 ID 或图片 URL | 用途 | 文件名 | 备注。相同 SKU＋平台＋素材 ID 再次导入时会更新原记录。")}</div>
          <textarea value={materialText} onChange={(event) => setMaterialText(event.target.value)} rows="7" className="focus-ring w-full resize-y rounded border border-slate-300 px-3 py-2 font-mono text-xs leading-6 text-ink" />
          <button disabled={importBusy || !materialText.trim()} className="focus-ring inline-flex items-center gap-2 rounded bg-mint px-4 py-2.5 text-sm font-semibold text-white hover:bg-teal-800 disabled:opacity-50">{importBusy ? <LoaderCircle size={17} className="animate-spin" /> : <Database size={17} />}{importBusy ? t("正在写入…") : t("写入素材台账")}</button>
        </form>
      </Section>

      <Section title={t("素材记录")} actions={<a href={api.materialRecordsExportUrl({ ...filters, includeArchived })} className="focus-ring inline-flex items-center gap-2 rounded border border-slate-300 px-3 py-2 text-sm font-medium text-slate-700 hover:border-mint hover:text-mint"><Download size={16} />{t("导出 CSV")}</a>}>
        <form onSubmit={applyFilters} className="mb-4 grid gap-3 md:grid-cols-[1fr_180px_180px_auto]">
          <input value={filters.sku} onChange={(event) => setFilters({ ...filters, sku: event.target.value })} placeholder={t("搜索 SKU")} className="focus-ring rounded border border-slate-300 px-3 py-2 text-sm" />
          <select value={filters.platformId} onChange={(event) => setFilters({ ...filters, platformId: event.target.value })} className="focus-ring rounded border border-slate-300 px-3 py-2 text-sm"><option value="">{t("全部平台")}</option>{PLATFORM_OPTIONS.map(([id, label]) => <option key={id} value={id}>{t(label)}</option>)}</select>
          <select value={filters.materialType} onChange={(event) => setFilters({ ...filters, materialType: event.target.value })} className="focus-ring rounded border border-slate-300 px-3 py-2 text-sm"><option value="">{t("全部用途")}</option>{Object.entries(TYPE_LABELS).map(([id, label]) => <option key={id} value={id}>{t(label)}</option>)}</select>
          <button className="focus-ring inline-flex items-center justify-center gap-1 rounded bg-ink px-3 py-2 text-sm font-medium text-white hover:bg-slate-700"><RefreshCw size={15} />{t("查询")}</button>
        </form>
        <div className="mb-4 grid gap-3 sm:grid-cols-3"><div className="rounded bg-slate-50 p-3"><div className="text-xs text-slate-500">{t("素材记录")}</div><div className="mt-1 text-xl font-semibold text-ink">{ledger.summary?.totalCount || 0}</div></div><div className="rounded bg-slate-50 p-3"><div className="text-xs text-slate-500">SKU</div><div className="mt-1 text-xl font-semibold text-ink">{ledger.summary?.skuCount || 0}</div></div><div className="rounded bg-slate-50 p-3"><div className="text-xs text-slate-500">{t("平台")}</div><div className="mt-1 text-xl font-semibold text-ink">{ledger.summary?.platformCount || 0}</div></div></div>
        {loading ? <div className="py-8 text-center text-sm text-slate-500">{t("正在加载…")}</div> : ledger.records.length === 0 ? <div className="py-8 text-center text-sm text-slate-500">{t("暂无匹配的素材记录。")}</div> : <div className="overflow-x-auto rounded border border-slate-200"><table className="w-full min-w-[820px] text-left text-sm"><thead className="bg-slate-50 text-xs text-slate-500"><tr><th className="px-3 py-2">SKU</th><th className="px-3 py-2">{t("平台")}</th><th className="px-3 py-2">{t("素材 ID / URL")}</th><th className="px-3 py-2">{t("用途")}</th><th className="px-3 py-2">{t("文件名")}</th><th className="px-3 py-2">{t("备注")}</th><th className="px-3 py-2">{t("更新时间")}</th></tr></thead><tbody>{ledger.records.slice(0, 500).map((record) => <tr key={record.id} className="border-t border-slate-100"><td className="px-3 py-2 font-mono text-xs">{record.sku}</td><td className="px-3 py-2">{record.platformId}</td><td className="max-w-xs truncate px-3 py-2 font-mono text-xs" title={record.materialId}>{record.materialId}</td><td className="px-3 py-2">{t(TYPE_LABELS[record.materialType] || record.materialType)}</td><td className="px-3 py-2">{record.fileName || '—'}</td><td className="max-w-xs truncate px-3 py-2 text-slate-500">{record.notes || '—'}</td><td className="px-3 py-2 text-xs text-slate-500">{dateTime(record.updatedAt)}</td></tr>)}</tbody></table></div>}
      </Section>

      <Section title={t("素材分页与单条管理")}>
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-3 text-sm"><button className="btn-secondary" disabled={loading || page <= 1} onClick={() => changePage(page - 1)}>{t("上一页")}</button><span>{t("第") + " "}{ledger.pagination?.page || page} / {ledger.pagination?.totalPages || 1}{" " + t("页 · 每页 50 条")}</span><button className="btn-secondary" disabled={loading || page >= (ledger.pagination?.totalPages || 1)} onClick={() => changePage(page + 1)}>{t("下一页")}</button><label className="flex items-center gap-2"><input type="checkbox" checked={includeArchived} onChange={(event) => { setIncludeArchived(event.target.checked); changePage(1, event.target.checked); }} />{t("包含已归档")}</label></div>
          <label className="block text-sm text-slate-600">{t("选择当前页素材进行编辑或归档")}<select value={editing?.id || ''} onChange={(event) => setEditing(ledger.records.find((record) => record.id === event.target.value) || null)} className="focus-ring mt-1 w-full rounded border border-slate-300 p-2"><option value="">{t("请选择素材记录")}</option>{ledger.records.map((record) => <option key={record.id} value={record.id}>{record.sku} · {record.platformId} · {record.materialId} {record.status === 'archived' ? t("（已归档）") : ''}</option>)}</select></label>
          {editing && <form onSubmit={saveMaterial} className="space-y-3"><div className="grid gap-3 md:grid-cols-2">{[['sku', 'SKU'], ['platformId', '平台'], ['materialId', '素材 ID / URL'], ['fileName', '文件名'], ['notes', '备注']].map(([key, label]) => <label key={key} className="text-sm text-slate-600">{t(label)}<input value={editing[key] || ''} onChange={(event) => setEditing({ ...editing, [key]: event.target.value })} className="focus-ring mt-1 w-full rounded border border-slate-300 p-2" /></label>)}<label className="text-sm text-slate-600">{t("用途")}<select value={editing.materialType} onChange={(event) => setEditing({ ...editing, materialType: event.target.value })} className="focus-ring mt-1 w-full rounded border border-slate-300 p-2">{Object.entries(TYPE_LABELS).map(([id, label]) => <option key={id} value={id}>{t(label)}</option>)}</select></label></div><div className="flex gap-2"><button className="btn-primary" disabled={editBusy}>{t("保存修改")}</button><button type="button" className="btn-secondary" disabled={editBusy} onClick={archiveMaterial}>{editing.status === 'archived' ? t("恢复记录") : t("归档记录")}</button></div></form>}
        </div>
      </Section>

      <Section title={t("XLSX 模板表头识别")}>
        <form onSubmit={inspectTemplate} className="grid gap-4 md:grid-cols-[220px_1fr_auto] md:items-end">
          <label className="text-sm text-slate-600">{t("目标平台")}<select value={templatePlatform} onChange={(event) => { setTemplatePlatform(event.target.value); setInspection(null); setFillPreview(null); setFillResult(null); }} className="focus-ring mt-1 w-full rounded border border-slate-300 px-3 py-2 text-ink">{PLATFORM_OPTIONS.map(([id, label]) => <option key={id} value={id}>{t(label)}</option>)}</select></label>
          <label className="text-sm text-slate-600">{t("选择无宏 XLSX 模板")}<div className="mt-1 flex h-10 items-center gap-2 rounded border border-slate-300 bg-white px-3"><Upload size={16} className="text-mint" /><input type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" onChange={(event) => { setTemplateFile(event.target.files?.[0] || null); setInspection(null); setFillPreview(null); setFillResult(null); }} className="min-w-0 flex-1 text-xs" /></div></label>
          <button disabled={inspectBusy || !templateFile} className="focus-ring inline-flex h-10 items-center justify-center gap-2 rounded bg-ink px-4 text-sm font-semibold text-white hover:bg-slate-700 disabled:opacity-50">{inspectBusy ? <LoaderCircle size={17} className="animate-spin" /> : <FileSpreadsheet size={17} />}{inspectBusy ? t("识别中…") : t("识别模板")}</button>
        </form>
        <div className="mt-4 flex items-center gap-2 rounded border border-slate-200 bg-slate-50 p-3 text-xs text-slate-600"><FileCheck2 size={16} className="text-mint" />{t("只读取前 30 行用于识别；文件不会保留，宏不会执行，外部链接不会访问。")}</div>
        <MappingResult result={inspection} />
      </Section>
      {inspection && <Section title={t("模板副本回填")}>
        <div className="space-y-4">
          <p className="text-sm text-slate-600">{t("填写商品 JSON 数组，预览逐个单元格差异，再生成 XLSX 副本。已有公式始终保留；遇到公式冲突会阻止执行。")}</p>
          <div className="grid gap-3 md:grid-cols-3">{inspection.mapping.fields.map((field) => <label key={field.field} className="text-sm text-slate-600">{field.field}{inspection.mapping.required.includes(field.field) ? t("（必填）") : ''}<select value={fillMapping[field.field] ?? ''} onChange={(event) => { setFillMapping({ ...fillMapping, [field.field]: event.target.value === '' ? null : Number(event.target.value) }); setFillPreview(null); setFillResult(null); }} className="focus-ring mt-1 w-full rounded border border-slate-300 p-2"><option value="">{t("不填入")}</option>{(inspection.sheets.find((sheet) => sheet.name === inspection.selectedSheet)?.headers || []).map((header, index) => <option key={index} value={index}>{index + 1}. {header || t("空列")}</option>)}</select></label>)}</div>
          <textarea aria-label={t("回填商品数据")} rows={9} value={fillRecords} onChange={(event) => { setFillRecords(event.target.value); setFillPreview(null); setFillResult(null); }} className="focus-ring w-full rounded border border-slate-300 p-3 font-mono text-xs" />
          <div className="flex flex-wrap items-center gap-3"><button type="button" className="btn-secondary" onClick={fillFromMaterials}>{t("补入当前素材台账")}</button><label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={overwriteCells} onChange={(event) => { setOverwriteCells(event.target.checked); setFillPreview(null); setFillResult(null); }} />{t("允许替换模板已有文本（公式除外）")}</label><button className="btn-primary" disabled={fillBusy || !templateFile} onClick={previewFill}>{t("预览回填差异")}</button></div>
          {fillPreview && <div className="space-y-3"><p className="text-sm">{t("工作表：")}{fillPreview.sheetName}{" " + t("· 修改") + " "}{fillPreview.summary.changedCells}{" " + t("格 · 冲突") + " "}{fillPreview.summary.blockedCells}{" " + t("格")}</p>
            <div className="max-h-80 overflow-auto rounded border border-slate-200"><table className="w-full text-left text-sm"><thead className="bg-slate-50"><tr><th className="p-2">{t("单元格")}</th><th className="p-2">{t("字段")}</th><th className="p-2">{t("原值")}</th><th className="p-2">{t("新值")}</th></tr></thead><tbody>{fillPreview.changes.slice(0, 100).map((change) => <tr key={change.ref} className="border-t border-slate-100"><td className="p-2">{change.ref}</td><td className="p-2">{change.field}</td><td className="max-w-xs break-all p-2">{change.before || t("空")}</td><td className="max-w-xs break-all p-2">{change.after}</td></tr>)}</tbody></table></div>
            {fillPreview.blocked.map((item) => <p key={item.ref} className="text-sm text-amber-800">{item.ref}：{item.reason === 'FORMULA_PRESERVED' ? t("此单元格包含公式，请更换映射或模板") : t("此单元格已有内容，请检查是否允许替换")}</p>)}
            <button className="btn-primary" disabled={fillBusy || !fillPreview.canExecute} onClick={executeFill}>{t("确认并生成模板副本")}</button>
          </div>}
          {fillResult && <div className="flex flex-wrap gap-3 rounded bg-teal-50 p-4 text-sm text-teal-900"><span>{t("副本已生成，原文件保持不变。")}</span><a className="underline" href={`${ASSET_BASE}${fillResult.downloadUrl}`} download>{t("下载 XLSX 副本")}</a><a className="underline" href={`${ASSET_BASE}${fillResult.diffUrl}`} download>{t("下载差异报告")}</a></div>}
        </div>
      </Section>}
    </div>
  );
}
