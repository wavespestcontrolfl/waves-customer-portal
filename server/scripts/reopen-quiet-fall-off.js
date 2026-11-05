#!/usr/bin/env node
/**
 * Reopen the admin alerts the quiet fall-off closed (the quiet policy in server/services/admin-alert-retention.js).
 *
 * Finds rows with done_by 'quiet-72h' closed at or after --since and, with --apply, puts them back in the bell
 * (done fields cleared, metadata.quietHoldFrom stamped, so the rule waits 72 more hours). A row a later closer
 * took no longer has done_by 'quiet-72h' and is left alone. Dry run by default. Prints counts only.
 *
 * Run:
 *   node server/scripts/reopen-quiet-fall-off.js --since <ISO time>            (dry run)
 *   node server/scripts/reopen-quiet-fall-off.js --since <ISO time> --apply    (write)
 *   node server/scripts/reopen-quiet-fall-off.js --run <run id> [--apply]      (one run, from the audit_log row)
 */
const db = require('../models/db');
const { reopenQuietFallOff } = require('../services/admin-alert-retention');

async function main(argv) {
  const apply = argv.includes('--apply');
  const arg = (name) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : null);
  const since = arg('--since');
  const run = arg('--run');
  if ((!since || Number.isNaN(new Date(since).getTime())) && !run) {
    console.error('Usage: node server/scripts/reopen-quiet-fall-off.js (--since <ISO time> | --run <run id>) [--apply]');
    process.exitCode = 1;
    return;
  }
  const result = await reopenQuietFallOff({ since, run, apply });
  console.log(`[reopen-quiet-fall-off] ${apply ? 'APPLY' : 'DRY-RUN'} ${run ? `run ${run}` : `since ${since}`}: ${result.found} row(s) closed by quiet-72h`);
  Object.entries(result.byCategory).sort((a, b) => b[1] - a[1]).forEach(([category, n]) => console.log(`  ${category}: ${n}`));
  if (apply) console.log(`[reopen-quiet-fall-off] reopened ${result.reopened}`);
  else if (result.found) console.log('[reopen-quiet-fall-off] add --apply to reopen them');
}

main(process.argv.slice(2))
  .catch((err) => { console.error(`[reopen-quiet-fall-off] failed: ${err.message}`); process.exitCode = 1; })
  .finally(() => db.destroy());
