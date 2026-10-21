const { BrowserWindow, utilityProcess } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomBytes } = require('node:crypto');

async function pageCheck(window, origin, route, heading) {
  await window.loadURL(`${origin}${route}`);
  for (let attempt = 0; attempt < 50; attempt++) {
    const ready = await window.webContents.executeJavaScript(`Boolean(document.querySelector('h1')?.innerText.includes(${JSON.stringify(heading)}))`);
    if (ready) {
      await new Promise((resolve) => setTimeout(resolve, 200));
      const errors = await window.webContents.executeJavaScript(`Array.from(document.querySelectorAll('[role="alert"]')).map((node) => node.innerText).filter(Boolean)`);
      if (errors.length) throw new Error(`页面 ${route} 检查失败：${errors.join('；')}`);
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`页面 ${route} 未加载：${heading}`);
}

async function waitForUi(window, expression) {
  for (let attempt = 0; attempt < 50; attempt++) {
    if (await window.webContents.executeJavaScript(expression)) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('界面语言切换验收超时');
}
async function selectLanguage(window, locale) {
  await window.webContents.executeJavaScript(`(() => { const select = document.querySelector('select[aria-label="Interface language / 界面语言"]'); if (!select) throw new Error('Language selector missing'); select.value = ${JSON.stringify(locale)}; select.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  await waitForUi(window, `document.documentElement.lang === ${JSON.stringify(locale)}`);
}

async function workspaceSmoke({ window, origin, runtime, dataRoot, requestApi, cloudSync }) {
  const checks = {};
  for (const [route, heading, key] of [
    ['/task-center', '统一任务中心', 'taskCenterPage'], ['/products', '商品中心', 'productsPage'], ['/userSpace', '个人空间', 'personalSpacePage'],
    ['/studio', '创作工作室', 'studioPage'], ['/account', '个人与团队', 'accountPage'], ['/announcements', '公告与帮助', 'noticePage'],
    ['/sync', '设备绑定与受控同步', 'syncPage'], ['/connections', '店铺与 ERP 授权', 'connectionsPage'], ['/support', '技术支持诊断', 'supportAdminPage']
  ]) checks[key] = await pageCheck(window, origin, route, heading);
  await pageCheck(window, origin, '/workbench/collection', '图片采集与表格批量下载');
  await window.webContents.executeJavaScript(`(() => { const input = document.querySelector('input[placeholder="例如：Amazon 秋季新品"]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'IMAGE-手工标题-001'); input.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await selectLanguage(window, 'en-US');
  checks.localeFormPreserved = await waitForUi(window, `document.querySelector('h1')?.innerText === 'Image collection & spreadsheet downloads' && document.querySelector('input[placeholder="e.g. Amazon autumn products"]')?.value === 'IMAGE-手工标题-001'`);
  checks.localePersistence = await pageCheck(window, origin, '/workbench/sku-pack', 'SKU folder image packs');
  await window.webContents.executeJavaScript(`(() => { const toggle = Array.from(document.querySelectorAll('label')).find((label) => label.innerText.includes('Remove backgrounds first')); if (!toggle) throw new Error('Background-removal toggle missing'); toggle.querySelector('input[type="checkbox"]').click(); })()`);
  await waitForUi(window, `Boolean(document.querySelector('select option[value="sharp"]'))`);
  checks.localeApiValuesPreserved = await window.webContents.executeJavaScript(`Array.from(document.querySelectorAll('input')).some((input) => input.value === '{sku}-{role}-{index}') && Array.from(document.querySelectorAll('select option')).some((option) => option.value === 'sharp' && option.innerText.includes('Local Sharp'))`);
  for (const [route, heading, key] of [
    ['/task-center', 'Task center', 'englishTaskCenter'], ['/products', 'Products', 'englishProducts'], ['/userSpace', 'My files', 'englishPersonalSpace'],
    ['/studio', 'Creative studio', 'englishStudio'], ['/account', 'Account & team', 'englishAccount'], ['/announcements', 'Notices & help', 'englishNotices'],
    ['/sync', 'Device pairing & controlled sync', 'englishSync'], ['/connections', 'Shop & ERP access', 'englishConnections'],
    ['/workbench/materials', 'Asset registry & template inspection', 'englishMaterials'], ['/workbench/commerce', 'Listing preflight & pricing preview', 'englishCommerce'],
    ['/workbench', 'Cross-border Image Operations', 'englishWorkbench'], ['/upload', 'Upload product images', 'englishUpload']
  ]) checks[key] = await pageCheck(window, origin, route, heading);
  checks.localeDesktopPage = await pageCheck(window, origin, '/desktop', 'Desktop & recovery');
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      window.webContents.invalidate(); await new Promise((resolve) => setTimeout(resolve, 250));
      const preview = await window.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true });
      if (!preview.isEmpty()) { await fs.writeFile(path.join(dataRoot, 'desktop-english-preview.png'), preview.toPNG()); break; }
    } catch { /* Screenshot availability is separate from functional locale assertions. */ }
  }
  await selectLanguage(window, 'zh-CN');
  checks.localeSwitchBack = await waitForUi(window, `document.querySelector('h1')?.innerText === '客户端与恢复'`);
  const localImage = await require('sharp')({ create: { width: 60, height: 80, channels: 4, background: '#e45b31' } }).png().toBuffer();
  const podForm = new FormData(); podForm.append('images', new Blob([localImage], { type: 'image/png' }), 'POD-test.png');
  podForm.append('options', JSON.stringify({ mode: 'pod', width: 320, height: 400, format: 'png', confirm: true }));
  const pod = await (await requestApi('/api/platform/studio/render', { method: 'POST', body: podForm })).json();
  checks.podPack = pod.summary.successCount === 1 && (await requestApi(pod.downloadUrl)).ok;
  checks.resultDetailPage = await pageCheck(window, origin, `/results/${pod.id}`, '任务结果与追踪');
  const postLocal = async (route, body) => (await requestApi(route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).json();
  const preview = await postLocal('/api/workbench/pricing-previews', { items: [{ sku: 'SMOKE-SKU', price: 10 }], rules: [{ type: 'fixed', value: 1 }] });
  const sandbox = await postLocal('/api/platform/commerce-sandbox', { sourceId: preview.id, mode: 'local-sandbox', confirm: true });
  checks.commerceSandboxPage = await pageCheck(window, origin, `/commerce-sandbox/${sandbox.id}`, '本地模拟沙箱');
  const committed = await postLocal(`/api/platform/commerce-sandbox/${sandbox.id}/run`, { confirm: true, approvalHash: sandbox.approvalHash });
  checks.commerceSandboxIdempotent = committed.summary.successCount === 1 && (await postLocal(`/api/platform/commerce-sandbox/${sandbox.id}/run`, { confirm: true, approvalHash: sandbox.approvalHash })).items[0].attempt === 1;
  checks.bundledHelp = (await requestApi('/api/platform/help')).ok;
  const snapshot = await (await requestApi('/api/snapshots', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ includeUploads: false, includeOutputs: false, includeDocs: false }) })).json();
  const archive = new (require('adm-zip'))(Buffer.from(await (await requestApi(`/api/snapshots/${snapshot.snapshot.snapshotId}/download`)).arrayBuffer()));
  checks.workspaceBackup = Boolean(archive.getEntry('snapshot/platform.sqlite')) && Boolean(archive.getEntry('snapshot/app.sqlite'));
  let web, browser;
  try {
    const webRoot = path.join(dataRoot, 'web-smoke');
    const env = { ...process.env, PORT: '0', CROSSBORDER_DATA_ROOT: webRoot, WEB_AUTH_ENABLED: 'true', WEB_PUBLIC_ORIGIN: '', STORAGE_DRIVER: 'sqlite', SQLITE_DB_PATH: path.join(webRoot, 'backend', 'data', 'app.sqlite'), FRONTEND_DIST_DIR: path.join(runtime, 'frontend') };
    delete env.LOCAL_API_TOKEN; delete env.ELECTRON_RUN_AS_NODE;
    web = utilityProcess.fork(path.join(runtime, 'backend', 'src', 'server.js'), [], { env, stdio: 'ignore', serviceName: 'Isolated Web acceptance service' });
    const webOrigin = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Web 验收服务启动超时')), 30000);
      web.on('message', (message) => { if (message?.type === 'ready') { clearTimeout(timer); resolve(`http://127.0.0.1:${message.port}`); } });
      web.once('exit', (code) => { clearTimeout(timer); reject(new Error(`Web 验收服务提前退出 ${code}`)); });
    });
    const password = randomBytes(20).toString('hex');
    const agreement = await (await fetch(`${webOrigin}/api/auth/agreement`)).json();
    checks.webAuthBoundary = (await fetch(`${webOrigin}/api/tasks`)).status === 401;
    browser = new BrowserWindow({ show: false, webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, partition: 'workspace-smoke' } });
    checks.webLoginPage = await pageCheck(browser, webOrigin, '/', '创建你的运营工作空间');
    await browser.webContents.executeJavaScript(`(() => { const input = document.querySelector('input[autocomplete="username"]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'locale-账号-test'); input.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    await selectLanguage(browser, 'en-US');
    checks.webLoginLocale = await waitForUi(browser, `document.querySelector('h1')?.innerText === 'Create your workspace' && document.querySelector('input[autocomplete="username"]')?.value === 'locale-账号-test'`);
    await pageCheck(browser, webOrigin, '/userProtocol', agreement.title);
    checks.legalOriginalPreserved = await browser.webContents.executeJavaScript(`document.body.innerText.includes(${JSON.stringify(agreement.sections[0])}) && document.body.innerText.includes('The agreement is in Chinese.')`);
    await selectLanguage(browser, 'zh-CN');
    await pageCheck(browser, webOrigin, '/', '创建你的运营工作空间');
    const post = (route, data, headers = {}) => fetch(`${webOrigin}/api${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(data) });
    const created = await post('/auth/bootstrap', { username: 'acceptance-admin', password, agree: true, agreementVersion: agreement.version });
    if (!created.ok) throw new Error('Web 管理员初始化失败');
    const logged = await post('/auth/login', { username: 'acceptance-admin', password });
    if (!logged.ok) throw new Error('Web 登录失败');
    const session = await logged.json();
    const cookie = logged.headers.get('set-cookie').split(';')[0];
    const headers = { Cookie: cookie, 'X-CSRF-Token': session.csrf };
    await browser.webContents.session.cookies.set({ url: webOrigin, name: 'crossborder_session', value: cookie.slice(cookie.indexOf('=') + 1), httpOnly: true, sameSite: 'lax' });
    checks.webWorkspacePage = await pageCheck(browser, webOrigin, '/account', '个人与团队');
    checks.webSessionCookieHidden = await browser.webContents.executeJavaScript('!document.cookie.includes("crossborder_session")');
    checks.ownerAssignmentPage = await browser.webContents.executeJavaScript('document.body.innerText.includes("成员数据归属分配")');
    const members = [];
    for (const [username, role] of [['isolation-left', 'operator'], ['isolation-right', 'operator'], ['isolation-reader', 'viewer'], ['isolation-support', 'support']]) {
      if (!(await post('/platform/members', { username, password, role }, headers)).ok) throw new Error('隔离验收成员创建失败');
      const login = await post('/auth/login', { username, password, agree: true, agreementVersion: agreement.version });
      if (!login.ok) throw new Error('隔离验收成员登录失败');
      const result = await login.json();
      members.push({ id: result.user.id, headers: { Cookie: login.headers.get('set-cookie').split(';')[0], 'X-CSRF-Token': result.csrf } });
    }
    const [left, right, reader, technical] = members;
    const privateForm = new FormData(); privateForm.append('images', new Blob([localImage], { type: 'image/png' }), 'member-private.png');
    const privateUpload = await fetch(`${webOrigin}/api/tasks/upload`, { method: 'POST', headers: left.headers, body: privateForm });
    if (!privateUpload.ok) throw new Error('隔离验收图片上传失败');
    const privateTask = (await privateUpload.json()).task;
    const getAs = (route, member) => fetch(`${webOrigin}${route}`, { headers: member.headers });
    checks.memberTaskIsolation = (await getAs(`/api/tasks/${privateTask.id}`, left)).status === 200 && (await getAs(`/api/tasks/${privateTask.id}`, right)).status === 404;
    checks.memberAssetIsolation = (await getAs(privateTask.sourceImages[0].previewUrl, left)).status === 200 && (await getAs(privateTask.sourceImages[0].previewUrl, right)).status === 404;
    const rightList = await (await getAs('/api/platform/task-center', right)).json();
    checks.memberIndexIsolation = rightList.pagination.total === 0 && rightList.records.length === 0;
    const ownerRoute = `/platform/resources/image/${privateTask.id}`;
    const approval = await (await post(`${ownerRoute}/owner-preview`, { ownerId: reader.id }, headers)).json();
    const assigned = await post(`${ownerRoute}/owner`, { ownerId: reader.id, approvalHash: approval.approvalHash, confirm: true }, headers);
    checks.memberApprovedAssignment = assigned.ok && (await getAs(privateTask.sourceImages[0].previewUrl, reader)).status === 200 && (await getAs(privateTask.sourceImages[0].previewUrl, left)).status === 404;
    checks.memberReadonlyPreserved = (await fetch(`${webOrigin}/api/tasks/${privateTask.id}/product`, { method: 'PATCH', headers: { ...reader.headers, 'Content-Type': 'application/json' }, body: '{}' })).status === 403;
    const diagnostic = await (await getAs('/api/platform/support/status', technical)).json();
    checks.supportSanitizedDiagnostics = diagnostic.scope === 'sanitized-environment-only' && diagnostic.capabilities.readBusinessData === false && !/apiKey|password|localPath|sourceImages|accessToken/.test(JSON.stringify(diagnostic));
    checks.supportBusinessBlocked = (await getAs('/api/tasks', technical)).status === 403 && (await getAs(privateTask.sourceImages[0].previewUrl, technical)).status === 403;
    checks.supportMutationBlocked = (await post('/platform/devices/code', {}, technical.headers)).status === 403;
    await browser.webContents.session.cookies.set({ url: webOrigin, name: 'crossborder_session', value: technical.headers.Cookie.slice(technical.headers.Cookie.indexOf('=') + 1), httpOnly: true, sameSite: 'lax' });
    checks.supportRolePage = await pageCheck(browser, webOrigin, '/support', '技术支持诊断');
    checks.supportRouteGuard = await pageCheck(browser, webOrigin, '/products', '技术支持诊断');
    const pair = await (await post('/platform/devices/code', {}, headers)).json();
    const connection = await cloudSync.connect({ serviceUrl: webOrigin, code: pair.code, name: 'Acceptance Windows device' });
    const synchronized = await cloudSync.synchronize();
    const credential = await fs.readFile(path.join(dataRoot, 'sync', 'cloud-session.enc'));
    checks.encryptedDeviceSync = connection.secureStorageAvailable && synchronized.mirror.length > 0 && !credential.toString().includes(webOrigin);
    checks.metadataOnlySync = !/filePath|previewUrl|downloadUrl|localPath|apiKey|cookie/i.test(JSON.stringify(synchronized.mirror));
    await post(`/platform/devices/${connection.deviceId}/revoke`, {}, headers);
    checks.revokedDeviceBlocked = await cloudSync.synchronize().then(() => false, () => true);
    await cloudSync.disconnect();
    await post('/auth/logout', {}, headers);
    checks.webLogoutInvalidatesSession = (await fetch(`${webOrigin}/api/tasks`, { headers: { Cookie: cookie } })).status === 401;
  } finally {
    browser?.destroy();
    if (web) await new Promise((resolve) => { const timer = setTimeout(() => { web.kill(); resolve(); }, 5000); web.once('exit', () => { clearTimeout(timer); resolve(); }); try { web.postMessage({ type: 'shutdown' }); } catch { clearTimeout(timer); resolve(); } });
  }
  return checks;
}
module.exports = { workspaceSmoke };
