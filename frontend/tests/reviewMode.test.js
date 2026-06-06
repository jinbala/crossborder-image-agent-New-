import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizeReviewMode, normalizeReviewOptions } from '../src/utils/reviewMode.js';

test('normalizeReviewMode returns explicit mock and real values', () => {
  assert.equal(normalizeReviewMode('mock'), 'mock');
  assert.equal(normalizeReviewMode('real'), 'real');
  assert.equal(normalizeReviewMode({ mode: 'real' }), 'real');
});

test('normalizeReviewMode treats DOM or React events as mock', () => {
  const button = { constructor: { name: 'HTMLButtonElement' } };
  const event = { currentTarget: button, target: button, mode: undefined };
  button.__reactFiber = { stateNode: button };

  assert.equal(normalizeReviewMode(event), 'mock');
  assert.deepEqual(normalizeReviewOptions(event), { mode: 'mock' });
  assert.equal(JSON.stringify(normalizeReviewOptions(event)), '{"mode":"mock"}');
});
