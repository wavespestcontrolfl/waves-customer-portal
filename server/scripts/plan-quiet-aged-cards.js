#!/usr/bin/env node
/**
 * Dry run for the quiet_aged rule of the nightly triage sweep (owner ruling 2026-11-09). Reads only, writes nothing.
 * Prints what the next sweep would dismiss: counts by reason code and severity, the total, and how many fit under the
 * per-run cap. Uses the same candidate rows and classifier as the sweep, so a card an evidence rule would close is not
 * counted.
 *
 * Run:
 *   node server/scripts/plan-quiet-aged-cards.js              (evidence rules as this process's gates read them)
 *   node server/scripts/plan-quiet-aged-cards.js --evidence    (evaluate the evidence rules even if their gate is off here)
 */
const db = require('../models/db');
const { planQuietAged, MAX_TRANSITIONS_PER_RUN, QUIET_AGE_DAYS } = require('../services/triage-auto-resolve');

async function main(argv) {
  const ignoreGate = argv.includes('--evidence');
  const plan = await planQuietAged({ ignoreGate });
  console.log(`[plan-quiet-aged-cards] DRY-RUN (no writes), evidence rules ${ignoreGate ? 'forced on' : 'per this process gate'}: scanned ${plan.scanned} open card(s)`);
  console.log(`  would dismiss (quiet ${QUIET_AGE_DAYS}+ days): ${plan.total}; other rules pending: ${plan.otherRulesPending}; next run applies ${plan.wouldApplyNextRun} (cap ${MAX_TRANSITIONS_PER_RUN})`);
  Object.entries(plan.byReason).sort((a, b) => b[1].total - a[1].total).forEach(([code, b]) => {
    const sev = Object.entries(b.bySeverity).map(([k, n]) => `${k} ${n}`).join(', ');
    console.log(`  ${code}: ${b.total} (${sev})`);
  });
}

main(process.argv.slice(2))
  .catch((err) => { console.error(`[plan-quiet-aged-cards] failed: ${err.message}`); process.exitCode = 1; })
  .finally(() => db.destroy());
