#!/usr/bin/env node
/**
 * Reopen the call review cards the quiet_aged rule dismissed (the nightly triage sweep,
 * server/services/triage-auto-resolve.js, owner ruling 2026-11-09).
 *
 * Finds cards with resolution_rule 'quiet_aged' that are still dismissed and were closed at or after --since and,
 * with --apply, puts them back (status 'open', resolution fields cleared, call_log.review_status re-synced under the
 * per-call triage lock). A card a person closed since no longer carries that rule and is left alone. A card whose call
 * already holds a live card of the same reason (a reprocess filed a fresh one) is skipped. Reopened cards restart the
 * 7-day clock, so turn GATE_TRIAGE_AUTO_RESOLVE off first or they fall off again in a week.
 * Dry run by default. Prints counts only.
 *
 * Run:
 *   node server/scripts/reopen-quiet-aged-cards.js --since <ISO time>            (dry run)
 *   node server/scripts/reopen-quiet-aged-cards.js --since <ISO time> --apply    (write)
 */
const db = require('../models/db');
const { reopenQuietAged } = require('../services/triage-auto-resolve');

async function main(argv) {
  const apply = argv.includes('--apply');
  const since = argv.includes('--since') ? argv[argv.indexOf('--since') + 1] : null;
  if (!since || Number.isNaN(new Date(since).getTime())) {
    console.error('Usage: node server/scripts/reopen-quiet-aged-cards.js --since <ISO time> [--apply]');
    process.exitCode = 1;
    return;
  }
  const result = await reopenQuietAged({ since, apply });
  console.log(`[reopen-quiet-aged-cards] ${apply ? 'APPLY' : 'DRY-RUN'} since ${since}: ${result.found} card(s) dismissed by quiet_aged`);
  console.log(`  can reopen: ${result.reopenable}; skipped (call already has a live card of that reason): ${result.skippedHasLiveCard}; skipped (duplicate dismissal): ${result.skippedDuplicate}`);
  Object.entries(result.byReason).sort((a, b) => b[1] - a[1]).forEach(([code, n]) => console.log(`  ${code}: ${n}`));
  if (apply) console.log(`[reopen-quiet-aged-cards] reopened ${result.reopened}`);
  else if (result.reopenable) console.log('[reopen-quiet-aged-cards] add --apply to reopen them');
}

main(process.argv.slice(2))
  .catch((err) => { console.error(`[reopen-quiet-aged-cards] failed: ${err.message}`); process.exitCode = 1; })
  .finally(() => db.destroy());
