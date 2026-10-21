import fs from 'node:fs/promises';
import os from 'node:os';
import sharp from 'sharp';
import { createRequire } from 'node:module';
import { paths } from './dbPaths.js';
import { platformDb, privateSafe, audit } from './platformStore.js';
import { getStorageDriver } from '../storage/index.js';
import { fail } from './accountService.js';

const require = createRequire(import.meta.url);
export async function supportStatus(actor) {
  if (!['admin', 'support'].includes(actor?.role)) throw fail('当前角色没有诊断权限', 403);
  let database = false;
  try { database = platformDb().prepare('SELECT 1 AS ready').get().ready === 1; } catch { /* Report availability, never an exception containing a filesystem path. */ }
  const disk = await fs.statfs(paths.rootDir).catch(() => null);
  const report = { formatVersion: 1, generatedAt: new Date().toISOString(), scope: 'sanitized-environment-only',
    version: process.env.APP_DESKTOP_VERSION || 'web-source',
    runtime: { platform: process.platform, arch: process.arch, node: process.versions.node, electron: process.versions.electron || null, uptimeSeconds: Math.floor(process.uptime()) },
    dependencies: { sharp: sharp.versions.sharp, sqlite: require('better-sqlite3/package.json').version },
    environment: { cpuCount: os.cpus().length, availableMemoryBytes: os.freemem(), availableDiskBytes: disk ? disk.bavail * disk.bsize : null, storageDriver: getStorageDriver(), databaseReady: database },
    exclusions: ['business-images', 'business-records', 'account-list', 'credentials', 'absolute-paths', 'raw-logs'],
    capabilities: { readDiagnostics: true, readBusinessData: false, readCredentials: false, mutateBusinessData: false } };
  audit(actor, 'support.diagnostics-read', '', 200, { scope: report.scope });
  return privateSafe(report);
}
