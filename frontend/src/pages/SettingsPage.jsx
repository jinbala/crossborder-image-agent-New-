import { useLocale } from '../i18n/LocaleProvider.jsx';
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import Section from '../components/Section.jsx';
import { api } from '../services/api.js';
import { ErrorMessage, PrimaryButton } from './pageUtils.jsx';
import { maintenanceLabel, maintenanceStatusLabels, settingFieldLabels } from '../utils/maintenanceLabels.js';

const providerOptions = {
  visionProvider: ['mock', 'gemini', 'qwen', 'openai'],
  imageProvider: ['mock', 'real'],
  backgroundProvider: ['mock', 'openai', 'qwen', 'gemini', 'custom'],
  reviewProvider: ['mock', 'gemini', 'openai', 'qwen'],
  mattingProvider: ['sharp', 'mock', 'external']
};

function targetsToText(platforms = []) {
  return platforms
    .map((item) => [item.platformId, item.site, item.language, item.categoryId].filter(Boolean).join(','))
    .join('\n');
}

function textToTargets(text) {
  return String(text || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [platformId = 'amazon', site = 'US', language = 'English', categoryId = 'electronics_storage'] = line.split(',').map((item) => item.trim());
      return { platformId, site, language, categoryId };
    });
}

function providerCostValue(settings, action, provider) {
  const value = settings?.cost?.[action]?.[provider];
  if (typeof value === 'number') return value;
  if (value && typeof value === 'object') return value.perCall || 0;
  return 0;
}

function setProviderCost(settings, action, provider, value) {
  return {
    ...settings,
    cost: {
      ...settings.cost,
      [action]: {
        ...(settings.cost?.[action] || {}),
        [provider]: Number(value) || 0
      }
    }
  };
}

function hasSensitiveKeys(value) {
  if (!value || typeof value !== 'object') return false;
  return Object.entries(value).some(([key, nested]) => (
    /(api[_-]?key|secret|token|password|credential)/i.test(key) || hasSensitiveKeys(nested)
  ));
}

export default function SettingsPage() {
  const { t, dateTime } = useLocale();
  const [settings, setSettings] = useState(null);
  const [envSummary, setEnvSummary] = useState(null);
  const [warnings, setWarnings] = useState([]);
  const [templates, setTemplates] = useState([]);
  const [snapshots, setSnapshots] = useState([]);
  const [healthSummary, setHealthSummary] = useState(null);
  const [platformText, setPlatformText] = useState('');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [loading, setLoading] = useState(true);

  const templateName = useMemo(() => {
    const selected = templates.find((template) => template.id === settings?.defaults?.workflowTemplateId);
    return selected?.name || null;
  }, [templates, settings]);

  async function load() {
    setLoading(true);
    setError('');
    try {
      const [effective, templateResult, snapshotResult, healthResult] = await Promise.all([
        api.getEffectiveSettings(),
        api.listWorkflowTemplates(),
        api.listSnapshots(),
        api.getFullHealth()
      ]);
      setSettings(effective.userSettings);
      setPlatformText(targetsToText(effective.userSettings.defaults?.platforms || []));
      setEnvSummary(effective.envSummary);
      setWarnings(effective.warnings || []);
      setTemplates(templateResult.templates || []);
      setSnapshots(snapshotResult.snapshots || []);
      setHealthSummary(healthResult.health);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  function update(path, value) {
    setSettings((current) => {
      const next = structuredClone(current);
      let cursor = next;
      for (let i = 0; i < path.length - 1; i += 1) {
        cursor[path[i]] = cursor[path[i]] || {};
        cursor = cursor[path[i]];
      }
      cursor[path.at(-1)] = value;
      return next;
    });
  }

  async function save() {
    setBusy('save');
    setError('');
    setMessage('');
    try {
      const payload = {
        ...settings,
        defaults: {
          ...settings.defaults,
          platforms: textToTargets(platformText)
        }
      };
      if (hasSensitiveKeys(payload)) {
        throw new Error(t('设置中心不能保存 API Key、token、secret 或密码字段，请在部署环境单独配置密钥。'));
      }
      const result = await api.updateSettings(payload);
      setSettings(result.userSettings);
      setPlatformText(targetsToText(result.userSettings.defaults?.platforms || []));
      const effective = await api.getEffectiveSettings();
      setEnvSummary(effective.envSummary);
      setWarnings(effective.warnings || []);
      setMessage(t("设置已保存。"));
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy('');
    }
  }

  async function reset() {
    if (!window.confirm(t("确定要恢复默认设置吗？这不会修改 .env，也不会删除任务数据。"))) return;
    setBusy('reset');
    setError('');
    setMessage('');
    try {
      const result = await api.resetSettings();
      setSettings(result.userSettings);
      setPlatformText(targetsToText(result.userSettings.defaults?.platforms || []));
      const effective = await api.getEffectiveSettings();
      setEnvSummary(effective.envSummary);
      setWarnings(effective.warnings || []);
      setMessage(t("已恢复默认设置。"));
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy('');
    }
  }

  if (!settings) {
    return <div className="space-y-3"><h1 className="text-2xl font-semibold text-ink">{t('设置中心')}</h1><ErrorMessage error={error} /><p className="text-sm text-slate-500">{error ? t('设置暂不可用，请检查连接或当前账号权限后重试。') : t('正在加载设置...')}</p>{error && <button type="button" data-settings-retry disabled={loading} onClick={load} className="btn-secondary">{t('重新加载设置')}</button>}</div>;
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-ink">{t("设置中心")}</h1>
          <p className="mt-1 text-sm text-slate-500">{t('统一管理本地运营偏好。Provider 密钥通过部署环境配置，页面不会显示或保存密钥。')}</p>
        </div>
        <div className="flex gap-2">
          <button type="button" onClick={reset} disabled={Boolean(busy)} className="rounded border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 disabled:opacity-60">{t("恢复默认")}</button>
          <PrimaryButton busy={busy === 'save'} onClick={save}>{t("保存设置")}</PrimaryButton>
        </div>
      </div>

      <ErrorMessage error={error} />
      {message && <div className="rounded border border-teal-200 bg-teal-50 px-4 py-3 text-sm text-teal-800">{message}</div>}
      {warnings.length > 0 && (
        <div className="rounded border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          {warnings.map((warning, index) => <div key={`${warning.code}-${index}`}>{warning.message}</div>)}
        </div>
      )}

      <Section title={t("默认工作流")}>
        <div className="grid gap-3 md:grid-cols-2">
          <label className="block">
            <span className="mb-1 block text-sm font-medium text-slate-700">{t("默认模板")}</span>
            <select value={settings.defaults.workflowTemplateId || ''} onChange={(event) => update(['defaults', 'workflowTemplateId'], event.target.value || null)} className="w-full rounded border border-slate-300 bg-white px-3 py-2 text-sm">
              <option value="">{t("不指定模板")}</option>
              {templates.map((template) => <option key={template.id} value={template.id}>{template.name}</option>)}
            </select>
            <span className="mt-1 block text-xs text-slate-500">{t("当前默认：")}{templateName || t('未设置')}</span>
          </label>
          <label className="block">
            <span className="mb-1 block text-sm font-medium text-slate-700">{t("识别模式")}</span>
            <select value={settings.defaults.recognitionMode} onChange={(event) => update(['defaults', 'recognitionMode'], event.target.value)} className="w-full rounded border border-slate-300 bg-white px-3 py-2 text-sm">
              <option value="fast">fast</option>
              <option value="balanced">balanced</option>
              <option value="full">full</option>
            </select>
          </label>
          <label className="block md:col-span-2">
            <span className="mb-1 block text-sm font-medium text-slate-700">{t("默认平台 targets（每行：platformId,site,language,categoryId）")}</span>
            <textarea rows={4} value={platformText} onChange={(event) => setPlatformText(event.target.value)} className="w-full rounded border border-slate-300 px-3 py-2 text-sm" />
          </label>
        </div>
      </Section>

      <Section title={t("Provider 偏好")}>
        <div className="grid gap-3 md:grid-cols-5">
          {Object.entries(providerOptions).map(([key, options]) => (
            <label key={key} className="block">
              <span className="mb-1 block text-sm font-medium text-slate-700">{maintenanceLabel(key, settingFieldLabels, t)}</span>
              <select value={settings.providers[key]} onChange={(event) => update(['providers', key], event.target.value)} className="w-full rounded border border-slate-300 bg-white px-3 py-2 text-sm">
                {options.map((option) => <option key={option} value={option}>{option}</option>)}
              </select>
            </label>
          ))}
        </div>
        {envSummary && (
          <div className="mt-3 grid gap-2 text-xs text-slate-600 md:grid-cols-4">
            <div>Gemini Key：{envSummary.hasGeminiKey ? t("已配置") : t("未配置")}</div>
            <div>OpenAI Key：{envSummary.hasOpenAIKey ? t("已配置") : t("未配置")}</div>
            <div>Qwen Key：{envSummary.hasQwenKey ? t("已配置") : t("未配置")}</div>
            <div>{t("导入目录：")}{envSummary.importRootConfigured ? t("已配置") : t("未配置")}</div>
          </div>
        )}
      </Section>

      <Section title={t("批量任务默认值")}>
        <div className="grid gap-3 md:grid-cols-4">
          <label className="block"><span className="mb-1 block text-sm font-medium text-slate-700">{t("默认并发数")}</span><input type="number" min="1" max="16" value={settings.defaults.batchConcurrency} onChange={(event) => update(['defaults', 'batchConcurrency'], Number(event.target.value))} className="w-full rounded border border-slate-300 px-3 py-2 text-sm" /></label>
          <label className="block"><span className="mb-1 block text-sm font-medium text-slate-700">{t("审核模式")}</span><select value={settings.defaults.reviewMode} onChange={(event) => update(['defaults', 'reviewMode'], event.target.value)} className="w-full rounded border border-slate-300 bg-white px-3 py-2 text-sm"><option value="mock">mock</option><option value="real">real</option></select></label>
          <label className="block"><span className="mb-1 block text-sm font-medium text-slate-700">{t("生图模式")}</span><select value={settings.defaults.generationMode} onChange={(event) => update(['defaults', 'generationMode'], event.target.value)} className="w-full rounded border border-slate-300 bg-white px-3 py-2 text-sm"><option value="mock">mock</option><option value="real_background">real_background</option></select></label>
        </div>
      </Section>

      <Section title={t("导入扫描")}>
        <div className="grid gap-3 md:grid-cols-4">
          <label className="flex items-center gap-2 text-sm text-slate-700"><input type="checkbox" checked={settings.importScan.enabled} onChange={(event) => update(['importScan', 'enabled'], event.target.checked)} />{t("启用扫描偏好")}</label>
          <label className="block md:col-span-2"><span className="mb-1 block text-sm font-medium text-slate-700">{t("默认导入目录")}</span><input value={settings.importScan.rootDir} onChange={(event) => update(['importScan', 'rootDir'], event.target.value)} className="w-full rounded border border-slate-300 px-3 py-2 text-sm" /></label>
          <label className="block"><span className="mb-1 block text-sm font-medium text-slate-700">{t("最大 SKU")}</span><input type="number" value={settings.importScan.maxSku} onChange={(event) => update(['importScan', 'maxSku'], Number(event.target.value))} className="w-full rounded border border-slate-300 px-3 py-2 text-sm" /></label>
        </div>
        <p className="mt-2 text-xs text-slate-500">{t("生产环境不建议开放任意本地路径扫描。当前设置是本地运营偏好，不会写入 API Key。")}</p>
      </Section>

      <Section title={t("存储模式")}>
        <div className="grid gap-3 text-sm md:grid-cols-3">
          <div className="rounded border border-slate-200 p-3">
            <div className="text-xs text-slate-500">{t("当前模式")}</div>
            <div className="mt-1 font-semibold text-ink">{envSummary?.storageDriver === 'sqlite' ? 'SQLite' : 'JSON'}</div>
          </div>
          <div className="rounded border border-slate-200 p-3 md:col-span-2">
            <div className="text-xs text-slate-500">{t("SQLite DB 路径")}</div>
            <div className="mt-1 break-all font-mono text-xs text-slate-700">{envSummary?.sqliteDbPath || 'backend/data/app.sqlite'}</div>
          </div>
        </div>
        <div className="mt-3">
          <Link to="/storage" className="rounded border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700">{t("打开存储管理 / SQLite 试运行")}</Link>
        </div>
        <p className="mt-2 text-xs text-slate-500">{t('源码部署可在 .env 中修改 STORAGE_DRIVER 并重启后端；桌面客户端已使用 SQLite。请以当前模式为准，不要修改安装目录。')}</p>
      </Section>

      <Section title={t("成本估算")}>
        <div className="grid gap-3 md:grid-cols-4">
          <label className="block"><span className="mb-1 block text-sm font-medium text-slate-700">{t("货币")}</span><input value={settings.cost.currency} onChange={(event) => update(['cost', 'currency'], event.target.value)} className="w-full rounded border border-slate-300 px-3 py-2 text-sm" /></label>
          <label className="block"><span className="mb-1 block text-sm font-medium text-slate-700">{t("Gemini 识别 / 次")}</span><input type="number" step="0.0001" value={providerCostValue(settings, 'vision', 'gemini')} onChange={(event) => setSettings((current) => setProviderCost(current, 'vision', 'gemini', event.target.value))} className="w-full rounded border border-slate-300 px-3 py-2 text-sm" /></label>
          <label className="block"><span className="mb-1 block text-sm font-medium text-slate-700">{t("OpenAI 生图 / 次")}</span><input type="number" step="0.0001" value={providerCostValue(settings, 'image', 'openai')} onChange={(event) => setSettings((current) => setProviderCost(current, 'image', 'openai', event.target.value))} className="w-full rounded border border-slate-300 px-3 py-2 text-sm" /></label>
          <label className="block"><span className="mb-1 block text-sm font-medium text-slate-700">{t("Gemini 审核 / 次")}</span><input type="number" step="0.0001" value={providerCostValue(settings, 'review', 'gemini')} onChange={(event) => setSettings((current) => setProviderCost(current, 'review', 'gemini', event.target.value))} className="w-full rounded border border-slate-300 px-3 py-2 text-sm" /></label>
          <label className="block"><span className="mb-1 block text-sm font-medium text-slate-700">{t("External 抠图 / 次")}</span><input type="number" step="0.0001" value={providerCostValue(settings, 'matting', 'external')} onChange={(event) => setSettings((current) => setProviderCost(current, 'matting', 'external', event.target.value))} className="w-full rounded border border-slate-300 px-3 py-2 text-sm" /></label>
        </div>
        <p className="mt-2 text-xs text-slate-500">{t("成本只是本地预估，不代表真实账单。")}</p>
      </Section>

      <Section title={t("安全偏好")}>
        <div className="grid gap-2 md:grid-cols-3">
          {Object.keys(settings.safety).map((key) => (
            <label key={key} className="flex items-center gap-2 text-sm text-slate-700">
              <input type="checkbox" checked={settings.safety[key]} onChange={(event) => update(['safety', key], event.target.checked)} />
              {maintenanceLabel(key, settingFieldLabels, t)}
            </label>
          ))}
        </div>
      </Section>

      <Section title={t("UI 偏好")}>
        <div className="grid gap-2 md:grid-cols-3">
          <label className="block"><span className="mb-1 block text-sm font-medium text-slate-700">{t("默认 batch 视图")}</span><select value={settings.ui.defaultBatchView} onChange={(event) => update(['ui', 'defaultBatchView'], event.target.value)} className="w-full rounded border border-slate-300 bg-white px-3 py-2 text-sm"><option value="guide">guide</option><option value="advanced">advanced</option></select></label>
          <label className="flex items-center gap-2 text-sm text-slate-700"><input type="checkbox" checked={settings.ui.collapseAdvancedByDefault} onChange={(event) => update(['ui', 'collapseAdvancedByDefault'], event.target.checked)} />{t("默认折叠高级操作")}</label>
          <label className="flex items-center gap-2 text-sm text-slate-700"><input type="checkbox" checked={settings.ui.showDebugPanels} onChange={(event) => update(['ui', 'showDebugPanels'], event.target.checked)} />{t("显示 debug 面板")}</label>
        </div>
      </Section>

      <Section title={t("项目快照 / 备份恢复")}>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="text-sm text-slate-600">{t("最近快照：")}{snapshots[0]?.createdAt ? dateTime(snapshots[0].createdAt) : t("暂无快照")}
            <div className="mt-1 text-xs text-slate-500">{t('快照不包含 .env 或明文 Provider 密钥；工作空间备份可能包含密码散列和加密授权数据，请私密保管。')}</div>
          </div>
          <Link to="/snapshots" className="rounded border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700">{t("打开备份与恢复")}</Link>
        </div>
      </Section>

      <Section title={t("环境诊断")}>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="text-sm text-slate-600">{t("最近检查：")}{healthSummary?.checkedAt ? dateTime(healthSummary.checkedAt) : t("未检查")}
            <div className="mt-1 text-xs text-slate-500">{t('当前状态：{status} · 错误 {errors} / 警告 {warnings}', { status: maintenanceLabel(healthSummary?.overallStatus, maintenanceStatusLabels, t), errors: healthSummary?.summary?.errorCount || 0, warnings: healthSummary?.summary?.warningCount || 0 })}
            </div>
          </div>
          <Link to="/health" className="rounded border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700">{t("打开系统健康检查")}</Link>
        </div>
      </Section>
    </div>
  );
}
