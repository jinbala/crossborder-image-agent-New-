const fs = require('node:fs/promises');
const { randomUUID } = require('node:crypto');

async function read(file) {
  let stat;
  try { stat = await fs.lstat(file); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 65536) return { invalid: true, rotate: true };
  const raw = await fs.readFile(file, 'utf8');
  try {
    const value = JSON.parse(raw);
    if (value.version !== 1 || !['running', 'stopped'].includes(value.state) || typeof value.runId !== 'string' || !value.runId || !Number.isFinite(Date.parse(value.startedAt))) throw new Error('INVALID_SESSION_STATE');
    return { raw, value };
  } catch { return { invalid: true, raw }; }
}

async function atomic(file, contents) {
  const temp = `${file}.tmp-${process.pid}-${randomUUID()}`;
  try {
    await fs.writeFile(temp, contents, { flag: 'wx' });
    for (let attempt = 0; ; attempt++) {
      try { await fs.rename(temp, file); break; }
      catch (error) {
        if (!['EPERM', 'EACCES', 'EBUSY'].includes(error.code) || attempt >= 4) throw error;
        await new Promise((resolve) => setTimeout(resolve, 25 * (attempt + 1)));
      }
    }
  } finally { await fs.rm(temp, { force: true }).catch(() => {}); }
}

// pendingRoute has already passed protocolRoute's allow-list validation.
function startupRoute(pendingRoute, interrupted) { return pendingRoute || (interrupted ? '/desktop' : '/workbench'); }

async function beginDesktopSession(file) {
  const previous = await read(file);
  if (previous?.rotate) await fs.rename(file, `${file}.previous`);
  else if (previous) await atomic(`${file}.previous`, previous.raw);
  const interrupted = Boolean(previous?.invalid || previous?.value?.state === 'running');
  const current = { version: 1, runId: randomUUID(), state: 'running', startedAt: new Date().toISOString() };
  await atomic(file, JSON.stringify(current));
  return {
    interrupted,
    async finish() {
      const active = await read(file);
      if (active?.value?.runId !== current.runId || active.value.state !== 'running') return false;
      await atomic(file, JSON.stringify({ ...current, state: 'stopped', finishedAt: new Date().toISOString() }));
      return true;
    }
  };
}

module.exports = { beginDesktopSession, startupRoute };
