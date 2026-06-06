import assert from 'node:assert/strict';
import { test } from 'node:test';
import { listTemplates } from '../src/services/workflowTemplateService.js';

test('real_api_small_batch_test system template is available for real-test small batches', async () => {
  const templates = await listTemplates();
  const template = templates.find((item) => item.id === 'real_api_small_batch_test');

  assert.ok(template);
  assert.equal(template.modes.recognition, 'real');
  assert.equal(template.modes.imageGeneration, 'real-test');
  assert.equal(template.modes.review, 'real');
  assert.equal(template.modes.upload, 'dry-run');
  assert.equal(template.generation.defaultMode, 'real-test');
  assert.equal(template.review.defaultMode, 'real');
  assert.ok([1, 2].includes(template.queue.concurrency));
  assert.equal(template.queue.maxImageAutoFix, 2);
  assert.equal(template.safety.preventRealUpload, true);
});
