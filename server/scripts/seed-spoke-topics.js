#!/usr/bin/env node
/**
 * Seed the curated per-spoke blog topics (server/data/spoke-seed-topics-v1.json)
 * into opportunity_queue as operator-pinned 'operator_intercept' rows tagged
 * spoke_seed=true + target_sites=[<spoke>].
 *
 * Usage:
 *   node server/scripts/seed-spoke-topics.js --dry-run     # print, no writes
 *   node server/scripts/seed-spoke-topics.js               # upsert all
 *   node server/scripts/seed-spoke-topics.js --file=path   # alternate manifest
 *
 * Idempotent: dedupe_key `spoke:v1:<id>` + ON CONFLICT DO UPDATE.
 * Re-running refreshes payload/score/window without duplicating rows and never
 * resets a claimed/done/pending_review row.
 */

const seeder = require('../services/content/spoke-seed-seeder');

const ARGS = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    if (!a.startsWith('--')) return [a, true];
    const stripped = a.slice(2);
    const eq = stripped.indexOf('=');
    if (eq === -1) return [stripped, true];
    return [stripped.slice(0, eq), stripped.slice(eq + 1)];
  })
);

const dryRun = !!(ARGS['dry-run'] || ARGS.dryrun);
const file = ARGS.file ? String(ARGS.file) : undefined;

(async function main() {
  try {
    const result = await seeder.seedAll({ ...(file ? { file } : {}), dryRun });
    if (result.disabled) {
      console.log('Spoke blog network is DISABLED — all blog content publishes to the hub (wavespestcontrol.com) only.');
      console.log('No spoke topics were seeded. Set SPOKE_BLOG_NETWORK_ENABLED=true to re-enable the per-spoke blog lane.');
      process.exit(0);
    }
    for (const row of result.rows) {
      const window = row.available_at
        ? `available ${row.available_at.toISOString().slice(0, 10)}`
        : 'available now';
      const site = (row.signal_metadata && row.signal_metadata.spoke_target_site) || '?';
      console.log(`${dryRun ? '[dry-run] ' : ''}${row.dedupe_key}  ${row.action_type}  score=${row.score}  → ${site}  ${window}`);
    }
    console.log(`${dryRun ? '[dry-run] would seed' : 'Seeded'} ${result.rows.length} spoke topic(s).`);
    process.exit(0);
  } catch (err) {
    console.error(`seed-spoke-topics failed: ${err.message}`);
    process.exit(1);
  }
})();
