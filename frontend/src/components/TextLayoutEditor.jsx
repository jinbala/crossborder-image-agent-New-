import { useLocale } from '../i18n/LocaleProvider.jsx';
import { useEffect, useMemo, useState } from 'react';

function cloneLayout(layout) {
  return JSON.parse(JSON.stringify(layout || {}));
}

function ensureArrays(layout) {
  return {
    ...layout,
    textElements: Array.isArray(layout.textElements) ? layout.textElements : [],
    iconElements: Array.isArray(layout.iconElements) ? layout.iconElements : [],
    lineElements: Array.isArray(layout.lineElements) ? layout.lineElements : []
  };
}

function elementKey(kind, id) {
  return `${kind}:${id}`;
}

function splitKey(key = '') {
  const [kind, ...rest] = key.split(':');
  return { kind, id: rest.join(':') };
}

function canvasScale(canvas) {
  return 420 / (canvas?.width || 1600);
}

export default function TextLayoutEditor({ layout, onSave, onRestore, onRegenerate, saving = false }) {
  const { t } = useLocale();
  const [draft, setDraft] = useState(() => ensureArrays(cloneLayout(layout)));
  const [selectedKey, setSelectedKey] = useState('');
  const [dragging, setDragging] = useState(null);
  const scale = canvasScale(draft.canvas);

  useEffect(() => {
    setDraft(ensureArrays(cloneLayout(layout)));
    setSelectedKey('');
  }, [layout]);

  const selected = useMemo(() => {
    const { kind, id } = splitKey(selectedKey);
    const listName = `${kind}Elements`;
    return draft[listName]?.find((item) => item.id === id) || null;
  }, [draft, selectedKey]);

  if (!layout) return null;

  function updateElement(kind, id, patch) {
    const listName = `${kind}Elements`;
    setDraft((current) => ({
      ...current,
      [listName]: (current[listName] || []).map((item) => (
        item.id === id
          ? { ...item, ...patch, editedByUser: true, editedAt: new Date().toISOString() }
          : item
      ))
    }));
  }

  function deleteElement(kind, id) {
    const listName = `${kind}Elements`;
    setDraft((current) => ({
      ...current,
      [listName]: (current[listName] || []).map((item) => (
        item.id === id
          ? { ...item, visible: false, editedByUser: true, editedAt: new Date().toISOString() }
          : item
      ))
    }));
  }

  function selectedListName() {
    const { kind } = splitKey(selectedKey);
    return `${kind}Elements`;
  }

  function selectedKind() {
    return splitKey(selectedKey).kind;
  }

  function updateSelected(patch) {
    if (!selected) return;
    updateElement(selectedKind(), selected.id, patch);
  }

  function startDrag(event, kind, item) {
    if (kind === 'line') return;
    event.preventDefault();
    event.stopPropagation();
    setSelectedKey(elementKey(kind, item.id));
    setDragging({
      kind,
      id: item.id,
      startX: event.clientX,
      startY: event.clientY,
      originalX: Number(item.x || 0),
      originalY: Number(item.y || 0)
    });
  }

  function moveDrag(event) {
    if (!dragging) return;
    const deltaX = (event.clientX - dragging.startX) / scale;
    const deltaY = (event.clientY - dragging.startY) / scale;
    updateElement(dragging.kind, dragging.id, {
      x: Math.round(dragging.originalX + deltaX),
      y: Math.round(dragging.originalY + deltaY)
    });
  }

  function renderTextElement(item) {
    if (item.visible === false) return null;
    return (
      <button
        key={item.id}
        type="button"
        onClick={() => setSelectedKey(elementKey('text', item.id))}
        onPointerDown={(event) => startDrag(event, 'text', item)}
        className={`absolute border text-left ${selectedKey === elementKey('text', item.id) ? 'border-coral bg-white/90' : 'border-blue-300 bg-blue-50/85'}`}
        style={{
          left: item.x * scale,
          top: item.y * scale,
          width: item.width * scale,
          minHeight: Math.max(20, (item.height || 70) * scale),
          fontSize: Math.max(10, (item.fontSize || 32) * scale),
          fontWeight: item.fontWeight || 700,
          textAlign: item.align || 'left',
          zIndex: item.zIndex || 1
        }}
      >
        {item.text}
      </button>
    );
  }

  function renderIconElement(item) {
    if (item.visible === false) return null;
    return (
      <button
        key={item.id}
        type="button"
        onClick={() => setSelectedKey(elementKey('icon', item.id))}
        onPointerDown={(event) => startDrag(event, 'icon', item)}
        className={`absolute flex items-center justify-center rounded border text-[10px] font-semibold ${selectedKey === elementKey('icon', item.id) ? 'border-coral bg-white' : 'border-emerald-300 bg-emerald-50'}`}
        style={{
          left: item.x * scale,
          top: item.y * scale,
          width: (item.size || 60) * scale,
          height: (item.size || 60) * scale,
          zIndex: item.zIndex || 100
        }}
      >
        {item.label || item.type}
      </button>
    );
  }

  function renderLineElement(item) {
    if (item.visible === false) return null;
    return (
      <g key={item.id} onClick={() => setSelectedKey(elementKey('line', item.id))} className="cursor-pointer">
        <line
          x1={item.x1 * scale}
          y1={item.y1 * scale}
          x2={item.x2 * scale}
          y2={item.y2 * scale}
          stroke={selectedKey === elementKey('line', item.id) ? '#ef4444' : '#0f766e'}
          strokeWidth="3"
        />
        {item.label && <text x={item.x2 * scale + 6} y={item.y2 * scale} fontSize="11" fill="#0f766e">{item.label}</text>}
      </g>
    );
  }

  const listName = selectedListName();

  return (
    <div className="grid gap-3 lg:grid-cols-[430px_1fr]">
      <div
        className="relative aspect-square w-full max-w-[420px] overflow-hidden rounded border border-slate-300 bg-white"
        style={{ background: draft.canvas?.background || '#fff' }}
        onPointerMove={moveDrag}
        onPointerUp={() => setDragging(null)}
        onPointerLeave={() => setDragging(null)}
      >
        <div className="absolute inset-0">
          <div className="absolute rounded border-2 border-dashed border-slate-300 bg-slate-100/70"
            style={{
              left: (draft.productArea?.x || 500) * scale,
              top: (draft.productArea?.y || 420) * scale,
              width: (draft.productArea?.width || 600) * scale,
              height: (draft.productArea?.height || 560) * scale
            }}
          />
          <svg className="absolute inset-0 h-full w-full">{draft.lineElements.map(renderLineElement)}</svg>
          {draft.iconElements.map(renderIconElement)}
          {draft.textElements.map(renderTextElement)}
        </div>
      </div>

      <div className="space-y-3 text-xs">
        <div className="grid grid-cols-3 gap-2">
          <div className="rounded border border-slate-200 bg-slate-50 p-2">{t("文字") + " "}{draft.textElements.length}</div>
          <div className="rounded border border-slate-200 bg-slate-50 p-2">{t("图标") + " "}{draft.iconElements.length}</div>
          <div className="rounded border border-slate-200 bg-slate-50 p-2">{t("线条") + " "}{draft.lineElements.length}</div>
        </div>

        <select
          value={selectedKey}
          onChange={(event) => setSelectedKey(event.target.value)}
          className="w-full rounded border border-slate-300 bg-white px-2 py-2"
        >
          <option value="">{t("选择要编辑的元素")}</option>
          {draft.textElements.map((item) => <option key={item.id} value={elementKey('text', item.id)}>{t("文字：")}{item.text || item.id}</option>)}
          {draft.iconElements.map((item) => <option key={item.id} value={elementKey('icon', item.id)}>{t("图标：")}{item.label || item.id}</option>)}
          {draft.lineElements.map((item) => <option key={item.id} value={elementKey('line', item.id)}>{t("线条：")}{item.label || item.id}</option>)}
        </select>

        {selected && (
          <div className="space-y-2 rounded border border-slate-200 bg-white p-3">
            {'text' === selectedKind() && (
              <label className="block">
                <span className="font-medium text-slate-600">{t("文字内容")}</span>
                <textarea className="mt-1 min-h-16 w-full rounded border border-slate-300 px-2 py-1" value={selected.text || ''} onChange={(event) => updateSelected({ text: event.target.value })} />
              </label>
            )}
            {'icon' === selectedKind() && (
              <label className="block">
                <span className="font-medium text-slate-600">{t("图标标签")}</span>
                <input className="mt-1 w-full rounded border border-slate-300 px-2 py-1" value={selected.label || ''} onChange={(event) => updateSelected({ label: event.target.value })} />
              </label>
            )}
            {'line' === selectedKind() && (
              <label className="block">
                <span className="font-medium text-slate-600">{t("线条标签")}</span>
                <input className="mt-1 w-full rounded border border-slate-300 px-2 py-1" value={selected.label || ''} onChange={(event) => updateSelected({ label: event.target.value })} />
              </label>
            )}

            {'line' !== selectedKind() ? (
              <div className="grid grid-cols-2 gap-2">
                <label>X<input type="number" className="mt-1 w-full rounded border border-slate-300 px-2 py-1" value={selected.x || 0} onChange={(event) => updateSelected({ x: Number(event.target.value) })} /></label>
                <label>Y<input type="number" className="mt-1 w-full rounded border border-slate-300 px-2 py-1" value={selected.y || 0} onChange={(event) => updateSelected({ y: Number(event.target.value) })} /></label>
                {'text' === selectedKind() && <label>{t("字号")}<input type="number" className="mt-1 w-full rounded border border-slate-300 px-2 py-1" value={selected.fontSize || 32} onChange={(event) => updateSelected({ fontSize: Number(event.target.value) })} /></label>}
                {'icon' === selectedKind() && <label>{t("大小")}<input type="number" className="mt-1 w-full rounded border border-slate-300 px-2 py-1" value={selected.size || 60} onChange={(event) => updateSelected({ size: Number(event.target.value) })} /></label>}
              </div>
            ) : (
              <div className="grid grid-cols-2 gap-2">
                {['x1', 'y1', 'x2', 'y2'].map((field) => (
                  <label key={field}>{field}<input type="number" className="mt-1 w-full rounded border border-slate-300 px-2 py-1" value={selected[field] || 0} onChange={(event) => updateSelected({ [field]: Number(event.target.value) })} /></label>
                ))}
              </div>
            )}

            {'text' === selectedKind() && (
              <label className="block">
                <span className="font-medium text-slate-600">{t("对齐方式")}</span>
                <select className="mt-1 w-full rounded border border-slate-300 px-2 py-1" value={selected.align || 'left'} onChange={(event) => updateSelected({ align: event.target.value })}>
                  <option value="left">{t("左对齐")}</option>
                  <option value="center">{t("居中")}</option>
                  <option value="right">{t("右对齐")}</option>
                </select>
              </label>
            )}

            <div className="grid grid-cols-3 gap-2">
              <label className="flex items-center gap-2 rounded border border-slate-200 px-2 py-1">
                <input type="checkbox" checked={selected.visible !== false} onChange={(event) => updateSelected({ visible: event.target.checked })} />{t("显示")}</label>
              <button type="button" className="rounded border border-slate-300 px-2 py-1" onClick={() => updateSelected({ zIndex: (selected.zIndex || 1) + 1 })}>{t("上移层级")}</button>
              <button type="button" className="rounded border border-slate-300 px-2 py-1" onClick={() => updateSelected({ zIndex: Math.max(0, (selected.zIndex || 1) - 1) })}>{t("下移层级")}</button>
            </div>
            <button type="button" className="rounded border border-red-200 bg-red-50 px-3 py-1 text-red-700" onClick={() => deleteElement(selectedKind(), selected.id)}>{t("隐藏/删除元素")}</button>
          </div>
        )}

        <div className="flex flex-wrap gap-2">
          <button type="button" disabled={saving} onClick={() => onSave?.(draft)} className="rounded bg-ink px-3 py-2 text-white disabled:opacity-60">
            {saving ? t("正在保存...") : t("保存布局")}
          </button>
          {onRegenerate && <button type="button" onClick={() => onRegenerate(draft)} className="rounded border border-coral px-3 py-2 text-coral">{t("使用当前排版重新生成")}</button>}
          <button type="button" onClick={onRestore} className="rounded border border-slate-300 px-3 py-2 text-slate-700">{t("恢复自动布局")}</button>
        </div>
      </div>
    </div>
  );
}
