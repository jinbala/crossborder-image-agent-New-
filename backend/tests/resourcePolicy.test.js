import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resourceWorkerLimit, mapWithResourceLimit } from '../src/services/resourcePolicy.js';
test('resource policy caps workers by user request, CPU, free memory and disk', () => {
  const base = { cpuCount: 16, availableMemoryBytes: 16 * 1024 ** 3, availableDiskBytes: 16 * 1024 ** 3 };
  assert.equal(resourceWorkerLimit(4, base), 4);
  assert.equal(resourceWorkerLimit(1, base), 1);
  assert.equal(resourceWorkerLimit(4, { ...base, cpuCount: 2 }), 1);
  assert.equal(resourceWorkerLimit(4, { ...base, availableMemoryBytes: 800 * 1024 ** 2, action: 'generate' }), 1);
  assert.equal(resourceWorkerLimit(4, { ...base, availableDiskBytes: 200 * 1024 ** 2 }), 1);
});
test('bounded image analysis processes each item exactly once', async () => {
  const seen = [];
  await mapWithResourceLimit([1, 2, 3, 4], async (item) => { seen.push(item); }, 2);
  assert.deepEqual(seen.sort(), [1, 2, 3, 4]);
});
