import assert from 'node:assert/strict';
import { test } from 'node:test';

test('api.review sends a serializable mock review body for event-like input', async () => {
  const { api } = await import('../src/services/api.js');
  const button = { constructor: { name: 'HTMLButtonElement' } };
  const event = { currentTarget: button, target: button };
  button.__reactFiber = { stateNode: button };
  let capturedOptions = null;

  global.fetch = async (_url, options) => {
    capturedOptions = options;
    return {
      ok: true,
      json: async () => ({ task: { id: 'task-1' } })
    };
  };

  await api.review('task-1', event);

  assert.equal(capturedOptions.method, 'POST');
  assert.equal(capturedOptions.body, '{"mode":"mock"}');
});

test('api.review sends real mode when requested', async () => {
  const { api } = await import('../src/services/api.js');
  let capturedOptions = null;

  global.fetch = async (_url, options) => {
    capturedOptions = options;
    return {
      ok: true,
      json: async () => ({ task: { id: 'task-1' } })
    };
  };

  await api.review('task-1', { mode: 'real' });

  assert.equal(capturedOptions.body, '{"mode":"real"}');
});
