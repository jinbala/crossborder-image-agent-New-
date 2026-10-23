import { approveManifestRepair } from './skuManifestRecovery.js';

const types = new Set(['image-pack', 'collection-plan', 'studio', 'listing-dry-run', 'pricing-preview', 'template-fill']);
export function canRepairWorkbenchManifest(data, role) {
  return ['admin', 'operator'].includes(role) && types.has(data?.type) && data?.manifestRead?.canRepair === true && data.manifestRead.readOnly === true && data.manifestRead.primaryUnchanged === true;
}
export async function approveWorkbenchManifestRepair(api, data, t, confirm) {
  return approveManifestRepair({ previewSkuManifestRepair: async id => {
    const preview = await api.previewWorkbenchManifestRepair(id);
    if (preview.id !== data.id) throw new Error(t('恢复来源不可用或已经变化，请刷新结果页后重新预览。'));
    return preview;
  } }, data.id, t, confirm, data.manifestRead?.sourceHash);
}
