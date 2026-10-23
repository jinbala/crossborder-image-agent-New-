import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from '@babel/parser';
import { execFileSync } from 'node:child_process';
import { LOCALE_KEY, normalizeLocale, readLocale, persistLocale, translate, formatDateTime } from '../src/i18n/core.js';
import { english } from '../src/i18n/messages.js';

test('interface locale defaults to Chinese, validates values and safely persists without credentials', () => {
  const saved = new Map(); const storage = { getItem: (key) => saved.get(key), setItem: (key, value) => saved.set(key, value) };
  assert.equal(readLocale(storage), 'zh-CN');
  assert.equal(persistLocale(storage, 'en-US'), true); assert.equal(readLocale(storage), 'en-US');
  assert.deepEqual([...saved], [[LOCALE_KEY, 'en-US']]);
  for (const value of [null, undefined, '', 'EN', 'fr-FR', '../en-US', { locale: 'en-US' }]) assert.equal(normalizeLocale(value), 'zh-CN');
  assert.equal(persistLocale(storage, 'invalid'), true); assert.equal(readLocale(storage), 'zh-CN');
});
test('blocked storage never prevents startup or a temporary interface-language change', () => {
  const blocked = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } };
  assert.equal(readLocale(blocked), 'zh-CN'); assert.equal(persistLocale(blocked, 'en-US'), false);
  assert.equal(readLocale(null), 'zh-CN');
  assert.equal(persistLocale(null, 'en-US'), false);
});
test('UI translation has a readable fallback and preserves unknown business strings and naming placeholders', () => {
  assert.equal(translate('en-US', '图片采集'), 'Image collection'); assert.equal(translate('zh-CN', '图片采集'), '图片采集');
  for (const input of ['SKU-中文标题/主图.jpg', '{sku}-{role}-{index}', '__proto__', 'constructor', 'toString', '用户自定义名称', '', null, 13]) assert.equal(translate('en-US', input), input);
  assert.equal(translate('en-US', '已导出 {name}', { name: '$&/{unknown}/中文.jpg' }), 'Exported $&/{unknown}/中文.jpg');
  assert.equal(translate('zh-CN', '已导出 {name}', { name: '原图.jpg' }), '已导出 原图.jpg');
  assert.equal(translate('en-US', '第 {page} / {pages} 页 · 共 {total} 条', { page: 2, pages: 4, total: 170 }), 'Page 2 / 4 · 170 records');
});
test('every English catalog message preserves its named interpolation fields and has no duplicate keys', () => {
  const fields = (text) => [...new Set([...text.matchAll(/\{([A-Za-z][A-Za-z0-9_]*)\}/g)].map((match) => match[1]))].sort();
  for (const [source, message] of Object.entries(english)) { assert.equal(typeof message, 'string'); assert.ok(message.trim()); assert.deepEqual(fields(message), fields(source), source); }
  const keys = ['messages', 'operations', 'maintenance', 'imageWorkflow', 'taskOperations', 'legacyWorkflow', 'batchReports', 'exportReports', 'reportDetails'].flatMap((name) => {
    const ast = parse(fs.readFileSync(new URL(`../src/i18n/${name}.js`, import.meta.url), 'utf8'), { sourceType: 'module' });
    return ast.program.body.find((node) => node.type === 'ExportNamedDeclaration').declaration.declarations[0].init.properties
      .filter((item) => item.type === 'ObjectProperty').map((item) => item.key.value);
  });
  assert.equal(new Set(keys).size, keys.length);
});
test('date formatting is locale-aware and handles invalid or absent values without exceptions', () => {
  assert.equal(formatDateTime('en-US', null), '—'); assert.equal(formatDateTime('zh-CN', 'not a date'), '—');
  assert.notEqual(formatDateTime('en-US', '2026-10-20T10:20:00Z'), formatDateTime('zh-CN', '2026-10-20T10:20:00Z'));
});
test('locale provider does not remount workflows and leaves agreement/business content untouched', () => {
  const root = path.dirname(fileURLToPath(import.meta.url));
  const provider = fs.readFileSync(path.join(root, '../src/i18n/LocaleProvider.jsx'), 'utf8');
  const auth = fs.readFileSync(path.join(root, '../src/components/AuthGate.jsx'), 'utf8');
  const collection = fs.readFileSync(path.join(root, '../src/pages/CollectionWorkbenchPage.jsx'), 'utf8');
  assert.ok(provider.includes('<Context.Provider value={value}>{children}</Context.Provider>')); assert.ok(!provider.includes('key={locale}'));
  assert.ok(auth.includes('className="leading-7">{text}</p>')); assert.ok(collection.includes('{item.title ||')); assert.ok(collection.includes('{item.sku}'));
});
test('migrated core JSX has no uncovered literal UI copy or missing referenced catalog messages', () => {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const files = ['src/App.jsx', 'src/components/AuthGate.jsx', 'src/components/Layout.jsx', 'src/components/StatusBadge.jsx', 'src/components/LanguageSwitcher.jsx', 'src/pages/WorkspaceHomePage.jsx', 'src/pages/CollectionWorkbenchPage.jsx', 'src/pages/SkuPackPage.jsx', 'src/pages/DesktopPage.jsx', 'src/pages/SupportPage.jsx'];
  const output = execFileSync(process.execPath, ['scripts/localize-ui.mjs', '--check', ...files], { cwd: root, encoding: 'utf8' });
  const report = JSON.parse(output); assert.equal(report.unlocalizedCount, 0); assert.equal(report.missingCount, 0);
});
test('operations pages cover display templates and explicit confirmation messages without translating records', () => {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const files = ['WorkspacePages', 'StudioPage', 'SyncPage', 'ConnectionsPage', 'MaterialsWorkbenchPage', 'CommerceWorkbenchPage', 'CommerceSandboxPage', 'JobResultPage', 'WorkbenchPage', 'UploadPage'].map((name) => `src/pages/${name}.jsx`);
  const report = JSON.parse(execFileSync(process.execPath, ['scripts/localize-ui.mjs', '--check', '--expressions', ...files, 'src/components/DesktopUpdates.jsx', 'src/components/TaskProgress.jsx'], { cwd: root, encoding: 'utf8' }));
  assert.equal(report.unlocalizedCount, 0); assert.equal(report.missingCount, 0);
  const products = fs.readFileSync(path.join(root, 'src/pages/WorkspacePages.jsx'), 'utf8');
  assert.ok(products.includes('{item.data.title || item.data.name}')); assert.ok(products.includes('value={form[key]}'));
});
