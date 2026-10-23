import { approveSkuPackMatting } from './collectionPack.js';
// Legacy checkpoints may lack finalizePending. This is only an entry hint;
// the server must still validate the recovery scope and output snapshot.
export function skuFinalizationHint(data) {
  return data?.type === 'sku-pack' && (data.recovery?.finalizePending === true || (data.summary?.unprocessedCount === 0 && ((data.status === 'paused' && ['EPERM', 'EACCES', 'EBUSY'].includes(data.error?.code)) || (['running', 'paused'].includes(data.status) && data.recovery?.available === true))));
}
export async function approveSkuResume(api, id, retryFailed, t, confirm) {
  const preview = await api.previewSkuPackResume(id, retryFailed === true);
  const onlyFinalize = preview.onlyFinalize === true;
  const validScope = onlyFinalize ? preview.imageCount === 0 && preview.skuCount === 0 && preview.remote === false : Number.isInteger(preview.imageCount) && preview.imageCount >= 1 && preview.imageCount <= 300 && Number.isInteger(preview.skuCount) && preview.skuCount >= 1 && preview.skuCount <= preview.imageCount;
  if (preview.canResume !== true || !/^[a-f0-9]{64}$/.test(preview.previewHash || '') || !validScope || (preview.onlyFinalize !== undefined && typeof preview.onlyFinalize !== 'boolean') || (preview.remote !== true && preview.remote !== false) || (preview.remote && (preview.options?.matteImages !== true || !['external', 'image2'].includes(preview.options.mattingProvider)))) throw new Error(t(preview.busy === true ? '图包正在处理，请稍后刷新恢复点。' : preview.blocked === 'MATTING_DESTINATION_UNAVAILABLE' ? '恢复所需抠图服务未配置或去向无效，未启动操作。' : '没有符合本次恢复范围的 SKU，请核对重试选项。'));
  if (!confirm(onlyFinalize ? t('图片处理已完成，确认仅重新生成结果 ZIP？不会重做图片或调用抠图服务。') : t('确认恢复本次 {skus} 个 SKU、{count} 张输入图片？已完成的 SKU 不重复处理，失败 SKU 重试会重新制作该 SKU。', { skus: preview.skuCount, count: preview.imageCount }))) return null;
  const remote = preview.remote === true;
  if (remote && !await approveSkuPackMatting(api, { ...preview.options, confirmPaidMatting: true }, { target: id, count: preview.imageCount }, t, confirm)) return null;
  return { confirm: true, retryFailed: retryFailed === true, previewHash: preview.previewHash, confirmPaidMatting: remote };
}
