import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const FORBIDDEN_PATTERNS = [
  { name: 'node_modules', regex: /(^|\/)node_modules(\/|$)/ },
  { name: 'backend_node_modules', regex: /^backend\/node_modules(\/|$)/ },
  { name: 'frontend_node_modules', regex: /^frontend\/node_modules(\/|$)/ },
  { name: 'env_file', regex: /(^|\/)\.env$/ },
  { name: 'backend_env_file', regex: /^backend\/\.env$/ },
  { name: 'frontend_env_file', regex: /^frontend\/\.env$/ },
  { name: 'sqlite_runtime', regex: /^backend\/data\/[^/]+\.sqlite(?:$|-.*$)/ },
  { name: 'sqlite_wal_shm', regex: /^backend\/data\/[^/]+\.sqlite-(?:wal|shm)$/ },
  { name: 'sqlite_migration_backup', regex: /^backend\/data\/db-before-sqlite-migration-/ },
  { name: 'sqlite_snapshot_test_data', regex: /^backend\/data\/snapshot-sqlite-test-/ },
  { name: 'backend_test_results', regex: /^backend\/test-results(\/|$)/ },
  { name: 'uploads', regex: /(^|\/)uploads(\/|$)/ },
  { name: 'outputs', regex: /(^|\/)outputs(\/|$)/ },
  { name: 'backups', regex: /^backups(\/|$)/ },
  { name: 'vision_tmp', regex: /^\.vision-tmp(\/|$)/ },
  { name: 'frontend_dist', regex: /^frontend\/dist(\/|$)/ },
  { name: 'dev_server_log', regex: /(^|\/)dev-server[^/]*\.log$/ },
  { name: 'log_file', regex: /(^|\/)[^/]+\.log$/ }
];

const PROJECT_PREFIX = /^crossborder-image-agent\//;

export function normalizeZipEntry(entry) {
  return String(entry || '')
    .replace(/\\/g, '/')
    .replace(/^\/+/, '')
    .replace(PROJECT_PREFIX, '');
}

export function findForbiddenEntries(entries) {
  const normalized = entries.map(normalizeZipEntry).filter(Boolean);
  const matches = [];
  for (const entry of normalized) {
    const pattern = FORBIDDEN_PATTERNS.find((item) => item.regex.test(entry));
    if (pattern) matches.push({ entry, pattern: pattern.name });
  }
  return matches;
}

export function hasEntry(entries, expected) {
  const normalizedExpected = normalizeZipEntry(expected);
  return entries.map(normalizeZipEntry).includes(normalizedExpected);
}

function findEndOfCentralDirectory(buffer) {
  const signature = 0x06054b50;
  const minOffset = Math.max(0, buffer.length - 0xffff - 22);
  for (let offset = buffer.length - 22; offset >= minOffset; offset -= 1) {
    if (buffer.readUInt32LE(offset) === signature) return offset;
  }
  throw new Error('Invalid ZIP: end of central directory was not found.');
}

export function listZipEntries(zipPath) {
  const buffer = fs.readFileSync(zipPath);
  const eocdOffset = findEndOfCentralDirectory(buffer);
  const entryCount = buffer.readUInt16LE(eocdOffset + 10);
  const centralDirectoryOffset = buffer.readUInt32LE(eocdOffset + 16);
  const entries = [];
  let offset = centralDirectoryOffset;

  for (let index = 0; index < entryCount; index += 1) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) {
      throw new Error(`Invalid ZIP: central directory entry ${index + 1} is malformed.`);
    }
    const flags = buffer.readUInt16LE(offset + 8);
    const fileNameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const nameStart = offset + 46;
    const nameEnd = nameStart + fileNameLength;
    const encoding = (flags & 0x0800) ? 'utf8' : 'latin1';
    entries.push(buffer.toString(encoding, nameStart, nameEnd));
    offset = nameEnd + extraLength + commentLength;
  }

  return entries;
}

export function validateReleaseEntries(entries) {
  const normalizedEntries = entries.map(normalizeZipEntry).filter(Boolean);
  const forbidden = findForbiddenEntries(normalizedEntries);
  return {
    totalEntries: normalizedEntries.length,
    forbiddenCount: forbidden.length,
    forbidden,
    containsPackageLock: hasEntry(normalizedEntries, 'backend/package-lock.json') && hasEntry(normalizedEntries, 'frontend/package-lock.json'),
    containsEnvExample: hasEntry(normalizedEntries, '.env.example'),
    containsRealEnv: normalizedEntries.some((entry) => /(^|\/)\.env$/.test(entry)),
    containsSqliteRuntime: normalizedEntries.some((entry) => /^backend\/data\/[^/]+\.sqlite(?:$|-.*$)/.test(entry)),
    containsUploadsOutputsBackups: normalizedEntries.some((entry) => /(^|\/)(uploads|outputs)(\/|$)|^backups(\/|$)/.test(entry))
  };
}

export function validateReleasePackage(zipPath) {
  return validateReleaseEntries(listZipEntries(zipPath));
}

function runCli() {
  const zipPath = process.argv[2];
  if (!zipPath) {
    console.error('Usage: node scripts/validate-release-package.mjs <release.zip>');
    process.exit(2);
  }
  const resolved = path.resolve(zipPath);
  const result = validateReleasePackage(resolved);
  const includeFullForbiddenList = process.argv.includes('--full');
  const printable = includeFullForbiddenList
    ? { zipPath: resolved, ...result }
    : {
        zipPath: resolved,
        ...result,
        forbiddenSample: result.forbidden.slice(0, 50),
        forbidden: undefined
      };
  console.log(JSON.stringify(printable, null, 2));
  if (result.forbiddenCount > 0 || result.containsRealEnv || result.containsSqliteRuntime || result.containsUploadsOutputsBackups) {
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCli();
}
