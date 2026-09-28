// READ-ONLY — no writes, no locks, no customer contact.
//
// Historical replay for the seven-day overdue-reminder spacing rule
// (server/services/collections/dunning-spacing.js, GATE_DUNNING_SPACING_SHADOW
// PR 1 of the dunning-unification spacing work). Over the last N days
// (default 30), lists overdue-reminder events that landed within 7 days
// of a PREVIOUS overdue-reminder event for the same customer, from ANY of the
// five dunning rails' sources — grouped by (previous source → this source),
// counts only, plus an hours-apart distribution. This is the owner's
// evidence for whether the enforcing PR is still needed after the ladder
// (#5126) and orphan adoption (#5179) remove most of the double-contact
// handoffs — NOT a re-check the shadow gate or contact-policy.js call.
//
// No customer names or ids appear anywhere in the output — aggregate counts
// only.
//
// Usage (repo root):
//   railway run --service Postgres -- node server/scripts/dunning-spacing-replay.js            # last 30 days
//   railway run --service Postgres -- node server/scripts/dunning-spacing-replay.js --days 60

const path = require('path');

// Fail closed: without a usable URL the knex config would fall back to
// whatever local/dev database is reachable (same guard as
// ops/agents/primary-property-backfill.js).
const usableUrl = (v) => { const u = String(v || '').trim(); return !!u && u !== 'undefined' && u !== 'null'; };
if (!usableUrl(process.env.DATABASE_PUBLIC_URL) && !usableUrl(process.env.DATABASE_URL)) {
  console.error('[dunning-spacing-replay] DATABASE_PUBLIC_URL (or DATABASE_URL) not set — aborting. Run via: railway run --service Postgres -- node server/scripts/dunning-spacing-replay.js');
  process.exit(1);
}
if (!usableUrl(process.env.DATABASE_PUBLIC_URL)) delete process.env.DATABASE_PUBLIC_URL;
// The app's knex reads DATABASE_URL; railway run injects the internal host,
// unreachable from a local machine — prefer the public proxy, with TLS.
if (process.env.DATABASE_PUBLIC_URL) {
  process.env.DATABASE_URL = process.env.DATABASE_PUBLIC_URL;
  if (!/sslmode=/.test(process.env.DATABASE_URL) && !process.env.PGSSLMODE) process.env.PGSSLMODE = 'no-verify';
}

const db = require(path.join(__dirname, '..', 'models', 'db'));
const {
  OVERDUE_SOURCES, OVERDUE_PURPOSES, summarizeDunningSpacingReplay, isUnclassifiedLegacyReplay,
} = require(path.join(__dirname, '..', 'services', 'collections', 'dunning-spacing'));

const DAY_MS = 24 * 60 * 60 * 1000;
const SPACING_MS = 7 * DAY_MS;

function parseArgs(argv) {
  const daysIdx = argv.indexOf('--days');
  let days = 30;
  if (daysIdx > -1) {
    const raw = argv[daysIdx + 1];
    if (!/^[1-9]\d*$/.test(String(raw || ''))) {
      console.error(`[dunning-spacing-replay] --days needs a positive integer, got ${JSON.stringify(raw ?? null)} — aborting`);
      process.exit(1);
    }
    days = parseInt(raw, 10);
  }
  return { days };
}

// Fixed hours-apart buckets across the 7-day (168h) window.
const HOUR_BUCKETS = [24, 48, 72, 96, 120, 144, 168];
function bucketLabel(hours) {
  for (let i = 0; i < HOUR_BUCKETS.length; i += 1) {
    const hi = HOUR_BUCKETS[i];
    const lo = i === 0 ? 0 : HOUR_BUCKETS[i - 1];
    if (hours < hi) return `${lo}-${hi}h`;
  }
  return '168h+';
}

(async () => {
  const { days } = parseArgs(process.argv.slice(2));
  const now = new Date();
  const windowStart = new Date(now.getTime() - days * DAY_MS);
  // A "previous" row can sit up to 7 days before a row inside the window, so
  // the read reaches 7 days further back than the reported window.
  const lookbackStart = new Date(windowStart.getTime() - SPACING_MS);

  const rows = await db('collections_contact_ledger')
    .whereIn('source', [...OVERDUE_SOURCES])
    .whereIn('purpose', [...OVERDUE_PURPOSES])
    .where('occurred_at', '>', lookbackStart)
    // Close the historical interval at the captured `now`, not query time — a
    // reminder committed after `now` but before this query runs would
    // otherwise slip into a report labeled as ending at `now` (codex r2 P2).
    .where('occurred_at', '<=', now)
    .orderBy(['customer_id', 'occurred_at', 'id'])
    .select('id', 'customer_id', 'source', 'occurred_at', 'metadata', 'invoice_ids');

  const {
    spacingHits, candidatesInWindow, spacedWithin7d, customersAffected,
  } = summarizeDunningSpacingReplay(rows, { windowStart });

  const pairCounts = new Map(); // "prevSource→thisSource" -> count
  const hourBuckets = new Map(); // bucket label -> count
  for (const { previous, current, hoursApart } of spacingHits) {
    const key = `${previous.source}→${current.source}`;
    pairCounts.set(key, (pairCounts.get(key) || 0) + 1);
    const label = bucketLabel(hoursApart);
    hourBuckets.set(label, (hourBuckets.get(label) || 0) + 1);
  }

  console.log(`[dunning-spacing-replay] last ${days}d (window ${windowStart.toISOString()} .. ${now.toISOString()}), overdue-reminder rows read from ${lookbackStart.toISOString()}`);
  console.log(`[dunning-spacing-replay] overdue-reminder events in window: ${candidatesInWindow}, of those within 7d of a previous one (any source): ${spacedWithin7d}, distinct customers affected: ${customersAffected}`);
  const unclassified = rows.filter((row) => isUnclassifiedLegacyReplay(row) && new Date(row.occurred_at) >= windowStart).length;
  if (unclassified) {
    console.log(`[dunning-spacing-replay] ${unclassified} deferred follow-up text(s) from before replays carried their touch key are left out (unclassifiable: overdue vs bank-verification, and not groupable with their email)`);
  }

  console.log('[dunning-spacing-replay] by (previous source → this source):');
  const pairs = [...pairCounts.entries()].sort((a, b) => b[1] - a[1]);
  if (!pairs.length) console.log('  (none)');
  for (const [key, count] of pairs) console.log(`  ${key}: ${count}`);

  console.log('[dunning-spacing-replay] hours-apart distribution:');
  const bucketLabels = [...HOUR_BUCKETS.map((_, i) => `${i === 0 ? 0 : HOUR_BUCKETS[i - 1]}-${HOUR_BUCKETS[i]}h`), '168h+'];
  for (const label of bucketLabels) {
    const count = hourBuckets.get(label) || 0;
    if (count) console.log(`  ${label}: ${count}`);
  }
})()
  .catch((e) => { console.error('[dunning-spacing-replay] failed:', e.message); process.exitCode = 1; })
  .finally(() => db.destroy());
