import assert from 'node:assert/strict';
import { test } from 'node:test';
import { getProviders } from '../src/providers/index.js';

test('mock providers return normalized provider metadata', async () => {
  const providers = getProviders('mock');
  const vision = await providers.vision.recognize({ task: { id: 'task_provider_test' } });

  assert.equal(vision.provider, 'mock');
  assert.equal(vision.status, 'success');
  assert.equal(typeof vision.durationMs, 'number');
  assert.ok(vision.model);
  assert.ok(vision.data.productInfoRaw.name);
  assert.ok(Array.isArray(vision.data.visibleText));

  const image = await providers.image.generate({
    task: {
      id: 'task_provider_test',
      platform: 'Amazon',
      productInfoConfirmed: { sku: 'SKU-PROVIDER', name: 'Provider Test Bottle', packageList: [] }
    },
    plan: {
      id: 'plan_provider_test',
      type: 'main_image',
      title: 'Main Image',
      prompt: 'Mock prompt'
    },
    outputIndex: 1
  });

  assert.equal(image.provider, 'mock');
  assert.equal(image.status, 'succeeded');
  assert.equal(image.data.planId, 'plan_provider_test');
  assert.equal(image.data.provider, 'mock');

  const review = await providers.review.review({
    task: { id: 'task_provider_test' },
    image: image.data
  });

  assert.equal(review.provider, 'mock');
  assert.equal(review.status, 'success');
  assert.equal(review.data.imageId, image.data.id);
  assert.ok(Array.isArray(review.data.issues));
});
