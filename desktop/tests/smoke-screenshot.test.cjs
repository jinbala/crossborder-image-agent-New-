const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { smokeScreenshot } = require('../src/smoke-screenshot.cjs');
test('screenshot retries a transient render failure and writes the successful image', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'crossborder-screenshot-test-'));
  let calls = 0;
  try {
    const window = { webContents: { capturePage: async () => { if (++calls === 1) throw new Error('UnknownVizError'); return { isEmpty: () => false, toPNG: () => Buffer.from('png-fixture') }; } } };
    const filename = path.join(directory, 'preview.png'); await smokeScreenshot(window, filename);
    assert.equal(calls, 2); assert.equal(await fs.readFile(filename, 'utf8'), 'png-fixture');
  } finally { if (path.dirname(directory) === path.resolve(os.tmpdir()) && path.basename(directory).startsWith('crossborder-screenshot-test-')) await fs.rm(directory, { recursive: true, force: true }); }
});
test('screenshot remains a failed gate after three render failures', async () => {
  let calls = 0;
  await assert.rejects(smokeScreenshot({ webContents: { capturePage: async () => { calls++; throw new Error('UnknownVizError'); } } }, 'unused.png'), /after three attempts.*UnknownVizError/);
  assert.equal(calls, 3);
});
