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
    assert.equal(calls, 3); assert.equal(await fs.readFile(filename, 'utf8'), 'png-fixture');
  } finally { if (path.dirname(directory) === path.resolve(os.tmpdir()) && path.basename(directory).startsWith('crossborder-screenshot-test-')) await fs.rm(directory, { recursive: true, force: true }); }
});
test('screenshot remains a failed gate after three render failures', async () => {
  let calls = 0;
  await assert.rejects(smokeScreenshot({ webContents: { capturePage: async () => { calls++; throw new Error('UnknownVizError'); } } }, 'unused.png'), /after three attempts.*UnknownVizError/);
  assert.equal(calls, 3);
});

test('anchored snapshots force layout and save the latest native frame without renderer animation waits', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'crossborder-screenshot-test-')); t.after(async () => { const resolved = await fs.realpath(directory); assert.equal(path.dirname(resolved), await fs.realpath(os.tmpdir())); assert.ok(path.basename(resolved).startsWith('crossborder-screenshot-test-')); await fs.rm(resolved, { recursive: true, force: true }); });
  let calls = 0, scripts = [];
  const window = { webContents: {
    executeJavaScript: async source => scripts.push(source),
    capturePage: async (_rect, options) => { assert.deepEqual(options, { stayHidden: true, stayAwake: true }); const bytes = Buffer.from(++calls === 1 ? 'warmup-only' : 'latest-frame'); return { isEmpty: () => false, toPNG: () => bytes }; }
  } };
  const file = path.join(directory, 'anchored.png'); await smokeScreenshot(window, file, { selector: '[data-report]' });
  assert.equal(calls, 2); assert.equal(scripts.length, 1); assert.match(scripts[0], /scrollIntoView/); assert.match(scripts[0], /getBoundingClientRect/); assert.ok(!scripts[0].includes('requestAnimationFrame')); assert.equal(await fs.readFile(file, 'utf8'), 'latest-frame');
});

test('a missing screenshot anchor fails before any capture or output is accepted', async () => {
  const error = new Error('Screenshot anchor not found');
  await assert.rejects(smokeScreenshot({ webContents: { executeJavaScript: async () => { throw error; }, capturePage: () => assert.fail('no capture for missing anchors') } }, 'unused.png', { selector: '[missing]' }), actual => actual === error);
});

test('UI smoke modules do not wait for hidden animation frames before screenshots', async () => {
  const source = path.join(__dirname, '..', 'src');
  for (const file of (await fs.readdir(source)).filter(name => name.endsWith('-smoke.cjs'))) assert.ok(!(await fs.readFile(path.join(source, file), 'utf8')).includes('requestAnimationFrame'), file);
  const draft = await fs.readFile(path.join(source, 'collection-draft-smoke.cjs'), 'utf8');
  assert.ok(draft.includes('.smokeScreenshot(')); assert.ok(!draft.includes('.capturePage('));
});
