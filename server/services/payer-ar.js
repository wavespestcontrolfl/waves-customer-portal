/**
 * Payer AR / aging (Phase 2 — P4).
 *
 * A NEW AR layer keyed on the PAYER → STATEMENT, parallel to (and independent of)
 * the per-customer/per-invoice self-pay AR. Aging is keyed on the STATEMENT's
 * `due_date`, never the child invoices' — an accrued invoice has no individual due
 * date; the statement is the receivable.
 *
 * Outstanding = a frozen, owed, not-yet-settled statement:
 *   finalized | sent | viewed | processing
 * (`open` is still accruing — not yet a receivable; `paid`/`void` are settled.)
 * `processing` (a payment in flight) is still an outstanding balance for AR — the
 * money hasn't landed — even though dunning pauses while it's in flight.
 *
 * Buckets by days past due (statement.due_date vs today, ET):
 *   current (≤0) | b1_15 | b16_30 | b31_45 | b45_plus
 *
 * Design: docs/design/payer-net-statements-plan.md (AR / aging / reporting).
 */

const db = require('../models/db');
const { etDateString } = require('../utils/datetime-et');
const { dateOnlyString } = require('../utils/date-only');

// Frozen + owed + unsettled. Mirrors payer-statement-settle's PAYABLE set plus
// `processing` (money in flight is still a receivable until it lands).
const OUTSTANDING_STATEMENT_STATUSES = ['finalized', 'sent', 'viewed', 'processing'];

const BUCKET_KEYS = ['current', 'b1_15', 'b16_30', 'b31_45', 'b45_plus'];

function emptyBuckets() {
  return BUCKET_KEYS.reduce((acc, k) => { acc[k] = { count: 0, total: 0 }; return acc; }, {});
}

function bucketForDaysPastDue(days) {
  if (days <= 0) return 'current';
  if (days <= 15) return 'b1_15';
  if (days <= 30) return 'b16_30';
  if (days <= 45) return 'b31_45';
  return 'b45_plus';
}

function daysBetweenYmd(fromYmd, toYmd) {
  const [fy, fm, fd] = String(fromYmd).split('-').map(Number);
  const [ty, tm, td] = String(toYmd).split('-').map(Number);
  return Math.round((Date.UTC(ty, tm - 1, td) - Date.UTC(fy, fm - 1, fd)) / 86400000);
}

/**
 * Derive aging facts for ONE statement row (no DB). Returns null for a statement
 * with no due_date (e.g. `open` that slipped in). `days_past_due` is negative
 * before the due date; `overdue` is days_past_due > 0.
 */
function ageStatement(stmt, asOfYmd = etDateString()) {
  if (!stmt?.due_date) return { days_past_due: null, overdue: false, aging_bucket: 'current' };
  const dpd = daysBetweenYmd(dateOnlyString(stmt.due_date), asOfYmd);
  return { days_past_due: dpd, overdue: dpd > 0, aging_bucket: bucketForDaysPastDue(dpd) };
}

function round2(n) { return Math.round((Number(n) || 0) * 100) / 100; }

/**
 * Roll a list of outstanding statement rows into bucket + by-terms summaries.
 * Pure (no DB) so it's unit-testable and reusable across the per-payer and
 * cross-payer reads.
 */
function summarize(statements, asOfYmd = etDateString()) {
  const buckets = emptyBuckets();
  const byTerms = {};
  let total = 0;
  let count = 0;
  let oldestDaysPastDue = null;
  let pastDueTotal = 0;

  for (const s of statements) {
    const amt = Number(s.total) || 0;
    const { days_past_due, aging_bucket, overdue } = ageStatement(s, asOfYmd);
    total += amt;
    count += 1;
    buckets[aging_bucket].count += 1;
    buckets[aging_bucket].total += amt;

    const terms = s.terms_snapshot || 'unknown';
    if (!byTerms[terms]) byTerms[terms] = { count: 0, total: 0 };
    byTerms[terms].count += 1;
    byTerms[terms].total += amt;

    if (overdue) {
      pastDueTotal += amt;
      if (days_past_due != null && (oldestDaysPastDue == null || days_past_due > oldestDaysPastDue)) {
        oldestDaysPastDue = days_past_due;
      }
    }
  }

  for (const k of BUCKET_KEYS) buckets[k].total = round2(buckets[k].total);
  for (const t of Object.keys(byTerms)) byTerms[t].total = round2(byTerms[t].total);

  return {
    outstanding_total: round2(total),
    past_due_total: round2(pastDueTotal),
    statement_count: count,
    oldest_days_past_due: oldestDaysPastDue,
    buckets,
    by_terms: byTerms,
  };
}

/**
 * Per-payer AR: every outstanding statement for one payer + the aging summary.
 * Each statement carries its derived aging fields for the UI.
 */
async function payerArForPayer(payerId, { database = db } = {}) {
  const pid = Number(payerId);
  if (!Number.isInteger(pid) || pid <= 0) return { summary: summarize([]), statements: [] };
  const asOf = etDateString();
  const rows = await database('payer_statements')
    .where({ payer_id: pid })
    .whereIn('status', OUTSTANDING_STATEMENT_STATUSES)
    .orderBy('due_date', 'asc');
  const statements = rows.map((s) => ({ ...s, ...ageStatement(s, asOf) }));
  return { summary: summarize(rows, asOf), statements };
}

/**
 * Cross-payer AR ("AR by terms" dashboard source): the org-wide outstanding
 * balance, bucketed and split by terms, plus a per-payer rollup sorted by oldest
 * past-due first (the collections worklist). Gate-dark safe: returns zeros when
 * no statements exist.
 */
async function computePayerArAging({ database = db } = {}) {
  const asOf = etDateString();
  const rows = await database('payer_statements as s')
    .leftJoin('payers as p', 'p.id', 's.payer_id')
    .whereIn('s.status', OUTSTANDING_STATEMENT_STATUSES)
    .select(
      's.id', 's.payer_id', 's.status', 's.terms_snapshot', 's.total', 's.due_date',
      'p.display_name as payer_name', 'p.company_name as payer_company',
    );

  const overall = summarize(rows, asOf);

  const byPayerMap = new Map();
  for (const s of rows) {
    const key = s.payer_id;
    if (!byPayerMap.has(key)) {
      byPayerMap.set(key, {
        payer_id: s.payer_id,
        payer_name: s.payer_company || s.payer_name || `Payer ${s.payer_id}`,
        statements: [],
      });
    }
    byPayerMap.get(key).statements.push(s);
  }
  const payers = [...byPayerMap.values()].map((entry) => {
    const sum = summarize(entry.statements, asOf);
    return {
      payer_id: entry.payer_id,
      payer_name: entry.payer_name,
      outstanding_total: sum.outstanding_total,
      past_due_total: sum.past_due_total,
      statement_count: sum.statement_count,
      oldest_days_past_due: sum.oldest_days_past_due,
      buckets: sum.buckets,
    };
  }).sort((a, b) => (b.oldest_days_past_due ?? -Infinity) - (a.oldest_days_past_due ?? -Infinity));

  return { as_of: asOf, ...overall, payers };
}

module.exports = {
  OUTSTANDING_STATEMENT_STATUSES,
  BUCKET_KEYS,
  bucketForDaysPastDue,
  ageStatement,
  summarize,
  payerArForPayer,
  computePayerArAging,
};
