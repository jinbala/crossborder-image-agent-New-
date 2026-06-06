import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import request from 'supertest';
import app from '../src/app.js';

const originalEnv = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnv };
});

test('GET /api/settings/providers/status returns sanitized provider status only', async () => {
  process.env.VISION_PROVIDER = 'gemini';
  process.env.GEMINI_API_KEY = 'gemini-secret-value';
  process.env.GEMINI_VISION_MODEL = 'gemini-test-model';
  process.env.IMAGE_PROVIDER = 'real';
  process.env.BACKGROUND_PROVIDER = 'openai';
  process.env.OPENAI_API_KEY = '';
  process.env.OPENAI_IMAGE_MODEL = 'gpt-image-test';
  process.env.REVIEW_PROVIDER = 'openai';
  process.env.OPENAI_REVIEW_MODEL = 'gpt-review-test';

  await request(app)
    .get('/api/settings/providers/status')
    .expect(200)
    .expect((res) => {
      assert.equal(res.body.upload.realUploadEnabled, false);
      assert.equal(res.body.upload.readyForRealUpload, false);
      assert.equal(res.body.modes.mockAvailable, true);
      assert.equal(res.body.modes.realTestAvailable, false);
      assert.equal(res.body.vision.provider, 'gemini');
      assert.equal(res.body.vision.model, 'gemini-test-model');
      assert.deepEqual(res.body.vision.requiredVariables, ['GEMINI_API_KEY']);
      assert.equal(res.body.vision.configured, true);
      assert.equal(res.body.image.provider, 'openai');
      assert.equal(res.body.image.model, 'gpt-image-test');
      assert.equal(res.body.image.configured, false);
      assert.deepEqual(res.body.image.missingVariables, ['OPENAI_API_KEY']);
      assert.equal(res.body.review.provider, 'openai');
      assert.equal(res.body.review.model, 'gpt-review-test');
      assert.deepEqual(res.body.review.missingVariables, ['OPENAI_API_KEY']);

      const text = JSON.stringify(res.body);
      assert.doesNotMatch(text, /gemini-secret-value|OPENAI_API_KEY=|API Key|token|secret-value|sk-|\.env|[A-Z]:\\|app\.sqlite|node_modules/i);
    });
});
