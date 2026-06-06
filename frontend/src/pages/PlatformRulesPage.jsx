import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import StepNav from '../components/StepNav.jsx';
import TaskProgress from '../components/TaskProgress.jsx';
import Section from '../components/Section.jsx';
import { api } from '../services/api.js';
import { ErrorMessage, PrimaryButton, useTask, DisabledReason } from './pageUtils.jsx';
import { actionDisabledReason, canRunAction } from '../utils/taskWorkflow.js';
import { buildRulesSummary, platformRulesEmptyText, ruleListText } from '../utils/platformRulesDisplay.js';

const quickSelections = [
  { id: 'amazon-temu', label: 'Amazon + Temu', platforms: ['amazon', 'temu'] },
  { id: 'amazon-noon', label: 'Amazon + Noon', platforms: ['amazon', 'noon'] },
  { id: 'all', label: '全部平台', platforms: ['amazon', 'temu', 'noon', 'ozon', 'rakuten'] }
];

const categoryLabels = {
  general: '通用商品',
  electronics_storage: '电子产品 / 存储设备',
  electronics_general: '电子产品',
  beauty: '美妆个护',
  apparel: '服饰',
  home: '家居',
  tools: '工具',
  pet: '宠物',
  medical_device: '医疗器械'
};

function normalizeTarget(platform, existing = {}) {
  return {
    id: existing.id,
    targetId: existing.targetId || existing.id,
    platformId: platform.platformId,
    site: existing.site || platform.sites?.[0] || 'US',
    language: existing.language || platform.languages?.[0] || platform.defaultLanguage || 'English',
    categoryId: existing.categoryId || existing.category || platform.categories?.[0] || 'general'
  };
}

function mainImageRuleSummary(rules, platformId) {
  const rule = rules?.rules?.[platformId]?.imageTypes?.main_image;
  if (!rule) return '暂无主图规则摘要';
  const textRule = rule.text?.allowed ? '主图允许少量文字' : '主图不允许文字';
  const background = rule.background?.recommended || '简洁背景';
  const forbidden = (rule.forbiddenElements || []).slice(0, 4).join('、');
  return `${textRule}；推荐背景：${background}；禁止：${forbidden || '价格、促销、水印等'}`;
}

export default function PlatformRulesPage() {
  const { taskId } = useParams();
  const navigate = useNavigate();
  const { task, loading, error, setError } = useTask(taskId);
  const [rulesLoading, setRulesLoading] = useState(true);
  const [rules, setRules] = useState(null);
  const [targets, setTargets] = useState([]);
  const [effectiveRulesByTarget, setEffectiveRulesByTarget] = useState({});
  const [effectiveRulesLoading, setEffectiveRulesLoading] = useState(false);
  const [effectiveRulesError, setEffectiveRulesError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    async function loadRules() {
      setRulesLoading(true);
      setError('');
      try {
        const result = await api.listPlatformRules();
        setRules(result);
      } catch (err) {
        setError(err.message);
      } finally {
        setRulesLoading(false);
      }
    }
    loadRules();
  }, [setError]);

  useEffect(() => {
    if (!rules?.platforms?.length || !task) return;
    if (task.targets?.length) {
      setTargets(task.targets.map((target) => {
        const platform = rules.platforms.find((item) => item.platformId === target.platformId) || rules.platforms[0];
        return normalizeTarget(platform, target);
      }));
      return;
    }
    const legacyPlatform = rules.platforms.find((platform) => platform.platformId === (task.platformId || task.platform)) || rules.platforms[0];
    setTargets([normalizeTarget(legacyPlatform, task)]);
  }, [rules, task?.id, task?.targets]);

  const selectedIds = useMemo(() => new Set(targets.map((target) => target.platformId)), [targets]);
  const targetRuleKey = useMemo(() => targets
    .map((target) => `${target.platformId}:${target.categoryId || 'generic_ecommerce'}`)
    .join('|'), [targets]);

  useEffect(() => {
    if (!targetRuleKey) {
      setEffectiveRulesByTarget({});
      setEffectiveRulesError('');
      return;
    }

    let cancelled = false;

    async function loadEffectiveRules() {
      setEffectiveRulesLoading(true);
      setEffectiveRulesError('');
      try {
        const pairs = targets.map((target) => ({
          key: `${target.platformId}:${target.categoryId || 'generic_ecommerce'}`,
          platformId: target.platformId,
          categoryId: target.categoryId || 'generic_ecommerce'
        }));
        const results = await Promise.all(pairs.map(async (pair) => {
          const result = await api.getEffectiveRules({
            platformId: pair.platformId,
            categoryId: pair.categoryId
          });
          return [pair.key, result.effectiveRules || result];
        }));
        if (!cancelled) {
          setEffectiveRulesByTarget(Object.fromEntries(results));
        }
      } catch (err) {
        if (!cancelled) {
          setEffectiveRulesError(err.message || platformRulesEmptyText());
          setEffectiveRulesByTarget({});
        }
      } finally {
        if (!cancelled) setEffectiveRulesLoading(false);
      }
    }

    loadEffectiveRules();
    return () => {
      cancelled = true;
    };
  }, [targetRuleKey]);

  function platformById(platformId) {
    return rules?.platforms?.find((platform) => platform.platformId === platformId);
  }

  function togglePlatform(platform) {
    setTargets((current) => {
      if (current.some((target) => target.platformId === platform.platformId)) {
        return current.filter((target) => target.platformId !== platform.platformId);
      }
      return [...current, normalizeTarget(platform)];
    });
  }

  function updateTarget(platformId, patch) {
    setTargets((current) => current.map((target) => {
      if (target.platformId !== platformId) return target;
      const platform = platformById(platformId);
      return normalizeTarget(platform, { ...target, ...patch });
    }));
  }

  function applyQuickSelection(platformIds) {
    setTargets(platformIds
      .map((platformId) => platformById(platformId))
      .filter(Boolean)
      .map((platform) => normalizeTarget(platform, targets.find((target) => target.platformId === platform.platformId))));
  }

  async function save() {
    setBusy(true);
    setError('');
    try {
      await api.savePlatform(taskId, {
        targets: targets.map((target) => ({
          id: target.id,
          targetId: target.targetId,
          platformId: target.platformId,
          site: target.site,
          language: target.language,
          categoryId: target.categoryId
        }))
      });
      navigate(`/tasks/${taskId}/plans`);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  if (loading || rulesLoading) return <div className="text-sm text-slate-500">正在加载平台规则...</div>;

  const canSaveRules = canRunAction(task.status, 'selectRules');
  const selectedTargets = targets
    .map((target) => ({ ...target, platform: platformById(target.platformId) }))
    .filter((target) => target.platform);

  return (
    <div className="max-w-6xl space-y-5">
      <StepNav taskId={taskId} />
      <TaskProgress task={{ ...task, targets }} />
      <ErrorMessage error={error} />
      <h1 className="text-2xl font-semibold text-ink">选择目标平台规则</h1>
      <Section title="多平台目标">
        <div className="mb-4 flex flex-wrap gap-2">
          {quickSelections.map((selection) => (
            <button
              key={selection.id}
              type="button"
              onClick={() => applyQuickSelection(selection.platforms)}
              className="rounded border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 hover:border-mint hover:text-mint"
            >
              {selection.label}
            </button>
          ))}
        </div>

        <div className="grid gap-3 md:grid-cols-3">
          {(rules?.platforms || []).map((platform) => {
            const checked = selectedIds.has(platform.platformId);
            return (
              <label
                key={platform.platformId}
                className={`cursor-pointer rounded border p-4 ${checked ? 'border-mint bg-teal-50' : 'border-slate-200 bg-white'}`}
              >
                <input
                  type="checkbox"
                  className="mr-2 accent-teal-700"
                  checked={checked}
                  onChange={() => togglePlatform(platform)}
                />
                <span className="font-semibold text-ink">{platform.name}</span>
                <span className="mt-2 block text-sm text-slate-500">
                  站点：{platform.sites.join(', ')} / 语言：{platform.languages.join(', ')}
                </span>
                <span className="mt-2 block text-xs leading-5 text-slate-500">
                  {mainImageRuleSummary(rules, platform.platformId)}
                </span>
              </label>
            );
          })}
        </div>

        <div className="mt-5 space-y-4">
          {selectedTargets.map(({ platform, ...target }) => (
            <div key={target.platformId} className="rounded border border-slate-200 bg-slate-50 p-4">
              <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                <div>
                  <div className="font-semibold text-ink">{platform.name}</div>
                  <div className="mt-1 text-xs text-slate-500">{mainImageRuleSummary(rules, platform.platformId)}</div>
                </div>
                <span className="rounded border border-slate-200 bg-white px-2 py-1 text-xs text-slate-500">
                  target: {target.platformId}
                </span>
              </div>
              <div className="grid gap-4 md:grid-cols-3">
                <label className="block">
                  <span className="mb-1 block text-sm font-medium text-slate-700">站点</span>
                  <select value={target.site} onChange={(event) => updateTarget(target.platformId, { site: event.target.value })} className="focus-ring w-full rounded border border-slate-300 bg-white px-3 py-2 text-sm text-slate-600">
                    {(platform.sites || ['US']).map((item) => <option key={item}>{item}</option>)}
                  </select>
                </label>
                <label className="block">
                  <span className="mb-1 block text-sm font-medium text-slate-700">目标语言</span>
                  <select value={target.language} onChange={(event) => updateTarget(target.platformId, { language: event.target.value })} className="focus-ring w-full rounded border border-slate-300 bg-white px-3 py-2 text-sm text-slate-600">
                    {(platform.languages || ['English']).map((item) => <option key={item}>{item}</option>)}
                  </select>
                </label>
                <label className="block">
                  <span className="mb-1 block text-sm font-medium text-slate-700">商品类目</span>
                  <select value={target.categoryId} onChange={(event) => updateTarget(target.platformId, { categoryId: event.target.value })} className="focus-ring w-full rounded border border-slate-300 bg-white px-3 py-2 text-sm text-slate-600">
                    {(platform.categories || ['general']).map((item) => <option key={item} value={item}>{categoryLabels[item] || item}</option>)}
                  </select>
                </label>
              </div>
              <div className="mt-4 rounded border border-slate-200 bg-white p-4">
                <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                  <div className="font-semibold text-ink">平台 / 类目规则摘要</div>
                  {effectiveRulesLoading && <span className="text-xs text-slate-500">正在加载规则摘要...</span>}
                </div>
                {(() => {
                  const summary = buildRulesSummary(effectiveRulesByTarget[`${target.platformId}:${target.categoryId || 'generic_ecommerce'}`]);
                  if (effectiveRulesError || summary.emptyText) {
                    return (
                      <div className="rounded border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
                        {effectiveRulesError || summary.emptyText}
                      </div>
                    );
                  }
                  return (
                    <div className="space-y-3 text-sm text-slate-600">
                      <div className="grid gap-3 md:grid-cols-2">
                        <div>
                          <div className="text-xs font-semibold text-slate-500">当前平台</div>
                          <div className="mt-1 text-ink">{summary.platformText}</div>
                        </div>
                        <div>
                          <div className="text-xs font-semibold text-slate-500">当前类目</div>
                          <div className="mt-1 text-ink">{summary.categoryText}</div>
                        </div>
                      </div>
                      <div>
                        <div className="text-xs font-semibold text-slate-500">主图规则</div>
                        <div className="mt-1">{summary.mainImageText}</div>
                      </div>
                      <div>
                        <div className="text-xs font-semibold text-slate-500">辅图规则</div>
                        <div className="mt-1">{summary.secondaryImageText}</div>
                      </div>
                      <div>
                        <div className="text-xs font-semibold text-slate-500">高风险字段</div>
                        <div className="mt-2 flex flex-wrap gap-2">
                          {summary.highRiskFields.map((field) => (
                            <span key={field} className="rounded border border-amber-200 bg-amber-50 px-2 py-1 text-xs text-amber-800">
                              {field}
                            </span>
                          ))}
                        </div>
                      </div>
                      <div className="grid gap-3 md:grid-cols-2">
                        <div>
                          <div className="text-xs font-semibold text-slate-500">禁用词 / 禁用表达</div>
                          <div className="mt-1">{ruleListText(summary.bannedWords)}</div>
                        </div>
                        <div>
                          <div className="text-xs font-semibold text-slate-500">谨慎词 / 需证据表达</div>
                          <div className="mt-1">{ruleListText(summary.cautionWords)}</div>
                        </div>
                      </div>
                      <div>
                        <div className="text-xs font-semibold text-slate-500">操作建议</div>
                        <ul className="mt-2 list-disc space-y-1 pl-5">
                          {summary.recommendations.map((item) => <li key={item}>{item}</li>)}
                        </ul>
                      </div>
                    </div>
                  );
                })()}
              </div>
            </div>
          ))}
        </div>

        {selectedTargets.length === 0 && (
          <div className="mt-5 rounded border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
            请至少选择一个目标平台。
          </div>
        )}

        <div className="mt-5">
          <PrimaryButton busy={busy} disabled={!canSaveRules || selectedTargets.length === 0} onClick={save}>保存平台规则并继续</PrimaryButton>
          <DisabledReason reason={!canSaveRules ? actionDisabledReason(task.status, 'selectRules') : ''} />
        </div>
      </Section>
    </div>
  );
}
