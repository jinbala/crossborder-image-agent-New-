import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  findForbiddenEntries,
  hasEntry,
  normalizeZipEntry
} from './validate-release-package.mjs';

test('normalizeZipEntry uses forward slashes and removes leading project folder', () => {
  assert.equal(normalizeZipEntry('crossborder-image-agent\\backend\\src\\app.js'), 'backend/src/app.js');
  assert.equal(normalizeZipEntry('/frontend/src/App.jsx'), 'frontend/src/App.jsx');
});

test('findForbiddenEntries flags runtime dependencies secrets and local data', () => {
  const entries = [
    'backend/node_modules/express/index.js',
    'frontend/node_modules/vite/bin/openChrome.applescript',
    '.env',
    'backend/.env',
    'frontend/.env',
    'backend/data/app.sqlite',
    'backend/data/app.sqlite-wal',
    'backend/data/app.sqlite-shm',
    'backend/data/db-before-sqlite-migration-20260601.json',
    'backend/data/snapshot-sqlite-test-abc/app.sqlite',
    'backend/test-results/vision-result.json',
    'uploads/source.png',
    'outputs/export.zip',
    'backups/backup.zip',
    '.vision-tmp/input.png',
    'frontend/dist/index.html',
    'backend/dev-server.log',
    'frontend/dev-server.err.log',
    'README.md'
  ];

  const forbidden = findForbiddenEntries(entries);
  assert.equal(forbidden.length, entries.length - 1);
  assert.equal(forbidden.some((item) => item.entry === 'README.md'), false);
});

test('hasEntry checks required release files without matching similarly named files', () => {
  const entries = ['README.md', '.env.example', 'backend/package-lock.json', 'frontend/package-lock.json'];
  assert.equal(hasEntry(entries, 'README.md'), true);
  assert.equal(hasEntry(entries, '.env.example'), true);
  assert.equal(hasEntry(entries, '.env'), false);
});
