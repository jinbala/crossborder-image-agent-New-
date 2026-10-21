import os from 'node:os';
export function resourceWorkerLimit(requested = 2, {
  cpuCount = os.availableParallelism?.() || os.cpus().length,
  availableMemoryBytes = os.freemem(), availableDiskBytes = Infinity, action = 'image'
} = {}) {
  const memoryPerWorker = (action === 'generate' ? 768 : 256) * 1024 ** 2;
  const cpuLimit = Math.max(1, Math.floor(cpuCount / 2));
  const memoryLimit = Math.max(1, Math.floor(availableMemoryBytes / memoryPerWorker));
  const diskLimit = availableDiskBytes === Infinity ? 64 : Math.max(1, Math.floor(availableDiskBytes / (128 * 1024 ** 2)));
  return Math.max(1, Math.min(64, Math.floor(Number(requested) || 1), cpuLimit, memoryLimit, diskLimit));
}
export async function mapWithResourceLimit(items, fn, requested = 2) {
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(items.length, resourceWorkerLimit(requested)) }, async () => {
    while (cursor < items.length) { const index = cursor++; await fn(items[index], index); }
  }));
}
