import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  cleanupDashboardErrorMessage,
  cleanupRefreshStatusText
} from '../src/utils/dashboardCleanup.js';

test('cleanupRefreshStatusText shows loading and last refresh time', () => {
  assert.equal(cleanupRefreshStatusText({ refreshing: true }), '正在刷新...');
  assert.equal(
    cleanupRefreshStatusText({
      lastRefreshedAt: new Date('2026-06-01T14:32:08'),
      now: new Date('2026-06-01T14:34:08')
    }),
    '最近刷新：14:32:08'
  );
  assert.equal(cleanupRefreshStatusText({ lastRefreshedAt: new Date(Date.now() - 20 * 1000) }), '最近刷新：刚刚');
});

test('cleanupDashboardErrorMessage returns Chinese error and clears on success', () => {
  assert.equal(
    cleanupDashboardErrorMessage(new Error('network failed')),
    '运行文件占用获取失败，请检查后端是否已启动。'
  );
  assert.equal(cleanupDashboardErrorMessage(null), '');
});
