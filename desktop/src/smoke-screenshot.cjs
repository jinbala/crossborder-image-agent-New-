const fs = require('node:fs/promises');
async function smokeScreenshot(window, filename, { selector } = {}) {
  if (selector) await window.webContents.executeJavaScript(`(()=>{const anchor=document.querySelector(${JSON.stringify(selector)});if(!anchor)throw new Error('Screenshot anchor not found');anchor.scrollIntoView({block:'center'});const rect=anchor.getBoundingClientRect();if(rect.bottom<=0||rect.top>=innerHeight)throw new Error('Screenshot anchor is outside the viewport');})()`);
  let lastError;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      // Use native capture for hidden compositor snapshots. A renderer rAF promise can
      // remain pending indefinitely in hidden test windows despite live timers.
      // Keep the outer step deadline and capture twice; only save the latest
      // actual frame, never substitute a timer or an empty image for a snapshot.
      const warmup = await window.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true });
      if (warmup.isEmpty()) throw new Error('Empty warmup screenshot');
      await new Promise(resolve => setTimeout(resolve, 200));
      const preview = await window.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true });
      if (preview.isEmpty()) throw new Error('Empty screenshot');
      await fs.writeFile(filename, preview.toPNG());
      return;
    } catch (error) { lastError = error; await new Promise(resolve => setTimeout(resolve, 300)); }
  }
  throw new Error(`Window screenshot failed after three attempts: ${lastError?.message}`);
}
module.exports = { smokeScreenshot };
