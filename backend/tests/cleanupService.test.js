import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  getCleanupSummary,
  previewCleanup,
  runCleanup
} from '../src/services/cleanupService.js';

async function makeProject() {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'cia-cleanup-service-'));
  await fs.mkdir(path.join(projectRoot, '.vision-tmp'), { recursive: true });
  await fs.mkdir(path.join(projectRoot, 'backend', 'test-results'), { recursive: true });
  await fs.mkdir(path.join(projectRoot, 'outputs', 'task-1'), { recursive: true });
  await fs.mkdir(path.join(projectRoot, 'backups'), { recursive: true });
  await fs.mkdir(path.join(projectRoot, 'uploads'), { recursive: true });
  return projectRoot;
}

async function writeFile(projectRoot, relativePath, content = 'cleanup-data', daysOld = 40) {
  const filePath = path.join(projectRoot, relativePath);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content);
  const mtime = new Date(Date.now() - daysOld * 24 * 60 * 60 * 1000);
  await fs.utimes(filePath, mtime, mtime);
  return filePath;
}

async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

test('cleanup summary counts allowlisted runtime directories without deleting files', async () => {
  const projectRoot = await makeProject();
  const filePath = await writeFile(projectRoot, '.vision-tmp/probe.tmp', '12345');

  const summary = await getCleanupSummary({ projectRoot });

  assert.equal(summary.totalFiles >= 1, true);
  assert.equal(summary.groups.some((group) => group.groupName === 'visionTmp' && group.fileCount === 1 && group.bytes === 5), true);
  assert.equal(await exists(filePath), true);
});

test('cleanup preview filters by age and never deletes files', async () => {
  const projectRoot = await makeProject();
  const oldFile = await writeFile(projectRoot, '.vision-tmp/old.tmp', 'old-file', 40);
  const freshFile = await writeFile(projectRoot, '.vision-tmp/fresh.tmp', 'fresh-file', 1);

  const preview = await previewCleanup({ olderThanDays: 30, groups: ['visionTmp'] }, { projectRoot });

  assert.equal(preview.totalFiles, 1);
  assert.equal(preview.groups[0].files[0].relativePath, '.vision-tmp/old.tmp');
  assert.equal(await exists(oldFile), true);
  assert.equal(await exists(freshFile), true);
});

test('cleanup run requires confirm true', async () => {
  const projectRoot = await makeProject();
  await writeFile(projectRoot, '.vision-tmp/old.tmp', 'old-file', 40);

  await assert.rejects(
    () => runCleanup({ olderThanDays: 30, groups: ['visionTmp'] }, { projectRoot }),
    /confirm=true/
  );
});

test('cleanup run deletes only backend-selected allowlist candidates', async () => {
  const projectRoot = await makeProject();
  const deletableFile = await writeFile(projectRoot, '.vision-tmp/old.tmp', 'old-file', 40);
  const envFile = await writeFile(projectRoot, '.env', 'SECRET=do-not-read', 40);
  const sqliteFile = await writeFile(projectRoot, 'backend/data/app.sqlite', 'sqlite', 40);
  const sourceFile = await writeFile(projectRoot, 'backend/src/server.js', 'console.log(1)', 40);

  const result = await runCleanup({
    olderThanDays: 30,
    groups: ['visionTmp'],
    files: ['../../.env', '.env', 'backend/data/app.sqlite', 'backend/src/server.js'],
    confirm: true
  }, { projectRoot });

  assert.equal(result.deletedFiles, 1);
  assert.equal(await exists(deletableFile), false);
  assert.equal(await exists(envFile), true);
  assert.equal(await exists(sqliteFile), true);
  assert.equal(await exists(sourceFile), true);
});

test('cleanup preview blocks traversal and protected files even inside allowlisted directories', async () => {
  const projectRoot = await makeProject();
  await writeFile(projectRoot, '.vision-tmp/.env', 'SECRET=hidden', 40);
  await writeFile(projectRoot, '.vision-tmp/generated.js', 'console.log(1)', 40);

  const preview = await previewCleanup({ olderThanDays: 30, groups: ['visionTmp'] }, { projectRoot });

  assert.equal(preview.totalFiles, 2);
  assert.equal(preview.groups[0].files.every((file) => file.deletable === false), true);
  assert.equal(preview.groups[0].files.some((file) => /受保护/.test(file.reason)), true);
});

test('orphan uploads are risky and not deleted by default', async () => {
  const projectRoot = await makeProject();
  const uploadFile = await writeFile(projectRoot, 'uploads/orphan.jpg', 'image', 40);

  const preview = await previewCleanup({ olderThanDays: 30, groups: ['orphanUploads'] }, { projectRoot });
  const result = await runCleanup({ olderThanDays: 30, groups: ['orphanUploads'], confirm: true }, { projectRoot });

  assert.equal(preview.groups[0].files[0].riskLevel, 'risky');
  assert.equal(preview.groups[0].files[0].deletable, false);
  assert.equal(result.deletedFiles, 0);
  assert.equal(result.skippedFiles, 1);
  assert.equal(await exists(uploadFile), true);
});

test('cleanup run records delete errors and continues with remaining files', async () => {
  const projectRoot = await makeProject();
  const first = await writeFile(projectRoot, '.vision-tmp/first.tmp', 'first', 40);
  const second = await writeFile(projectRoot, '.vision-tmp/second.tmp', 'second', 40);
  let calls = 0;

  const result = await runCleanup(
    { olderThanDays: 30, groups: ['visionTmp'], confirm: true },
    {
      projectRoot,
      removeFile: async (filePath) => {
        calls += 1;
        if (filePath.endsWith('first.tmp')) throw new Error('locked file');
        await fs.rm(filePath, { force: true });
      }
    }
  );

  assert.equal(calls, 2);
  assert.equal(result.deletedFiles, 1);
  assert.equal(result.errors.length, 1);
  assert.equal(await exists(first), true);
  assert.equal(await exists(second), false);
});

test('cleanup run deletes overlapping group candidates only once', async () => {
  const projectRoot = await makeProject();
  const mockFile = await writeFile(projectRoot, 'outputs/task-1/mock-subject.png', 'mock-image', 40);

  const result = await runCleanup({
    olderThanDays: 30,
    groups: ['oldOutputs', 'oldMockImages'],
    confirm: true
  }, { projectRoot });

  assert.equal(result.deletedFiles, 1);
  assert.equal(result.deletedBytes, 'mock-image'.length);
  assert.equal(await exists(mockFile), false);
});
