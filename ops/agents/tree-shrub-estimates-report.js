#!/usr/bin/env node
/**
 * tree-shrub-estimates-report.js — READ-ONLY
 *
 * "Why do our Tree & Shrub quotes read high?" — one row per Tree & Shrub
 * estimate created or sent in the window, with the inputs the engine priced
 * from and what happened to the quote, plus the roll-up the owner asked for
 * (audit 2026-10-21): how many quotes priced a bed area the engine INFERRED
 * (lot_based / fallback) versus one somebody measured or the aerial read
 * (explicit / estimated), how big those beds were, how many trees priced
 * from the density backstop, and the accept rate by bed source.
 *
 *   railway run --service Postgres node ops/agents/tree-shrub-estimates-report.js [--days=90] [--since=YYYY-MM-DD] [--json] [--rows]
 *
 * Reads `estimates` in a read-only transaction (SET default_transaction_read_only
 * = on). Internal/test customers are excluded with the shared list in
 * server/services/internal-test-customers.js. Output carries estimate ids
 * (short), dates, statuses and pricing inputs only — no names, addresses,
 * phones or emails (they are selected only to apply the exclusion and are
 * dropped before anything prints).
 *
 * Where the inputs come from (three stored payload shapes, mirrored from
 * server/services/estimate-actuals.js#extractTreeShrubEstimate):
 *   1. estimate_data.engineResult.lineItems[service=tree_shrub] — the raw engine
 *      line (bedAreaUsed, bedAreaSource, treeCount, treeCountSource, monthly,
 *      manualReviewReasons). Trusted only when it AGREES with the mapped
 *      envelope (a revision can leave a stale raw line behind).
 *   2. estimate_data.result.results.tsMeta — the mapped envelope (eb = bed sqft,
 *      et = tree count, bedAreaIsEstimated = lot_based|fallback). The source
 *      enum is NOT kept there, so those rows report bedSource "inferred" or
 *      "measured" (coarse) rather than the four-value enum.
 *   3. Compact quote-wizard / lead-automation lines carry price only → "unknown".
 *
 * Quotes priced before migration 20261021000000 (open-parcel bed basis, 2/4/6
 * tree backstop) and 20261021010000 (40% margin) keep their stamped numbers;
 * the `pricedBefore` column marks them so the two regimes can be compared.
 */
const path = require('path');
const { Client } = require('pg');
const {
  INTERNAL_TEST_CUSTOMERS,
  isInternalTestCustomerId,
  isInternalTestEmail,
} = require(path.join(__dirname, '..', '..', 'server', 'services', 'internal-test-customers'));

const REPRICE_CUTOVER = '2026-10-21T00:00:00Z'; // first deploy carrying the T&S input fixes

function parseArgs(argv) {
  const args = { days: 90, since: null, json: false, rows: false };
  for (const raw of argv) {
    const [k, v] = raw.includes('=') ? raw.split(/=(.*)/s) : [raw, undefined];
    if (k === '--days') {
      const n = Number(v);
      if (!Number.isInteger(n) || n < 1) { console.error(`--days needs a positive whole number, got ${JSON.stringify(v ?? null)}`); process.exit(2); }
      args.days = n;
    } else if (k === '--since') {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) || Number.isNaN(Date.parse(`${v}T00:00:00Z`))) { console.error(`--since needs YYYY-MM-DD, got ${JSON.stringify(v ?? null)}`); process.exit(2); }
      args.since = v;
    } else if (k === '--json') args.json = true;
    else if (k === '--rows') args.rows = true;
    else if (k === '--help' || k === '-h') { console.log('usage: node ops/agents/tree-shrub-estimates-report.js [--days=90] [--since=YYYY-MM-DD] [--json] [--rows]'); process.exit(0); }
    else { console.error(`unknown flag ${raw}`); process.exit(2); }
  }
  return args;
}

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };
const positive = (v) => { const n = num(v); return n !== null && n > 0 ? n : null; };
const count = (v) => { const n = num(v); return n !== null && n >= 0 && Number.isInteger(n) ? n : null; };
const enumOf = (v) => (typeof v === 'string' && v.trim() ? v.trim().toLowerCase() : null);

function outcomeOf(row) {
  if (row.status === 'accepted' || row.accepted_at) {
    return row.accepted_service_mode === 'one_time' ? 'accepted_one_time' : 'accepted';
  }
  if (row.status === 'expired') return 'expired';
  if (row.status === 'declined') return 'declined';
  if (row.status === 'draft' || row.status === 'scheduled' || row.status === 'sending' || row.status === 'send_failed') return row.status;
  if (row.archived_at) return 'expired';
  if (row.expires_at && new Date(row.expires_at) < new Date()) return 'expired';
  return 'pending';
}

// One T&S extraction per estimate payload. `bedSource` is the four-value enum
// when the raw line is trustworthy, else the coarse inferred/measured verdict
// from the mapped envelope, else 'unknown'.
function extractTreeShrub(estimateData) {
  if (!estimateData || typeof estimateData !== 'object') return null;
  const tsMeta = estimateData.result?.results?.tsMeta;
  const hasMapped = !!(tsMeta && typeof tsMeta === 'object');
  const tierRows = estimateData.result?.results?.ts;
  const mappedSelected = Array.isArray(tierRows) ? tierRows.find((r) => r?.selected) : null;
  const mappedMonthly = positive(mappedSelected?.mo);

  const agrees = (q) => {
    if (!hasMapped) return true;
    if ((positive(q.bedAreaUsed ?? q.bedArea) ?? null) !== (positive(tsMeta.eb) ?? null)) return false;
    if ((count(q.treeCount) ?? null) !== (count(tsMeta.et) ?? null)) return false;
    const src = enumOf(q.bedAreaSource);
    if (src && typeof tsMeta.bedAreaIsEstimated === 'boolean'
      && (src === 'lot_based' || src === 'fallback') !== tsMeta.bedAreaIsEstimated) return false;
    return true;
  };

  const raw = Array.isArray(estimateData.engineResult?.lineItems)
    ? estimateData.engineResult.lineItems.find((li) => li?.service === 'tree_shrub') : null;
  if (raw && agrees(raw)) {
    const bedSource = enumOf(raw.bedAreaSource);
    if (bedSource || positive(raw.bedAreaUsed ?? raw.bedArea) || positive(raw.monthly)) {
      return {
        shape: 'raw',
        bedSqFt: positive(raw.bedAreaUsed ?? raw.bedArea),
        bedSource: bedSource || 'unknown',
        treeCount: count(raw.treeCount),
        treeSource: enumOf(raw.treeCountSource) || 'unknown',
        palmCount: count(raw.palmCount),
        tier: enumOf(raw.tier),
        monthly: positive(raw.monthly) ?? mappedMonthly,
        reviewReasons: Array.isArray(raw.manualReviewReasons) ? raw.manualReviewReasons : [],
      };
    }
  }
  const mappedLine = Array.isArray(estimateData.result?.lineItems)
    ? estimateData.result.lineItems.find((li) => li?.service === 'tree_shrub') : null;
  if (hasMapped && (positive(tsMeta.eb) || positive(tsMeta.et) || mappedMonthly)) {
    return {
      shape: 'mapped',
      bedSqFt: positive(tsMeta.eb),
      bedSource: typeof tsMeta.bedAreaIsEstimated === 'boolean' ? (tsMeta.bedAreaIsEstimated ? 'inferred' : 'measured') : 'unknown',
      treeCount: count(tsMeta.et),
      treeSource: 'unknown',
      palmCount: null,
      tier: enumOf(mappedSelected?.tier),
      monthly: mappedMonthly ?? positive(mappedLine?.monthly),
      reviewReasons: [],
    };
  }
  if (mappedLine || raw) {
    return {
      shape: 'compact',
      bedSqFt: null, bedSource: 'unknown', treeCount: null, treeSource: 'unknown', palmCount: null,
      tier: enumOf((mappedLine || raw).tier), monthly: positive((mappedLine || raw).monthly),
      reviewReasons: [],
    };
  }
  return null;
}

const median = (xs) => {
  const a = xs.filter((x) => Number.isFinite(x)).sort((x, y) => x - y);
  if (!a.length) return null;
  const mid = Math.floor(a.length / 2);
  return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
};
const pct = (n, d) => (d ? `${Math.round((n / d) * 1000) / 10}%` : '—');

function summarize(rows) {
  const bySource = {};
  for (const r of rows) {
    const key = r.bedSource;
    const b = bySource[key] || (bySource[key] = { quotes: 0, sent: 0, accepted: 0, declined: 0, beds: [], monthlies: [], densityTrees: 0, review: 0 });
    b.quotes++;
    if (['pending', 'accepted', 'accepted_one_time', 'declined', 'expired'].includes(r.outcome)) b.sent++;
    if (r.outcome === 'accepted') b.accepted++;
    if (r.outcome === 'declined') b.declined++;
    if (r.bedSqFt) b.beds.push(r.bedSqFt);
    if (r.monthly) b.monthlies.push(r.monthly);
    if (r.treeSource === 'density_estimate') b.densityTrees++;
    if (r.reviewReasons.length) b.review++;
  }
  const treeSources = {};
  for (const r of rows) treeSources[r.treeSource] = (treeSources[r.treeSource] || 0) + 1;
  const regimes = { before: rows.filter((r) => r.pricedBefore).length, after: rows.filter((r) => !r.pricedBefore).length };
  return { bySource, treeSources, regimes, total: rows.length };
}

function printReport(args, rows, excluded, windowStart) {
  const s = summarize(rows);
  console.log(`Tree & Shrub estimates since ${windowStart.slice(0, 10)} — ${s.total} quotes (${excluded} internal/test excluded)`);
  console.log(`priced before the 2026-10-21 input fixes: ${s.regimes.before}; after: ${s.regimes.after}`);
  console.log('');
  console.log('By bed-area source (explicit = typed, estimated = aerial/estimate field, lot_based = % of lot, fallback = 1,200 default; inferred/measured = older mapped-only rows)');
  console.log('source        quotes  sent  accepted  accept%  median bed sqft  median $/mo  density-tree quotes  review-flagged');
  for (const [src, b] of Object.entries(s.bySource).sort((a, c) => c[1].quotes - a[1].quotes)) {
    const mb = median(b.beds); const mm = median(b.monthlies);
    console.log(`${src.padEnd(13)} ${String(b.quotes).padStart(6)} ${String(b.sent).padStart(5)} ${String(b.accepted).padStart(9)}  ${pct(b.accepted, b.sent).padStart(7)}  ${(mb === null ? '—' : String(Math.round(mb))).padStart(15)}  ${(mm === null ? '—' : mm.toFixed(2)).padStart(11)}  ${String(b.densityTrees).padStart(19)}  ${String(b.review).padStart(14)}`);
  }
  console.log('');
  console.log('Tree count source: ' + Object.entries(s.treeSources).map(([k, v]) => `${k} ${v}`).join(', '));
  if (args.rows) {
    console.log('');
    console.log('id        created     status        outcome            bed sqft  bed source   trees  tree source       $/mo    tier      before-fix  review');
    for (const r of rows) {
      console.log(`${r.id.slice(0, 8)}  ${r.createdAt.slice(0, 10)}  ${r.status.padEnd(12)}  ${r.outcome.padEnd(17)}  ${(r.bedSqFt === null ? '—' : String(r.bedSqFt)).padStart(8)}  ${r.bedSource.padEnd(11)}  ${(r.treeCount === null ? '—' : String(r.treeCount)).padStart(5)}  ${r.treeSource.padEnd(16)}  ${(r.monthly === null ? '—' : r.monthly.toFixed(2)).padStart(6)}  ${(r.tier || '—').padEnd(8)}  ${r.pricedBefore ? 'yes' : 'no '}         ${r.reviewReasons.join(',')}`);
    }
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const conn = process.env.DATABASE_PUBLIC_URL;
  if (!conn) {
    console.error('DATABASE_PUBLIC_URL not set — run via: railway run --service Postgres node ops/agents/tree-shrub-estimates-report.js');
    process.exit(2);
  }
  const windowStart = args.since
    ? `${args.since}T00:00:00Z`
    : new Date(Date.now() - args.days * 86400000).toISOString();

  const c = new Client({ connectionString: conn, ssl: { rejectUnauthorized: false } });
  await c.connect();
  let rows = [];
  let excluded = 0;
  try {
    await c.query('BEGIN');
    await c.query('SET default_transaction_read_only = on');
    // Timestamps are compared as instants (timestamptz vs an ISO instant), so
    // no ET wall-clock conversion is needed for a rolling window.
    const res = await c.query(
      `SELECT id, customer_id, customer_name, customer_email, status, created_at, sent_at, accepted_at,
              declined_at, expires_at, archived_at, accepted_service_mode, estimate_data
         FROM estimates
        WHERE (created_at >= $1 OR sent_at >= $1)
          AND estimate_data::text ILIKE '%tree_shrub%'
        ORDER BY created_at DESC`,
      [windowStart],
    );
    await c.query('ROLLBACK');
    for (const row of res.rows) {
      const name = String(row.customer_name || '').trim().toLowerCase();
      if (INTERNAL_TEST_CUSTOMERS.includes(name) || isInternalTestCustomerId(row.customer_id) || isInternalTestEmail(row.customer_email)) { excluded++; continue; }
      const data = typeof row.estimate_data === 'string' ? JSON.parse(row.estimate_data) : row.estimate_data;
      const ts = extractTreeShrub(data);
      if (!ts) continue;
      const createdAt = new Date(row.created_at).toISOString();
      rows.push({
        id: String(row.id),
        createdAt,
        sentAt: row.sent_at ? new Date(row.sent_at).toISOString() : null,
        acceptedAt: row.accepted_at ? new Date(row.accepted_at).toISOString() : null,
        status: String(row.status || ''),
        outcome: outcomeOf(row),
        pricedBefore: createdAt < REPRICE_CUTOVER,
        ...ts,
      });
    }
  } finally {
    await c.end();
  }
  if (args.json) {
    console.log(JSON.stringify({ windowStart, excluded, summary: summarize(rows), rows }, null, 2));
    return;
  }
  printReport(args, rows, excluded, windowStart);
}

module.exports = { extractTreeShrub, outcomeOf, summarize, median };

if (require.main === module) {
  main().catch((err) => { console.error(err.message || err); process.exit(1); });
}
