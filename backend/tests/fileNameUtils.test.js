import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decodeOriginalFileName, getDisplayFileName, sanitizeStorageFileName } from '../src/utils/fileNameUtils.js';

test('decodes latin1-misread Chinese upload filenames', () => {
  const mojibake = Buffer.from('主图1.png', 'utf8').toString('latin1');
  assert.equal(decodeOriginalFileName(mojibake), '主图1.png');
});

test('keeps already readable Chinese upload filenames', () => {
  assert.equal(decodeOriginalFileName('尺寸图.png'), '尺寸图.png');
});

test('falls back when display filename is not readable', () => {
  assert.equal(getDisplayFileName('���.png', 1), '图片 2');
});

test('sanitizes storage filename while preserving extension', () => {
  const name = sanitizeStorageFileName('主图1.png', 'abc123');
  assert.match(name, /^abc123\.png$/);
});
