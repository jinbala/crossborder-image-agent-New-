async function waitFor(window, expression) {
  for (let attempt = 0; attempt < 80; attempt++) {
    if (await window.webContents.executeJavaScript(expression)) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`采集草稿界面验收超时：${expression}`);
}
async function collectionDraftSmoke({ window, origin, requestApi, draftId, dataRoot }) {
  const checks = {};
  const context = await (await requestApi('/api/workbench/collection-drafts')).json();
  checks.collectionDraftSurvivedPortChange = context.draft?.id === draftId && context.draft?.name === '端口变更恢复验证';
  await window.loadURL(`${origin}/workbench/collection`);
  await waitFor(window, 'Boolean(document.querySelector("[data-resume-collection]")) && document.querySelector("fieldset")?.disabled === true');
  if (dataRoot) {
    const preview = await window.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true });
    if (!preview.isEmpty()) await require('node:fs/promises').writeFile(require('node:path').join(dataRoot, 'collection-draft-preview.png'), preview.toPNG());
  }
  await window.webContents.executeJavaScript(`(() => {
    const nativeFetch = window.fetch; let lost = false;
    window.fetch = async (...args) => {
      const response = await nativeFetch(...args);
      if (!lost && String(args[0]).endsWith('/submit')) {
        lost = true; window.__lostCollectionJobId = (await response.clone().json()).id;
        throw new TypeError('SMOKE: response lost after commit');
      }
      return response;
    };
    document.querySelector('[data-resume-collection]').click();
  })()`);
  await waitFor(window, 'Boolean(window.__lostCollectionJobId) && Boolean(document.querySelector("[role=alert]")) && !document.querySelector("[data-resume-collection]")?.disabled');
  const lostId = await window.webContents.executeJavaScript('window.__lostCollectionJobId');
  const retained = await (await requestApi('/api/workbench/collection-drafts')).json();
  checks.collectionDraftLostReplyRetained = retained.draft?.id === draftId && retained.draft.jobId === lostId;
  await window.loadURL(`${origin}/workbench/collection`);
  await waitFor(window, 'Boolean(document.querySelector("[data-resume-collection]"))');
  await window.webContents.executeJavaScript('document.querySelector("[data-resume-collection]").click()');
  await waitFor(window, `document.querySelector('[data-current-collection-job]')?.getAttribute('data-current-collection-job') === ${JSON.stringify(lostId)} && !document.querySelector('[data-collection-draft]')`);
  const after = await (await requestApi('/api/workbench/collection-drafts')).json();
  checks.collectionDraftUiRecovered = after.draft === null && (await (await requestApi(`/api/workbench/collection-jobs/${encodeURIComponent(lostId)}`)).json()).options.name === '端口变更恢复验证';
  await window.webContents.executeJavaScript(`Array.from(document.querySelectorAll('button')).find((node) => node.innerText === '新建任务').click()`);
  await waitFor(window, 'document.querySelector("fieldset")?.disabled === false');
  const csv = ['SKU,销量,图片链接', '通过,20,https://images.example/pass.png', '过滤,1,https://images.example/skip.png'].join('\n');
  await window.webContents.executeJavaScript(`(() => {
    const input = document.querySelector('input[type=file]'), transfer = new DataTransfer();
    transfer.items.add(new File([${JSON.stringify(csv)}], 'UI-草稿恢复.csv', {type:'text/csv'}));
    input.files = transfer.files; input.dispatchEvent(new Event('change', {bubbles:true}));
    const sales = document.querySelector('input[type=number]');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(sales, '10'); sales.dispatchEvent(new Event('input', {bubbles:true}));
  })()`);
  await new Promise((resolve) => setTimeout(resolve, 100));
  await window.webContents.executeJavaScript('document.querySelector("form").requestSubmit()');
  await waitFor(window, 'Boolean(document.querySelector("[data-current-collection-job]")) && !document.querySelector("[data-collection-draft]")');
  const sheetId = await window.webContents.executeJavaScript('document.querySelector("[data-current-collection-job]").getAttribute("data-current-collection-job")');
  const sheet = await (await requestApi(`/api/workbench/collection-jobs/${encodeURIComponent(sheetId)}`)).json();
  checks.collectionDraftUiSheet = sheet.source.type === 'spreadsheet' && sheet.source.fileName === 'UI-草稿恢复.csv' && sheet.summary.inputCount === 2 && sheet.summary.skippedCount === 1 && sheet.items[0].sku === '通过';
  return checks;
}
module.exports = { collectionDraftSmoke };
