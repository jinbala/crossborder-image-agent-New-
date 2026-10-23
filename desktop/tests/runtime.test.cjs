const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { isInside, runtimeDirectories, redact, sanitizeValue, createToken, canNavigate, protocolRoute, filterLog, prepareExtension } = require('../src/runtime.cjs');
const fs = require('node:fs/promises');
const os = require('node:os');

test('directory containment rejects sibling-prefix and traversal paths', () => {
  const root = path.resolve('test-root');
  assert.equal(isInside(root, path.join(root, '中文 空格', 'file.png')), true);
  assert.equal(isInside(root, `${root}-other`), false);
  assert.equal(isInside(root, path.resolve(root, '..', 'outside')), false);
  assert.ok(Object.values(runtimeDirectories(root)).every((value) => isInside(root, value)));
});

test('packaged extension is copied to a stable OS directory and can update without removing unrelated files', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'desktop-extension-'));
  try {
    const source = path.resolve(__dirname, '../../browser-extension/temu-deep-collector');
    const directory = await prepareExtension(source, root);
    assert.equal(JSON.parse(await fs.readFile(path.join(directory, 'manifest.json'))).version, '0.5.5');
    await fs.writeFile(path.join(directory, 'user-note.txt'), 'preserve');
    assert.equal(await prepareExtension(source, root), directory);
    assert.equal(await fs.readFile(path.join(directory, 'user-note.txt'), 'utf8'), 'preserve');
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('logs filter by literal task ID and inclusive timestamp range', () => {
  const text = '2026-10-20T01:00:00.000Z task-a queued\n2026-10-20T02:00:00.000Z task-b failed\n2026-10-20T03:00:00.000Z task-a complete';
  assert.equal(filterLog(text, { taskId: 'task-a', from: '2026-10-20T02:00:00Z' }), text.split('\n')[2]);
  assert.equal(filterLog(text, { from: '2026-10-20T01:00:00Z', to: '2026-10-20T02:00:00Z' }).split('\n').length, 2);
  assert.equal(filterLog(text, { taskId: '.*' }), '');
  assert.throws(() => filterLog(text, { from: 'invalid' }), /时间范围/);
});

test('support logs remove credentials, personal contacts and Windows paths', () => {
  const result = redact('Authorization: Bearer secret123\nCookie=loginsecret\nfoo@example.com 13812345678 C:\\Users\\private\\image.png');
  for (const value of ['secret123', 'loginsecret', 'foo@example.com', '13812345678', 'private']) assert.equal(result.includes(value), false);
  assert.equal(redact('http://127.0.0.1:4000'), 'http://127.0.0.1:4000');
  assert.deepEqual(sanitizeValue({ password: 'private', nested: { apiKey: 'secret' }, enabled: true }), { password: '[已隐藏]', nested: { apiKey: '[已隐藏]' }, enabled: true });
});

test('navigation stays on the owned backend origin and tokens are unpredictable', () => {
  assert.equal(canNavigate('http://127.0.0.1:35000/workbench', 'http://127.0.0.1:35000'), true);
  for (const url of ['file:///etc/passwd', 'https://example.org', 'http://127.0.0.1:35001']) assert.equal(canNavigate(url, 'http://127.0.0.1:35000'), false);
  assert.match(createToken(), /^[a-f0-9]{64}$/);
  assert.notEqual(createToken(), createToken());
  assert.equal(protocolRoute('crossborder-workbench://collection?jobId=collect-job-safe'), '/workbench/collection?jobId=collect-job-safe');
  assert.equal(protocolRoute('crossborder-workbench://collection?jobId=../../unsafe'), null);
  assert.equal(protocolRoute('https://example.org'), null);
});
