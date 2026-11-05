#!/usr/bin/env node
/**
 * Dry run of the admin alert quiet fall-off (server/services/admin-alert-quiet-fall-off.js).
 *
 * Read-only: only SELECTs. Prints how many open bell alerts have had no new activity for 72 hours and would
 * be marked done, by category. Counts only; no alert text. Ignores GATE_ALERT_QUIET_FALL_OFF (it is a preview).
 *
 * Run: node server/scripts/quiet-fall-off-dry-run.js
 */
const db = require('../models/db');
const { selectCandidates, QUIET_HOURS, KEEP_UNTIL_SETTLED_CATEGORIES } = require('../services/admin-alert-quiet-fall-off');

async function main() {
  const now = new Date();
  const cutoff = new Date(now.getTime() - QUIET_HOURS * 60 * 60 * 1000);
  const byCategory = {};
  let total = 0;
  let cursor = null;
  for (;;) {
    const rows = await selectCandidates(db, { cutoff, now, cursor, limit: 500 });
    if (!rows.length) break;
    cursor = rows[rows.length - 1].id;
    rows.forEach((r) => { byCategory[r.category || 'unknown'] = (byCategory[r.category || 'unknown'] || 0) + 1; });
    total += rows.length;
  }
  console.log(`[quiet-fall-off] DRY-RUN: ${total} open bell alert(s) quiet for ${QUIET_HOURS}+ hours would be marked done`);
  Object.entries(byCategory).sort((a, b) => b[1] - a[1]).forEach(([category, n]) => console.log(`  ${category}: ${n}`));
  console.log(`[quiet-fall-off] kept until settled: ${KEEP_UNTIL_SETTLED_CATEGORIES.join(', ') || '(none)'}`);
}

main()
  .catch((err) => { console.error(`[quiet-fall-off] failed: ${err.message}`); process.exitCode = 1; })
  .finally(() => db.destroy());
