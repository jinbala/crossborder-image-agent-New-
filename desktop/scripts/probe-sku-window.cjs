// Narrow, owned-profile reproducer for the exact SKU UI smoke, with read-only
// Restart Manager diagnostics captured before the worker/window are stopped.
const { app, BrowserWindow, utilityProcess } = require('electron');
const fs = require('node:fs/promises'), fsSync = require('node:fs'), path = require('node:path');
const desktop = path.resolve(__dirname, '..'), profile = fsSync.mkdtempSync(path.join(desktop, '.smoke-data/sku-window-probe-')), dataRoot = path.join(profile, 'workspace');
const artifact = process.env.CROSSBORDER_PROBE_ASAR === '1' ? path.join(desktop, 'release/win-unpacked/resources/app.asar') : desktop;
app.setPath('userData', profile);
for (const flag of ['disable-background-timer-throttling', 'disable-renderer-backgrounding', 'disable-backgrounding-occluded-windows']) app.commandLine.appendSwitch(flag);
let worker, window, code = 1;
app.whenReady().then(async () => {
  await fs.mkdir(dataRoot);
  const token = require('node:crypto').randomBytes(32).toString('hex');
  const env = { ...process.env, PORT: '0', CROSSBORDER_DATA_ROOT: dataRoot, FRONTEND_DIST_DIR: path.join(artifact, 'runtime/frontend'), LOCAL_API_TOKEN: token, STORAGE_DRIVER: 'sqlite', SQLITE_DB_PATH: path.join(dataRoot, 'backend/data/app.sqlite'), AI_PROVIDER: 'mock', VISION_PROVIDER: 'mock', IMAGE_PROVIDER: 'mock', BACKGROUND_PROVIDER: 'mock', REVIEW_PROVIDER: 'mock', MATTING_PROVIDER: 'sharp', MATTING_FALLBACK_PROVIDER: 'sharp', OPENAI_API_KEY: '', GEMINI_API_KEY: '', QWEN_API_KEY: '', DASHSCOPE_API_KEY: '', MATTING_EXTERNAL_API_KEY: '', MATTING_API_KEY: '' }; delete env.ELECTRON_RUN_AS_NODE;
  worker = utilityProcess.fork(path.join(artifact, 'runtime/backend/src/server.js'), [], { env, stdio: 'pipe', serviceName: 'Owned SKU window probe' });
  worker.stderr?.on('data', data => process.stderr.write(data));
  const ready = await new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error('Probe service startup timeout')), 30000); worker.on('message', data => { if (data.type === 'ready') { clearTimeout(timer); resolve(data); } }); worker.once('exit', value => reject(new Error(`Probe worker exited ${value}`))); });
  const origin = `http://127.0.0.1:${ready.port}`;
  window = new BrowserWindow({ show: false, width: 1344, height: 835, useContentSize: true, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  await window.webContents.session.cookies.set({ url: origin, name: 'crossborder_local', value: token, httpOnly: true, secure: false, sameSite: 'strict', path: '/' });
  try {
    const checks = await require(path.join(artifact, 'src/sku-results-resume-smoke.cjs')).skuResultsResumeSmoke({ window, origin, dataRoot, requestApi: (route, options = {}) => fetch(origin + route, { ...options, headers: { 'x-local-token': token, ...options.headers } }) });
    code = Object.values(checks).every(Boolean) ? 0 : 1;
    const report = { ok: code === 0, profile: path.basename(profile), checks };
    await fs.writeFile(path.join(profile, 'probe-report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report));
  } catch (error) {
    const locks = [];
    for (const name of await fs.readdir(path.join(dataRoot, 'outputs/workbench')).catch(() => [])) {
      if (!/^sku-pack-\d+-[A-Za-z0-9_-]+$/.test(name)) continue;
      const target = path.join(dataRoot, 'outputs/workbench', name, `${name}.zip`);
      if (await fs.stat(target).catch(() => null)) locks.push({ id: name, ...(await require('../src/zip-lock-diagnostic.cjs').inspectSmokeZipLock(target).catch(error => ({ error: error.message }))) });
    }
    const report = { ok: false, profile: path.basename(profile), error: error.message, mainPid: process.pid, workerPid: worker.pid, rendererPid: window.webContents.getOSProcessId(), locks };
    await fs.writeFile(path.join(profile, 'probe-report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report));
  } finally {
    window.destroy();
    await new Promise(resolve => { const timer = setTimeout(() => { worker.kill(); resolve(); }, 6000); worker.once('exit', () => { clearTimeout(timer); resolve(); }); worker.postMessage({ type: 'shutdown' }); });
    app.exit(code);
  }
}).catch(error => { console.error(error); if (worker) worker.kill(); if (window) window.destroy(); app.exit(1); });
