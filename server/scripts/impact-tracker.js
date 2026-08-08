#!/usr/bin/env node
/**
 * impact-tracker.js — run the content-optimization impact sweep and show
 * verdicts. Read-only against gsc_pages; writes content_optimization_impact.
 *
 * Usage:
 *   node server/scripts/impact-tracker.js sweep      # baseline new + measure pending
 *   node server/scripts/impact-tracker.js verdicts   # show recorded verdicts
 *   node server/scripts/impact-tracker.js paused      # buckets at regression threshold
 *   node server/scripts/impact-tracker.js digest      # PREVIEW the ops emails (never sends)
 *
 * For prod data:
 *   railway run -s Postgres -- bash -c '
 *     DATABASE_URL=$DATABASE_PUBLIC_URL \
 *       node server/scripts/impact-tracker.js sweep
 *   '
 */

const db = require('../models/db');
const tracker = require('../services/seo/impact-tracker');

async function main() {
  const cmd = process.argv[2] || 'sweep';
  switch (cmd) {
    case 'sweep': {
      const live = await tracker.sweepNewlyLive({ db });
      const checked = await tracker.checkPending({ db });
      console.log('baselines created:', JSON.stringify(live));
      console.log('windows checked:  ', JSON.stringify({ checked: checked.checked, scanned: checked.scanned }));
      if (checked.paused_buckets?.length) console.log('PAUSED buckets:   ', JSON.stringify(checked.paused_buckets));
      break;
    }
    case 'verdicts': {
      const rows = await db('content_optimization_impact')
        .orderBy('updated_at', 'desc').limit(50)
        .select('page_url', 'bucket', 'verdict', 'verdict_confidence', 'estimated_lift_position', 'estimated_lift_clicks_pct', 'checked_21d_at');
      console.log(`\n${rows.length} impact row(s):`);
      for (const r of rows) {
        const v = r.verdict || 'pending';
        const lift = r.estimated_lift_position != null ? `pos ${r.estimated_lift_position} / clicks ${r.estimated_lift_clicks_pct}%` : '—';
        console.log(`  [${v}] ${r.page_url}  bucket=${r.bucket || '—'}  conf=${r.verdict_confidence ?? '—'}  lift: ${lift}`);
      }
      break;
    }
    case 'paused': {
      const paused = await tracker.pausedBuckets({ db });
      if (!paused.length) console.log('No buckets at the regression-pause threshold.');
      for (const p of paused) console.log(`  PAUSED: ${p.bucket} — ${p.regressions} regressions`);
      break;
    }
    // Preview only — composes the exact subjects/bodies the daily leg would
    // send, without the gate, the markers, or the mailer. Lets the digest be
    // eyeballed before GATE_IMPACT_DIGEST is flipped on.
    case 'digest': {
      const digest = require('../services/seo/impact-verdict-digest');
      const { BLIND_LOOP_DAYS, ROLLUP_WINDOW_DAYS } = digest.THRESHOLDS;
      const { checkedSince } = digest._internals;
      const { addETDays } = require('../utils/datetime-et');

      const paused = await tracker.pausedBuckets({ db });
      const blindRows = await checkedSince(db, addETDays(new Date(), -BLIND_LOOP_DAYS));
      const blindCounts = digest._internals.tallyVerdicts(blindRows);
      const rollupRows = await checkedSince(db, addETDays(new Date(), -ROLLUP_WINDOW_DAYS));

      const composed = [
        ['paused-lane', digest.composePausedAlert(paused)],
        ['blind-loop', ['improved', 'neutral', 'regressed'].some((k) => blindCounts[k] > 0)
          ? null
          : digest.composeBlindLoopAlert({ checked: blindCounts.insufficient_data })],
        ['weekly-rollup', digest.composeVerdictRollup(rollupRows)],
      ];
      for (const [name, email] of composed) {
        if (!email) { console.log(`\n[${name}] nothing to send (quiet — this is the normal case)`); continue; }
        console.log(`\n[${name}] SUBJECT: ${email.subject}\n${email.text}`);
      }
      break;
    }
    default:
      console.log('commands: sweep | verdicts | paused | digest');
  }
}

main().then(() => process.exit(0)).catch((err) => {
  console.error('impact-tracker failed:', err.message);
  process.exit(1);
});
