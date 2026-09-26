#!/usr/bin/env node
/**
 * Seed citability-backfill refresh rows for live blog posts that miss the
 * citability traits (named sources / concrete specifics / comparison /
 * how-to-choose — the same four the quality gate nudges on).
 *
 * Usage:
 *   node server/scripts/seed-citability-backfill.js --dry-run            # scan + print, no writes
 *   node server/scripts/seed-citability-backfill.js --per-day=5           # upsert, 5 posts activate per ET day
 *   node server/scripts/seed-citability-backfill.js --min-gaps=3 --limit=40
 *
 * Gated: writes need GATE_CITABILITY_BACKFILL=true (dry-run always works).
 * Idempotent: dedupe_key `citability:v1:<page_url>` + ON CONFLICT DO UPDATE;
 * claimed/done/pending_review rows are never reset.
 *
 * Prod: railway run -- node server/scripts/seed-citability-backfill.js --dry-run
 */

const seeder = require('../services/content/citability-backfill-seeder');

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

// A flag that is present but not a positive integer is an operator typo —
// fail closed with exit 1 rather than widening the run to the defaults
// (`--limit=abc` must never become "unlimited"; fallback P2).
function positiveIntFlag(name) {
  const raw = ARGS[name];
  if (raw === undefined) return undefined;
  if (raw === true || !/^\d+$/.test(String(raw)) || parseInt(raw, 10) < 1) {
    console.error(`seed-citability-backfill: --${name} must be a positive integer (got ${JSON.stringify(raw)})`);
    process.exit(1);
  }
  return parseInt(raw, 10);
}
const perDay = positiveIntFlag('per-day');
const minGaps = positiveIntFlag('min-gaps');
const limit = positiveIntFlag('limit') ?? null;

(async function main() {
  try {
    const result = await seeder.seedAll({
      dryRun,
      ...(perDay ? { perDay } : {}),
      ...(minGaps ? { minGaps } : {}),
      ...(limit ? { limit } : {}),
    });
    for (const row of result.rows) {
      const window = row.available_at ? `available ${row.available_at.toISOString().slice(0, 10)}` : 'available now';
      console.log(`${dryRun ? '[dry-run] ' : ''}${row.page_url}  score=${row.score}  gaps=${row.signal_metadata.citability_gaps.join(',')}  service=${row.service}  ${window}`);
    }
    const s = result.summary;
    console.log(`${dryRun ? '[dry-run] would seed' : 'Seeded'} ${result.rows.length} of ${s.scanned} scanned post(s) across ${s.days} ET day(s).`);
    process.exit(0);
  } catch (err) {
    console.error(`seed-citability-backfill failed: ${err.message}`);
    process.exit(1);
  }
})();
