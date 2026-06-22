#!/usr/bin/env node
/**
 * Mark a completed_pending_review autonomous run as trust-build approved.
 *
 * Usage:
 *   node server/scripts/approve-autonomous-run.js --id=<run_uuid> --by=adam
 *
 * Intended for Railway/operator use after reviewing the stored
 * autonomous_runs.draft_payload + gate snapshots.
 */

const db = require('../models/db');

const ARGS = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    if (!a.startsWith('--')) return [a, true];
    const stripped = a.slice(2);
    const eq = stripped.indexOf('=');
    if (eq === -1) return [stripped, true];
    return [stripped.slice(0, eq), stripped.slice(eq + 1)];
  })
);

const RUN_ID = String(ARGS.id || '').trim();
const APPROVED_BY = String(ARGS.by || process.env.USER || 'operator').trim().slice(0, 100);

if (!RUN_ID) {
  console.error('Usage: node server/scripts/approve-autonomous-run.js --id=<run_uuid> [--by=name]');
  process.exit(2);
}

(async function main() {
  try {
    const updated = await db('autonomous_runs')
      .where('id', RUN_ID)
      .where('outcome', 'completed_pending_review')
      .where('shadow_mode', false)
      // Approvable pending-review runs: trust-build ramp + named-competitor
      // comparisons (which never auto-publish — a human approves each one).
      .where((qb) => qb
        .where('skip_reason', 'like', 'trust_build_%')
        .orWhere('skip_reason', 'named_competitor_review'))
      .update({
        trust_build_approved_at: new Date(),
        trust_build_approved_by: APPROVED_BY,
        updated_at: new Date(),
      });

    if (!updated) {
      console.error(`No live trust_build completed_pending_review autonomous run found for id=${RUN_ID}`);
      process.exitCode = 1;
      return;
    }

    console.log(`Approved autonomous run ${RUN_ID} for trust-build credit by ${APPROVED_BY}`);
  } finally {
    await db.destroy().catch(() => {});
  }
})();
