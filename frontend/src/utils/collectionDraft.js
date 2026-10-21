export function assertCollectionDraftContext(context, actorId) {
  if (!context || context.actorId !== actorId || typeof context.generation !== 'string') throw new Error('当前成员或采集页面已变化，请刷新后重试');
  return context;
}

// The server owns the immutable input, not browser storage. Never fall back to unkeyed creation.
export async function recoverCollectionDraft(api, context, actorId, onJob = () => {}) {
  assertCollectionDraftContext(context, actorId);
  if (!context.draft?.id || ['unavailable', 'corrupt'].includes(context.draft.state)) throw new Error('原请求不可继续，请检查任务中心或明确放弃本轮请求');
  const job = await api.submitCollectionDraft(context.draft.id, actorId);
  if (typeof job?.id !== 'string' || job.creation?.durable !== true) throw new Error('客户端未确认持久任务身份，待确认请求已保留');
  // Render the known ID even when acknowledgement fails; retry still uses the same draft.
  onJob(job);
  await api.acknowledgeCollectionDraft(context.draft.id, actorId, job.id);
  return { job, context: assertCollectionDraftContext(await api.getCollectionDraft(), actorId) };
}
