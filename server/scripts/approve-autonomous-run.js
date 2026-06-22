#!/usr/bin/env node
/**
 * Approve a completed_pending_review autonomous run after operator review.
 *
 * Two parked kinds are handled:
 *   - trust_build_<n>_of_<m> → stamp trust-build credit (the draft itself is not
 *     published; credit graduates the action type toward auto-publish).
 *   - named_competitor_review → PUBLISH the reviewed draft (PR or live) via the
 *     autonomous runner, then complete the opportunity. A human signs off on
 *     every competitor naming.
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
    const run = await db('autonomous_runs')
      .where('id', RUN_ID)
      .where('outcome', 'completed_pending_review')
      .where('shadow_mode', false)
      .first();

    if (!run) {
      console.error(`No live completed_pending_review autonomous run found for id=${RUN_ID}`);
      process.exitCode = 1;
      return;
    }

    if (run.skip_reason === 'named_competitor_review') {
      // Publish the reviewed draft (PR or live) + complete the opportunity.
      // The runner atomically claims + publishes + owns the final opportunity/run
      // state (done for live; parked as astro_pr_pending_merge for a PR).
      const runner = require('../services/content/autonomous-runner');
      const result = await runner.approveAndPublishNamedCompetitor(run.opportunity_id, { approvedBy: APPROVED_BY });
      console.log(`Named-competitor run ${RUN_ID} approved by ${APPROVED_BY} → ${result.published_url || result.astro_pr_url || result.publish_status || 'submitted'}`);
      return;
    }

    if (/^trust_build_\d+_of_\d+$/.test(String(run.skip_reason || ''))) {
      await db('autonomous_runs').where('id', RUN_ID).update({
        trust_build_approved_at: new Date(),
        trust_build_approved_by: APPROVED_BY,
        updated_at: new Date(),
      });
      console.log(`Approved autonomous run ${RUN_ID} for trust-build credit by ${APPROVED_BY}`);
      return;
    }

    console.error(`Run ${RUN_ID} is parked as '${run.skip_reason}', which is not an approvable kind (expected trust_build_* or named_competitor_review)`);
    process.exitCode = 1;
  } finally {
    await db.destroy().catch(() => {});
  }
})();
