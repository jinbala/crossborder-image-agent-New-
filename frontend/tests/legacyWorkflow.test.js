import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { approvePaidOperation } from '../src/utils/paidOperationApproval.js';
import { normalizeReviewOptions } from '../src/utils/reviewMode.js';
import { normalizeStressTestPayload } from '../src/utils/stressTest.js';
import { translate } from '../src/i18n/core.js';
const t = (source, values) => translate('en-US', source, values);

test('all JSX display literals and explicit notices have catalog entries, not proof of full dynamic translation', () => {
  const cwd = fileURLToPath(new URL('..', import.meta.url));
  const report = JSON.parse(execFileSync(process.execPath, ['scripts/localize-ui.mjs', '--check', '--expressions'], { cwd, encoding: 'utf8' }));
  assert.equal(report.unlocalizedCount, 0); assert.equal(report.missingCount, 0);
});
test('read-only paid preflight preserves original targets, cancellation authorizes nothing, and mock grants no paid permission', async () => {
  let reads = 0, dialogs = 0;
  const api = { getProviderConfig: async () => { reads++; return { paidDestinations: { review: { provider: 'openai', origin: 'https://review.example' } } }; } };
  const result = await approvePaidOperation(api, { kinds: ['review'], target: 'SKU-原文', count: 8 }, t, (message) => { dialogs++; assert.ok(message.includes('SKU-原文')); assert.ok(message.includes('https://review.example')); assert.ok(message.includes('automatic retries')); return false; });
  assert.equal(result, null); assert.equal(reads, 1); assert.equal(dialogs, 1);
  assert.deepEqual(await approvePaidOperation(api, { kinds: ['review'], target: 'SKU-原文', count: 1 }, t, () => true), { confirmPaidApi: true });
  api.getProviderConfig = async () => ({ paidDestinations: { review: { provider: 'mock', origin: null } } });
  assert.deepEqual(await approvePaidOperation(api, { kinds: ['review'], allowMock: true }, t, () => { throw new Error('must not prompt for mock'); }), { confirmPaidApi: false });
  await assert.rejects(approvePaidOperation(api, { kinds: ['review'] }, t, () => true), /not configured/);
  api.getProviderConfig = async () => ({ paidDestinations: { matting: { provider: 'rembg', local: true, origin: null } } });
  assert.deepEqual(await approvePaidOperation(api, { kinds: ['matting'], allowMock: true }, t, () => { throw new Error('local processing must not prompt'); }), { confirmPaidApi: false });
});
test('unknown or credential-bearing paid destinations fail closed before confirmation', async () => {
  for (const origin of [null, 'https://user:private@example.test', 'https://example.test/private?token=secret', 'file:///private']) {
    const api = { getProviderConfig: async () => ({ paidDestinations: { vision: { provider: 'openai', origin } } }) };
    await assert.rejects(approvePaidOperation(api, { kinds: ['vision'] }, t, () => { throw new Error('must not prompt'); }), /Cannot verify/);
  }
});
test('review and stress normalizers preserve only strictly true paid confirmation without changing protocol enums', () => {
  for (const confirmPaidApi of [undefined, false, 'true', 1, {}]) {
    assert.equal(normalizeReviewOptions({ mode: 'real', confirmPaidApi }).confirmPaidApi, undefined);
    assert.equal(normalizeStressTestPayload({ mode: 'realVisionMockGenerate', confirmPaidApi }).confirmPaidApi, undefined);
  }
  assert.deepEqual(normalizeReviewOptions({ mode: 'real', confirmPaidApi: true }), { mode: 'real', confirmPaidApi: true });
  assert.equal(normalizeStressTestPayload({ mode: 'realVisionMockGenerate', confirmPaidApi: true }).confirmPaidApi, true);
});
test('acceptance errors are visible and replacing reports or deleting issues requires confirmation', () => {
  const source = fs.readFileSync(new URL('../src/pages/FinalAcceptancePage.jsx', import.meta.url), 'utf8');
  assert.ok(source.includes('<ErrorMessage error={error} />')); assert.ok(!source.includes('<ErrorMessage message={error}'));
  const remove = source.slice(source.indexOf('function deleteIssue('), source.indexOf('\n  return (', source.indexOf('function deleteIssue(')));
  assert.ok(remove.indexOf('window.confirm') < remove.indexOf('deleteFinalAcceptanceIssue'));
  assert.ok(source.includes('value={issue.title}')); assert.ok(!source.includes('value={t(issue.title)}'));
  const generate = fs.readFileSync(new URL('../src/pages/GeneratePage.jsx', import.meta.url), 'utf8');
  assert.ok(generate.includes('approvePaidOperation(api')); assert.ok(generate.includes('...extra, ...approval'));
});
