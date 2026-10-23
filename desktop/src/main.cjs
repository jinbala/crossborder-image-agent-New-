const { app, BrowserWindow, ipcMain, dialog, shell, Menu, Tray, nativeImage, utilityProcess, safeStorage } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { randomBytes } = require('node:crypto');
const { spawn } = require('node:child_process');
const { runtimeDirectories, redact, sanitizeValue, createToken, canNavigate, protocolRoute, filterLog, prepareExtension } = require('./runtime.cjs');
const { createCloudSync } = require('./cloud-sync.cjs');
const { createUpdater } = require('./update-service.cjs');
const { beginDesktopSession, startupRoute } = require('./session-state.cjs');

const smoke = process.argv.includes('--smoke-test');
const recoveryProbe = smoke && process.argv.includes('--smoke-recovery-probe');
const secondary = process.argv.includes('--smoke-secondary');
const rootArgument = process.argv.find((arg) => arg.startsWith('--smoke-root='));
app.setName('CrossborderWorkbench');
if (smoke || secondary) app.setPath('userData', rootArgument?.slice('--smoke-root='.length) || path.join(__dirname, '..', '.smoke-data'));
app.setAppUserModelId('cn.crossborder.imageworkbench');
const ownsLock = app.requestSingleInstanceLock();
if (!ownsLock) app.quit();

let window;
let tray;
let child;
let origin;
let quitting = false;
let stopping = false;
let logQueue = Promise.resolve();
let secondInstances = 0;
let pendingRoute = process.argv.map(protocolRoute).find(Boolean);
const token = createToken();
const dataRoot = path.join(app.getPath('userData'), 'workspace');
const directories = runtimeDirectories(dataRoot);
const runtime = path.join(app.getAppPath(), 'runtime');
const grantedDirectories = new Set();
const privateRoots = [app.getPath('userData'), os.homedir(), app.getAppPath()];
const cloudSync = createCloudSync({ directory: path.join(dataRoot, 'sync'), secureStorage: safeStorage,
  exportLocal: async () => (await requestApi('/api/platform/sync-export')).json() });
let updater;
let extensionDirectory;
let desktopSession;

function log(message) {
  const line = `${new Date().toISOString()} ${redact(message, privateRoots)}\n`;
  logQueue = logQueue.then(async () => {
    const file = path.join(directories.logs, 'desktop.log');
    const stat = await fs.stat(file).catch(() => null);
    if (stat?.size > 2 * 1024 * 1024) await fs.rename(file, `${file}.previous`).catch(() => {});
    await fs.appendFile(file, line);
  }).catch(() => {});
  return logQueue;
}

function showWindow() {
  if (!window || window.isDestroyed()) return;
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
}

app.on('second-instance', (_event, argv) => {
  secondInstances += 1;
  const route = argv.map(protocolRoute).find(Boolean);
  if (route && window && origin) window.loadURL(`${origin}${route}`);
  else if (route) pendingRoute = route;
  showWindow(); log('已有实例已激活');
});

async function startService() {
  await log('启动本地任务服务');
  const env = { ...process.env, PORT: '0', CROSSBORDER_DATA_ROOT: dataRoot,
    FRONTEND_DIST_DIR: path.join(runtime, 'frontend'), LOCAL_API_TOKEN: token,
    STORAGE_DRIVER: 'sqlite', SQLITE_DB_PATH: path.join(directories.data, 'app.sqlite'),
    U2NET_HOME: directories.models, APP_DESKTOP_VERSION: app.getVersion() };
  if (smoke) Object.assign(env, { AI_PROVIDER: 'mock', VISION_PROVIDER: 'mock', IMAGE_PROVIDER: 'mock', BACKGROUND_PROVIDER: 'mock', REVIEW_PROVIDER: 'mock', MATTING_PROVIDER: 'sharp', MATTING_FALLBACK_PROVIDER: 'sharp',
    OPENAI_API_KEY: '', GEMINI_API_KEY: '', QWEN_API_KEY: '', DASHSCOPE_API_KEY: '', MATTING_EXTERNAL_API_KEY: '', MATTING_API_KEY: '' });
  delete env.ELECTRON_RUN_AS_NODE;
  const mattingRuntime = await fs.readFile(path.join(dataRoot, 'matting-runtime.json'), 'utf8').then(JSON.parse).catch(() => null);
  if (mattingRuntime?.command && mattingRuntime?.models && path.isAbsolute(mattingRuntime.command) && path.basename(mattingRuntime.command).toLowerCase() === 'rembg.exe' && path.isAbsolute(mattingRuntime.models)) {
    env.REMBG_COMMAND = mattingRuntime.command; env.REMBG_HOME = mattingRuntime.models; env.U2NET_HOME = mattingRuntime.models;
  }
  const service = utilityProcess.fork(path.join(runtime, 'backend', 'src', 'server.js'), [], {
    env, stdio: 'pipe', serviceName: '图片工作台本地服务'
  });
  child = service;
  service.stdout?.on('data', (chunk) => log(chunk.toString()));
  service.stderr?.on('data', (chunk) => log(chunk.toString()));
  const ready = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('本地服务启动超时，请查看客户端日志')), 30000);
    service.on('message', (message) => {
      if (message?.type === 'ready') { clearTimeout(timer); resolve(message); }
      if (message?.type === 'error') { clearTimeout(timer); reject(new Error(`本地服务启动失败：${message.code}`)); }
    });
    service.once('exit', (code) => { clearTimeout(timer); reject(new Error(`本地服务在启动时退出（${code}）`)); });
  }).catch((error) => { service.kill(); throw error; });
  origin = `http://127.0.0.1:${ready.port}`;
  service.once('exit', (code) => {
    log(`本地服务已退出，状态 ${code}`);
    if (!quitting && !stopping && !smoke) {
      dialog.showMessageBox(window, { type: 'error', title: '本地服务已中断',
        message: '任务恢复点已保留。请重新启动本地服务。', buttons: ['重启服务', '退出'], defaultId: 0 })
        .then(({ response }) => response === 0 ? restartService().catch(showError) : app.quit());
    }
  });
  return origin;
}

async function stopService() {
  if (!child) return;
  const service = child;
  child = null;
  stopping = true;
  await new Promise((resolve) => {
    const timer = setTimeout(() => { service.kill(); resolve(); }, 6000);
    service.once('exit', () => { clearTimeout(timer); resolve(); });
    try { service.postMessage({ type: 'shutdown' }); } catch { clearTimeout(timer); resolve(); }
  });
  stopping = false;
}

async function setSessionCookie() {
  // Clear the previous per-port session; never place the secret in a URL or renderer storage.
  await window.webContents.session.cookies.set({
    url: origin, name: 'crossborder_local', value: token,
    httpOnly: true, secure: false, sameSite: 'strict', path: '/'
  });
}

async function restartService() {
  await stopService();
  await startService();
  await setSessionCookie();
  await window.loadURL(`${origin}/desktop`);
  return { ok: true };
}

function showError(error) {
  log(error?.stack || error);
  if (!smoke) dialog.showErrorBox('客户端启动失败', `${redact(error?.message || error, privateRoots)}\n可在应用数据目录的 logs 中查看详情。`);
}

async function requestApi(url, options = {}) {
  const response = await fetch(`${origin}${url}`, { ...options, headers: { 'x-local-token': token, ...options.headers }, signal: options.signal || AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error(`本地请求失败（${response.status}）`);
  return response;
}

async function readLog(query = {}) {
  await logQueue;
  const handle = await fs.open(path.join(directories.logs, 'desktop.log'), 'r').catch(() => null);
  if (!handle) return '';
  try {
    const stat = await handle.stat();
    const buffer = Buffer.alloc(Math.min(stat.size, 128 * 1024));
    await handle.read(buffer, 0, buffer.length, Math.max(0, stat.size - buffer.length));
    return filterLog(redact(buffer.toString('utf8'), privateRoots), query);
  } finally { await handle.close(); }
}

async function supportPackage(destination) {
  const AdmZip = require('adm-zip');
  const archive = new AdmZip();
  let health;
  try { health = await (await requestApi('/api/health/full')).json(); } catch (error) { health = { error: error.message }; }
  archive.addFile('environment.json', Buffer.from(JSON.stringify({
    version: app.getVersion(), platform: process.platform, arch: process.arch,
    versions: process.versions, generatedAt: new Date().toISOString(),
    health: sanitizeValue(health, privateRoots)
  }, null, 2)));
  archive.addFile('desktop.log', Buffer.from(await readLog()));
  try {
    const summary = await (await requestApi('/api/desktop/runtime')).json();
    archive.addFile('task-summary.json', Buffer.from(JSON.stringify(sanitizeValue(summary, privateRoots), null, 2)));
  } catch { /* A stopped service must not prevent exporting its diagnostic log. */ }
  await new Promise((resolve, reject) => archive.writeZip(destination, (error) => error ? reject(error) : resolve()));
  return { saved: true, fileName: path.basename(destination) };
}

function registerBridge() {
  const handle = (name, fn) => ipcMain.handle(`desktop:${name}`, async (event, ...args) => {
    if (!window || event.sender !== window.webContents || !canNavigate(event.senderFrame?.url || '', origin)) throw new Error('未授权的客户端页面');
    return fn(...args);
  });
  handle('info', () => ({ version: app.getVersion(), dataRoot, directories, serviceUrl: origin,
    platform: process.platform, packaged: app.isPackaged, running: Boolean(child),
    extensionDirectory, startupRecovery: Boolean(desktopSession?.interrupted) }));
  handle('choose-directory', async () => {
    const result = await dialog.showOpenDialog(window, { title: '选择 SKU 图片根目录', properties: ['openDirectory'] });
    if (result.canceled) return null;
    const selected = await fs.realpath(result.filePaths[0]);
    grantedDirectories.add(selected);
    return selected;
  });
  handle('open-directory', async (key) => {
    const selected = key === 'extension' ? extensionDirectory : directories[key];
    if (!selected) throw new Error('不支持打开此目录');
    const error = await shell.openPath(selected);
    if (error) throw new Error('打开目录失败');
    return { ok: true };
  });
  handle('read-log', readLog);
  handle('export-support', async () => {
    const result = await dialog.showSaveDialog(window, { title: '导出脱敏诊断包', defaultPath: `workbench-support-${Date.now()}.zip`, filters: [{ name: 'ZIP', extensions: ['zip'] }] });
    if (result.canceled) return { saved: false };
    return supportPackage(result.filePath);
  });
  handle('restart-service', restartService);
  handle('cloud-info', () => cloudSync.info());
  handle('cloud-connect', (input) => cloudSync.connect(input));
  handle('cloud-sync', () => cloudSync.synchronize());
  handle('cloud-resolve', (id, choice) => cloudSync.resolve(id, choice));
  handle('cloud-disconnect', () => cloudSync.disconnect());
  handle('configure-rembg', async () => {
    const executable = await dialog.showOpenDialog(window, { title: '选择已安装的 rembg.exe（不会下载模型）', properties: ['openFile'], filters: [{ name: 'rembg', extensions: ['exe'] }] });
    if (executable.canceled) return { cancelled: true };
    const command = await fs.realpath(executable.filePaths[0]);
    if (path.basename(command).toLowerCase() !== 'rembg.exe') throw new Error('请选择 Python 虚拟环境 Scripts 目录中的 rembg.exe');
    const folder = await dialog.showOpenDialog(window, { title: '选择模型根目录（需要另行确认模型许可）', defaultPath: directories.models, properties: ['openDirectory'] });
    if (folder.canceled) return { cancelled: true };
    const models = await fs.realpath(folder.filePaths[0]);
    const approval = await dialog.showMessageBox(window, { type: 'question', title: '保存本地抠图环境', message: '确认保存所选依赖和模型目录，并重启本地服务？请先暂停任务。此操作不下载模型、不代表同意模型许可。', detail: `${command}\n${models}`, buttons: ['取消', '保存并重启'], defaultId: 0, cancelId: 0 });
    if (approval.response !== 1) return { cancelled: true };
    await fs.writeFile(path.join(dataRoot, 'matting-runtime.json'), JSON.stringify({ command, models }));
    return restartService();
  });
  handle('update-info', () => updater.info());
  handle('update-check', () => updater.check());
  handle('update-stage', () => updater.stage());
  handle('update-import', async () => {
    const manifest = await dialog.showOpenDialog(window, { title: '导入当前版本的发布者签名清单', properties: ['openFile'], filters: [{ name: '签名清单', extensions: ['json'] }] });
    if (manifest.canceled) return updater.info();
    const installer = await dialog.showOpenDialog(window, { title: '选择与签名清单匹配的安装包（仅校验，不执行）', properties: ['openFile'], filters: [{ name: 'Windows 安装包', extensions: ['exe'] }] });
    return installer.canceled ? updater.info() : updater.importPackage(manifest.filePaths[0], installer.filePaths[0]);
  });
  handle('update-install', async (version) => {
    const installer = await updater.readyToInstall(version);
    const approval = await dialog.showMessageBox(window, { type: 'question', title: '安装已验证版本', message: `确认安装版本 ${version}？请先暂停任务。安装前会安全退出工作台；用户图片与输出不删除。`, detail: '回退旧版本同样需要已签名且散列校验通过的历史安装包。', buttons: ['稍后', '安装并退出'], defaultId: 0, cancelId: 0 });
    if (approval.response !== 1) return { cancelled: true };
    await updater.readyToInstall(version);
    await new Promise((resolve, reject) => { const process = spawn(installer, [], { detached: true, stdio: 'ignore', windowsHide: false }); process.once('error', reject); process.once('spawn', () => { process.unref(); resolve(); }); });
    app.quit(); return { started: true };
  });
  handle('import-directory', async (candidate) => {
    if (typeof candidate !== 'string' || candidate.length > 32768) throw new Error('无效目录');
    const selected = await fs.realpath(candidate);
    if (!(await fs.stat(selected)).isDirectory()) throw new Error('请选择文件夹');
    if (!grantedDirectories.has(selected)) {
      const result = await dialog.showMessageBox(window, { type: 'question', title: '导入图片目录',
        message: '将读取此目录中的 SKU 子文件夹和商品图片。', detail: selected, buttons: ['取消', '导入'], defaultId: 0, cancelId: 0 });
      if (result.response !== 1) return { cancelled: true };
      grantedDirectories.add(selected);
    }
    const response = await requestApi('/api/batches/import-folder', { method: 'POST',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ folderPath: selected, name: path.basename(selected) }) });
    return response.json();
  });
}

async function createWindow() {
  window = new BrowserWindow({
    width: 1360, height: 900, minWidth: 1024, minHeight: 680, show: false,
    title: '跨境图片工作台', backgroundColor: '#f8fafc',
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), nodeIntegration: false, contextIsolation: true, sandbox: true }
  });
  // Hidden UI probes need foreground-equivalent frames/timers. Production keeps
  // Electron's default background throttling; this does not change user windows.
  if (smoke) window.webContents.setBackgroundThrottling(false);
  if (smoke) window.webContents.on('will-prevent-unload', () => log('自动验收导航触发未保存警告；未自动绕过'));
  await setSessionCookie();
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event, url) => { if (!canNavigate(url, origin)) event.preventDefault(); });
  window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  window.webContents.session.setPermissionCheckHandler(() => false);
  window.webContents.on('render-process-gone', (_event, details) => {
    log(`界面进程退出：${details.reason}`);
    if (!quitting && !smoke) dialog.showMessageBox(window, { message: '界面已中断，任务恢复点已保留。', buttons: ['重新打开'] }).then(() => window.loadURL(`${origin}/desktop`));
  });
  window.on('close', (event) => { if (!quitting && tray && !smoke) { event.preventDefault(); window.hide(); } });
  await window.loadURL(`${origin}${startupRoute(pendingRoute, desktopSession?.interrupted)}`);
  if (!smoke) showWindow();
}

async function createTray() {
  const png = await require('sharp')(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="32" height="32" rx="7" fill="#0f766e"/><path d="M7 9h18v14H7z" fill="none" stroke="white" stroke-width="2"/><path d="m8 22 6-7 4 4 3-3 4 6" fill="none" stroke="white" stroke-width="2"/></svg>')).png().toBuffer();
  const icon = nativeImage.createFromBuffer(png);
  tray = new Tray(icon);
  tray.setToolTip('跨境图片工作台：本地服务运行中');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '打开工作台', click: showWindow },
    { label: '客户端与恢复任务', click: () => { window.loadURL(`${origin}/desktop`); showWindow(); } },
    { label: '暂停全部批量队列', click: async () => {
      try { await requestApi('/api/desktop/pause-all', { method: 'POST' }); await log('批量队列已请求暂停'); } catch (error) { showError(error); }
    } },
    { type: 'separator' }, { label: '退出', click: () => app.quit() }
  ]));
  tray.on('double-click', showWindow);
}

async function runSmoke() {
  const checks = {};
  checks.smokeRendererForegroundFrames = window.webContents.getBackgroundThrottling() === false && await window.webContents.executeJavaScript(`new Promise(resolve=>{const start=performance.now();requestAnimationFrame(()=>requestAnimationFrame(()=>resolve(performance.now()-start<2000)));})`);
  const step = (name, run, timeoutMs) => require('./smoke-step.cjs').smokeStep({ profileRoot: app.getPath('userData'), name, run, timeoutMs });
  const health = await (await fetch(`${origin}/api/health`)).json();
  checks.health = health.ok === true;
  checks.collectionRequestCapability = health.capabilities?.collectionRequestIdempotency === 1 && typeof health.capabilities?.collectionCreationEpoch === 'string';
  checks.unauthenticatedBlocked = (await fetch(`${origin}/api/tasks`)).status === 401;
  checks.foreignOriginBlocked = (await fetch(`${origin}/api/tasks`, { headers: { origin: 'https://example.org', 'x-local-token': token } })).status === 403;
  checks.renderer = await window.webContents.executeJavaScript('document.body.innerText.includes("运营工作台") && typeof window.desktop.info === "function" && typeof window.require === "undefined"');
  checks.cookieHidden = await window.webContents.executeJavaScript('!document.cookie.includes("crossborder_local")');
  checks.nativeSqlite = (await (await requestApi('/api/storage/status')).json()).storageDriver === 'sqlite';
  const code = await (await requestApi('/api/desktop/pairing-code', { method: 'POST' })).json();
  const extensionOrigin = `chrome-extension://${'a'.repeat(32)}`;
  const paired = await fetch(`${origin}/api/desktop/pair`, { method: 'POST', headers: { 'Content-Type': 'application/json', origin: extensionOrigin }, body: JSON.stringify({ code: code.code }) });
  const connection = await paired.json();
  const collectionRequest = { clientRequestId: `smoke-${randomBytes(16).toString('hex')}`, creationEpoch: health.capabilities?.collectionCreationEpoch, rows: [{ sku: 'PAIR-SMOKE', imageUrls: ['https://img.example/smoke.png'] }] };
  const collectionHeaders = { 'Content-Type': 'application/json', origin: extensionOrigin, 'x-workbench-token': connection.accessToken };
  const collected = await fetch(`${origin}/api/workbench/collection-jobs/rows`, { method: 'POST', headers: collectionHeaders, body: JSON.stringify(collectionRequest) });
  const collectionJob = await collected.json();
  checks.extensionPairing = paired.status === 200 && collected.status === 201;
  const replayResponse = await fetch(`${origin}/api/workbench/collection-jobs/rows`, { method: 'POST', headers: collectionHeaders, body: JSON.stringify(collectionRequest) });
  const replayJob = await replayResponse.json();
  checks.collectionRequestReplay = replayResponse.status === 200 && replayJob.id === collectionJob.id && replayJob.creation?.replayed === true;
  checks.collectionRequestConflict = (await fetch(`${origin}/api/workbench/collection-jobs/rows`, { method: 'POST', headers: collectionHeaders, body: JSON.stringify({ ...collectionRequest, options: { minSales: 999 } }) })).status === 409;
  checks.extensionLoadableDirectory = !extensionDirectory.includes('.asar') && JSON.parse(await fs.readFile(path.join(extensionDirectory, 'manifest.json'), 'utf8')).manifest_version === 3;
  checks.extensionScope = (await fetch(`${origin}/api/tasks`, { headers: { origin: extensionOrigin, 'x-workbench-token': connection.accessToken } })).status === 403;
  const image = await require('sharp')({ create: { width: 30, height: 20, channels: 3, background: '#ffffff' } }).png().toBuffer();
  const form = new FormData();
  form.append('images', new Blob([image], { type: 'image/png' }), '测试图.png');
  const pack = await (await requestApi('/api/workbench/image-packs', { method: 'POST', body: form })).json();
  const zip = await requestApi(pack.downloadUrl);
  checks.imagePack = zip.status === 200 && Buffer.from(await zip.arrayBuffer()).subarray(0, 2).toString() === 'PK';
  const childEnv = { ...process.env }; delete childEnv.ELECTRON_RUN_AS_NODE;
  await new Promise((resolve, reject) => {
    const secondaryProcess = spawn(process.execPath, [app.getAppPath(), '--smoke-secondary', `--smoke-root=${app.getPath('userData')}`], { windowsHide: true, env: childEnv, stdio: 'ignore' });
    const timer = setTimeout(() => { secondaryProcess.kill(); reject(new Error('单实例测试超时')); }, 10000);
    secondaryProcess.once('exit', () => { clearTimeout(timer); resolve(); });
    secondaryProcess.once('error', reject);
  });
  checks.singleInstance = secondInstances > 0;
  const draftContext = await (await requestApi('/api/workbench/collection-drafts')).json();
  const stagedDraft = await (await requestApi('/api/workbench/collection-drafts/rows', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ expectedActorId: draftContext.actorId, generation: draftContext.generation, rows: [{ productUrl: 'https://shop.example/port-recovery' }], options: { name: '端口变更恢复验证' } }) })).json();
  checks.collectionDraftStaged = Boolean(stagedDraft.draft?.id) && stagedDraft.draft?.jobId === null;
  const oldOrigin = origin;
  await restartService();
  const restartedCollectionResponse = await requestApi('/api/workbench/collection-jobs/rows', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(collectionRequest) });
  const restartedCollection = await restartedCollectionResponse.json();
  checks.collectionRequestRestart = restartedCollectionResponse.status === 200 && restartedCollection.id === collectionJob.id && restartedCollection.creation?.durable === true;
  checks.restarted = (await (await requestApi('/api/workbench/jobs')).json()).some((job) => job.id === pack.id);
  checks.oldServiceStopped = await fetch(`${oldOrigin}/api/health`).then(() => false, () => true);
  checks.desktopRuntimeLoaded = false;
  for (let i = 0; i < 30; i++) {
    if (await window.webContents.executeJavaScript(`document.body.innerText.includes(${JSON.stringify(`Windows 客户端 v${app.getVersion()}`)}) && !document.body.innerText.includes("存储：读取中")`)) { checks.desktopRuntimeLoaded = true; break; }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  checks.desktopPage = await window.webContents.executeJavaScript('document.body.innerText.includes("客户端与恢复")');
  checks.previewScreenshot = false;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      window.webContents.invalidate();
      await new Promise((resolve) => setTimeout(resolve, 250));
      const preview = await window.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true });
      if (preview.isEmpty()) continue;
      await fs.writeFile(path.join(app.getPath('userData'), 'desktop-preview.png'), preview.toPNG());
      checks.previewScreenshot = true; break;
    } catch (error) { await log(`验收截图暂不可用（${attempt + 1}/3）：${error.message}`); }
  }
  checks.supportExport = (await supportPackage(path.join(dataRoot, 'support-smoke.zip'))).saved;
  Object.assign(checks, await step('collection-draft', () => require('./collection-draft-smoke.cjs').collectionDraftSmoke({ window, origin, requestApi, draftId: stagedDraft.draft.id, dataRoot })));
  Object.assign(checks, await step('workspace', () => require('./workspace-smoke.cjs').workspaceSmoke({ window, origin, runtime, dataRoot, requestApi, cloudSync })));
  Object.assign(checks, await step('maintenance', () => require('./maintenance-smoke.cjs').maintenanceSmoke({ window, origin, dataRoot, requestApi })));
  Object.assign(checks, await step('image-workflow', () => require('./image-workflow-smoke.cjs').imageWorkflowSmoke({ window, origin, dataRoot, requestApi })));
  Object.assign(checks, await step('task-operations', () => require('./task-operations-smoke.cjs').taskOperationsSmoke({ window, origin, dataRoot, requestApi })));
  Object.assign(checks, await step('legacy-workflow', () => require('./legacy-workflow-smoke.cjs').legacyWorkflowSmoke({ window, origin, dataRoot, requestApi })));
  Object.assign(checks, await step('acceptance-workspace', () => require('./acceptance-workspace-smoke.cjs').acceptanceWorkspaceSmoke({ window, origin, dataRoot, requestApi, restartService: async () => { await restartService(); return origin; } })));
  Object.assign(checks, await step('batch-reports-i18n', () => require('./batch-reports-i18n-smoke.cjs').batchReportsI18nSmoke({ window, origin, dataRoot, requestApi })));
  Object.assign(checks, await step('export-integrity', () => require('./export-integrity-smoke.cjs').exportIntegritySmoke({ window, origin, dataRoot, requestApi })));
  Object.assign(checks, await step('target-export', () => require('./target-export-smoke.cjs').targetExportSmoke({ window, origin, dataRoot, requestApi })));
  Object.assign(checks, await step('export-reports-i18n', () => require('./export-reports-i18n-smoke.cjs').exportReportsI18nSmoke({ window, origin, dataRoot, requestApi })));
  Object.assign(checks, await step('receiving-workflow', () => require('./receiving-workflow-smoke.cjs').receivingWorkflowSmoke({ window, origin, dataRoot, requestApi })));
  Object.assign(checks, await step('workbench-snapshot', () => require('./workbench-snapshot-smoke.cjs').workbenchSnapshotSmoke({ window, origin, dataRoot, requestApi })));
  Object.assign(checks, await step('cold-recovery', () => require('./cold-recovery-smoke.cjs').coldRecoverySmoke({ dataRoot, requestApi, executable: process.execPath, appPath: app.getAppPath(), packaged: app.isPackaged, version: app.getVersion() }), 180000));
  const report = { ok: Object.values(checks).every(Boolean), version: app.getVersion(), packaged: app.isPackaged, checks };
  await fs.writeFile(path.join(app.getPath('userData'), 'smoke-report.json'), JSON.stringify(report, null, 2));
  await log(JSON.stringify(report));
  app.exitCode = report.ok ? 0 : 1;
  app.quit();
}

app.on('before-quit', (event) => {
  if (!ownsLock) return;
  event.preventDefault();
  if (quitting) return;
  quitting = true;
  const stopped = child ? requestApi('/api/desktop/pause-all', { method: 'POST', signal: AbortSignal.timeout(1500) }).catch(() => {}).then(stopService) : Promise.resolve();
  stopped.finally(async () => {
    if (desktopSession) await desktopSession.finish().catch((error) => log(`保存退出状态失败：${error.message}`));
    await logQueue; tray?.destroy(); app.exit(app.exitCode || 0);
  });
});
app.on('window-all-closed', () => { if (!tray && !smoke) app.quit(); });

if (ownsLock) app.whenReady().then(async () => {
  const updateConfig = await fs.readFile(path.join(app.getAppPath(), 'src', 'update-trust.json'), 'utf8').then(JSON.parse).catch(() => ({}));
  updater = createUpdater({ directory: path.join(dataRoot, 'updates'), config: updateConfig, currentVersion: app.getVersion() });
  if (app.isPackaged && !smoke && !secondary) app.setAsDefaultProtocolClient('crossborder-workbench');
  await Promise.all(Object.values(directories).map((directory) => fs.mkdir(directory, { recursive: true })));
  desktopSession = await beginDesktopSession(path.join(app.getPath('userData'), 'desktop-session.json'));
  extensionDirectory = await prepareExtension(path.join(runtime, 'browser-extension', 'temu-deep-collector'), dataRoot);
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: '工作台', submenu: [{ label: '客户端与恢复任务', click: () => window.loadURL(`${origin}/desktop`) }, { type: 'separator' }, { role: 'quit', label: '退出' }] },
    { label: '编辑', submenu: [{ role: 'undo', label: '撤销' }, { role: 'redo', label: '重做' }, { type: 'separator' }, { role: 'cut', label: '剪切' }, { role: 'copy', label: '复制' }, { role: 'paste', label: '粘贴' }, { role: 'selectAll', label: '全选' }] },
    { label: '视图', submenu: [{ role: 'reload', label: '刷新' }, { role: 'resetZoom', label: '实际大小' }, { role: 'zoomIn', label: '放大' }, { role: 'zoomOut', label: '缩小' }] }
  ]));
  registerBridge();
  await startService();
  await createWindow();
  if (!smoke) await createTray();
  if (recoveryProbe) {
    const report = await require('./cold-recovery-smoke.cjs').runRecoveryProbe({ window, dataRoot, requestApi, startupRecovery: desktopSession.interrupted, version: app.getVersion(), packaged: app.isPackaged });
    app.exitCode = report.ok ? 0 : 1; app.quit();
  } else if (smoke) await runSmoke();
}).catch(async (error) => {
  showError(error);
  if (smoke) await fs.writeFile(path.join(app.getPath('userData'), 'smoke-report.json'), JSON.stringify({ ok: false, version: app.getVersion(), packaged: app.isPackaged, error: redact(error.stack || error.message, privateRoots) }, null, 2)).catch(() => {});
  await stopService(); await logQueue; app.exit(1);
});
