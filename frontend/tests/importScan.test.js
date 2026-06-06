import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildScanSummaryMessage,
  getScanCandidateDisplay,
  hasScanCandidates,
  normalizeImportBatchFolderPayload,
  normalizeImportScanPayload,
  normalizeImportScannedFoldersPayload
} from '../src/utils/importScan.js';

function circularClickEvent() {
  const button = { constructor: { name: 'HTMLButtonElement' } };
  const event = { currentTarget: button, target: button };
  button.__reactFiber = { stateNode: button };
  return event;
}

test('normalizeImportScanPayload defaults to backend IMPORT_ROOT_DIR unless rootDir is explicit', () => {
  assert.deepEqual(normalizeImportScanPayload({}), {});
  assert.deepEqual(normalizeImportScanPayload(undefined), {});
  assert.deepEqual(normalizeImportScanPayload(circularClickEvent()), {});
  assert.deepEqual(normalizeImportScanPayload({ rootDir: ' D:\\Code\\batch-import ' }), {
    rootDir: 'D:\\Code\\batch-import'
  });
});

test('scan candidates summary and empty state helpers are stable', () => {
  assert.equal(hasScanCandidates({ candidates: [{ folderName: 'sku001-hard-drive' }] }), true);
  assert.equal(hasScanCandidates({ candidates: [] }), false);
  assert.equal(buildScanSummaryMessage({
    summary: { totalFolders: 2 },
    candidates: [{ folderName: 'sku001-hard-drive' }, { folderName: 'sku002-hard-drive' }]
  }), '扫描完成，共发现 2 个 SKU 文件夹');
});

test('scan candidate display explains new imported elsewhere skipped and invalid states', () => {
  assert.deepEqual(getScanCandidateDisplay({ status: 'new' }), {
    status: 'new',
    label: '可导入',
    hint: '扫描发现，可导入到当前 batch',
    selectable: true
  });
  assert.equal(getScanCandidateDisplay({ status: 'imported', existingBatchId: 'batch-other' }).label, '已导入到其他 batch');
  assert.equal(getScanCandidateDisplay({ status: 'imported', existingBatchId: 'batch-current' }, { currentBatchId: 'batch-current' }).label, '已导入当前 batch');
  assert.equal(getScanCandidateDisplay({ status: 'skipped', reason: '不是 new' }).label, '已跳过');
  assert.equal(getScanCandidateDisplay({ status: 'empty' }).label, '无效 / 空文件夹');
});

test('import payload normalizers strip click events and keep plain JSON', () => {
  assert.deepEqual(normalizeImportScannedFoldersPayload(circularClickEvent()), {
    folderPaths: [],
    batchName: '',
    defaultTargets: [],
    templateId: undefined
  });
  assert.deepEqual(normalizeImportBatchFolderPayload(circularClickEvent()), {
    folderPath: '',
    name: '',
    defaultTargets: [],
    templateId: undefined
  });
});

test('api import scan methods send serializable bodies', async () => {
  const { api } = await import('../src/services/api.js');
  const captured = [];
  global.fetch = async (_url, options) => {
    captured.push(options);
    return {
      ok: true,
      json: async () => ({ candidates: [], summary: { totalFolders: 0 } })
    };
  };

  await api.scanImportRoot(circularClickEvent());
  await api.importScannedFolders(circularClickEvent());
  await api.importBatchFolder(circularClickEvent());
  await api.startBatchQueue('batch-1', { action: 'prepare', concurrency: 1, mode: 'mock' });
  await api.startBatchQueue('batch-1', circularClickEvent());

  assert.equal(captured[0].body, '{}');
  assert.equal(captured[1].body, '{"folderPaths":[],"batchName":"","defaultTargets":[]}');
  assert.equal(captured[2].body, '{"folderPath":"","name":"","defaultTargets":[]}');
  assert.equal(captured[3].body, '{"action":"prepare","mode":"mock","concurrency":1}');
  assert.equal(captured[4].body, '{"action":"recognize","mode":"mock"}');
});
