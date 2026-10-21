const fs = require('node:fs/promises');
async function smokeScreenshot(window, filename) {
  let lastError;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const preview = await window.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true });
      if (preview.isEmpty()) throw new Error('Empty screenshot');
      await fs.writeFile(filename, preview.toPNG());
      return;
    } catch (error) { lastError = error; await new Promise(resolve => setTimeout(resolve, 300)); }
  }
  throw new Error(`Window screenshot failed after three attempts: ${lastError?.message}`);
}
module.exports = { smokeScreenshot };
