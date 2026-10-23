const elements = Object.fromEntries(['name', 'maxProducts', 'minSales', 'pageWaitMs', 'betweenProductsMs', 'batchSize', 'cooldownSeconds', 'browserSessionDownload', 'status', 'collectCurrent', 'finishManual', 'retryFailed', 'prepare', 'start', 'stop', 'reset', 'openJob', 'error', 'serviceUrl', 'pairCode', 'pairClient', 'checkClient', 'developmentClient', 'connectionStatus', 'workflowStep', 'connectionDetails'].map((id) => [id, document.getElementById(id)]));
let connection = null;
let lastState = null;
let addressInitialized = false;
let nameInitialized = false;
let activeAction = '';

function renderWorkflow() {
  const count = (lastState?.rows || []).length;
  const working = Boolean(activeAction) || ['running', 'pausing', 'uploading'].includes(lastState?.status);
  elements.collectCurrent.disabled = working;
  elements.finishManual.disabled = working || !count;
  for (const key of ['prepare','start','reset','retryFailed']) elements[key].disabled = working;
  if (activeAction === 'collect') elements.workflowStep.textContent = '正在采集当前商品，请稍候；不要重复点击。';
  else if (activeAction === 'send' || lastState?.status === 'uploading') elements.workflowStep.textContent = '正在发送图片到本机，请稍候；清单会保留，不需要重新采集。';
  else if (!count) elements.workflowStep.textContent = '第 1 步：打开商品页，再点“1. 采集当前商品”。';
  else if (!connection?.serviceUrl) elements.workflowStep.textContent = `清单已有 ${count} 个商品。第 2 步：展开“客户端连接”配对，再点“2. 发送到本地工作台”。`;
  else if (lastState?.status === 'awaiting_transfer' && lastState?.browserTransfer?.failed) elements.workflowStep.textContent = '回传未完成，本地任务和清单已保留。先查看下方失败阶段；本机接收失败请检测连接并重新配对，图片站下载失败请人工检查授权和页面，再次发送会跳过本机已保存图片。';
  else if (lastState?.backendJob?.id) elements.workflowStep.textContent = '已有本地下载任务。第 3 步：点“3. 查看下载任务”检查图片；若仍有失败，可保留清单后重试发送。';
  else elements.workflowStep.textContent = `清单已有 ${count} 个商品。第 2 步：点“2. 发送到本地工作台”；允许图片域名权限后等待回传。`;
}

async function manualAction(kind, run) {
  if (activeAction || ['running','pausing','uploading'].includes(lastState?.status)) return;
  activeAction = kind; elements.error.textContent = ''; renderWorkflow();
  try { await run(); } catch (error) { elements.error.textContent = error.message; }
  finally { activeAction = ''; renderWorkflow(); }
}

function call(type, payload = {}) {
  return chrome.runtime.sendMessage({ type, ...payload }).then((response) => {
    if (!response?.ok) throw new Error(response?.error || '扩展操作失败');
    return response.result;
  });
}

function options() {
  return {
    name: elements.name.value.trim() || 'Temu 深度采集',
    maxProducts: Math.max(1, Math.min(200, Number(elements.maxProducts.value || 30))),
    minSales: Math.max(0, Number(elements.minSales.value || 0)),
    pageWaitMs: Math.max(3000, Math.min(30000, Number(elements.pageWaitMs.value || 6000))),
    betweenProductsMs: Math.max(3000, Math.min(60000, Number(elements.betweenProductsMs.value || 8000))),
    batchSize: Math.max(1, Math.min(10, Number(elements.batchSize.value || 3))),
    cooldownMs: Math.max(30000, Math.min(1800000, Number(elements.cooldownSeconds.value || 60) * 1000)),
    downloadWaitMs: 500,
    maxImagesPerProduct: 50,
    browserSessionDownload: elements.browserSessionDownload.checked
  };
}

function render(state) {
  lastState = state;
  const labels = { idle: '未开始', manual: '手动采集中', awaiting_transfer: '等待授权回传图片', uploading: '正在回传登录态图片', prepared: '已识别列表', running: '正在深采', pausing: '正在暂停', paused: '已暂停', cooldown: '轮次冷却', challenge: '等待人工验证', completed: '采集完成', failed: '任务失败' };
  const progress = state.status === 'manual' || (!(state.urls || []).length && (state.rows || []).length > 0)
    ? `手动清单：${(state.rows || []).length} 个商品`
    : `进度：${state.cursor || 0} / ${(state.urls || []).length}`;
  const pending = state.browserTransfer ? Math.max(0, state.browserTransfer.pending ?? ((state.browserTransfer.total || 0) - (state.browserTransfer.success || 0) - (state.browserTransfer.failed || 0))) : 0;
  const stages = { 'image-download': '图片站下载', 'local-upload': '本机接收', 'image-permission': '图片域名授权' };
  const details = (state.browserTransfer?.failures || []).slice(0, 5).map((failure) => `\n${stages[failure.stage] || '图片回传'} [${failure.code || 'TRANSFER_FAILED'}]：${failure.message || '请检测连接后重试'}`).join('');
  const transfer = state.browserTransfer ? `\n本轮图片：成功 ${state.browserTransfer.success || 0}，失败 ${state.browserTransfer.failed || 0}，未处理 ${pending}，共 ${state.browserTransfer.total || 0}${details}` : '';
  elements.status.textContent = `状态：${labels[state.status] || state.status}\n${progress}\n成功商品：${(state.rows || []).length}，失败：${(state.failures || []).length}${transfer}${state.lastError ? `\n提示：${state.lastError}` : ''}`;
  if (!nameInitialized) { if (state.options?.name) elements.name.value = state.options.name; nameInitialized = true; }
  const jobId = state.backendJob?.id;
  elements.openJob.style.display = jobId ? 'inline-block' : 'none';
  elements.openJob.href = jobId ? (connection?.paired ? `crossborder-workbench://collection?jobId=${encodeURIComponent(jobId)}` : `http://127.0.0.1:5173/workbench/collection?jobId=${encodeURIComponent(jobId)}`) : '#';
  renderWorkflow();
}

async function refresh() {
  try {
    connection = await call('connection');
    if (!addressInitialized) { elements.serviceUrl.value = connection.serviceUrl || ''; addressInitialized = true; }
    elements.connectionStatus.textContent = connection.paired ? `已配对 ${connection.serviceUrl}（点击检测连接确认服务状态）` : connection.mode === 'standalone' ? `开发模式 ${connection.serviceUrl}` : '尚未配对，请使用客户端显示的动态端口；不会自动连接 4000';
    render(await call('state'));
  }
  catch (error) { elements.error.textContent = error.message; }
}

elements.prepare.addEventListener('click', async () => {
  try { elements.error.textContent = ''; render(await call('prepare', { options: options() })); }
  catch (error) { elements.error.textContent = error.message; }
});
elements.collectCurrent.addEventListener('click', () => manualAction('collect', async () => { render(await call('collect-current', { options: options() })); }));
elements.finishManual.addEventListener('click', () => manualAction('send', async () => {
    if (!lastState?.rows?.length) throw new Error('还没有采集商品，请先采集当前页');
    if (!connection?.serviceUrl) { elements.connectionDetails.open = true; throw new Error('请先展开“客户端连接”，填写客户端显示的地址并配对；不要清空采集清单'); }
    if (elements.browserSessionDownload.checked) {
      const origins = [...new Set(lastState.rows.flatMap((row) => row.imageUrls || []).map((value) => { try { const url = new URL(value); return url.protocol === 'https:' ? `${url.origin}/*` : ''; } catch { return ''; } }).filter(Boolean))];
      // Request in the click handler, before any network await, so browser user-gesture consent is preserved.
      if (origins.length && !(await chrome.permissions.request({ origins }))) throw new Error('未授权图片域名；清单保留。再次发送时可重新授权，不会绕过浏览器权限。');
    }
    render(await call('finish-manual', { options: options() }));
}));
elements.start.addEventListener('click', async () => {
  try { elements.error.textContent = ''; render(await call('start')); window.setTimeout(refresh, 500); }
  catch (error) { elements.error.textContent = error.message; }
});
elements.stop.addEventListener('click', async () => { try { render(await call('stop')); } catch (error) { elements.error.textContent = error.message; } });
elements.retryFailed.addEventListener('click', async () => { try { if (window.confirm('只重试失败商品，原成功任务保持不变。是否继续？')) render(await call('retry-failed')); } catch (error) { elements.error.textContent = error.message; } });
elements.reset.addEventListener('click', async () => { try { if (window.confirm('清空扩展进度？已经发送到本机的任务和图片不会删除。')) render(await call('reset')); } catch (error) { elements.error.textContent = error.message; } });
elements.pairClient.addEventListener('click', async () => {
  try {
    connection = await call('pair-client', { serviceUrl: elements.serviceUrl.value, code: elements.pairCode.value });
    elements.pairCode.value = '';
    await refresh();
  } catch (error) { elements.error.textContent = error.message; }
});
elements.checkClient.addEventListener('click', async () => {
  try { const result = await call('check-client'); elements.error.textContent = ''; elements.connectionStatus.textContent = `本机服务可达 ${result.serviceUrl}；实际回传仍将校验配对权限`; } catch (error) { elements.error.textContent = error.message; }
});
elements.developmentClient.addEventListener('click', async () => {
  if (!window.confirm('仅连接你自行启动的无鉴权源码开发服务？正常 Windows 客户端应使用配对码，不应选择开发模式。')) return;
  try { connection = await call('use-development-client', { serviceUrl: elements.serviceUrl.value }); elements.error.textContent = ''; await refresh(); } catch (error) { elements.error.textContent = error.message; }
});

refresh();
window.setInterval(refresh, 1500);
