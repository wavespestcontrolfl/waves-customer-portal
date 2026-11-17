#!/usr/bin/env node
/**
 * Dry run of the promise age-out (runPromiseAgeOut in server/services/promise-age-out.js).
 *
 * Read-only: only SELECTs. Prints how many open promises nobody touched are past the 30-day limit and would be
 * dismissed, by channel, by party and by kind. Counts only; no promise text and no customer.
 *
 * Run: node server/scripts/promise-age-out-dry-run.js
 */
const db = require('../models/db');
const { runPromiseAgeOut, AGE_OUT_DAYS } = require('../services/promise-age-out');

const lines = (counts) => Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([name, n]) => `  ${name}: ${n}`);

async function main() {
  const summary = await runPromiseAgeOut({ dryRun: true });
  console.log(`[promise-age-out] DRY-RUN: ${summary.expired.total} open promise(s) past ${AGE_OUT_DAYS} days would be dismissed (last date before ${summary.cutoff})`);
  if (!summary.complete) console.log(`[promise-age-out] PARTIAL: the scan stopped at its page limit; the real total is at least ${summary.expired.total}`);
  console.log(['by channel:', ...lines(summary.expired.byChannel), 'by party:', ...lines(summary.expired.byParty), 'by kind:', ...lines(summary.expired.byKind)].join('\n'));
}

main()
  .catch((err) => { console.error(`[promise-age-out] failed: ${err.message}`); process.exitCode = 1; })
  .finally(() => db.destroy());
