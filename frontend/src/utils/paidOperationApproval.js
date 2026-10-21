// Read-only until the user approves the current operation. A mock preview grants no paid permission.
export async function approvePaidOperation(api, { kinds, target, count, allowMock = false }, t, confirm) {
  const config = await api.getProviderConfig(), destinations = config?.paidDestinations;
  if (!destinations || kinds.some(kind => !destinations[kind])) throw new Error(t('无法读取本次处理的数据去向，未启动操作。'));
  const selected = kinds.map(kind => ({ kind, ...destinations[kind] }));
  if (selected.every(item => item.provider === 'mock' || item.local === true)) {
    if (allowMock) return { confirmPaidApi: false };
    throw new Error(t('本次真实服务未配置，未启动操作。'));
  }
  for (const item of selected.filter(item => item.provider !== 'mock' && item.local !== true)) {
    let valid = false;
    try { const url = new URL(item.origin); valid = ['http:', 'https:'].includes(url.protocol) && url.origin === item.origin && !url.username && !url.password; } catch { /* Fail closed. */ }
    if (!valid) throw new Error(t('无法读取本次处理的数据去向，未启动操作。'));
  }
  const destinationsText = selected.map(item => `${item.kind}: ${item.provider} ${item.origin || (item.local ? 'local' : 'mock')}`).join('\n');
  return confirm(t('批准本次真实处理？\n目标：{target}\n范围：{count}\n服务去向：\n{destinations}\n图片、商品信息或审核内容可能外发。单价尚未核定，失败及自动重试也可能计费；不会发布商品或修改线上价格。', { target, count, destinations: destinationsText })) ? { confirmPaidApi: true } : null;
}
