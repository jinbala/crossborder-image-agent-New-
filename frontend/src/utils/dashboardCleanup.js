export function cleanupDashboardErrorMessage(error) {
  return error ? '运行文件占用获取失败，请检查后端是否已启动。' : '';
}

export function cleanupRefreshStatusText({ refreshing = false, lastRefreshedAt = null, now = new Date() } = {}, t = (text) => text, dateTime = null) {
  if (refreshing) return t('正在刷新...');
  if (!lastRefreshedAt) return '';
  const date = lastRefreshedAt instanceof Date ? lastRefreshedAt : new Date(lastRefreshedAt);
  if (!Number.isFinite(date.getTime())) return '';
  const current = now instanceof Date ? now : new Date(now);
  if (current.getTime() - date.getTime() < 60 * 1000) return t('最近刷新：刚刚');
  if (dateTime) return `${t('最近刷新：')}${dateTime(date)}`;
  return `最近刷新：${date.toLocaleTimeString('zh-CN', { hour12: false })}`;
}
