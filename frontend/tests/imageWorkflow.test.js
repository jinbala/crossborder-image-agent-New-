import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { translate } from '../src/i18n/core.js';
import { mattingTaskList, mattingQualityLabel, mattingCompareCards, mattingConfigNotice, mattingImage2Notice, mattingSelectionFor } from '../src/utils/matting.js';
import { approveImageGeneration } from '../src/utils/imageGenerationApproval.js';

const t = (source, values) => translate('en-US', source, values);
test('matting handles the real tasks envelope, old array contract and invalid response without changing records', () => {
  const tasks = [{ id: 'original', sourceImages: [{ id: 'image-original', displayName: '中文原图.png' }] }];
  const before = structuredClone(tasks); assert.deepEqual(mattingTaskList({ tasks }), tasks); assert.deepEqual(mattingTaskList(tasks), tasks);
  for (const value of [null, {}, { tasks: null }, { tasks: {} }]) assert.deepEqual(mattingTaskList(value), []);
  assert.deepEqual(tasks, before);
});
test('quality labels localize only display strings and retain original filenames and provider payloads', () => {
  const input = { originalImage: { displayName: '较好-原图.png' }, sharp: { providerUsed: 'sharp', status: 'success', qualityScore: { score: 82, level: 'good' } } };
  const copy = structuredClone(input), cards = mattingCompareCards(input, t);
  assert.equal(mattingQualityLabel(input.sharp.qualityScore, t), 'Quality score: 82 / 100 (Good)');
  assert.equal(mattingQualityLabel(null, t), 'Quality score: unknown');
  assert.equal(cards[0].statusText, '较好-原图.png'); assert.deepEqual(input, copy);
  assert.match(mattingConfigNotice({ localAiAvailable: true }), /rembg/); assert.match(mattingImage2Notice({ localAiAvailable: true }), /rembg/);
});
test('generation approval uses sanitized destination, preserves task identifiers, and cancellation stays read-only', async () => {
  let reads = 0, dialogs = 0; const fake = { async getMattingConfig() { reads++; return { generationDestination: { origin: 'https://images.example' } }; } };
  const cancelled = await approveImageGeneration(fake, { taskId: '任务原文', count: 3, mattingProvider: 'image2' }, t, (message) => {
    dialogs++; assert.ok(message.includes('任务原文')); assert.ok(message.includes('https://images.example')); assert.ok(message.includes('failed calls')); assert.ok(message.includes('Image limit: 3')); return false;
  });
  assert.equal(cancelled, false); assert.equal(reads, 1); assert.equal(dialogs, 1);
  assert.equal(await approveImageGeneration(fake, { taskId: '任务原文' }, t, () => true), true);
  for (const origin of [null, 'https://user:secret@images.example', 'javascript:alert(1)', 'https://images.example/path?token=secret']) {
    fake.getMattingConfig = async () => ({ generationDestination: { origin } });
    await assert.rejects(approveImageGeneration(fake, { taskId: 'original' }, t, () => { throw new Error('must not confirm'); }), /Cannot verify/);
  }
});
test('image workflow static labels and confirmations are translated without changing editable business values', () => {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const files = ['src/pages/MattingPage.jsx', 'src/pages/ProductInfoPage.jsx', 'src/pages/ImagePlanPage.jsx', 'src/components/TextLayoutEditor.jsx'];
  const report = JSON.parse(execFileSync(process.execPath, ['scripts/localize-ui.mjs', '--check', '--expressions', ...files], { cwd: root, encoding: 'utf8' }));
  assert.equal(report.unlocalizedCount, 0); assert.equal(report.missingCount, 0);
  const plan = fs.readFileSync(new URL('../src/pages/ImagePlanPage.jsx', import.meta.url), 'utf8');
  assert.ok(plan.includes('value={draft.title}')); assert.ok(plan.includes('title: draft.title')); assert.ok(plan.includes("imageType: 'main_image'"));
  const text = fs.readFileSync(new URL('../src/components/TextLayoutEditor.jsx', import.meta.url), 'utf8'); assert.ok(text.includes('{item.text}')); assert.ok(!text.includes('t(item.text)'));
  const product = fs.readFileSync(new URL('../src/pages/ProductInfoPage.jsx', import.meta.url), 'utf8');
  const component = product.slice(product.indexOf('export default function ProductInfoPage'));
  assert.ok(component.indexOf('if (!task)') < component.indexOf('const sourceImages = task.sourceImages'));
  assert.ok(component.includes('data-product-retry')); assert.ok(component.includes('packageList: fromLines(toLines(draft.packageList))'));
  const matting = fs.readFileSync(new URL('../src/pages/MattingPage.jsx', import.meta.url), 'utf8');
  assert.ok(matting.includes('mattingSelectionFor(selectedTask, selectedImage?.id, adoptionResult)'));
  assert.ok(matting.includes('disabled={loading || Boolean(busy)} value={imageId}'));
});

test('adoption display binds both task and source image and can recover a saved selection after reload', () => {
  const saved = { sourceImageId: 'image-original', previewUrl: '/outputs/own.png' }, task = { id: 'own-task', mattingSelection: saved };
  assert.equal(mattingSelectionFor(task, 'image-original', null), saved);
  assert.equal(mattingSelectionFor(task, 'different-image', null), null);
  const foreign = { taskId: 'other-task', selection: { sourceImageId: 'image-original', previewUrl: '/outputs/foreign.png' } };
  assert.equal(mattingSelectionFor({ id: 'own-task' }, 'image-original', foreign), null);
  assert.equal(mattingSelectionFor(task, 'image-original', foreign), saved);
});

test('empty loading state never treats two missing image identifiers as an adopted result', () => {
  for (const task of [undefined, null, {}, { id: 'task-loading' }]) {
    for (const imageId of [undefined, null, '']) assert.equal(mattingSelectionFor(task, imageId, null), null);
  }
  assert.equal(mattingSelectionFor({ id: 'task-loading' }, 'image-1', null), null);
});
