#!/usr/bin/env node
/**
 * Reopen the promises one run of the promise age-out dismissed (server/services/promise-age-out.js).
 *
 * Finds the promises that still carry that run's marker and, with --apply, sets them open again with no proof. A
 * promise a person has since settled or reopened no longer matches and is left alone. Dry run by default. Prints
 * counts only. The run id is the runId in the run's audit_log row (action promise_age_out.expire).
 *
 * A reopened promise that is still past the 30-day limit expires again on the next nightly run, so use this after
 * the rule changed. One promise is reopened for good from the Owed tab's "Closed automatically" list.
 *
 * Run:
 *   node server/scripts/reopen-promise-age-out.js --run <run id>            (dry run)
 *   node server/scripts/reopen-promise-age-out.js --run <run id> --apply    (write)
 */
const db = require('../models/db');
const { reopenPromiseAgeOut } = require('../services/promise-age-out');

async function main(argv) {
  const apply = argv.includes('--apply');
  const run = argv.includes('--run') ? argv[argv.indexOf('--run') + 1] : null;
  if (!run || Number.isNaN(new Date(run).getTime())) {
    console.error('Usage: node server/scripts/reopen-promise-age-out.js --run <run id> [--apply]');
    process.exitCode = 1;
    return;
  }
  const result = await reopenPromiseAgeOut({ run, apply });
  console.log(`[reopen-promise-age-out] ${apply ? 'APPLY' : 'DRY-RUN'} run ${run}: ${result.found.total} promise(s) still dismissed by that run`);
  Object.entries(result.found.byChannel).forEach(([channel, n]) => console.log(`  ${channel}: ${n}`));
  if (apply) console.log(`[reopen-promise-age-out] reopened ${result.reopened}`);
  else if (result.found.total) console.log('[reopen-promise-age-out] add --apply to reopen them');
}

main(process.argv.slice(2))
  .catch((err) => { console.error(`[reopen-promise-age-out] failed: ${err.message}`); process.exitCode = 1; })
  .finally(() => db.destroy());
