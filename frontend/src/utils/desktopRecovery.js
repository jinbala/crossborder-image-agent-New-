const recoveryStateMessages = { draft: '草稿', queued: '排队', running: '运行中', waiting_user: '等待人工', paused: '已暂停', completed: '完成', partial: '部分完成', failed: '失败', cancelled: '已取消' };
export function recoveryStateMessage(state) { return recoveryStateMessages[state] || state; }

export function recoveryIndexPending(runtime) {
  return ['pending', 'running'].includes(runtime?.indexStatus?.status);
}

// One current page/request only. Historical indexing can outlive the first
// response; poll its metadata, never resume a business task automatically.
export function createRecoveryLoader({ getInfo = async () => null, getRuntime, onData, onError,
  intervalMs = 1000, maxPollFailures = 3, timeoutMs = 8000,
  schedule = setTimeout, cancel = clearTimeout } = {}) {
  let generation = 0, disposed = false, timer, controller, previousRuntime = null, failures = 0;
  function later(page, ms) { timer = schedule(() => { void load(page, true); }, ms); }
  async function load(page = 1, polling = false) {
    if (disposed) return;
    cancel(timer); controller?.abort();
    const request = ++generation, current = new AbortController(); controller = current;
    if (!polling) failures = 0;
    try {
      const signal = AbortSignal.any([current.signal, AbortSignal.timeout(timeoutMs)]);
      const [info, runtime] = await Promise.all([getInfo(), getRuntime(page, { signal })]);
      if (disposed || request !== generation) return;
      if (!runtime || !Array.isArray(runtime.recovery) ||
          (runtime.recoveryPagination?.page !== undefined && runtime.recoveryPagination.page !== page)) {
        throw Object.assign(new Error('恢复接口返回无效，请点击刷新状态重试。'), { code: 'RECOVERY_INVALID_RESPONSE' });
      }
      previousRuntime = runtime; failures = 0;
      onData?.({ info, runtime, page });
      if (recoveryIndexPending(runtime)) later(page, intervalMs);
      return runtime;
    } catch (error) {
      if (disposed || request !== generation) return;
      onError?.(error);
      // Bounded backoff for an interrupted background scan. Initial failures
      // and terminal scans require an explicit refresh, not an endless loop.
      if (polling && recoveryIndexPending(previousRuntime) && ++failures < maxPollFailures) later(page, intervalMs * 2 ** (failures - 1));
    }
  }
  return { load, dispose() { disposed = true; generation++; cancel(timer); controller?.abort(); } };
}
