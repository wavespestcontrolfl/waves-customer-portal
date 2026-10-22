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
 * tree backstop) and 20261021010000 (40% margin) keep their stamped numbers.
 * The `regime` column tells the two apart from the STORED result (the
 * `pricingKnobs.lotBedBasis` stamp only the repriced engine writes — not the
 * margin value, which an admin-tuned row can hold anywhere), never from the
 * row's created_at, which a revision does not touch.
 */
const path = require('path');
const { Client } = require('pg');
const {
  INTERNAL_TEST_CUSTOMERS,
  isInternalTestCustomerId,
  isInternalTestEmail,
} = require(path.join(__dirname, '..', '..', 'server', 'services', 'internal-test-customers'));
const { parseETDateTime } = require(path.join(__dirname, '..', '..', 'server', 'utils', 'datetime-et'));

function parseArgs(argv) {
  const args = { days: 90, since: null, json: false, rows: false };
  for (const raw of argv) {
    const [k, v] = raw.includes('=') ? raw.split(/=(.*)/s) : [raw, undefined];
    if (k === '--days') {
      const n = Number(v);
      if (!Number.isInteger(n) || n < 1) { console.error(`--days needs a positive whole number, got ${JSON.stringify(v ?? null)}`); process.exit(2); }
      args.days = n;
    } else if (k === '--since') {
      if (!isRealCalendarDate(v)) { console.error(`--since needs a real YYYY-MM-DD calendar date, got ${JSON.stringify(v ?? null)}`); process.exit(2); }
      args.since = v;
    } else if (k === '--json') args.json = true;
    else if (k === '--rows') args.rows = true;
    else if (k === '--help' || k === '-h') { console.log('usage: node ops/agents/tree-shrub-estimates-report.js [--days=90] [--since=YYYY-MM-DD] [--json] [--rows]'); process.exit(0); }
    else { console.error(`unknown flag ${raw}`); process.exit(2); }
  }
  return args;
}

// Date.parse normalizes an impossible date (2026-02-31 -> March 3) instead of
// rejecting it, which would silently drop days from the cohort (Codex #6398
// r5): the components must round-trip through a UTC date unchanged.
function isRealCalendarDate(v) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(v || ''));
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };
const positive = (v) => { const n = num(v); return n !== null && n > 0 ? n : null; };
const count = (v) => { const n = num(v); return n !== null && n >= 0 && Number.isInteger(n) ? n : null; };
const enumOf = (v) => (typeof v === 'string' && v.trim() ? v.trim().toLowerCase() : null);

function outcomeOf(row) {
  if (row.status === 'accepted' || row.accepted_at) {
    return row.accepted_service_mode === 'one_time' ? 'accepted_one_time' : 'accepted';
  }
  // An internal draft that aged out was never a sent quote: the repository's
  // disposition says so (expired_unsent), and a row with no disposition and
  // no sent_at is the same thing. Counting it as sent inflates the
  // denominator and depresses the accept rate (Codex #6398 r7).
  const neverSent = row.disposition === 'expired_unsent' || (!row.disposition && !row.sent_at);
  if (row.status === 'expired') return neverSent ? 'expired_unsent' : 'expired';
  if (row.status === 'declined') return 'declined';
  if (row.status === 'draft' || row.status === 'scheduled' || row.status === 'sending' || row.status === 'send_failed') return row.status;
  if (row.archived_at) return neverSent ? 'expired_unsent' : 'expired';
  if (row.expires_at && new Date(row.expires_at) < new Date()) return 'expired';
  return 'pending';
}

// The MAPPED envelope's T&S facts (Admin V2 persists only this envelope):
// tsMeta, the selected tier row, the recurring row's review flags.
function mappedContext(estimateData) {
  const tsMeta = estimateData.result?.results?.tsMeta;
  const tierRows = estimateData.result?.results?.ts;
  const mappedSelected = Array.isArray(tierRows) ? tierRows.find((r) => r?.selected) : null;
  // Review flags ride result.recurring.services (mapV1ToLegacyShape), so a
  // parked quote counts as flagged even with no raw line (Codex #6398 r4).
  const services = estimateData.result?.recurring?.services;
  const mappedService = Array.isArray(services) ? services.find((s) => s?.service === 'tree_shrub') : null;
  return {
    tsMeta: tsMeta && typeof tsMeta === 'object' ? tsMeta : null,
    mappedSelected,
    mappedMonthly: positive(mappedSelected?.mo),
    mappedReasons: mappedService && Array.isArray(mappedService.manualReviewReasons) ? mappedService.manualReviewReasons : null,
    mappedLine: Array.isArray(estimateData.result?.lineItems)
      ? estimateData.result.lineItems.find((li) => li?.service === 'tree_shrub') : null,
  };
}

// A retained raw engine line is trustworthy only while it agrees with the
// mapped envelope on the inputs (bed, trees, inferred-or-not); a revision
// that changed them left the raw line stale.
function rawAgreesWithMapped(raw, tsMeta) {
  if (!tsMeta) return true;
  if ((positive(raw.bedAreaUsed ?? raw.bedArea) ?? null) !== (positive(tsMeta.eb) ?? null)) return false;
  if ((count(raw.treeCount) ?? null) !== (count(tsMeta.et) ?? null)) return false;
  const src = enumOf(raw.bedAreaSource);
  if (src && typeof tsMeta.bedAreaIsEstimated === 'boolean'
    && (src === 'lot_based' || src === 'fallback') !== tsMeta.bedAreaIsEstimated) return false;
  return true;
}

// The fields a revision can change WITHOUT touching bed/trees — provenance,
// tier, price, review flags and knob stamps — where the mapped revision wins
// over a retained raw line (Codex #6398 r3/r4; same rule as estimate-actuals).
function mappedOverRaw(raw, ctx) {
  const { tsMeta, mappedSelected, mappedMonthly, mappedReasons } = ctx;
  return {
    treeSource: enumOf(tsMeta?.treeCountSource) || enumOf(raw.treeCountSource) || 'unknown',
    tier: enumOf(mappedSelected?.tier) || enumOf(raw.tier),
    monthly: mappedMonthly ?? positive(raw.monthly),
    reviewReasons: mappedReasons ?? (Array.isArray(raw.manualReviewReasons) ? raw.manualReviewReasons : []),
    marginTarget: num(tsMeta?.pricingKnobs?.marginTarget) ?? num(raw.pricingKnobs?.marginTarget) ?? num(raw.marginTarget),
    lotBedBasis: enumOf(tsMeta?.pricingKnobs?.lotBedBasis) || enumOf(raw.pricingKnobs?.lotBedBasis),
  };
}

// Raw shape: the full source enums from the engine line.
function rawShape(raw, ctx) {
  const bedSource = enumOf(raw.bedAreaSource);
  const bedSqFt = positive(raw.bedAreaUsed ?? raw.bedArea);
  if (!bedSource && !bedSqFt && !positive(raw.monthly)) return null;
  return {
    shape: 'raw',
    bedSqFt,
    bedSource: bedSource || 'unknown',
    treeCount: count(raw.treeCount),
    palmCount: count(raw.palmCount),
    ...mappedOverRaw(raw, ctx),
  };
}

// Mapped shape: tsMeta keeps the numbers but not the four-value source enum,
// so the bed source is the coarse inferred / measured verdict.
function mappedShape(ctx) {
  const { tsMeta, mappedSelected, mappedMonthly, mappedReasons, mappedLine } = ctx;
  if (!tsMeta || !(positive(tsMeta.eb) || positive(tsMeta.et) || mappedMonthly)) return null;
  const bedSource = typeof tsMeta.bedAreaIsEstimated === 'boolean'
    ? (tsMeta.bedAreaIsEstimated ? 'inferred' : 'measured') : 'unknown';
  return {
    shape: 'mapped',
    bedSqFt: positive(tsMeta.eb),
    bedSource,
    treeCount: count(tsMeta.et),
    treeSource: enumOf(tsMeta.treeCountSource) || 'unknown',
    palmCount: null,
    tier: enumOf(mappedSelected?.tier),
    monthly: mappedMonthly ?? positive(mappedLine?.monthly),
    reviewReasons: mappedReasons || [],
    marginTarget: num(tsMeta.pricingKnobs?.marginTarget),
    lotBedBasis: enumOf(tsMeta.pricingKnobs?.lotBedBasis),
  };
}

// Compact shape: a quote-wizard / lead-automation line carries price only —
// never a fabricated zero for the inputs.
function compactShape(line, ctx) {
  if (!line) return null;
  return {
    shape: 'compact',
    bedSqFt: null, bedSource: 'unknown', treeCount: null, treeSource: 'unknown', palmCount: null,
    tier: enumOf(line.tier), monthly: positive(line.monthly),
    reviewReasons: ctx.mappedReasons || [],
    marginTarget: num(line.pricingKnobs?.marginTarget),
    lotBedBasis: enumOf(line.pricingKnobs?.lotBedBasis),
  };
}

// One T&S extraction per estimate payload, in precedence order: a raw engine
// line that still agrees with the mapped envelope (full source enums), else
// the mapped envelope (coarse inferred/measured), else a compact line, else
// null.
// A current mapped envelope that carries NO T&S row at all is authoritative:
// a revision that removed Tree & Shrub left the original engineResult behind,
// and that stale raw line must not count as a sent or accepted T&S quote
// (Codex #6398 r13).
function mappedEnvelopeWithoutTreeShrub(estimateData, ctx) {
  const result = estimateData.result;
  const present = result && typeof result === 'object'
    && (Array.isArray(result.lineItems) || (result.results && typeof result.results === 'object') || Array.isArray(result.recurring?.services));
  return !!present && !ctx.tsMeta && !ctx.mappedLine && !ctx.mappedSelected && ctx.mappedReasons === null;
}

function extractTreeShrub(estimateData) {
  if (!estimateData || typeof estimateData !== 'object') return null;
  const ctx = mappedContext(estimateData);
  if (mappedEnvelopeWithoutTreeShrub(estimateData, ctx)) return null;
  const raw = Array.isArray(estimateData.engineResult?.lineItems)
    ? estimateData.engineResult.lineItems.find((li) => li?.service === 'tree_shrub') : null;
  const fromRaw = raw && rawAgreesWithMapped(raw, ctx.tsMeta) ? rawShape(raw, ctx) : null;
  return fromRaw || mappedShape(ctx) || compactShape(ctx.mappedLine || raw, ctx);
}

// Which pricing regime a stored quote carries — read from the STORED result,
// never from the row's created_at (a revision reprices estimate_data without
// touching created_at, and a deploy instant is not knowable from the data;
// Codex #6398). The marker is the `pricingKnobs.lotBedBasis` stamp, which
// only the 2026-10-21 engine writes: a fresh quote stamps 'open_parcel'; a
// replay of a pre-change line stamps the 'gross_lot' it was sent with; an
// older line has no stamp. The margin value is NOT the marker — an
// admin-tuned global_margin_target_ts (preserved by 20261021010000) makes a
// fresh quote stamp 0.42 or 0.35, so a threshold on it would misfile both
// cohorts (Codex #6398 r4).
function regimeOf(ts) {
  return ts.lotBedBasis === 'open_parcel' ? 'after_2026_10_21' : 'before_2026_10_21';
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
  const regimes = { before: rows.filter((r) => r.regime === 'before_2026_10_21').length, after: rows.filter((r) => r.regime === 'after_2026_10_21').length };
  return { bySource, treeSources, regimes, total: rows.length };
}

function printReport(args, rows, excluded, windowStart) {
  const s = summarize(rows);
  console.log(`Tree & Shrub estimates since ${windowStart.slice(0, 10)} — ${s.total} quotes (${excluded} internal/test excluded)`);
  console.log(`priced under the pre-2026-10-21 engine (no lotBedBasis stamp, or a replayed gross_lot stamp): ${s.regimes.before}; under the repriced engine (open_parcel stamp): ${s.regimes.after}`);
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
    console.log('id        created     status        outcome            bed sqft  bed source   trees  tree source       $/mo    tier      regime               review');
    for (const r of rows) {
      console.log(`${r.id.slice(0, 8)}  ${r.createdAt.slice(0, 10)}  ${r.status.padEnd(12)}  ${r.outcome.padEnd(17)}  ${(r.bedSqFt === null ? '—' : String(r.bedSqFt)).padStart(8)}  ${r.bedSource.padEnd(11)}  ${(r.treeCount === null ? '—' : String(r.treeCount)).padStart(5)}  ${r.treeSource.padEnd(16)}  ${(r.monthly === null ? '—' : r.monthly.toFixed(2)).padStart(6)}  ${(r.tier || '—').padEnd(8)}  ${r.regime.padEnd(19)}  ${r.reviewReasons.join(',')}`);
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
  // --since is a CALENDAR day in the business's Eastern time (AGENTS.md ET
  // rule; Codex #6398): parse it as ET midnight and hand Postgres the
  // instant. The rolling --days window is already instant arithmetic.
  const windowStart = args.since
    ? parseETDateTime(`${args.since}T00:00:00`).toISOString()
    : new Date(Date.now() - args.days * 86400000).toISOString();

  const c = new Client({ connectionString: conn, ssl: { rejectUnauthorized: false } });
  await c.connect();
  let rows = [];
  let excluded = 0;
  try {
    // READ ONLY on the BEGIN itself: default_transaction_read_only is copied
    // into a transaction when it STARTS, so setting it after BEGIN left this
    // transaction writable (Codex #6398 r5).
    await c.query('BEGIN READ ONLY');
    // Timestamps are compared as instants (timestamptz vs an ISO instant), so
    // no ET wall-clock conversion is needed for a rolling window.
    const res = await c.query(
      `SELECT id, customer_id, customer_name, customer_email, status, disposition, created_at, sent_at, accepted_at,
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
        regime: regimeOf(ts),
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

module.exports = { extractTreeShrub, outcomeOf, regimeOf, summarize, median, isRealCalendarDate };

if (require.main === module) {
  main().catch((err) => { console.error(err.message || err); process.exit(1); });
}
