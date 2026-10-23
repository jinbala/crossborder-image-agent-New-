export function collectionPackLink(id) {
  return typeof id === 'string' && /^collect-job-[A-Za-z0-9_-]+$/.test(id)
    ? `/workbench/sku-pack?collectionJobId=${encodeURIComponent(id)}` : '';
}

export function collectionPackFiles(preview) {
  if (!preview || !Array.isArray(preview.images) || !preview.images.length || preview.images.length > 300 || !/^[a-f0-9]{64}$/.test(preview.previewHash || '')) throw new Error('采集图包预检无效，请重新读取来源');
  return preview.images.map(image => ({
    name: image.relativePath.split('/').at(-1), webkitRelativePath: image.relativePath,
    size: image.size, lastModified: 0
  }));
}

export function collectionPackPayload(preview, options, confirmPartial) {
  return { previewHash: preview.previewHash, confirm: true, confirmPartial: confirmPartial === true, options };
}

// Shared by manual-folder and collection-source packs. Read-only preflight and
// an operation-specific dialog precede every remote matting submission.
export async function approveSkuPackMatting(api, options, { target, count }, t, confirm) {
  if (!options.matteImages || !['external', 'image2'].includes(options.mattingProvider)) return true;
  if (options.confirmPaidMatting !== true) throw new Error(t('请先勾选本次任务的费用确认。'));
  const config = await api.getMattingConfig();
  const destination = config?.dataDestinations?.find(item => item.provider === options.mattingProvider);
  let valid = false;
  try { const url = new URL(destination.origin); valid = ['https:', 'http:'].includes(url.protocol) && url.origin === destination.origin && !url.username && !url.password; } catch { /* Fail closed. */ }
  if (!valid) throw new Error(t('无法读取本次处理的数据去向，未启动操作。'));
  return confirm(t('批准本次图包抠图？\n目标：{target}\n图片数量：{count}\n服务：{provider}\n图片将发送至：{origin}\n单价尚未核定，失败或重试也可能计费；不会发布商品或修改线上价格。', { target, count, provider: options.mattingProvider, origin: destination.origin }));
}
