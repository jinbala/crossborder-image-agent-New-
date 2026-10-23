import { approveManifestRepair } from './skuManifestRecovery.js';

export function collectionSnapshotReadOnly(job) {
  return job?.type === 'collection-job' && job?.manifestRead?.readOnly === true && job.manifestRead.primaryUnchanged === true;
}
export function canRepairCollectionManifest(job, role) {
  return collectionSnapshotReadOnly(job) && job.manifestRead.canRepair === true && ['admin', 'operator'].includes(role);
}
export async function approveCollectionManifestRepair(api, job, t, confirm) {
  if (!collectionSnapshotReadOnly(job)) throw new Error(t('恢复来源不可用或已经变化，请刷新结果页后重新预览。'));
  return approveManifestRepair({ previewSkuManifestRepair: async id => {
    const preview = await api.previewCollectionManifestRepair(id);
    if (preview.id !== job.id) throw new Error(t('恢复来源不可用或已经变化，请刷新结果页后重新预览。'));
    return preview;
  } }, job.id, t, confirm, job.manifestRead.sourceHash);
}
