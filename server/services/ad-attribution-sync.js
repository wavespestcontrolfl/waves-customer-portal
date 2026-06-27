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
 * cost). This module rolls a customer's completed, costed visits up to their
 * acquisition funnel row, so the existing dashboards read true numbers. Revenue
 * is summed from job_costs — NOT service_records — because job_costs is only ever
 * written by calculateJobCost (never the synthetic seed migration 20260401000027)
 * and exists even for legacy rows the service_records write-through skips.
 *
 * A lead is only credited with revenue from visits ON/AFTER its lead_date, so a
 * reactivated/existing customer's pre-lead history isn't attributed to a new ad
 * source. Recurring status uses the canonical membership classifier (tier-aware),
 * not monthly_rate alone.
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
    const ad = String(a.lead_date || '');
    const bd = String(b.lead_date || '');
    if (ad !== bd) return ad < bd ? -1 : 1;
    const ac = String(a.created_at || '');
    const bc = String(b.created_at || '');
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

// Realized revenue + gross profit from a customer's costed visits, summed from
// the authoritative job_costs ledger (only ever written by calculateJobCost, so
// never the synthetic seed data in service_records). `since` (the acquisition
// lead_date) bounds it to visits ON/AFTER the lead, so pre-lead history isn't
// credited to the ad source. Returns null only if job_costs is absent.
async function customerRealized(db, customerId, since = null) {
  const jcCols = await db('job_costs').columnInfo().catch(() => null);
  if (!jcCols) return null;
  const q = db('job_costs').where({ customer_id: customerId });
  if (since && jcCols.service_date) q.where('service_date', '>=', since);
  const agg = await q.first(
    db.raw('COALESCE(SUM(revenue), 0) as revenue'),
    db.raw('COALESCE(SUM(gross_profit), 0) as gross_profit'),
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

  // Credit only revenue from visits on/after the acquisition lead.
  const realized = await customerRealized(db, customerId, primary.lead_date);
  if (!realized) return { updated: 0, reason: 'no_financials' };
  if (realized.visits === 0) return { updated: 0, reason: 'no_completed_visits' };

  const customer = await db('customers').where({ id: customerId }).first();
  const isRecurring = isMembershipCustomerRow(customer || {});
  const tm = targetMarginPct != null ? targetMarginPct : await getTargetMarginPct(db);
  const patch = buildAttributionPatch({
    realized, isRecurring, monthlyRate: customer?.monthly_rate, targetMarginPct: tm, asaCols,
  });

  await db('ad_service_attribution').where({ id: primary.id }).update(patch);

  // Clear money columns on the customer's OTHER rows so a row that was the primary
  // on a prior run (before a later/backfilled earlier-dated row appeared) can't
  // keep stale totals — the read side SUMs these across rows, so two credited rows
  // = double-count. Only touches rows that actually carry a credit.
  const otherIds = rows.filter((r) => r.id !== primary.id).map((r) => r.id);
  if (otherIds.length) {
    const clear = { completed_revenue: null, gross_profit: null, updated_at: new Date() };
    if (asaCols.gross_margin_pct) clear.gross_margin_pct = null;
    if (asaCols.projected_ltv_12mo) clear.projected_ltv_12mo = null;
    const cleared = await db('ad_service_attribution')
      .whereIn('id', otherIds)
      .whereNotNull('completed_revenue')
      .update(clear);
    if (cleared) {
      logger.warn(
        `[ad-attribution-sync] customer ${customerId}: cleared stale totals from ${cleared} `
        + `non-primary row(s); credited primary ${primary.id} only`,
      );
    }
  }
  return { updated: 1, customerId, primaryId: primary.id, ...patch };
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
