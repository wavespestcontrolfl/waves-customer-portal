#!/usr/bin/env node
/**
 * Dry run of the admin alert quiet policy (runAdminAlertQuietPolicy in server/services/admin-alert-retention.js).
 *
 * Read-only: only SELECTs. It runs the policy in shadow mode with no cursor and no audit record, and prints how many
 * open bell alerts have had no new activity for 72 hours and would be marked done, by category. Counts only; no alert
 * text. Ignores GATE_ALERT_QUIET_FALL_OFF (it is a preview).
 *
 * Run: node server/scripts/quiet-fall-off-dry-run.js
 */
const db = require('../models/db');
const retention = require('../services/admin-alert-retention');

async function main() {
  const io = { ...retention.defaultQuietIo(db), loadCursor: async () => null, saveCursor: async () => {}, record: async () => {} };
  const summary = await retention.runAdminAlertQuietPolicy({ mode: 'shadow', io, maxBatches: 1000 });
  console.log(`[quiet-fall-off] DRY-RUN: ${summary.expire.total} open bell alert(s) quiet for ${retention.QUIET_HOURS}+ hours would be marked done`);
  Object.entries(summary.expire.byCategory).sort((a, b) => b[1] - a[1]).forEach(([category, n]) => console.log(`  ${category}: ${n}`));
  console.log(`[quiet-fall-off] held (an emitter raises it again by itself): ${summary.held.periodic}`);
  console.log(`[quiet-fall-off] kept until settled: ${retention.KEEP_UNTIL_SETTLED_CATEGORIES.join(', ') || '(none)'}`);
}

main()
  .catch((err) => { console.error(`[quiet-fall-off] failed: ${err.message}`); process.exitCode = 1; })
  .finally(() => db.destroy());
