import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  getReviewStaleNotice,
  mockPreviewReviewNotice,
  splitMockPreviewIssues
} from '../src/utils/reviewDisplay.js';

test('mockPreviewReviewNotice explains mock preview without hiding real compliance issues', () => {
  assert.equal(
    mockPreviewReviewNotice({ mockPreviewCount: 1 }),
    '当前图片为 mock 预览图，仅用于流程测试，不代表真实平台上传结果。mock 预览图可能触发占位图、文字布局或主体保真相关提示，这不等同于真实图片违规。'
  );
  assert.equal(mockPreviewReviewNotice({ mockPreviewCount: 0 }), '');
});

test('getReviewStaleNotice warns when generated images changed after review', () => {
  assert.match(getReviewStaleNotice({
    generatedImages: [{ id: 'img-new', updatedAt: '2026-06-02T10:00:00.000Z' }],
    review: { reviewedAt: '2026-06-02T09:00:00.000Z' },
    reviewResults: []
  }), /重新审核|閲嶆柊/);

  assert.equal(getReviewStaleNotice({
    generatedImages: [{ id: 'img-old', updatedAt: '2026-06-02T08:00:00.000Z' }],
    review: { reviewedAt: '2026-06-02T09:00:00.000Z' },
    reviewResults: []
  }), '');

  assert.match(getReviewStaleNotice({
    generatedImages: [],
    review: { hasStaleResults: true },
    reviewResults: []
  }), /重新审核|閲嶆柊/);
});

test('splitMockPreviewIssues separates mock source hints from real compliance issues', () => {
  const issues = [
    { type: 'mock_preview_source', category: 'source', message: 'mock preview placeholder' },
    { type: 'chinese_text', category: 'text', message: '图片包含中文' },
    { type: 'main_image_text', category: 'platform', message: 'Amazon 主图包含文字' }
  ];

  const result = splitMockPreviewIssues(issues);

  assert.deepEqual(result.mockPreviewIssues.map((issue) => issue.message), ['mock preview placeholder']);
  assert.deepEqual(result.complianceIssues.map((issue) => issue.message), ['图片包含中文', 'Amazon 主图包含文字']);
});
