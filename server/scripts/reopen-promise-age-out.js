#!/usr/bin/env node
/**
 * Reopen the promises one run of the promise age-out dismissed (server/services/promise-age-out.js).
 *
 * Without --run it lists the runs whose dismissals still stand, read from the promises themselves: every
 * dismissed promise carries its run id, so the list does not need the run's audit_log row.
 *
 * With --run it finds the promises that still carry that run's marker and, with --apply, sets them open again,
 * each with the proof it carried before the run (most carried none), and puts back the alerts that run closed for
 * them. A promise a person has since settled or reopened no longer matches and is left alone. Dry run by default.
 * Prints counts only.
 *
 * A reopened promise that is still past the 30-day limit expires again on the next nightly run, so use this after
 * the rule changed. One promise is reopened for good from the Owed tab's "Closed automatically" list.
 *
 * Run:
 *   node server/scripts/reopen-promise-age-out.js                           (list the runs)
 *   node server/scripts/reopen-promise-age-out.js --run <run id>            (dry run)
 *   node server/scripts/reopen-promise-age-out.js --run <run id> --apply    (write)
 */
const db = require('../models/db');
const { reopenPromiseAgeOut, listPromiseAgeOutRuns } = require('../services/promise-age-out');

const USAGE = 'Usage: node server/scripts/reopen-promise-age-out.js [--run <run id> [--apply]]';

async function listRuns() {
  const runs = await listPromiseAgeOutRuns();
  console.log(runs.length ? '[reopen-promise-age-out] runs whose dismissals still stand (run id: promises):' : '[reopen-promise-age-out] no promise is dismissed by an age-out run');
  runs.forEach(({ run, promises }) => console.log(`  ${run}: ${promises}`));
  console.log(USAGE);
}

async function main(argv) {
  if (!argv.includes('--run')) return listRuns();
  const apply = argv.includes('--apply');
  const run = argv[argv.indexOf('--run') + 1];
  if (!run || Number.isNaN(new Date(run).getTime())) {
    console.error(USAGE);
    process.exitCode = 1;
    return undefined;
  }
  const result = await reopenPromiseAgeOut({ run, apply });
  console.log(`[reopen-promise-age-out] ${apply ? 'APPLY' : 'DRY-RUN'} run ${run}: ${result.found.total} promise(s) still dismissed by that run`);
  Object.entries(result.found.byChannel).forEach(([channel, n]) => console.log(`  ${channel}: ${n}`));
  if (apply) console.log(`[reopen-promise-age-out] reopened ${result.reopened} promise(s) and ${result.alertsReopened} alert(s)`);
  else if (result.found.total) console.log('[reopen-promise-age-out] add --apply to reopen them');
  return undefined;
}

main(process.argv.slice(2))
  .catch((err) => { console.error(`[reopen-promise-age-out] failed: ${err.message}`); process.exitCode = 1; })
  .finally(() => db.destroy());
