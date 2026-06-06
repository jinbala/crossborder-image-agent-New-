#!/usr/bin/env node
import '../src/config/env.js';
import { fileURLToPath } from 'node:url';
import { runSqliteTrialChecklist } from '../src/services/sqliteTrialChecklistService.js';

export async function runTrialCheckCli(options = {}) {
  const report = await runSqliteTrialChecklist();
  if (!options.silent) {
    console.log(JSON.stringify({
      status: report.overallStatus,
      storageDriver: report.storageDriver,
      sqlitePath: report.sqlitePath,
      schemaVersion: report.schemaVersion,
      recommendedAction: report.recommendedAction,
      counts: report.counts,
      items: report.items.map((item) => ({
        id: item.id,
        title: item.title,
        status: item.status,
        message: item.message
      })),
      rollback: report.rollback
    }, null, 2));
  }
  return report;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runTrialCheckCli().catch((err) => {
    console.error(JSON.stringify({
      status: 'failed',
      error: {
        code: err.code || 'SQLITE_TRIAL_CHECK_FAILED',
        message: err.message
      }
    }, null, 2));
    process.exitCode = 1;
  });
}
