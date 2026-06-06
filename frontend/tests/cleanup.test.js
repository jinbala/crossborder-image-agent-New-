import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  cleanupEmptyPreviewMessage,
  cleanupRiskLabel,
  cleanupRunDisabled,
  formatCleanupBytes,
  normalizeCleanupPayload
} from '../src/utils/cleanup.js';

test('normalizeCleanupPayload keeps supported groups and normalizes olderThanDays', () => {
  assert.deepEqual(normalizeCleanupPayload({
    olderThanDays: '30',
    groups: ['visionTmp', 'unknown', 'testResults']
  }), {
    olderThanDays: 30,
    groups: ['visionTmp', 'testResults']
  });

  assert.equal(normalizeCleanupPayload({ olderThanDays: -1 }).olderThanDays, 30);
});

test('formatCleanupBytes formats file sizes for display', () => {
  assert.equal(formatCleanupBytes(0), '0 B');
  assert.equal(formatCleanupBytes(1024), '1.00 KB');
  assert.equal(formatCleanupBytes(1024 * 1024), '1.00 MB');
});

test('cleanupRiskLabel maps risk levels to Chinese labels', () => {
  assert.equal(cleanupRiskLabel('safe'), '安全');
  assert.equal(cleanupRiskLabel('caution'), '谨慎');
  assert.equal(cleanupRiskLabel('risky'), '高风险');
});

test('cleanupRunDisabled is true until preview has deletable files', () => {
  assert.equal(cleanupRunDisabled(null), true);
  assert.equal(cleanupRunDisabled({ totalFiles: 0, groups: [{ files: [] }] }), true);
  assert.equal(cleanupRunDisabled({ totalFiles: 1, groups: [{ files: [{ deletable: false }] }] }), true);
  assert.equal(cleanupRunDisabled({ totalFiles: 1, groups: [{ files: [{ deletable: true }] }] }), false);
});

test('cleanupEmptyPreviewMessage explains zero candidates as a safe result', () => {
  const preview = { totalFiles: 0, totalBytes: 0, olderThanDays: 7, groups: [{ groupName: 'visionTmp', files: [] }] };
  assert.equal(
    cleanupEmptyPreviewMessage(preview, null, ['visionTmp']),
    '当前没有符合时间条件的可清理文件。这通常表示这些运行文件还没有超过当前时间阈值，因此系统不会清理。你可以尝试切换到 30 天前 / 90 天前，或稍后再清理。'
  );
});

test('cleanupEmptyPreviewMessage explains when summary has files but preview has no aged candidates', () => {
  const preview = { totalFiles: 0, totalBytes: 0, olderThanDays: 7, groups: [{ groupName: 'visionTmp', files: [] }] };
  const summary = { groups: [{ groupName: 'visionTmp', fileCount: 3, bytes: 1200 }] };
  assert.equal(
    cleanupEmptyPreviewMessage(preview, summary, ['visionTmp']),
    '目录中存在运行文件，但没有超过当前时间阈值，因此不会被清理。'
  );
});

test('cleanup API methods send normalized payloads', async () => {
  const { api } = await import('../src/services/api.js');
  const captured = [];
  global.fetch = async (url, options = {}) => {
    captured.push({ url, options });
    return {
      ok: true,
      json: async () => ({ totalFiles: 0, groups: [] })
    };
  };

  await api.getCleanupSummary();
  await api.previewCleanup({ olderThanDays: '7', groups: ['visionTmp', 'bad'] });
  await api.runCleanup({ olderThanDays: '90', groups: ['testResults'], confirm: true, files: ['ignored'] });

  assert.equal(captured[0].url, '/api/cleanup/summary');
  assert.equal(captured[1].url, '/api/cleanup/preview');
  assert.equal(captured[1].options.body, '{"olderThanDays":7,"groups":["visionTmp"]}');
  assert.equal(captured[2].url, '/api/cleanup/run');
  assert.equal(captured[2].options.body, '{"olderThanDays":90,"groups":["testResults"],"confirm":true}');
});
