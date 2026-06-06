import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  MATING_PROVIDER_OPTIONS,
  externalMattingEnabled,
  image2MattingEnabled,
  mattingCompareCards,
  mattingConfigNotice,
  mattingFallbackText,
  mattingImage2Notice,
  mattingOutputTypeWarning,
  mattingQualityLabel,
  normalizeMattingPayload,
  sanitizeMattingDisplay
} from '../src/utils/matting.js';

test('matting config notice explains unconfigured external API and keeps sharp available', () => {
  const notice = mattingConfigNotice({
    currentProvider: 'sharp',
    externalConfigured: false
  });

  assert.match(notice, /第三方抠图 API 未配置/);
  assert.match(notice, /sharp 本地抠图/);
  assert.equal(externalMattingEnabled({ externalConfigured: false }), false);
  assert.equal(MATING_PROVIDER_OPTIONS.some((item) => item.id === 'sharp' && item.enabled), true);
});

test('matting page contains Image2 experiment copy and result fields', () => {
  const page = readFileSync(new URL('../src/pages/MattingPage.jsx', import.meta.url), 'utf8');

  assert.match(page, /使用 Image2 抠图测试/);
  assert.match(page, /Image2 未配置/);
  assert.match(page, /Image2 结果为实验性抠图输出/);
  assert.match(page, /requestedProvider/);
  assert.match(page, /providerUsed/);
  assert.match(page, /outputType/);
});

test('matting config notice warns about cost when external is configured', () => {
  const notice = mattingConfigNotice({
    currentProvider: 'external',
    externalConfigured: true
  });

  assert.match(notice, /第三方抠图 API 可能产生费用/);
  assert.match(notice, /不会自动调用/);
  assert.equal(externalMattingEnabled({ externalConfigured: true }), true);
});

test('matting payload normalization keeps external opt-in explicit', () => {
  assert.deepEqual(normalizeMattingPayload({
    taskId: 'task-1',
    imageId: 'image-1',
    provider: 'external'
  }), {
    taskId: 'task-1',
    imageId: 'image-1',
    provider: 'external'
  });
  assert.deepEqual(normalizeMattingPayload({ taskId: 'task-1', imageId: 'image-1' }), {
    taskId: 'task-1',
    imageId: 'image-1',
    provider: 'sharp'
  });
  assert.deepEqual(normalizeMattingPayload({ taskId: 'task-1', imageId: 'image-1', provider: 'image2' }), {
    taskId: 'task-1',
    imageId: 'image-1',
    provider: 'image2'
  });
});

test('Image2 notices show unavailable and cost states without auto calling Image2', () => {
  assert.equal(image2MattingEnabled({ image2Available: false }), false);
  assert.match(mattingImage2Notice({ image2Available: false }), /Image2 未配置/);
  assert.match(mattingImage2Notice({ image2Available: false }), /不会产生第三方 API 成本/);
  assert.equal(image2MattingEnabled({ image2Available: true }), true);
  assert.match(mattingImage2Notice({ image2Available: true }), /Image2 抠图测试可能产生 API 成本/);
  assert.match(mattingImage2Notice({ image2Available: true }), /点击对应按钮/);
  assert.equal(MATING_PROVIDER_OPTIONS.some((item) => item.id === 'image2'), true);
});

test('non-transparent Image2 output type shows experimental warning', () => {
  assert.equal(mattingOutputTypeWarning('transparent'), '');
  assert.match(mattingOutputTypeWarning('edited-background-removed'), /不保证为标准透明背景 PNG/);
  assert.match(mattingOutputTypeWarning('simulated'), /实验性抠图输出/);
});

test('matting compare cards show original sharp external fallback and quality score', () => {
  const cards = mattingCompareCards({
    originalImage: { previewUrl: '/uploads/source.png' },
    sharp: { status: 'success', providerUsed: 'sharp', qualityScore: { score: 82, level: 'good', warnings: [] } },
    external: { status: 'skipped', message: '第三方抠图 API 未配置。' }
  });

  assert.equal(cards.some((card) => card.title === '原图'), true);
  assert.equal(cards.some((card) => card.title === 'sharp 抠图结果'), true);
  assert.equal(cards.some((card) => card.title === '第三方抠图结果'), true);
  assert.match(cards.map((card) => card.statusText).join('\n'), /未配置/);
  assert.match(mattingQualityLabel({ score: 82, level: 'good' }), /82/);
});

test('matting compare cards include Image2 experiment result fields', () => {
  const cards = mattingCompareCards({
    originalImage: { previewUrl: '/uploads/source.png' },
    sharp: { status: 'success', providerUsed: 'sharp', qualityScore: { score: 82, level: 'good', warnings: [] } },
    image2: {
      status: 'success',
      requestedProvider: 'image2',
      providerUsed: 'image2',
      outputType: 'edited-background-removed',
      fallbackUsed: false,
      qualityScore: { score: 74, level: 'medium', warnings: [] }
    }
  });

  const image2Card = cards.find((card) => card.title === 'Image2 实验结果');
  assert.equal(Boolean(image2Card), true);
  assert.match(image2Card.statusText, /image2/);
  assert.match(image2Card.metaText, /requestedProvider/);
  assert.match(image2Card.metaText, /outputType/);
});

test('matting fallback text and display sanitizer hide API keys and local paths', () => {
  assert.match(mattingFallbackText({ fallbackUsed: true, fallbackReason: '第三方抠图失败，已 fallback 到 sharp。' }), /fallback 到 sharp/);
  const display = sanitizeMattingDisplay({
    message: 'D:\\secret\\source.png sk-secret',
    apiKey: 'secret-key',
    nested: { previewUrl: '/outputs/task/matting.png', localPath: 'C:\\secret\\matting.png' }
  });
  const text = JSON.stringify(display);

  assert.doesNotMatch(text, /secret-key|sk-secret/);
  assert.doesNotMatch(text, /[A-Z]:\\/);
  assert.match(text, /\/outputs\/task\/matting\.png/);
});

test('matting API helpers call config run and compare endpoints without auto external call', async () => {
  const { api } = await import('../src/services/api.js');
  const captured = [];
  global.fetch = async (url, options = {}) => {
    captured.push({ url, options });
    return {
      ok: true,
      json: async () => ({ ok: true })
    };
  };

  await api.getMattingConfig();
  await api.runMatting({ taskId: 'task-1', imageId: 'image-1' });
  await api.runMatting({ taskId: 'task-1', imageId: 'image-1', provider: 'image2' });
  await api.compareMatting({ taskId: 'task-1', imageId: 'image-1' });

  assert.equal(captured[0].url, '/api/matting/config');
  assert.equal(captured[1].url, '/api/matting/run');
  assert.equal(captured[1].options.body, '{"taskId":"task-1","imageId":"image-1","provider":"sharp"}');
  assert.equal(captured[2].options.body, '{"taskId":"task-1","imageId":"image-1","provider":"image2"}');
  assert.equal(captured[3].url, '/api/matting/compare');
});

test('matting page contains Chinese guidance buttons warnings and safe states', () => {
  const page = readFileSync(new URL('../src/pages/MattingPage.jsx', import.meta.url), 'utf8');
  const app = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
  const layout = readFileSync(new URL('../src/components/Layout.jsx', import.meta.url), 'utf8');

  assert.match(page, /主体抠图测试/);
  assert.match(page, /使用 sharp 抠图测试/);
  assert.match(page, /使用第三方抠图测试/);
  assert.match(page, /第三方抠图 API 可能产生费用/);
  assert.match(page, /第三方抠图 API 未配置/);
  assert.match(page, /对比抠图结果/);
  assert.match(page, /质量评分/);
  assert.match(page, /fallback/);
  assert.match(app, /matting/);
  assert.match(layout, /主体抠图/);
});
