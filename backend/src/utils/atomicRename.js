import fs from 'node:fs/promises';

// Never unlink the destination first. A permanent failure must retain both the
// published file and the prepared replacement for explicit recovery.
export async function atomicRename(source, destination, { rename = fs.rename, wait = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
  for (let attempt = 0; attempt < 8; attempt++) {
    try { return await rename(source, destination); }
    catch (error) {
      if (!['EPERM', 'EACCES', 'EBUSY'].includes(error.code) || attempt === 7) throw error;
      await wait(Math.min(100 * 2 ** attempt, 1000));
    }
  }
}
