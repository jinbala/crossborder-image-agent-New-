import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { parse } from '@babel/parser';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { translate } from '../src/i18n/core.js';
import { buildRulesSummary, ruleListText } from '../src/utils/platformRulesDisplay.js';
import { actionDisabledReason } from '../src/utils/taskWorkflow.js';
import { cleanupRefreshStatusText } from '../src/utils/dashboardCleanup.js';

const t = (source, values) => translate('en-US', source, values);
const pageSource = fs.readFileSync(new URL('../src/pages/pageUtils.jsx', import.meta.url), 'utf8');
// Execute the shipped hook body with deterministic state/effect scheduling.
// Actual React routing/rendering is separately exercised by desktop smoke.
function hookHarness() {
  const slots = [], pending = [], effects = []; let index = 0;
  const ast = parse(pageSource, { sourceType: 'module', plugins: ['jsx'] });
  const hook = ast.program.body.find((node) => node.type === 'ExportNamedDeclaration' && node.declaration?.id?.name === 'useTask').declaration;
  const useTask = vm.runInNewContext(`(${pageSource.slice(hook.start, hook.end)})`, {
    api: { getTask(id) { return new Promise((resolve, reject) => pending.push({ id, resolve, reject })); } },
    useState(initial) { const key = index++; if (!(key in slots)) slots[key] = initial; return [slots[key], (value) => { slots[key] = typeof value === 'function' ? value(slots[key]) : value; }]; },
    useRef(initial) { const key = index++; return slots[key] ||= { current: initial }; },
    useEffect(callback, deps) { const key = index++, old = slots[key]; if (!old || deps.some((value, i) => value !== old.deps[i])) { slots[key] = { deps, cleanup: old?.cleanup }; effects.push(() => { slots[key].cleanup?.(); slots[key].cleanup = callback(); }); } }
  });
  return { pending, render(id) { index = 0; const value = useTask(id); while (effects.length) effects.shift()(); return value; } };
}
const tick = () => new Promise((resolve) => setImmediate(resolve));

test('late task A response cannot populate task B or remove its loading boundary', async () => {
  const h = hookHarness(); assert.equal(h.render('A').loading, true);
  h.render('B'); h.pending[1].resolve({ task: { id: 'B', sku: '原文-B' } }); await tick();
  assert.equal(h.render('B').task.sku, '原文-B');
  h.pending[0].resolve({ task: { id: 'A', sku: '原文-A' } }); await tick();
  assert.equal(h.render('B').task.id, 'B'); assert.equal(h.render('B').loading, false);
  const transition = h.render('C'); assert.equal(transition.task, null); assert.equal(transition.loading, true);
});
test('same-task refresh ignores a late failure, mismatched payloads fail closed, and retry recovers', async () => {
  const h = hookHarness(); h.render('A'); const current = h.render('A'); const refresh = current.refresh();
  h.pending[1].resolve({ task: { id: 'A', sku: 'new' } }); await refresh;
  h.pending[0].reject(new Error('old network failure')); await tick();
  assert.equal(h.render('A').task.sku, 'new'); assert.equal(h.render('A').error, '');
  const mismatch = h.render('A').refresh(); h.pending[2].resolve({ task: { id: 'foreign' } }); await mismatch;
  assert.equal(h.render('A').task, null); assert.match(h.render('A').error, /不匹配/);
  const retry = h.render('A').refresh(); h.pending[3].resolve({ task: { id: 'A' } }); await retry;
  assert.equal(h.render('A').task.id, 'A'); assert.equal(h.render('A').error, '');
});
test('controlled rule labels translate while names, forbidden words, recommendations and unknown fields stay original', () => {
  const input = { platformName: '平台原文', categoryName: '类目原文', effectiveHighRiskFields: ['capacity', '自定义字段'], effectiveMainImageRules: { background: 'pure_white', textAllowed: false }, effectiveSecondaryImageRules: { textAllowed: true, unconfirmedCertificationAllowed: false }, effectiveBannedWords: ['原文禁词'], recommendations: ['原文规则建议'] };
  const before = JSON.stringify(input), summary = buildRulesSummary(input, t);
  assert.equal(summary.platformText, '平台原文'); assert.equal(summary.categoryText, '类目原文');
  assert.match(summary.mainImageText, /White background.*No text/); assert.match(summary.secondaryImageText, /unconfirmed certifications/);
  assert.equal(summary.highRiskFields[1], '自定义字段 自定义字段'); assert.deepEqual(summary.bannedWords, ['原文禁词']); assert.deepEqual(summary.recommendations, ['原文规则建议']);
  assert.equal(ruleListText([], t), 'None'); assert.equal(ruleListText(['禁词原文'], t), '禁词原文'); assert.equal(JSON.stringify(input), before);
});

test('unavailable saved platform IDs are preserved instead of silently switching to the first platform', () => {
  const source = fs.readFileSync(new URL('../src/pages/PlatformRulesPage.jsx', import.meta.url), 'utf8');
  const ast = parse(source, { sourceType: 'module', plugins: ['jsx'] });
  const node = ast.program.body.find(item => item.type === 'FunctionDeclaration' && item.id.name === 'normalizeTarget');
  const normalize = vm.runInNewContext(`(${source.slice(node.start, node.end)})`);
  const result = normalize(undefined, { platformId: 'retired-原文', site: '原文站点', language: '原文语言', categoryId: '原文类目' });
  assert.equal(result.platformId, 'retired-原文'); assert.equal(result.site, '原文站点'); assert.equal(result.language, '原文语言'); assert.equal(result.categoryId, '原文类目');
  assert.ok(source.includes('unsupportedTargets.length > 0'));
  assert.ok(!source.includes('find((item) => item.platformId === target.platformId) || rules.platforms[0]'));
});
test('workflow disabled reasons and refresh times follow UI language without translating unknown status values', () => {
  assert.equal(actionDisabledReason('reviewed', 'exportImages', t), '');
  assert.match(actionDisabledReason('custom-原文', 'exportImages', t), /custom-原文.*requires/);
  assert.equal(cleanupRefreshStatusText({ refreshing: true }, t), 'Refreshing...');
  assert.equal(cleanupRefreshStatusText({ lastRefreshedAt: '2026-10-20T10:00:00Z', now: '2026-10-20T11:00:00Z' }, t, () => 'localized-time'), 'Last refreshed: localized-time');
});
test('task operation pages cover literal display copy and all task pages guard null before status reads', () => {
  const cwd = fileURLToPath(new URL('..', import.meta.url));
  const files = ['Dashboard', 'PlatformRulesPage', 'WorkflowTemplatesPage', 'ExportPage'].map((name) => `src/pages/${name}.jsx`);
  const report = JSON.parse(execFileSync(process.execPath, ['scripts/localize-ui.mjs', '--check', '--expressions', ...files, 'src/pages/pageUtils.jsx'], { cwd, encoding: 'utf8' }));
  assert.equal(report.unlocalizedCount, 0); assert.equal(report.missingCount, 0);
  for (const name of ['ExportPage', 'PlatformRulesPage', 'GeneratePage', 'ReviewPage']) {
    const source = fs.readFileSync(new URL(`../src/pages/${name}.jsx`, import.meta.url), 'utf8');
    assert.ok(source.indexOf('if (!task) return <TaskLoadFailure') < source.indexOf('canRunAction(task.status'));
    assert.ok(source.includes('TaskLoadFailure,') || source.includes(', TaskLoadFailure }'));
  }
  const template = fs.readFileSync(new URL('../src/pages/WorkflowTemplatesPage.jsx', import.meta.url), 'utf8');
  const remove = template.slice(template.indexOf('async function remove('), template.indexOf('\n  return ('));
  assert.ok(remove.indexOf('window.confirm') < remove.indexOf('api.deleteWorkflowTemplate'));
  assert.ok(template.includes('data-template-form disabled={loading || Boolean(busy)}'));
  assert.ok(template.includes('name: form.name')); assert.ok(!template.includes('name: t(form.name)'));
});

test('shared task navigation and all required long-job states have controlled translated labels', () => {
  const source = fs.readFileSync(new URL('../src/components/StatusBadge.jsx', import.meta.url), 'utf8');
  const ast = parse(source, { sourceType: 'module', plugins: ['jsx'] });
  const labels = ast.program.body.filter(node => node.type === 'VariableDeclaration').flatMap(node => node.declarations).find(node => node.id.name === 'labels').init.properties;
  const values = Object.fromEntries(labels.map(node => [node.key.name || node.key.value, node.value.value]));
  for (const state of ['draft', 'queued', 'running', 'waiting_user', 'paused', 'completed', 'partial', 'failed', 'cancelled']) {
    assert.ok(values[state], state); assert.ok(!/[\u3400-\u9fff]/.test(t(values[state])), `${state}: translated label missing`);
  }
  assert.ok(source.includes("Object.hasOwn(labels, status) ? t(labels[status]) : status || t('新任务')"));
  const nav = fs.readFileSync(new URL('../src/components/StepNav.jsx', import.meta.url), 'utf8');
  assert.ok(nav.includes('{t(label)}')); assert.ok(nav.includes('to={`/tasks/${taskId}/${key}`}'));
});
