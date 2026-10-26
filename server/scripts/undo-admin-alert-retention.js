#!/usr/bin/env node
/**
 * Undo one admin alert retention run (server/services/admin-alert-retention.js).
 *
 * Reopens the rows that run expired, found by their metadata.retention.run
 * stamp: done_at, done_by and resolution are cleared, the stamp is replaced by
 * metadata.retentionUndone {run, at}. read_at was never touched by retention,
 * so each row comes back exactly as it stood. A row a later closer took (an
 * emitter's own close, a person) no longer has done_by 'retention' and is left
 * alone. Reopened rows are old, so they sit low in the newest-first bell, and
 * the next nightly run expires them again unless GATE_ALERT_RETENTION is unset.
 *
 * Run:
 *   node server/scripts/undo-admin-alert-retention.js                        (list runs)
 *   node server/scripts/undo-admin-alert-retention.js --run <run id>         (dry run)
 *   node server/scripts/undo-admin-alert-retention.js --run <run id> --execute  (write)
 * The run id is the ISO time in the audit_log row (admin_alert_retention.expire,
 * metadata.runId) or in the list above.
 */
const db = require('../models/db');
const { undoRetentionRun, listRetentionRuns } = require('../services/admin-alert-retention');

async function main(argv) {
  const execute = argv.includes('--execute');
  const at = argv.indexOf('--run');
  const run = at >= 0 ? argv[at + 1] : null;
  if (!run) {
    const runs = await listRetentionRuns();
    console.log(runs.length ? 'Retention runs with rows still expired:' : 'No retention run has rows still expired.');
    runs.forEach((r) => console.log(`  ${r.run}  ${r.rows} rows`));
    return;
  }
  const result = await undoRetentionRun({ run, execute });
  console.log(`[undo-retention] ${execute ? 'EXECUTE' : 'DRY-RUN'} run ${run}: ${result.found} rows expired by it`);
  if (execute) console.log(`[undo-retention] reopened ${result.reopened}`);
  else if (result.found) console.log('[undo-retention] add --execute to reopen them');
}

main(process.argv.slice(2))
  .catch((err) => { console.error(`[undo-retention] failed: ${err.message}`); process.exitCode = 1; })
  .finally(() => db.destroy());
