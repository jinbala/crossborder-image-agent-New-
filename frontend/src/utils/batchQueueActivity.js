export function batchQueueActivity(batch) {
  const queue = batch?.queue || {};
  const running = queue.status === 'running';
  const locked = batch?.locks?.isRunning === true;
  const active = batch?.runtime?.queueActive === true;
  const draining = queue.status === 'cancelled' && locked;
  return {
    running,
    paused: queue.status === 'paused',
    busy: running || locked || active,
    draining,
    poll: running || Number(queue.runningJobs || 0) > 0 || draining || active
  };
}
