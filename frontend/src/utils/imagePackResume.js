export async function approveImagePackResume(api, id, retryFailed, t, confirm) {
  const p = await api.previewImagePackResume(id, retryFailed === true);
  if (p.id !== id || p.canResume !== true || p.busy !== false || p.readOnly !== false || p.remote !== false || p.retryFailed !== (retryFailed === true) || typeof p.onlyFinalize !== 'boolean' || typeof p.interruptedLock !== 'boolean' || !/^[a-f0-9]{64}$/.test(p.previewHash || '') || !Number.isInteger(p.imageCount) || (p.onlyFinalize ? p.imageCount !== 0 : p.imageCount < 1 || p.imageCount > 100)) throw new Error(t('图包恢复范围无效或正在运行，请刷新后重新预览。'));
  if (p.interruptedLock && !confirm(t('已确认原进程退出，是否保留中断锁副本并恢复？未知或仍在运行的锁不会被移除。'))) return null;
  if (!confirm(p.onlyFinalize ? t('图片处理已完成，确认仅重新生成结果 ZIP？不会重做图片或调用抠图服务。') : t('确认继续 {count} 张未完成图片？已完成图片不会重做；本次仅使用本地 Sharp，不上传图片。', { count: p.imageCount }))) return null;
  return { confirm: true, previewHash: p.previewHash, retryFailed: retryFailed === true };
}
