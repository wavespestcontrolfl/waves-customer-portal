#!/usr/bin/env node
/**
 * Seed the curated lawn / tree-shrub hub-blog topics
 * (server/data/category-seed-topics-v1.json) into opportunity_queue as
 * operator-pinned 'operator_intercept' rows tagged category_seed=true.
 *
 * Usage:
 *   node server/scripts/seed-category-topics.js --dry-run   # print, no writes
 *   node server/scripts/seed-category-topics.js             # upsert all
 *   node server/scripts/seed-category-topics.js --file=path # alternate manifest
 *
 * Idempotent: dedupe_key `catseed:v1:<id>` + ON CONFLICT DO UPDATE.
 * Re-running refreshes payload/score/window without duplicating rows and
 * never resets a claimed/done/pending_review row.
 */

const seeder = require('../services/content/category-seed-seeder');

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
    for (const row of result.rows) {
      const window = row.available_at
        ? `available ${row.available_at.toISOString().slice(0, 10)}`
        : 'available now';
      console.log(`${dryRun ? '[dry-run] ' : ''}${row.dedupe_key}  ${row.action_type}  service=${row.service}  score=${row.score}  ${window}`);
    }
    console.log(`${dryRun ? '[dry-run] would seed' : 'Seeded'} ${result.rows.length} category topic(s).`);
    process.exit(0);
  } catch (err) {
    console.error(`seed-category-topics failed: ${err.message}`);
    process.exit(1);
  }
})();
