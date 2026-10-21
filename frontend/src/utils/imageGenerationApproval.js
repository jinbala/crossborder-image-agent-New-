// Read-only preflight. A missing destination or a cancelled dialog never authorizes mutation.
export async function approveImageGeneration(api, input, t, confirm) {
  const config = await api.getMattingConfig();
  const origin = config?.generationDestination?.origin;
  let valid = false;
  try { const url = new URL(origin); valid = ['http:', 'https:'].includes(url.protocol) && url.origin === origin && !url.username && !url.password; } catch { /* Fail closed. */ }
  if (!valid) throw new Error(t('无法确认生图服务的数据去向，请检查 Provider 配置；未启动处理。'));
  return confirm(t('确认将任务 {taskId} 的图片与商品信息发送到 {origin}？\n最多生成 {count} 张；抠图方式：{mattingProvider}。Image2 预处理也会向该配置服务发送图片，可能额外计费。\n服务商可能对失败调用计费，当前未核定单价。是否批准本次处理？', { taskId: input.taskId, origin, count: input.count || 1, mattingProvider: input.mattingProvider || 'sharp' }));
}
