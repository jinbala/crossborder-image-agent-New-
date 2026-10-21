import { useLocale } from '../i18n/LocaleProvider.jsx';
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import Section from '../components/Section.jsx';
import { api } from '../services/api.js';
import { ErrorMessage, PrimaryButton } from './pageUtils.jsx';

const emptyForm = {
  name: '',
  description: '',
  categoryId: 'general',
  defaultTargetsText: 'amazon,US,English,general',
  visionProvider: 'mock',
  imageProvider: 'mock',
  backgroundProvider: 'mock',
  reviewProvider: 'mock',
  recognitionMode: 'balanced',
  queueConcurrency: 2,
  reviewMode: 'mock',
  allowRealLifestyle: false
};

function parseTargets(text) {
  return String(text || '')
    .split('\n')
    .flatMap((line) => line.split(';'))
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [platformId = 'amazon', site = 'US', language = 'English', categoryId = 'general'] = line.split(',').map((item) => item.trim());
      return { platformId, site, language, categoryId };
    });
}

function templateToForm(template) {
  return {
    ...emptyForm,
    name: template.name || '',
    description: template.description || '',
    categoryId: template.categoryId || 'general',
    defaultTargetsText: (template.defaultTargets || [])
      .map((target) => [target.platformId, target.site, target.language, target.categoryId || target.category].filter(Boolean).join(','))
      .join('\n'),
    visionProvider: template.providers?.visionProvider || 'mock',
    imageProvider: template.providers?.imageProvider || 'mock',
    backgroundProvider: template.providers?.backgroundProvider || 'mock',
    reviewProvider: template.providers?.reviewProvider || 'mock',
    recognitionMode: template.recognition?.mode || 'balanced',
    queueConcurrency: template.queue?.concurrency || 2,
    reviewMode: template.review?.defaultMode || 'mock',
    allowRealLifestyle: Boolean(template.generation?.allowRealLifestyle)
  };
}

function formToTemplate(form) {
  return {
    name: form.name,
    description: form.description,
    categoryId: form.categoryId,
    tags: ['user-template'],
    defaultTargets: parseTargets(form.defaultTargetsText),
    providers: {
      visionProvider: form.visionProvider,
      imageProvider: form.imageProvider,
      backgroundProvider: form.backgroundProvider,
      reviewProvider: form.reviewProvider
    },
    recognition: { mode: form.recognitionMode, maxImages: 15 },
    generation: { defaultMode: 'mock', allowRealLifestyle: form.allowRealLifestyle, realMode: 'auto' },
    review: { defaultMode: form.reviewMode },
    queue: { concurrency: Number(form.queueConcurrency) || 2, autoRetryEnabled: false, maxRetryPerJob: 1, retryableFilter: 'retryable' },
    export: { includeAllPlatforms: true, includeAnalytics: true },
    safety: { requireHumanConfirmation: true, preventAutoRealGeneration: !form.allowRealLifestyle, preventAutoRealReview: false }
  };
}

export default function WorkflowTemplatesPage() {
  const { t } = useLocale();
  const [templates, setTemplates] = useState([]);
  const [defaultTemplateId, setDefaultTemplateId] = useState('');
  const [selectedId, setSelectedId] = useState('');
  const [editingId, setEditingId] = useState('');
  const [form, setForm] = useState(emptyForm);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState(null);

  const selected = useMemo(() => templates.find((template) => template.id === selectedId) || templates[0] || null, [templates, selectedId]);

  async function load() {
    setLoading(true);
    setError('');
    try {
      const [result, settingsResult] = await Promise.all([
        api.listWorkflowTemplates(),
        api.getEffectiveSettings()
      ]);
      setTemplates(result.templates || []);
      setDefaultTemplateId(settingsResult.userSettings?.defaults?.workflowTemplateId || '');
      if (!selectedId && result.templates?.[0]) setSelectedId(result.templates[0].id);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  function updateForm(patch) {
    setForm((current) => ({ ...current, ...patch }));
  }

  function startCreate() {
    setEditingId('');
    setForm(emptyForm);
  }

  function startEdit(template) {
    setEditingId(template.id);
    setForm(templateToForm(template));
  }

  async function saveTemplate() {
    if (busy || loading || !form.name.trim()) return;
    if (editingId && !window.confirm(t('保存模板“{name}”的修改？只影响后续使用，不会改写已有任务快照或调用 AI。', { name: form.name }))) return;
    setBusy('save');
    setError('');
    try {
      const payload = formToTemplate(form);
      const result = editingId ? await api.updateWorkflowTemplate(editingId, payload) : await api.createWorkflowTemplate(payload);
      setSelectedId(result.template.id);
      setNotice({ action: 'saved', name: result.template.name });
      await load();
      setEditingId('');
      setForm(emptyForm);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy('');
    }
  }

  async function clone(templateId) {
    if (busy || loading) return;
    setBusy(`clone-${templateId}`);
    setError('');
    try {
      const result = await api.cloneWorkflowTemplate(templateId);
      await load();
      setSelectedId(result.template.id);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy('');
    }
  }

  async function remove(templateId) {
    const template = templates.find((item) => item.id === templateId);
    if (busy || loading || !template || template.isSystemTemplate) return;
    if (!window.confirm(t('删除模板“{name}”？仅删除此模板，无法在本页撤销；已有任务快照和图片不变。', { name: template.name }))) return;
    setBusy(`delete-${templateId}`);
    setError('');
    try {
      await api.deleteWorkflowTemplate(templateId);
      setNotice({ action: 'deleted', name: template.name });
      if (editingId === templateId) startCreate();
      await load();
      setSelectedId('');
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy('');
    }
  }

  return (
    <div className="space-y-5">
      <ErrorMessage error={error} />
      {notice && <p role="status" data-template-notice className="rounded border border-teal-200 bg-teal-50 p-3 text-sm">{notice.action === 'deleted' ? t('已删除模板：{name}。已有任务和图片不变。', { name: notice.name }) : t('已保存模板：{name}。未自动启动任务或调用 AI。', { name: notice.name })}</p>}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-ink">{t("工作流模板")}</h1>
          <p className="mt-1 text-sm text-slate-500">{t("模板用于快速填充平台、Provider、并发、重试和导出策略，不保存 API Key，也不会自动启动真实 AI。")}</p>
        </div>
        <Link to="/batches" className="rounded border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700">{t("返回批量任务")}</Link>
      </div>

      <button type="button" data-template-refresh disabled={loading || Boolean(busy)} onClick={load} className="btn-secondary">{t('刷新模板')}</button>
      {loading && <p className="text-sm text-slate-500">{t('正在加载模板...')}</p>}
      <Section title={t("模板列表")}>
        <div className="grid gap-3 md:grid-cols-2">
          {templates.map((template) => (
            <button
              key={template.id}
              data-template-id={template.id}
              disabled={loading || Boolean(busy)}
              type="button"
              onClick={() => setSelectedId(template.id)}
              className={`rounded border p-4 text-left ${selected?.id === template.id ? 'border-mint bg-teal-50' : 'border-slate-200 bg-white'}`}
            >
              <div className="flex items-center justify-between gap-2">
                <div className="font-semibold text-ink">{template.name}</div>
                <span className="rounded bg-slate-100 px-2 py-1 text-xs text-slate-600">{template.id === defaultTemplateId ? t("当前默认") : (template.isSystemTemplate ? t("系统模板") : t("用户模板"))}</span>
              </div>
              <div className="mt-1 text-sm text-slate-500">{template.description}</div>
              <div className="mt-2 text-xs text-slate-500">
                targets {template.defaultTargets?.length || 0} / vision {template.providers?.visionProvider || 'mock'} / image {template.providers?.imageProvider || 'mock'} / review {template.providers?.reviewProvider || 'mock'}
              </div>
            </button>
          ))}
        </div>
      </Section>

      {selected && (
        <Section title={t("模板详情")}>
          <div className="grid gap-3 md:grid-cols-4">
            <div className="rounded border border-slate-200 p-3"><div className="text-xs text-slate-500">{t("类目")}</div><div className="mt-1 font-semibold">{selected.categoryId}</div></div>
            <div className="rounded border border-slate-200 p-3"><div className="text-xs text-slate-500">{t("识别")}</div><div className="mt-1 font-semibold">{selected.providers?.visionProvider} / {selected.recognition?.mode}</div></div>
            <div className="rounded border border-slate-200 p-3"><div className="text-xs text-slate-500">{t("生图")}</div><div className="mt-1 font-semibold">{selected.providers?.imageProvider} / {selected.providers?.backgroundProvider}</div></div>
            <div className="rounded border border-slate-200 p-3"><div className="text-xs text-slate-500">{t("队列")}</div><div className="mt-1 font-semibold">{t("并发") + " "}{selected.queue?.concurrency || 2}</div></div>
          </div>
          <div className="mt-3 rounded border border-slate-200 bg-slate-50 p-3 text-sm text-slate-600">
            {(selected.defaultTargets || []).map((target) => (
              <div key={`${target.platformId}-${target.site}-${target.language}`}>{target.platformId} / {target.site} / {target.language} / {target.categoryId}</div>
            ))}
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            <button type="button" disabled={Boolean(busy)} onClick={() => clone(selected.id)} className="rounded border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700">{t("复制模板")}</button>
            {!selected.isSystemTemplate && (
              <>
                <button type="button" disabled={Boolean(busy)} onClick={() => startEdit(selected)} className="rounded border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700">{t("编辑")}</button>
                <button type="button" data-template-delete disabled={loading || Boolean(busy)} onClick={() => remove(selected.id)} className="rounded border border-red-300 bg-white px-3 py-2 text-sm font-medium text-red-700">{t("删除")}</button>
              </>
            )}
          </div>
        </Section>
      )}

      <Section title={editingId ? t("编辑用户模板") : t("新建用户模板")}>
        <fieldset data-template-form disabled={loading || Boolean(busy)}>
        <div className="grid gap-3 md:grid-cols-2">
          <label className="block"><span className="mb-1 block text-sm font-medium text-slate-700">{t("名称")}</span><input value={form.name} onChange={(event) => updateForm({ name: event.target.value })} className="w-full rounded border border-slate-300 px-3 py-2 text-sm" /></label>
          <label className="block"><span className="mb-1 block text-sm font-medium text-slate-700">{t("类目")}</span><input value={form.categoryId} onChange={(event) => updateForm({ categoryId: event.target.value })} className="w-full rounded border border-slate-300 px-3 py-2 text-sm" /></label>
          <label className="block md:col-span-2"><span className="mb-1 block text-sm font-medium text-slate-700">{t("描述")}</span><input value={form.description} onChange={(event) => updateForm({ description: event.target.value })} className="w-full rounded border border-slate-300 px-3 py-2 text-sm" /></label>
          <label className="block md:col-span-2"><span className="mb-1 block text-sm font-medium text-slate-700">{t("默认平台 targets（每行：platformId,site,language,categoryId）")}</span><textarea rows={4} value={form.defaultTargetsText} onChange={(event) => updateForm({ defaultTargetsText: event.target.value })} className="w-full rounded border border-slate-300 px-3 py-2 text-sm" /></label>
          <label className="block"><span className="mb-1 block text-sm font-medium text-slate-700">Vision Provider</span><select value={form.visionProvider} onChange={(event) => updateForm({ visionProvider: event.target.value })} className="w-full rounded border border-slate-300 px-3 py-2 text-sm"><option>mock</option><option>gemini</option><option>qwen</option><option>openai</option></select></label>
          <label className="block"><span className="mb-1 block text-sm font-medium text-slate-700">Image Provider</span><select value={form.imageProvider} onChange={(event) => updateForm({ imageProvider: event.target.value })} className="w-full rounded border border-slate-300 px-3 py-2 text-sm"><option>mock</option><option>real</option></select></label>
          <label className="block"><span className="mb-1 block text-sm font-medium text-slate-700">Background Provider</span><select value={form.backgroundProvider} onChange={(event) => updateForm({ backgroundProvider: event.target.value })} className="w-full rounded border border-slate-300 px-3 py-2 text-sm"><option>mock</option><option>openai</option></select></label>
          <label className="block"><span className="mb-1 block text-sm font-medium text-slate-700">Review Provider</span><select value={form.reviewProvider} onChange={(event) => updateForm({ reviewProvider: event.target.value })} className="w-full rounded border border-slate-300 px-3 py-2 text-sm"><option>mock</option><option>gemini</option><option>qwen</option><option>openai</option></select></label>
          <label className="block"><span className="mb-1 block text-sm font-medium text-slate-700">{t("识别模式")}</span><select value={form.recognitionMode} onChange={(event) => updateForm({ recognitionMode: event.target.value })} className="w-full rounded border border-slate-300 px-3 py-2 text-sm"><option>fast</option><option>balanced</option><option>full</option></select></label>
          <label className="block"><span className="mb-1 block text-sm font-medium text-slate-700">{t("队列并发")}</span><input type="number" min="1" max="4" value={form.queueConcurrency} onChange={(event) => updateForm({ queueConcurrency: event.target.value })} className="w-full rounded border border-slate-300 px-3 py-2 text-sm" /></label>
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          <PrimaryButton data-template-save busy={busy === 'save'} disabled={loading || Boolean(busy) || !form.name.trim()} onClick={saveTemplate}>{t("保存模板")}</PrimaryButton>
          <button type="button" onClick={startCreate} className="rounded border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700">{t("清空表单")}</button>
        </div>
        </fieldset>
      </Section>
    </div>
  );
}
