/**
 * Ad Attribution Sync — bridge realized service financials into the PPC funnel.
 *
 * ad_service_attribution rows are created at funnel_stage='lead' (lead-webhook /
 * call-attribution) and NEVER advanced — and their revenue/profit/LTV columns
 * (completed_revenue, gross_profit, gross_margin_pct, is_recurring,
 * projected_ltv_12mo) were never populated. So every /admin/ads ROI view that
 * reads those columns (revenue-attribution, service-lines, funnel) showed 0/null.
 *
 * Meanwhile job-costing already computes REAL per-visit gross profit into the
 * job_costs ledger (labor from time entries, materials from inventory FIFO, drive
 * cost). This module rolls a customer's COMPLETED costed visits up to their
 * acquisition funnel row, so the existing dashboards read true numbers. Revenue is
 * summed from job_costs joined to completed scheduled_services — NOT from
 * service_records (which the seed migration 20260401000027 populated with random
 * numbers) and NOT from raw job_costs (whose manual/equipment rows carry no
 * scheduled_service_id and would double-count a backfilled visit).
 *
 * A lead is only credited with revenue from visits ON/AFTER its lead_date, so a
 * reactivated/existing customer's pre-lead history isn't attributed to a new ad
 * source. Recurring status uses the canonical membership classifier (tier-aware),
 * not monthly_rate alone. The read+write runs in a transaction with the primary
 * row locked, so concurrent completions for one customer can't last-write-wins a
 * stale partial total over a fresh one.
 *
 * NOTE (scope): this populates the LTV/revenue/profit (numerator) side only.
 * The LTV:CAC and ROAS *ratios* additionally need ad_cost (spend) on the rows,
 * which comes from ad-platform data (ad_performance_daily), not service records —
 * that is a separate follow-up.
 *
 * Idempotent: re-summing from job_costs truth each run, so live completion and
 * the one-time backfill converge to the same values. A db handle may be passed so
 * a migration can run the backfill on its own knex.
 */

const logger = require('./logger');
const { isMembershipCustomerRow } = require('./waveguard-existing-services');

const DEFAULT_TARGET_MARGIN_PCT = 55; // company default if a customer has no realized margin yet

// Funnel stages we may advance to 'completed'. Excludes 'lost' — a lost lead that
// somehow also has completed visits keeps its terminal stage rather than being
// silently resurrected.
const ADVANCEABLE_STAGES = new Set([
  'lead', 'contacted', 'estimate_sent', 'estimate_viewed', 'booked', 'completed',
]);

function resolveDb(db) {
  return db || require('../models/db');
}

// node-postgres returns DATE columns as JS Date objects at UTC midnight, so
// String(date) yields "Wed Apr 01 2026 ..." which sorts/compares by weekday text,
// not chronologically. Normalize a DATE to a 'YYYY-MM-DD' string (Date or string
// input). Mirrors the recovery in reschedule-sms.js.
function toDateStr(v) {
  if (!v) return null;
  if (v instanceof Date) return v.toISOString().split('T')[0];
  return String(v).split('T')[0];
}

// Comparable key for a TIMESTAMP (created_at) tiebreak — full precision.
function tsKey(v) {
  if (!v) return '';
  return v instanceof Date ? v.toISOString() : String(v);
}

function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

/**
 * projectedLtv12moGP — projected 12-month GROSS PROFIT for a recurring customer.
 * = monthly_rate × blended margin × 12. Blended margin is the customer's realized
 * GP/revenue when they have costed visits, else the company target margin. Returns
 * null for non-recurring (one-time) customers — their LTV is just realized GP.
 * Pure / unit-testable.
 */
function projectedLtv12moGP({ monthlyRate, realizedRevenue = 0, realizedGrossProfit = 0, targetMarginPct } = {}) {
  const rate = Number(monthlyRate) || 0;
  if (rate <= 0) return null;
  const marginRatio = realizedRevenue > 0
    ? realizedGrossProfit / realizedRevenue
    : (Number(targetMarginPct) || DEFAULT_TARGET_MARGIN_PCT) / 100;
  return round2(rate * marginRatio * 12);
}

/**
 * pickPrimaryAttributionRow — a customer's realized totals are a single
 * customer-level number, so they're written to ONE row to avoid double-counting
 * when the read side SUMs completed_revenue across rows. Pick the first-touch
 * (earliest lead_date, then created_at) advanceable row. Returns null if none are
 * advanceable (e.g. all 'lost'). Pure / unit-testable.
 */
function pickPrimaryAttributionRow(rows = []) {
  const advanceable = rows.filter((r) => ADVANCEABLE_STAGES.has(r.funnel_stage));
  if (!advanceable.length) return null;
  return advanceable.slice().sort((a, b) => {
    // Normalize DATE → 'YYYY-MM-DD' so the compare is chronological, not by the
    // weekday text of a stringified Date. Undated rows sort last.
    const ad = toDateStr(a.lead_date) || '9999-99-99';
    const bd = toDateStr(b.lead_date) || '9999-99-99';
    if (ad !== bd) return ad < bd ? -1 : 1;
    const ac = tsKey(a.created_at);
    const bc = tsKey(b.created_at);
    return ac < bc ? -1 : ac > bc ? 1 : 0;
  })[0];
}

/**
 * buildAttributionPatch — the columns to write onto the primary funnel row from a
 * customer's realized financials. Only includes optional columns the table
 * actually has (asaCols guards an environment missing them). Pure / unit-testable.
 */
function buildAttributionPatch({ realized, isRecurring = false, monthlyRate, targetMarginPct, asaCols = {}, now } = {}) {
  const marginPct = realized.revenue > 0 ? round2((realized.grossProfit / realized.revenue) * 100) : null;
  // Only project recurring revenue for actual members — a one-time customer with a
  // stale positive monthly_rate must not get an LTV.
  const projected = isRecurring
    ? projectedLtv12moGP({
      monthlyRate,
      realizedRevenue: realized.revenue,
      realizedGrossProfit: realized.grossProfit,
      targetMarginPct,
    })
    : null;
  const patch = {
    funnel_stage: 'completed',
    completed_revenue: realized.revenue,
    gross_profit: realized.grossProfit,
    is_recurring: isRecurring,
    updated_at: now || new Date(),
  };
  if (asaCols.gross_margin_pct) patch.gross_margin_pct = marginPct;
  if (asaCols.projected_ltv_12mo) patch.projected_ltv_12mo = projected;
  return patch;
}

// Realized revenue + gross profit from a customer's COMPLETED costed visits,
// summed from the authoritative job_costs ledger (only ever written by
// calculateJobCost, so never the synthetic seed data in service_records).
//
// Inner-joined to scheduled_services for the completed-status gate (job_costs has
// no status column), which does double duty: it also drops manual/equipment
// job_costs rows — those carry no scheduled_service_id (admin-equipment) — so a
// visit that has BOTH a manual row and a backfill-created scheduled-service row
// is counted once, not twice.
//
// `since` (the acquisition lead_date, normalized) bounds it to visits ON/AFTER
// the lead, so pre-lead history isn't credited to the ad source. Returns null
// only if job_costs (or its scheduled_service_id link) is absent.
async function customerRealized(db, customerId, since = null) {
  const jcCols = await db('job_costs').columnInfo().catch(() => null);
  if (!jcCols || !jcCols.scheduled_service_id) return null;
  const q = db('job_costs as jc')
    .join('scheduled_services as ss', 'ss.id', 'jc.scheduled_service_id')
    .where('jc.customer_id', customerId)
    .where('ss.status', 'completed');
  if (since && jcCols.service_date) q.where('jc.service_date', '>=', since);
  const agg = await q.first(
    db.raw('COALESCE(SUM(jc.revenue), 0) as revenue'),
    db.raw('COALESCE(SUM(jc.gross_profit), 0) as gross_profit'),
    db.raw('COUNT(*) as visits'),
  );
  return {
    revenue: round2(agg?.revenue),
    grossProfit: round2(agg?.gross_profit),
    visits: Number(agg?.visits) || 0,
  };
}

async function getTargetMarginPct(db) {
  try {
    const row = await db('company_financials').orderBy('effective_date', 'desc').first();
    const v = Number(row?.target_gross_margin_pct);
    return Number.isFinite(v) && v > 0 ? v : DEFAULT_TARGET_MARGIN_PCT;
  } catch {
    return DEFAULT_TARGET_MARGIN_PCT;
  }
}

/**
 * syncCustomerAdAttribution(customerId, db?, opts?)
 * Roll the customer's realized revenue/gross profit/projected-LTV onto their
 * primary acquisition funnel row and advance it to 'completed'. No-op (with a
 * reason) when the customer has no attribution row or no completed costed visit.
 * Idempotent.
 */
async function syncCustomerAdAttribution(customerId, db, { targetMarginPct } = {}) {
  db = resolveDb(db);
  if (!customerId) return { updated: 0, reason: 'no_customer' };

  const asaCols = await db('ad_service_attribution').columnInfo().catch(() => ({}));
  if (!asaCols.completed_revenue) return { updated: 0, reason: 'cols_absent' };

  const rows = await db('ad_service_attribution').where({ customer_id: customerId });
  if (!rows.length) return { updated: 0, reason: 'no_attribution' };

  const primary = pickPrimaryAttributionRow(rows);
  if (!primary) return { updated: 0, reason: 'no_advanceable_rows' };
  const since = toDateStr(primary.lead_date);

  // Serialize concurrent syncs for the same customer: two fire-and-forget
  // completions costing at once could each read the aggregate then write, and a
  // stale read could overwrite a fresh total (last-write-wins). Lock the primary
  // row, then read the aggregate INSIDE the lock so the later writer always reads
  // the newest job_costs state.
  return db.transaction(async (trx) => {
    await trx('ad_service_attribution').where({ id: primary.id }).forUpdate().first();

    // Credit only revenue from visits on/after the acquisition lead.
    const realized = await customerRealized(trx, customerId, since);
    if (!realized) return { updated: 0, reason: 'no_financials' };
    if (realized.visits === 0) return { updated: 0, reason: 'no_completed_visits' };

    const customer = await trx('customers').where({ id: customerId }).first();
    const isRecurring = isMembershipCustomerRow(customer || {});
    const tm = targetMarginPct != null ? targetMarginPct : await getTargetMarginPct(trx);
    const patch = buildAttributionPatch({
      realized, isRecurring, monthlyRate: customer?.monthly_rate, targetMarginPct: tm, asaCols,
    });

    await trx('ad_service_attribution').where({ id: primary.id }).update(patch);

    // Clear AND demote the customer's OTHER rows so a row that was the primary on a
    // prior run (before a later/backfilled earlier-dated row appeared) can't keep
    // stale totals OR stay funnel_stage='completed'. The read side SUMs money and
    // counts completions by stage across rows, so a lingering credited/completed
    // row double-counts. Only touches rows that actually carry a credit; demoting
    // to 'lead' reverses a prior sync (which only ever sets 'completed').
    const otherIds = rows.filter((r) => r.id !== primary.id).map((r) => r.id);
    if (otherIds.length) {
      const clear = { funnel_stage: 'lead', completed_revenue: null, gross_profit: null, updated_at: new Date() };
      if (asaCols.gross_margin_pct) clear.gross_margin_pct = null;
      if (asaCols.projected_ltv_12mo) clear.projected_ltv_12mo = null;
      const cleared = await trx('ad_service_attribution')
        .whereIn('id', otherIds)
        .whereNotNull('completed_revenue')
        .update(clear);
      if (cleared) {
        logger.warn(
          `[ad-attribution-sync] customer ${customerId}: cleared+demoted ${cleared} stale `
          + `non-primary row(s); credited primary ${primary.id} only`,
        );
      }
    }
    return { updated: 1, customerId, primaryId: primary.id, ...patch };
  });
}

/**
 * backfillAdAttributionFromServiceRecords(db?)
 * One-time: sync every customer that has an attribution row. Idempotent. Used by
 * the backfill migration (passes its own knex) and runnable ad hoc.
 */
async function backfillAdAttributionFromServiceRecords(db, { onError } = {}) {
  db = resolveDb(db);
  const asaCols = await db('ad_service_attribution').columnInfo().catch(() => ({}));
  if (!asaCols.completed_revenue) return { processed: 0, updated: 0, skipped: 0 };

  const customerIds = await db('ad_service_attribution')
    .whereNotNull('customer_id')
    .distinct('customer_id')
    .pluck('customer_id')
    .catch(() => []);

  const targetMarginPct = await getTargetMarginPct(db); // resolve once for the whole run

  let processed = 0;
  let updated = 0;
  let skipped = 0;
  for (const cid of customerIds) {
    try {
      const res = await syncCustomerAdAttribution(cid, db, { targetMarginPct });
      processed += 1;
      if (res.updated) updated += 1;
    } catch (err) {
      skipped += 1;
      if (typeof onError === 'function') onError(cid, err);
      logger.warn(`[ad-attribution-sync] backfill skipped ${cid}: ${err.message}`);
    }
  }
  logger.info(`[ad-attribution-sync] backfill — processed ${processed}, updated ${updated}, skipped ${skipped}`);
  return { processed, updated, skipped };
}

module.exports = {
  syncCustomerAdAttribution,
  backfillAdAttributionFromServiceRecords,
  // exported for unit tests
  projectedLtv12moGP,
  pickPrimaryAttributionRow,
  buildAttributionPatch,
  customerRealized,
};
