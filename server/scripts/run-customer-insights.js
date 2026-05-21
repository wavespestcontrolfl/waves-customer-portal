#!/usr/bin/env node
/**
 * run-customer-insights.js — manual invocation for customer-insights-miner.
 *
 * Read-only against call_log / messages / google_reviews / messaging_suppression.
 * Writes (if --persist) only to customer_insight_clusters — cluster aggregates,
 * never raw transcripts.
 *
 * Usage:
 *   node server/scripts/run-customer-insights.js
 *   node server/scripts/run-customer-insights.js --days=180 --no-persist
 *   node server/scripts/run-customer-insights.js --json
 *
 * Recommended first run: --no-persist to verify zero PII leaks visually.
 *
 * For prod:
 *   railway run -s Postgres -- bash -c '
 *     DATABASE_URL=$DATABASE_PUBLIC_URL \
 *       node server/scripts/run-customer-insights.js --no-persist
 *   '
 */

const db = require('../models/db');
const miner = require('../services/content/customer-insights-miner');

const ARGS = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    if (!a.startsWith('--')) return [a, true];
    const [k, v] = a.slice(2).split('=');
    return [k, v === undefined ? true : v];
  })
);

const DAYS = parseInt(ARGS.days || 90, 10);
const PERSIST = !ARGS['no-persist'];
const JSON_OUT = !!ARGS.json;

(async function main() {
  try {
    const t0 = Date.now();
    const result = await miner.mineAll({ days: DAYS, persist: PERSIST });
    const ms = Date.now() - t0;

    if (JSON_OUT) {
      process.stdout.write(JSON.stringify(result, null, 2));
      await db.destroy();
      return;
    }

    console.log(`\n── Customer Insights Mine (${DAYS}d, ${ms}ms) ──\n`);

    console.log('Eligibility summary:');
    const e = result.eligibility_summary;
    console.log(`  records seen:     ${e.records_seen}`);
    console.log(`  records admitted: ${e.records_admitted}`);
    console.log(`  records excluded: ${e.records_excluded}`);
    for (const [reason, n] of Object.entries(e.exclusion_reasons || {})) {
      console.log(`    - ${reason.padEnd(30)} ${n}`);
    }

    console.log(`\nClusters detected: ${result.cluster_count}`);
    console.log(`Qualifying (≥ threshold): ${result.qualifying_count}`);
    console.log(`Persisted: ${result.persisted}\n`);

    console.log('Top 20 clusters:');
    console.log('  #  | total | sms / call / review |  conf  | topic                       | city            | example');
    console.log('  ---+-------+---------------------+--------+-----------------------------+-----------------+---------');
    for (let i = 0; i < Math.min(20, result.clusters.length); i++) {
      const c = result.clusters[i];
      const counts = `${(c.source_counts.sms || 0)} / ${(c.source_counts.call || 0)} / ${(c.source_counts.review || 0)}`;
      const example = (c.example_phrasing_anonymized || '').slice(0, 80).replace(/\s+/g, ' ');
      console.log(
        `  ${String(i + 1).padStart(2)} | ${String(c.total_count).padStart(5)} | ${counts.padEnd(19)} | ${(c.redaction_confidence || '?').padEnd(6)} | ${c.topic.padEnd(27)} | ${(c.city || '—').padEnd(15)} | ${example}`
      );
    }
    console.log('');
    await db.destroy();
  } catch (err) {
    console.error('Insights miner failed:', err);
    await db.destroy().catch(() => {});
    process.exit(1);
  }
})();
