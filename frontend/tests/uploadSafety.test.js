import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import {
  buildUploadSafetyDownload,
  getUploadSafetyDisplayModel,
  uploadSafetyJson,
  uploadSafetyNotice
} from '../src/utils/uploadSafety.js';

function safetyReport(overrides = {}) {
  return {
    meta: {
      generatedAt: '2026-06-01T12:00:00.000Z',
      mode: 'credential-safety-dry-run',
      realUploadEnabled: false
    },
    summary: {
      platformsChecked: 6,
      readyForSandboxApi: true,
      readyForRealUpload: false,
      criticalIssues: 1,
      warnings: 2
    },
    credentialStatus: {
      realUploadEnabled: false,
      platforms: [
        {
          platformId: 'temu',
          platformName: 'Temu',
          sandboxSupported: true,
          realUploadSupported: false,
          configured: true,
          requiredVariables: ['TEMU_CLIENT_ID', 'TEMU_CLIENT_SECRET', 'TEMU_ACCESS_TOKEN', 'TEMU_API_BASE_URL'],
          configuredVariables: ['TEMU_CLIENT_ID', 'TEMU_CLIENT_SECRET', 'TEMU_ACCESS_TOKEN', 'TEMU_API_BASE_URL'],
          missingVariables: [],
          maskedPreview: { TEMU_CLIENT_ID: '****configured****' },
          warnings: []
        },
        {
          platformId: 'miaoshou',
          platformName: '妙手',
          sandboxSupported: true,
          realUploadSupported: false,
          configured: false,
          requiredVariables: ['MIAOSHOU_APP_KEY', 'MIAOSHOU_APP_SECRET', 'MIAOSHOU_ACCESS_TOKEN', 'MIAOSHOU_API_BASE_URL'],
          configuredVariables: ['MIAOSHOU_APP_KEY'],
          missingVariables: ['MIAOSHOU_APP_SECRET', 'MIAOSHOU_ACCESS_TOKEN', 'MIAOSHOU_API_BASE_URL'],
          maskedPreview: {},
          warnings: [{ code: 'MISSING_VARIABLES', message: '缺少必要变量' }]
        }
      ]
    },
    securityFindings: [
      { code: 'REAL_UPLOAD_DISABLED', severity: 'info', message: '当前不会真实上传。' },
      { code: 'LOCAL_STORAGE_NOT_CREDENTIAL_STORE', severity: 'critical', message: 'localStorage 不适合保存真实平台凭据。' }
    ],
    recommendations: ['真实上传前请迁移到后端安全凭据管理方案，localStorage 仅用于 dry-run UI 体验。'],
    nextSuggestedAction: '继续使用 dry-run，真实上传前先完成安全方案。',
    ...overrides
  };
}

test('upload safety display model exposes credential status and localStorage risk', () => {
  const model = getUploadSafetyDisplayModel(safetyReport());

  assert.equal(model.emptyText, '');
  assert.equal(model.summaryCards.some((card) => card.label === 'realUploadEnabled' && card.value === 'false'), true);
  assert.equal(model.summaryCards.some((card) => card.label === 'readyForRealUpload' && card.value === 'false'), true);
  assert.equal(model.platformRows.length, 2);
  assert.equal(model.platformRows[0].requiredVariablesText.includes('TEMU_CLIENT_ID'), true);
  assert.equal(model.platformRows[0].configuredText, '已配置');
  assert.equal(model.platformRows[1].configuredText, '未配置');
  assert.match(model.findingText, /LOCAL_STORAGE_NOT_CREDENTIAL_STORE/);
  assert.match(model.recommendationText, /localStorage/);
  assert.match(model.notice, /不会真实上传/);
});

test('upload safety JSON export is sanitized and uses required file name', () => {
  const download = buildUploadSafetyDownload({
    report: safetyReport({
      securityFindings: [
        { message: 'API_KEY=abc sk-secret provider secret D:\\Code\\.env app.sqlite node_modules Temu token' }
      ]
    }),
    timestamp: '2026-06-01T12-00-00-000Z'
  });

  assert.equal(download.fileName, 'upload-safety-report-2026-06-01T12-00-00-000Z.json');
  assert.equal(download.mimeType, 'application/json');
  assert.doesNotMatch(download.json, /\.env|API_KEY|sk-|Provider secret|Temu token|Miaoshou token|Amazon token|[A-Z]:\\|app\.sqlite|node_modules/i);
  assert.doesNotMatch(uploadSafetyJson(safetyReport({ recommendations: ['real token value secret C:\\tmp'] })), /real token value|[A-Z]:\\/i);
});

test('BatchPage wires platform credential safety section without real upload buttons', () => {
  const pageSource = fs.readFileSync(path.resolve('src/pages/BatchPage.jsx'), 'utf8');
  const apiSource = fs.readFileSync(path.resolve('src/services/api.js'), 'utf8');

  assert.match(pageSource, /平台凭据与上传安全检查/);
  assert.match(pageSource, /刷新凭据状态/);
  assert.match(pageSource, /导出上传安全检查报告 JSON/);
  assert.match(pageSource, /uploadSafetyNotice/);
  assert.match(pageSource, /api\.getUploadCredentialStatus/);
  assert.match(pageSource, /api\.getUploadSafetyReport/);
  assert.match(pageSource, /downloadUploadSafetyJson/);
  assert.match(pageSource, /localStorage 仅用于 dry-run UI 体验/);
  assert.match(apiSource, /getUploadCredentialStatus/);
  assert.match(apiSource, /getUploadSafetyReport/);
  assert.match(uploadSafetyNotice, /不会真实上传/);
  assert.match(uploadSafetyNotice, /不会调用平台 API/);
  assert.doesNotMatch(pageSource, /真实上传按钮|测试真实 API|savePlatformToken|submitPlatformUpload|realUploadEnabled: true|TEMU_CLIENT_SECRET=/);
});
