import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const files = [
  'src/pages/BatchPage.jsx',
  'src/services/api.js',
  'src/utils/importScan.js',
  'src/utils/batchWorkflowGuide.js',
  'src/pages/GeneratePage.jsx',
  'src/pages/ReviewPage.jsx'
];

const suspicious = [
  '\uFFFD',
  '\u93C8',
  '\u9428',
  '\u9422',
  '\u6D93',
  '\u93B5',
  '\u7EDB',
  '\u934F',
  '\u95C2',
  '\u00E5',
  '\u00E7',
  '\u00E4',
  '\uE0A3',
  '\uE62C',
  '\u952B',
  '\u9286',
  '\u20AC'
];

test('batch-facing frontend copy does not contain mojibake markers', () => {
  const matches = [];

  for (const file of files) {
    const content = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
    const lines = content.split(/\r?\n/);
    lines.forEach((line, index) => {
      if (suspicious.some((marker) => line.includes(marker))) {
        matches.push(`${file}:${index + 1}:${line.trim()}`);
      }
    });
  }

  assert.deepEqual(matches, []);
});
