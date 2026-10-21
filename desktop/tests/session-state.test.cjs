const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { beginDesktopSession, startupRoute } = require('../src/session-state.cjs');

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'crossborder-session-state-'));
  t.after(async () => {
    assert.equal(path.dirname(await fs.realpath(directory)), await fs.realpath(os.tmpdir()));
    await fs.rm(directory, { recursive: true, force: true });
  });
  return path.join(directory, 'session.json');
}

test('fresh and clean restarts preserve the regular workbench entry', async (t) => {
  const file = await fixture(t), first = await beginDesktopSession(file);
  assert.equal(first.interrupted, false); assert.equal(startupRoute(null, false), '/workbench');
  assert.equal(await first.finish(), true);
  const second = await beginDesktopSession(file);
  assert.equal(second.interrupted, false); assert.equal(JSON.parse(await fs.readFile(`${file}.previous`)).state, 'stopped');
});
test('unclean restart enters recovery but an explicit validated deep link takes precedence', async (t) => {
  const file = await fixture(t);
  await beginDesktopSession(file);
  const next = await beginDesktopSession(file);
  assert.equal(next.interrupted, true); assert.equal(startupRoute(null, true), '/desktop');
  assert.equal(startupRoute('/workbench/collection?jobId=fixture', true), '/workbench/collection?jobId=fixture');
  assert.equal(JSON.parse(await fs.readFile(`${file}.previous`)).state, 'running');
});
test('corrupt and oversized records are retained and lead to safe manual recovery', async (t) => {
  const file = await fixture(t);
  await fs.writeFile(file, '{truncated');
  assert.equal((await beginDesktopSession(file)).interrupted, true);
  assert.equal(await fs.readFile(`${file}.previous`, 'utf8'), '{truncated');
  const oversized = 'x'.repeat(65537);
  await fs.writeFile(file, oversized);
  assert.equal((await beginDesktopSession(file)).interrupted, true);
  assert.equal(await fs.readFile(`${file}.previous`, 'utf8'), oversized);
});
test('finishing an older run cannot mark a newer run clean, and finish is idempotent', async (t) => {
  const file = await fixture(t), old = await beginDesktopSession(file), current = await beginDesktopSession(file);
  assert.equal(await old.finish(), false); assert.equal(JSON.parse(await fs.readFile(file)).state, 'running');
  assert.equal(await current.finish(), true); assert.equal(await current.finish(), false);
});
