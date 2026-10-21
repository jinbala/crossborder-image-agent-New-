import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { english } from '../src/i18n/messages.js';
import { translate } from '../src/i18n/core.js';
import { maintenanceLabel, maintenanceStatusLabels, settingFieldLabels, cleanupSafetyLabels } from '../src/utils/maintenanceLabels.js';
import { CLEANUP_GROUP_OPTIONS, cleanupRiskLabel, cleanupEmptyPreviewMessage, normalizeCleanupPayload } from '../src/utils/cleanup.js';

const t = (source, values) => translate('en-US', source, values);
test('maintenance statuses preserve false and unknown protocol or business values without mutation', () => {
  assert.equal(maintenanceLabel(false, maintenanceStatusLabels, t), 'No');
  assert.equal(maintenanceLabel(true, maintenanceStatusLabels, t), 'Yes');
  assert.equal(maintenanceLabel('not_started', maintenanceStatusLabels, t), 'Not started');
  for (const labels of [maintenanceStatusLabels, settingFieldLabels, cleanupSafetyLabels]) for (const value of Object.values(labels)) assert.ok(Object.hasOwn(english, value), value);
  assert.equal(maintenanceLabel('safe', cleanupSafetyLabels, t), 'Safe to delete');
  for (const value of ['__proto__', 'constructor', 'SKU-中文主图.jpg', 'new-backend-status']) assert.equal(maintenanceLabel(value, maintenanceStatusLabels, t), value);
  assert.equal(settingFieldLabels.requireHumanConfirmation, '要求人工确认');
});
test('cleanup display translations leave backend groups, paths and confirmation booleans unchanged', () => {
  const groups = structuredClone(CLEANUP_GROUP_OPTIONS);
  for (const group of groups) { assert.ok(Object.hasOwn(english, group.label), group.label); if (group.caution) assert.ok(Object.hasOwn(english, group.caution)); }
  for (const risk of ['safe', 'caution', 'risky', 'unknown']) assert.ok(Object.hasOwn(english, cleanupRiskLabel(risk)));
  assert.ok(Object.hasOwn(english, cleanupEmptyPreviewMessage({ totalFiles: 0, groups: [] })));
  assert.deepEqual(CLEANUP_GROUP_OPTIONS, groups);
  assert.deepEqual(normalizeCleanupPayload({ groups: ['visionTmp', 'oldBackups'], olderThanDays: '90', confirm: true }), { groups: ['visionTmp', 'oldBackups'], olderThanDays: 90, confirm: true });
  assert.equal(t('文件数：{count}', { count: 1 }), 'Files: 1');
  assert.equal(t('清理完成：删除 {deleted} 个文件，释放 {bytes}，跳过 {skipped} 个文件。', { deleted: 2, bytes: '3 KB', skipped: 1 }), 'Cleanup completed: files deleted 2; space freed 3 KB; files skipped 1.');
});
test('maintenance pages and explicit safety confirmations have no missing static translations', () => {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const pages = ['SettingsPage', 'StoragePage', 'SnapshotPage', 'HealthPage', 'CleanupPage', 'pageUtils'].map((name) => `src/pages/${name}.jsx`);
  const report = JSON.parse(execFileSync(process.execPath, ['scripts/localize-ui.mjs', '--check', '--expressions', ...pages], { cwd: root, encoding: 'utf8' }));
  assert.equal(report.unlocalizedCount, 0); assert.equal(report.missingCount, 0);
  for (const name of ['StoragePage', 'HealthPage', 'CleanupPage']) {
    const source = fs.readFileSync(new URL(`../src/pages/${name}.jsx`, import.meta.url), 'utf8');
    assert.ok(name === 'CleanupPage' ? source.includes('{file.relativePath}') && source.includes('{item.message}') : source.includes('JSON.stringify('));
    assert.ok(!source.includes('.toLocaleString()'));
  }
  const snapshot = fs.readFileSync(new URL('../src/pages/SnapshotPage.jsx', import.meta.url), 'utf8');
  assert.ok(snapshot.includes("snapshot.metadata.notes.join('；')"));
  assert.ok(snapshot.includes('confirmRevokeAuthorizations: restoreOptions.restorePlatformDb'));
  assert.ok(!snapshot.includes('t(snapshot.metadata.notes'));
});
test('owned diagnostic titles and SQLite checklist labels have English entries; raw reports remain unmodified', () => {
  const health = fs.readFileSync(new URL('../../backend/src/services/systemHealthService.js', import.meta.url), 'utf8');
  for (const [, title] of health.matchAll(/title:\s*'([^']+)'/g)) if (/[\u3400-\u9fff]/.test(title)) assert.ok(Object.hasOwn(english, title), title);
  const checklist = fs.readFileSync(new URL('../../backend/src/services/sqliteTrialChecklistService.js', import.meta.url), 'utf8').split('function nowIso')[0];
  for (const [, title] of checklist.matchAll(/\['[^']+', '([^']+)'\]/g)) assert.ok(Object.hasOwn(english, title), title);
  assert.ok(health.includes('# CrossBorder Image Agent 系统健康检查报告'));
});

test('settings initialization failures expose the original error and a retry without enabling writes', () => {
  const settings = fs.readFileSync(new URL('../src/pages/SettingsPage.jsx', import.meta.url), 'utf8');
  const emptyView = settings.slice(settings.indexOf('if (!settings)'), settings.indexOf('if (!settings)') + 650);
  assert.ok(emptyView.includes('<ErrorMessage error={error} />'));
  assert.ok(emptyView.includes('data-settings-retry disabled={loading} onClick={load}'));
  assert.ok(!emptyView.includes('onClick={save}'));
  const components = fs.readFileSync(new URL('../src/pages/pageUtils.jsx', import.meta.url), 'utf8');
  assert.ok(components.includes('role="alert"'));
});
