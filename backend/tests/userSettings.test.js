import assert from 'node:assert/strict';
import { test } from 'node:test';
import request from 'supertest';
import app from '../src/app.js';
import {
  readDb,
} from '../src/services/db.js';
import {
  getEffectiveSettings,
  getUserSettings,
  resetUserSettings,
  sanitizeSettingsInput,
  updateUserSettings
} from '../src/services/userSettingsService.js';
import { estimateBatchCost } from '../src/services/batchAnalyticsService.js';
import { resolveBatchConcurrency } from '../src/services/batchQueueService.js';

test('getUserSettings creates v4.3 defaults', async () => {
  await resetUserSettings();
  const settings = await getUserSettings();
  assert.equal(settings.version, 'v4.3');
  assert.equal(settings.defaults.batchConcurrency, 2);
  assert.equal(settings.defaults.recognitionMode, 'balanced');
  assert.equal(settings.providers.visionProvider, 'gemini');
  assert.equal(settings.defaults.platforms[0].platformId, 'amazon');
  assert.equal(settings.sqliteTrial.status, 'not_started');
  assert.equal(settings.sqliteTrial.enabled, false);
  assert.equal(settings.sqliteTrial.lastTrialCheckAt, null);
  assert.equal(settings.sqliteTrial.lastTrialCheckStatus, null);
  assert.deepEqual(settings.sqliteTrial.trialChecklist, []);
});

test('updateUserSettings supports partial updates and filters sensitive fields', async () => {
  try {
    const updated = await updateUserSettings({
      defaults: { batchConcurrency: 2 },
      providers: { visionProvider: 'mock' },
      OPENAI_API_KEY: 'do-not-store',
      nested: { token: 'do-not-store' }
    });
    assert.equal(updated.defaults.batchConcurrency, 2);
    assert.equal(updated.providers.visionProvider, 'mock');
    const clean = sanitizeSettingsInput({ key: 'ok', secretToken: 'bad', nested: { apiKey: 'bad', value: 1 } });
    assert.deepEqual(clean, { key: 'ok', nested: { value: 1 } });
    const db = await readDb();
    assert.doesNotMatch(JSON.stringify(db.userSettings), /do-not-store/);
  } finally {
    await resetUserSettings();
  }
});

test('settings API returns effective summary without API keys and warns about missing keys', async () => {
  const previousGeminiKey = process.env.GEMINI_API_KEY;
  try {
    delete process.env.GEMINI_API_KEY;
    await updateUserSettings({ providers: { visionProvider: 'gemini' } });
    const response = await request(app).get('/api/settings/effective').expect(200);
    assert.equal(response.body.envSummary.hasGeminiKey, false);
    assert.ok(response.body.warnings.some((warning) => warning.code === 'MISSING_PROVIDER_KEY'));
    assert.doesNotMatch(JSON.stringify(response.body), /GEMINI_API_KEY|secret|token/i);

    await request(app)
      .put('/api/settings')
      .send({ defaults: { reviewMode: 'real' }, password: 'nope' })
      .expect(200)
      .expect((res) => {
        assert.equal(res.body.userSettings.defaults.reviewMode, 'real');
        assert.doesNotMatch(JSON.stringify(res.body), /nope/);
      });

    await request(app).post('/api/settings/reset').expect(200);
    const settings = await getUserSettings();
    assert.equal(settings.defaults.reviewMode, 'mock');
  } finally {
    await resetUserSettings();
    if (previousGeminiKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = previousGeminiKey;
  }
});

test('getEffectiveSettings never returns real provider keys', async () => {
  const previousOpenAIKey = process.env.OPENAI_API_KEY;
  try {
    process.env.OPENAI_API_KEY = 'real-key-must-not-leak';
    const effective = await getEffectiveSettings();
    assert.equal(effective.envSummary.hasOpenAIKey, true);
    assert.doesNotMatch(JSON.stringify(effective), /real-key-must-not-leak/);
  } finally {
    if (previousOpenAIKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousOpenAIKey;
  }
});

test('batch queue default concurrency can be resolved from settings', () => {
  assert.equal(resolveBatchConcurrency(undefined, { defaults: { batchConcurrency: 3 } }), 3);
  assert.equal(resolveBatchConcurrency(99, { defaults: { batchConcurrency: 3 } }), 4);
});

test('batch analytics prefers userSettings cost before env cost', async () => {
  const userSettings = {
    cost: {
      currency: 'USD',
      vision: { gemini: 0.77 },
      image: { openai: 1.25 },
      review: { gemini: 0.33 },
      matting: { external: 0.11 }
    }
  };
  const cost = estimateBatchCost({}, [{
    recognitionMeta: { provider: 'gemini' },
    generatedImages: [{ provider: 'openai', isRealGenerated: true, mattingProvider: 'external' }],
    reviewResults: [{ provider: 'gemini' }]
  }], userSettings);
  assert.equal(cost.byAction.vision, 0.77);
  assert.equal(cost.byAction.image, 1.25);
  assert.equal(cost.byAction.review, 0.33);
  assert.equal(cost.byAction.matting, 0.11);
});
