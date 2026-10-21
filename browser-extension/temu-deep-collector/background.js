import { backendFetch, pairClient, publicConnection, checkClientConnection, useDevelopmentClient } from './connection.js';
const STATE_KEY = 'temuDeepCollectorStateV1';
const NEXT_STEP_ALARM = 'temu-deep-collector-next-step';
let stepping = false;
let transferring = false;

function initialState() {
  return { status: 'idle', sourceTabId: null, collectorTabId: null, challengeTabId: null, urls: [], cursor: 0, rows: [], failures: [], options: {}, creationRequest: null, backendJob: null, browserTransfer: null, stopRequested: false, processedInRound: 0, resumeAfter: null, updatedAt: new Date().toISOString() };
}

async function readState() {
  const stored = await chrome.storage.local.get(STATE_KEY);
  return { ...initialState(), ...(stored[STATE_KEY] || {}) };
}

async function writeState(patch) {
  const next = { ...(await readState()), ...patch, updatedAt: new Date().toISOString() };
  await chrome.storage.local.set({ [STATE_KEY]: next });
  return next;
}

function extractLinksInPage(maxProducts) {
  const links = [...document.querySelectorAll('a[href]')].map((anchor) => {
    try { return new URL(anchor.href, location.href); } catch { return null; }
  }).filter(Boolean).filter((url) => {
    const host = url.hostname.toLowerCase();
    return (host === 'temu.com' || host.endsWith('.temu.com')) && (/\/goods\.html/i.test(url.pathname) || /-g-\d+\.html/i.test(url.pathname) || url.searchParams.has('goods_id'));
  });
  return [...new Set(links.map((url) => { url.hash = ''; return url.href; }))].slice(0, maxProducts);
}

function extractProductInPage() {
  const text = (document.body?.innerText || '').slice(0, 1_500_000);
  const challenge = /verify you are human|security verification|captcha|请完成验证|安全验证|验证码|异常访问|unusual traffic/i.test(`${location.href}\n${document.title}\n${text}`);
  const title = document.querySelector('h1')?.textContent?.trim()
    || document.querySelector('meta[property="og:title"]')?.content?.trim()
    || document.title.replace(/\s*\|\s*Temu.*$/i, '').trim();
  const salesText = text.match(/(?:已售|销量|sold|purchased|orders?)[^\d]{0,30}(\d+(?:\.\d+)?\s*(?:万|w|k|千)?)/i)?.[1] || '';
  const toSales = (value) => {
    const match = String(value).toLowerCase().replaceAll(',', '').match(/(\d+(?:\.\d+)?)\s*(万|w|k|千)?/i);
    if (!match) return null;
    const multiplier = /万|w/i.test(match[2] || '') ? 10000 : /k|千/i.test(match[2] || '') ? 1000 : 1;
    return Math.round(Number(match[1]) * multiplier);
  };
  const candidates = new Map();
  const variants = [];
  const sourceCounts = { meta: 0, dom: 0, lazy: 0, srcset: 0, style: 0, structuredData: 0, script: 0 };
  const decodeValue = (value) => String(value || '')
    .replaceAll('\\/', '/')
    .replace(/\\u002f/gi, '/')
    .replace(/\\u0026/gi, '&')
    .replace(/&amp;/gi, '&')
    .replace(/^["']|["'\\),;]+$/g, '');
  const add = (value, source = 'dom', force = false) => {
    try {
      const decoded = decodeValue(value);
      const url = new URL(decoded, location.href);
      const looksLikeImage = /\.(?:jpe?g|png|webp|avif)(?:$|[?#])/i.test(url.href)
        || /(?:image|img|thumbnail|thumb|format=webp|format=jpeg)/i.test(url.href);
      if (url.protocol !== 'https:' || (!force && !looksLikeImage)) return '';
      url.hash = '';
      if (!candidates.has(url.href)) {
        candidates.set(url.href, source);
        sourceCounts[source] = Number(sourceCounts[source] || 0) + 1;
      }
      return url.href;
    } catch { /* Ignore malformed URLs. */ }
    return '';
  };
  document.querySelectorAll('meta[property="og:image"], meta[name="twitter:image"]').forEach((node) => add(node.content, 'meta', true));
  document.querySelectorAll('img').forEach((image) => {
    if (image.naturalWidth && image.naturalHeight && image.naturalWidth < 180 && image.naturalHeight < 180) return;
    add(image.currentSrc || image.src, 'dom', true);
    ['src', 'original', 'image', 'zoomImage', 'lazySrc', 'originalSrc'].forEach((key) => add(image.dataset?.[key], 'lazy', true));
    for (const attribute of image.attributes || []) {
      if (/^data-.+(?:src|image|original|url)$/i.test(attribute.name)) add(attribute.value, 'lazy', true);
    }
    String(image.srcset || image.dataset?.srcset || '').split(',').forEach((part) => add(part.trim().split(/\s+/)[0], 'srcset', true));
  });
  document.querySelectorAll('source[srcset]').forEach((node) => String(node.srcset || '').split(',').forEach((part) => add(part.trim().split(/\s+/)[0], 'srcset', true)));
  document.querySelectorAll('[style*="background"]').forEach((node) => {
    for (const match of String(node.style?.backgroundImage || node.getAttribute('style') || '').matchAll(/url\(["']?([^"')]+)["']?\)/gi)) add(match[1], 'style', true);
  });

  const variantIdKeys = ['skuId', 'sku_id', 'goodsSkuId', 'specId', 'variantId', 'id'];
  const variantNameKeys = ['specName', 'variantName', 'colorName', 'name', 'label', 'value'];
  const imageKey = /(?:^|_)(?:image|images|img|thumb|thumbnail|gallery|picture|photo|original)(?:url|urls|src|list)?$/i;
  const walk = (root, source = 'structuredData') => {
    const stack = [{ value: root, key: '', depth: 0 }];
    let visited = 0;
    while (stack.length && visited < 50_000 && candidates.size < 500) {
      const current = stack.pop();
      visited += 1;
      if (typeof current.value === 'string') {
        if (imageKey.test(current.key) || /https?:\\?\/\\?\/[^\s"']+\.(?:jpe?g|png|webp|avif)/i.test(current.value)) add(current.value, source, imageKey.test(current.key));
        continue;
      }
      if (!current.value || typeof current.value !== 'object' || current.depth > 16) continue;
      if (!Array.isArray(current.value)) {
        const entries = Object.entries(current.value);
        const imageEntry = entries.find(([key]) => imageKey.test(key));
        if (imageEntry) {
          const rawImages = Array.isArray(imageEntry[1]) ? imageEntry[1] : [imageEntry[1]];
          const imageUrls = rawImages.map((value) => typeof value === 'string' ? add(value, source, true) : add(value?.url || value?.src || value?.imageUrl, source, true)).filter(Boolean);
          const id = variantIdKeys.map((key) => current.value[key]).find((value) => value !== undefined && value !== null);
          const name = variantNameKeys.map((key) => current.value[key]).find((value) => typeof value === 'string' && value.trim());
          if ((id || name) && imageUrls.length) variants.push({ id: String(id || ''), name: String(name || ''), imageUrls });
        }
      }
      for (const [key, child] of Object.entries(current.value)) stack.push({ value: child, key, depth: current.depth + 1 });
    }
  };
  document.querySelectorAll('script[type="application/ld+json"], script[type="application/json"], script#__NEXT_DATA__').forEach((script) => {
    try { walk(JSON.parse(script.textContent || ''), 'structuredData'); } catch { /* Some pages embed non-JSON script text. */ }
  });
  let scannedScriptBytes = 0;
  document.querySelectorAll('script:not([src])').forEach((script) => {
    if (scannedScriptBytes >= 3_000_000 || candidates.size >= 500) return;
    const scriptText = String(script.textContent || '').slice(0, 3_000_000 - scannedScriptBytes);
    scannedScriptBytes += scriptText.length;
    for (const match of scriptText.matchAll(/https?:\\?\/\\?\/[^\s"'<>]+?\.(?:jpe?g|png|webp|avif)(?:\\?[^\s"'<>]*)?/gi)) add(match[0], 'script');
  });
  const sku = new URL(location.href).searchParams.get('goods_id') || location.pathname.match(/-g-(\d+)\.html/i)?.[1] || `TEMU-${Date.now()}`;
  const dedupedVariants = [...new Map(variants.map((variant) => [`${variant.id}|${variant.name}|${variant.imageUrls.join(',')}`, variant])).values()].slice(0, 100);
  return {
    challenge,
    sku,
    title,
    sales: toSales(salesText),
    productUrl: location.href,
    imageUrls: [...candidates.keys()].slice(0, 200),
    variants: dedupedVariants,
    extraction: { sourceCounts, totalFound: candidates.size, returned: Math.min(candidates.size, 200), scannedScriptBytes }
  };
}

function waitForTab(tabId, timeoutMs = 45000) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { chrome.tabs.onUpdated.removeListener(listener); reject(new Error('页面加载超时')); }, timeoutMs);
    const listener = (updatedId, info, tab) => {
      if (updatedId !== tabId || info.status !== 'complete') return;
      clearTimeout(timeout);
      chrome.tabs.onUpdated.removeListener(listener);
      resolve(tab);
    };
    chrome.tabs.onUpdated.addListener(listener);
  });
}

async function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

async function collectOne(url, waitMs, existingTabId = null, resumeChallenge = false) {
  let tab = null;
  if (existingTabId) tab = await chrome.tabs.get(existingTabId).catch(() => null);
  if (!tab) {
    tab = await chrome.tabs.create({ url, active: false });
    await waitForTab(tab.id);
  } else if (!resumeChallenge || tab.url !== url) {
    const loaded = waitForTab(tab.id);
    await chrome.tabs.update(tab.id, { url, active: false });
    await loaded;
  }
  try {
    await sleep(waitMs);
    const execution = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: extractProductInPage });
    const result = execution?.[0]?.result || null;
    if (result?.challenge) {
      await chrome.tabs.update(tab.id, { active: true });
      result.challengeTabId = tab.id;
    }
    if (result) result.collectorTabId = tab.id;
    return result;
  } catch (error) {
    error.collectorTabId = tab.id;
    throw error;
  }
}

async function createBackendJob(state, verifiedConnection = null) {
  const connection = verifiedConnection || await checkClientConnection();
  if (connection.capabilities?.collectionRequestIdempotency !== 1 || !connection.capabilities.collectionCreationEpoch) throw new Error('当前客户端不支持防重复回传，请启动 0.12.0 或更新版本后重新配对；采集清单已保留');
  let pending = state.creationRequest;
  if (pending && !pending.payload) throw new Error('原回传请求已确认但本机任务 ID 缺失，请检查任务中心；不会自动另建任务');
  if (!pending) {
    const id = crypto.randomUUID();
    pending = { id, optionsSnapshot: state.options, payload: {
      clientRequestId: id,
      creationEpoch: connection.capabilities.collectionCreationEpoch,
      rows: state.rows,
      options: {
        name: state.options.name || 'Temu 深度采集', mode: 'temu-deep', minSales: Number(state.options.minSales || 0),
        extraWaitMs: Number(state.options.downloadWaitMs || 500), maxImagesPerProduct: Number(state.options.maxImagesPerProduct || 50),
        downloadOriginal: true, randomFileNames: Boolean(state.options.randomFileNames)
      }
    } };
    // Must persist identity and immutable payload before the first network mutation.
    await writeState({ creationRequest: pending });
  }
  const response = await backendFetch('/workbench/collection-jobs/rows', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(pending.payload)
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error || `本地工作台返回 HTTP ${response.status}`);
  }
  const job = await response.json();
  if (!job?.id || job.creation?.durable !== true) throw new Error('客户端未确认防重复请求，请核对客户端版本后再次发送；原请求标识保留');
  await writeState({ backendJob: job, creationRequest: { id: pending.id } });
  return job;
}

async function requestImageHostPermissions(rows) {
  const origins = [...new Set(rows.flatMap((row) => row.imageUrls || []).map((value) => {
    try {
      const url = new URL(value);
      return url.protocol === 'https:' ? `${url.origin}/*` : '';
    } catch { return ''; }
  }).filter(Boolean))];
  const missing = [];
  for (const origin of origins) {
    if (!(await chrome.permissions.contains({ origins: [origin] }))) missing.push(origin);
  }
  if (!missing.length) return true;
  return chrome.permissions.request({ origins: missing });
}

async function mirrorBrowserImages(state, backendJob) {
  const maxImages = Math.max(1, Math.min(100, Number(state.options.maxImagesPerProduct || 50)));
  const tasks = [];
  state.rows.forEach((row, rowIndex) => {
    const backendItem = backendJob.items?.[rowIndex];
    if (!backendItem || backendItem.status === 'skipped') return;
    (row.imageUrls || []).slice(0, maxImages).filter((sourceUrl) => !backendItem.images?.some((image) => image.sourceUrl === sourceUrl && image.status === 'success')).forEach((sourceUrl) => tasks.push({ backendItem, row, sourceUrl }));
  });
  const progress = { total: tasks.length, success: 0, failed: 0, failures: [] };
  if (!tasks.length) return progress;
  const granted = await requestImageHostPermissions(state.rows);
  if (!granted) {
    progress.failed = tasks.length;
    progress.failures.push({ code: 'HOST_PERMISSION_DENIED', message: '用户未授权图片域名，保留链接供本地任务稍后下载。' });
    return progress;
  }
  for (const task of tasks) {
    try {
      const imageResponse = await fetch(task.sourceUrl, { credentials: 'include', cache: 'no-store', referrer: task.row.productUrl || undefined });
      if (!imageResponse.ok) throw new Error(`图片返回 HTTP ${imageResponse.status}`);
      const declaredType = String(imageResponse.headers.get('content-type') || '').split(';')[0].toLowerCase();
      const contentType = declaredType === 'image/jpg' ? 'image/jpeg' : declaredType;
      if (!/^image\/(jpeg|png|webp|avif|gif|tiff)$/.test(contentType)) throw new Error(`返回内容不是受支持图片：${contentType || '未知类型'}`);
      const blob = await imageResponse.blob();
      if (!blob.size || blob.size > 25 * 1024 * 1024) throw new Error('图片为空或超过 25MB');
      const form = new FormData();
      form.append('itemId', task.backendItem.id);
      form.append('sourceUrl', task.sourceUrl);
      form.append('finalUrl', imageResponse.url || task.sourceUrl);
      form.append('image', blob, `browser-image.${contentType.split('/')[1].replace('jpeg', 'jpg')}`);
      const upload = await backendFetch(`/workbench/collection-jobs/${encodeURIComponent(backendJob.id)}/browser-images`, { method: 'POST', body: form });
      if (!upload.ok) {
        const body = await upload.json().catch(() => ({}));
        throw new Error(body.error || `本地图片导入返回 HTTP ${upload.status}`);
      }
      progress.success += 1;
    } catch (error) {
      progress.failed += 1;
      if (progress.failures.length < 30) progress.failures.push({ sourceUrl: task.sourceUrl, message: error.message });
    }
    await writeState({ status: 'uploading', backendJob, browserTransfer: progress });
  }
  return progress;
}

async function scheduleNext(delayMs = 100) {
  await chrome.alarms.create(NEXT_STEP_ALARM, { when: Date.now() + Math.max(50, delayMs) });
}

async function runStep() {
  if (stepping) return;
  stepping = true;
  try {
    let state = await readState();
    if (state.status !== 'running') return;
    if (state.stopRequested) {
      await chrome.alarms.clear(NEXT_STEP_ALARM);
      await writeState({ status: 'paused' });
      return;
    }
    if (state.cursor >= state.urls.length) {
      if (!state.rows.length) throw new Error('没有采集到可导入的商品数据');
      const backendJob = state.backendJob || await createBackendJob(state);
      if (state.collectorTabId) await chrome.tabs.remove(state.collectorTabId).catch(() => {});
      await writeState({ status: state.options.browserSessionDownload === false ? 'completed' : 'awaiting_transfer', backendJob, stopRequested: false, collectorTabId: null, challengeTabId: null, processedInRound: 0, resumeAfter: null,
        lastError: state.options.browserSessionDownload === false ? '' : '商品链接已保存。请点击“发送到本地工作台”授权图片域名并回传登录态图片。' });
      return;
    }

    const url = state.urls[state.cursor];
    // Keep a watchdog alarm so a suspended MV3 worker can retry the same checkpoint.
    await scheduleNext(Math.max(120_000, Number(state.options.pageWaitMs || 6000) + 90_000));
    try {
      const reusableTabId = state.challengeTabId || state.collectorTabId;
      const row = await collectOne(url, Number(state.options.pageWaitMs || 6000), reusableTabId, Boolean(state.challengeTabId));
      if (!row) throw new Error('页面没有返回采集结果');
      if (row.challenge) {
        await writeState({ status: 'challenge', collectorTabId: row.collectorTabId, challengeTabId: row.challengeTabId, lastError: 'Temu 要求人工完成安全验证。任务已停止，请在当前标签页完成人工验证后再继续。' });
        return;
      }
      delete row.challengeTabId;
      const collectorTabId = row.collectorTabId;
      delete row.collectorTabId;
      state.rows.push(row);
      state.collectorTabId = collectorTabId;
    } catch (error) {
      if (error.collectorTabId) state.collectorTabId = error.collectorTabId;
      state.failures.push({ url, code: error.code || (/timeout|超时/i.test(error.message) ? 'PAGE_TIMEOUT' : /登录|login|sign.in/i.test(error.message) ? 'LOGIN_REQUIRED' : 'PAGE_COLLECTION_FAILED'), message: error.message, at: new Date().toISOString() });
    }
    state.cursor += 1;
    state.processedInRound = Number(state.processedInRound || 0) + 1;
    const batchSize = Math.max(1, Math.min(10, Number(state.options.batchSize || 3)));
    if (state.cursor < state.urls.length && state.processedInRound >= batchSize) {
      const cooldownMs = Math.max(30_000, Math.min(30 * 60_000, Number(state.options.cooldownMs || 60_000)));
      const resumeAfter = new Date(Date.now() + cooldownMs).toISOString();
      await writeState({ cursor: state.cursor, rows: state.rows, failures: state.failures, collectorTabId: state.collectorTabId, status: 'cooldown', challengeTabId: null, processedInRound: 0, resumeAfter, lastError: `已连续处理 ${batchSize} 个商品。为降低访问压力，请等待到 ${new Date(resumeAfter).toLocaleTimeString()} 后手动继续。` });
      await chrome.alarms.clear(NEXT_STEP_ALARM);
      return;
    }
    await writeState({ cursor: state.cursor, rows: state.rows, failures: state.failures, collectorTabId: state.collectorTabId, processedInRound: state.processedInRound, status: 'running', challengeTabId: null, resumeAfter: null, lastError: '' });
    await scheduleNext(Math.max(3000, Math.min(60_000, Number(state.options.betweenProductsMs || 8000))));
  } catch (error) {
    await writeState({ status: 'failed', lastError: error.message });
  } finally {
    stepping = false;
  }
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === NEXT_STEP_ALARM) runStep();
});

chrome.runtime.onStartup.addListener(async () => {
  const state = await readState();
  if (state.status === 'running') await scheduleNext();
  if (state.status === 'uploading') await writeState({ status: 'awaiting_transfer', lastError: '图片回传已中断，重新配对后点击发送，将跳过本机已保存图片。' });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id) return false;
  (async () => {
    if (message.type === 'pair-client') return pairClient(message.serviceUrl, message.code);
    if (message.type === 'check-client') return checkClientConnection();
    if (message.type === 'use-development-client') return useDevelopmentClient(message.serviceUrl);
    if (message.type === 'connection') return publicConnection();
    if (message.type === 'state') return readState();
    if (message.type === 'prepare') {
      const previous = await readState();
      if (previous.creationRequest && !previous.backendJob) throw new Error('原图片回传结果尚未确认，请先再次发送找回任务；如需新轮次，请明确清空进度，服务端旧任务不会删除');
      if (previous.collectorTabId) await chrome.tabs.remove(previous.collectorTabId).catch(() => {});
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id || !/^https:\/\/[^/]*temu\.com\//i.test(tab.url || '')) throw new Error('请先打开 Temu 商品列表或搜索结果页');
      const execution = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: extractLinksInPage, args: [Number(message.options.maxProducts || 50)] });
      const urls = execution?.[0]?.result || [];
      if (!urls.length) throw new Error('当前页面没有识别到商品链接，请滚动列表加载商品后重试');
      return writeState({ ...initialState(), status: 'prepared', sourceTabId: tab.id, urls, options: message.options });
    }
    if (message.type === 'collect-current') {
      const previous = await readState();
      if (previous.creationRequest && !previous.backendJob) throw new Error('原回传结果尚未确认，请先再次发送找回任务；清单与请求标识均已保留');
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id || !/^https:\/\/[^/]*temu\.com\//i.test(tab.url || '')) throw new Error('请先打开一个 Temu 商品详情页');
      const pageUrl = new URL(tab.url);
      if (!(/\/goods\.html/i.test(pageUrl.pathname) || /-g-\d+\.html/i.test(pageUrl.pathname) || pageUrl.searchParams.has('goods_id'))) {
        throw new Error('当前不是可识别的 Temu 商品详情页');
      }
      const execution = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: extractProductInPage });
      const row = execution?.[0]?.result || null;
      if (!row) throw new Error('当前页面没有返回采集结果');
      if (row.challenge) throw new Error('当前页面正在安全验证，请人工完成后重试');
      if (!row.imageUrls?.length) throw new Error('当前页面没有识别到商品图片，请等待页面加载完成后重试');
      const state = await readState();
      const rows = ['manual', 'awaiting_transfer'].includes(state.status) && !state.backendJob ? [...state.rows] : [];
      const existingIndex = rows.findIndex((item) => item.productUrl === row.productUrl);
      if (existingIndex >= 0) rows[existingIndex] = row;
      else rows.push(row);
      return writeState({
        ...initialState(),
        status: 'manual',
        rows,
        cursor: rows.length,
        options: message.options || state.options,
        lastError: existingIndex >= 0 ? '当前商品已更新' : '当前商品已加入手动采集清单'
      });
    }
    if (message.type === 'finish-manual') {
      if (transferring || stepping) throw new Error('当前采集或回传仍在执行，请等待完成');
      transferring = true;
      try {
      let state = await readState();
      if (!state.rows.length) throw new Error('还没有采集任何商品');
      const verifiedConnection = await checkClientConnection();
      state = await writeState({ rows: state.creationRequest?.payload?.rows || state.rows,
        options: state.creationRequest?.optionsSnapshot || { ...state.options, ...(message.options || {}) }, status: 'uploading', lastError: '' });
      const backendJob = state.backendJob ? await backendFetch(`/workbench/collection-jobs/${encodeURIComponent(state.backendJob.id)}`).then(async (response) => {
        if (!response.ok) throw new Error('原采集任务暂不可读取，请检查客户端连接，不会自动创建重复任务');
        return response.json();
      }) : await createBackendJob(state, verifiedConnection);
      await writeState({ status: 'uploading', backendJob, browserTransfer: { total: 0, success: 0, failed: 0, failures: [] } });
      const browserTransfer = state.options.browserSessionDownload === false ? null : await mirrorBrowserImages(state, backendJob);
      const lastError = browserTransfer?.failed
        ? `有 ${browserTransfer.failed} 张图片无法通过当前登录会话回传；链接已保留，可在本地任务中继续下载。`
        : backendJob.creation?.replayed ? '已找回首次发送创建的任务，使用原规则继续回传；未重复建任务。' : '';
      return await writeState({ status: 'completed', backendJob, browserTransfer, stopRequested: false, lastError });
      } finally { transferring = false; }
    }
    if (message.type === 'start') {
      const state = await readState();
      if (!state.urls.length) throw new Error('请先识别当前 Temu 列表页');
      if (state.resumeAfter && Date.now() < new Date(state.resumeAfter).getTime()) {
        throw new Error(`仍在冷却中，请在 ${new Date(state.resumeAfter).toLocaleTimeString()} 后继续`);
      }
      const next = await writeState({ status: 'running', stopRequested: false, processedInRound: 0, resumeAfter: null, lastError: '' });
      await scheduleNext();
      return next;
    }
    if (message.type === 'retry-failed') {
      if (stepping) throw new Error('请先暂停当前采集');
      const state = await readState(), urls = [...new Set(state.failures.map((item) => item.url))];
      if (state.creationRequest && !state.backendJob) throw new Error('原回传尚未确认，请先再次发送找回任务；不会丢弃请求标识');
      if (!urls.length) throw new Error('没有失败商品需要重试');
      await chrome.alarms.clear(NEXT_STEP_ALARM);
      // A new failed-only round never revisits already successful products or replaces their saved job.
      return writeState({ ...initialState(), status: 'prepared', sourceTabId: state.sourceTabId, urls, options: state.options, previousJobId: state.backendJob?.id || null,
        lastError: '已创建只含失败商品的重试轮次，原成功任务保留。确认后点击开始/继续。' });
    }
    if (message.type === 'stop') {
      await chrome.alarms.clear(NEXT_STEP_ALARM);
      return writeState({ status: stepping ? 'pausing' : 'paused', stopRequested: true });
    }
    if (message.type === 'reset') {
      await chrome.alarms.clear(NEXT_STEP_ALARM);
      const state = await readState();
      if (state.collectorTabId) await chrome.tabs.remove(state.collectorTabId).catch(() => {});
      await chrome.storage.local.remove(STATE_KEY);
      return initialState();
    }
    throw new Error('未知操作');
  })().then((result) => sendResponse({ ok: true, result })).catch(async (error) => {
    if (message.type === 'finish-manual' && !transferring && !stepping) await writeState({ status: 'awaiting_transfer', lastError: error.message }).catch(() => {});
    sendResponse({ ok: false, error: error.message });
  });
  return true;
});
