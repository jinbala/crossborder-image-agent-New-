const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { inspectSmokeZipLock } = require('../src/zip-lock-diagnostic.cjs');

test('Windows smoke lock diagnostics identify the owned holder without stopping it', { skip: process.platform !== 'win32' }, async () => {
  const root = await fs.mkdtemp(path.join(__dirname, '../.smoke-data/zip-lock-detector-'));
  const file = path.join(root, 'fixture.zip'); await fs.writeFile(file, 'owned diagnostic fixture');
  const script = `$zipProbeStream=[IO.File]::Open('${file.replaceAll("'", "''")}',[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read);[Console]::WriteLine('held');[Console]::Out.Flush();[Console]::ReadLine()|Out-Null;$zipProbeStream.Dispose()`;
  const holder = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true });
  const exited = new Promise(resolve => holder.once('exit', resolve));
  try {
    await new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error('Owned lock holder startup timeout')), 5000); holder.stdout.once('data', () => { clearTimeout(timer); resolve(); }); holder.once('error', reject); });
    const result = await inspectSmokeZipLock(file);
    assert.equal(result.supported, true); assert.ok(result.processes.some(value => value.startsWith(`${holder.pid}:`)));
    assert.equal(holder.exitCode, null); // Query never closes or restarts holders.
    await assert.rejects(fs.rename(file, `${file}.moved`), error => ['EPERM', 'EBUSY', 'EACCES'].includes(error.code));
  } finally {
    holder.stdin.end('\n');
    const clean = await Promise.race([exited.then(() => true), new Promise(resolve => setTimeout(() => resolve(false), 5000))]);
    if (!clean) { holder.kill(); await exited; }
    await fs.rm(root, { recursive: true, force: true });
  }
  await assert.rejects(inspectSmokeZipLock(path.resolve(__dirname, '../package.json')), /owned smoke ZIP/);
});
