#!/usr/bin/env node
/**
 * run-conversion-feedback.js — manual invocation for the conversion
 * feedback miner. Computes per-(city, service) 90-day conversion
 * rollups from leads / estimates / call_log.
 *
 * Read-only against the source tables; writes (if --persist) only to
 * conversion_feedback_snapshots.
 *
 * Usage:
 *   node server/scripts/run-conversion-feedback.js
 *   node server/scripts/run-conversion-feedback.js --window=180 --no-persist
 *   node server/scripts/run-conversion-feedback.js --json
 *
 * For prod (recommended first run: --no-persist):
 *   railway run -s Postgres -- bash -c '
 *     DATABASE_URL=$DATABASE_PUBLIC_URL \
 *       node server/scripts/run-conversion-feedback.js --no-persist
 *   '
 */

const db = require('../models/db');
const miner = require('../services/seo/conversion-feedback-miner');

const ARGS = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    if (!a.startsWith('--')) return [a, true];
    const [k, v] = a.slice(2).split('=');
    return [k, v === undefined ? true : v];
  })
);

const WINDOW = parseInt(ARGS.window || 90, 10);
const PERSIST = !ARGS['no-persist'];
const JSON_OUT = !!ARGS.json;

(async function main() {
  try {
    const t0 = Date.now();
    const result = await miner.mineWindow({ windowDays: WINDOW, persist: PERSIST });
    const ms = Date.now() - t0;

    if (JSON_OUT) {
      process.stdout.write(JSON.stringify(result, null, 2));
      await db.destroy();
      return;
    }

    console.log(`\n── Conversion Feedback (${WINDOW}d ending ${result.window_end_date}, ${ms}ms) ──\n`);
    console.log(`Rollups computed: ${result.rollup_count}   Persisted: ${result.persisted}\n`);

    console.log('Top 15 by combined score:');
    console.log('  city            | service       | leads | forms | calls(b) | est(a)  | revenue       | close% | $/lead  | LQS CR  RR');
    console.log('  ----------------+---------------+-------+-------+----------+---------+---------------+--------+---------+-----------');
    for (const r of result.rollups.slice(0, 15)) {
      const city = (r.city === '_global' ? '(unattributed)' : r.city).padEnd(15);
      const service = (r.service === '_global' ? '(any)' : r.service).padEnd(13);
      const leads = String(r.leads_total).padStart(5);
      const forms = String(r.form_submissions).padStart(5);
      const calls = `${r.calls_handled}/${r.calls_booked}`.padStart(8);
      const ests = `${r.estimates_sent}/${r.estimates_accepted}`.padStart(7);
      const rev = `$${Math.round(r.estimated_revenue).toLocaleString()}`.padStart(13);
      const close = r.close_rate != null ? `${Math.round(r.close_rate * 100)}%`.padStart(6) : '   —  ';
      const perLead = r.leads_total > 0 ? `$${Math.round(r.estimated_revenue / r.leads_total).toLocaleString()}` : '—';
      console.log(
        `  ${city} | ${service} | ${leads} | ${forms} | ${calls} | ${ests} | ${rev} | ${close} | ${perLead.padStart(7)} | ${String(r.lead_quality_score).padStart(3)} ${String(r.close_rate_score).padStart(3)} ${String(r.revenue_realization_score).padStart(3)}`
      );
    }
    console.log('\n  LQS = leadQualityScore  CR = closeRateScore  RR = revenueRealizationScore');
    console.log('');
    await db.destroy();
  } catch (err) {
    console.error('Conversion miner failed:', err);
    await db.destroy().catch(() => {});
    process.exit(1);
  }
})();
