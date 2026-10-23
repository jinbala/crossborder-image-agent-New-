import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { skuResultRows, filteredSkuResults, skuResultsPage, skuResultsCsv } from '../src/utils/skuPackResults.js';
const group = (sku, success = 1, failed = 0, skipped = 0) => ({ sku, inputCount: 2, successCount: success, failedCount: failed, duplicateSkippedCount: skipped, items: [{ status: 'success', role: 'main', sourceRelativePath: `${sku}/主图.png` }, ...(failed ? [{ status: 'failed', error: { code: 'RAW_ERROR', message: '原文,"问题"\n重试' } }] : [])] });
test('SKU result projection distinguishes success, partial, failed, skipped and pending without mutating input', () => {
  const result = { skuResults: [group('已完成'), group('部分完成', 1, 1), group('失败', 0, 1), group('重复', 0, 0, 1), group('待处理', 0)] }, before = JSON.stringify(result);
  assert.deepEqual(skuResultRows(result).map(row => row.status), ['completed', 'partial', 'failed', 'skipped', 'pending']); assert.equal(JSON.stringify(result), before);
});
test('SKU result searches combine literal SKU/path/error/role matching with exact status', () => {
  const result = { skuResults: [group('原文-A'), group('原文-B', 0, 1), group('C')] };
  assert.equal(filteredSkuResults(result, { q: '原文', status: 'failed' })[0].sku, '原文-B');
  assert.equal(filteredSkuResults(result, { q: 'raw_error' }).length, 1); assert.equal(filteredSkuResults(result, { q: '主图.png' }).length, 3); assert.equal(filteredSkuResults(result, { q: '.*' }).length, 0);
});
test('SKU pages render bounded slices for 5000 rows, clamp stale pages and handle empty input', () => {
  const result = { skuResults: Array.from({ length: 5000 }, (_, i) => group(`SKU-${i}`)) };
  assert.equal(skuResultsPage(result, { page: 2 }).rows[0].sku, 'SKU-25'); assert.equal(skuResultsPage(result, { page: 999, pageSize: 999 }).page, 50); assert.equal(skuResultsPage(result, { page: 999, pageSize: 999 }).rows.length, 100); assert.equal(skuResultsPage(null).total, 0);
});
test('SKU CSV includes every filtered row independent of the visible page, with raw codes and escaped messages', () => {
  const result = { skuResults: Array.from({ length: 40 }, (_, i) => group(`SKU-${i}`, 0, 1)) }, csv = skuResultsCsv(result, { status: 'failed', page: 2 });
  assert.ok(csv.startsWith('\uFEFF')); assert.ok(csv.includes('"SKU-0"')); assert.ok(csv.includes('"SKU-39"')); assert.ok(csv.includes('"failed"')); assert.ok(csv.includes('RAW_ERROR')); assert.ok(csv.includes('原文,""问题""\n重试'));
});
test('SKU CSV protects formula prefixes while preserving source records and arbitrary business names', () => {
  for (const sku of ['=1+1', '+cmd', '-cmd', '@cmd', ' \t=1', '\rname', '\tname']) { const result = { skuResults: [group(sku)] }, before = JSON.stringify(result); assert.ok(skuResultsCsv(result).includes(`"'${sku}"`)); assert.equal(JSON.stringify(result), before); }
  assert.ok(skuResultsCsv({ skuResults: [group('原文 $& {sku}')] }).includes('原文 $& {sku}'));
});
test('result page wiring uses bounded rows and all-filtered CSV rather than rendering every group', () => {
  const page = fs.readFileSync(new URL('../src/pages/SkuPackPage.jsx', import.meta.url), 'utf8');
  assert.ok(!page.includes('result.skuResults.map(')); assert.ok(page.includes('resultPage.rows.map(')); assert.ok(page.includes('skuResultsCsv(result, resultQuery)'));
  for (const marker of ['search', 'status', 'size', 'export', 'prev', 'next', 'pagination']) assert.ok(page.includes(`data-sku-result-${marker}`));
});
