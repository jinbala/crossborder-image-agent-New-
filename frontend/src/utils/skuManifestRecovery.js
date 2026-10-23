export function manifestRecoveryLabel(read, t) {
  if (read?.readOnly !== true || read.primaryUnchanged !== true) return '';
  if (read.source === 'backup') return t('当前展示备份清单的只读快照，主清单未被改写。');
  if (read.source === 'archive') return t('当前展示已发布 ZIP 内清单的只读快照，主清单未被改写。');
  return '';
}

export function canRepairManifest(data, canMakeImages) {
  return canMakeImages === true && data?.type === 'sku-pack' && data?.manifestRead?.readOnly === true && data.manifestRead.primaryUnchanged === true;
}

export async function approveManifestRepair(api, id, t, confirm, displayedSourceHash) {
  const preview = await api.previewSkuManifestRepair(id);
  if (preview.canRepair !== true || preview.onlyManifest !== true || preview.imageCount !== 0 || preview.remote !== false || !['backup', 'archive'].includes(preview.source) || !/^[a-f0-9]{64}$/.test(preview.previewHash || '') || !/^[a-f0-9]{64}$/.test(preview.sourceHash || '') || preview.sourceHash !== displayedSourceHash) throw new Error(t('恢复来源不可用或已经变化，请刷新结果页后重新预览。'));
  if (!confirm(t('确认仅修复本任务主清单？原损坏清单将保留副本；不修改图片、不重新打包，也不调用付费服务。'))) return null;
  return { confirm: true, previewHash: preview.previewHash, sourceHash: preview.sourceHash };
}
