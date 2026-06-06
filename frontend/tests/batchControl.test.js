import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

test('batch control API helpers call cancel delete and reset endpoints with confirmation', async () => {
  const { api } = await import('../src/services/api.js');
  const captured = [];
  global.fetch = async (url, options = {}) => {
    captured.push({ url, options });
    return {
      ok: true,
      json: async () => ({
        result: {
          batchId: 'batch-control-ui',
          status: 'cancelled',
          deletedFiles: false,
          originalFoldersPreserved: true
        },
        batchTask: { id: 'batch-control-ui', status: 'cancelled' }
      })
    };
  };

  await api.cancelBatch('batch-control-ui', { confirm: true });
  await api.deleteBatch('batch-control-ui', { confirm: true });
  await api.resetBatchImportState('batch-control-ui', { confirm: true });

  assert.equal(captured[0].url, '/api/batches/batch-control-ui/cancel');
  assert.equal(captured[0].options.method, 'POST');
  assert.equal(JSON.parse(captured[0].options.body).confirm, true);
  assert.equal(captured[1].url, '/api/batches/batch-control-ui');
  assert.equal(captured[1].options.method, 'DELETE');
  assert.equal(JSON.parse(captured[1].options.body).confirm, true);
  assert.equal(captured[2].url, '/api/batches/batch-control-ui/reset-import');
  assert.equal(captured[2].options.method, 'POST');
  assert.equal(JSON.parse(captured[2].options.body).confirm, true);
});

test('BatchPage shows safe batch control buttons confirmations and feedback', () => {
  const pageSource = fs.readFileSync(path.resolve('src/pages/BatchPage.jsx'), 'utf8');
  const apiSource = fs.readFileSync(path.resolve('src/services/api.js'), 'utf8');

  assert.match(pageSource, /取消当前 batch/);
  assert.match(pageSource, /删除当前 batch 记录/);
  assert.match(pageSource, /重置导入状态/);
  assert.match(pageSource, /不会删除本地图片文件夹/);
  assert.match(pageSource, /当前 batch 已取消/);
  assert.match(pageSource, /batch 记录已删除，本地图片未删除/);
  assert.match(pageSource, /导入状态已重置，可以重新扫描目录/);
  assert.match(pageSource, /batch 操作失败，请查看错误信息后重试。/);
  assert.match(pageSource, /window\.confirm/);
  assert.match(pageSource, /api\.cancelBatch/);
  assert.match(pageSource, /api\.deleteBatch/);
  assert.match(pageSource, /api\.resetBatchImportState/);
  assert.match(apiSource, /cancelBatch/);
  assert.match(apiSource, /deleteBatch/);
  assert.match(apiSource, /resetBatchImportState/);

  assert.doesNotMatch(pageSource, /uploadPlatform|platformApi|realReviewProvider|Image2/);
});
