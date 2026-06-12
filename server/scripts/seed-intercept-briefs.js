#!/usr/bin/env node
/**
 * Seed the competitor-intercept briefs (server/data/intercept-briefs-v1.json)
 * into opportunity_queue as operator-pinned 'operator_intercept' rows.
 *
 * Usage:
 *   node server/scripts/seed-intercept-briefs.js --dry-run     # print, no writes
 *   node server/scripts/seed-intercept-briefs.js               # upsert all 13
 *   node server/scripts/seed-intercept-briefs.js --file=path   # alternate manifest
 *
 * Idempotent: dedupe_key `intercept:v1:<id>` + ON CONFLICT DO UPDATE.
 * Re-running refreshes payload/score/window without duplicating rows and
 * never resets a claimed/done/pending_review row.
 *
 * Window handling: 'immediate' rows are claimable now; future-dated rows
 * carry available_at and self-activate when the date passes (no cron).
 */

const seeder = require('../services/content/intercept-brief-seeder');

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
      console.log(`${dryRun ? '[dry-run] ' : ''}${row.dedupe_key}  ${row.action_type}  score=${row.score}  service=${row.service}  ${window}`);
    }
    console.log(`${dryRun ? '[dry-run] would seed' : 'Seeded'} ${result.rows.length} intercept brief(s).`);
    process.exit(0);
  } catch (err) {
    console.error(`seed-intercept-briefs failed: ${err.message}`);
    process.exit(1);
  }
})();
