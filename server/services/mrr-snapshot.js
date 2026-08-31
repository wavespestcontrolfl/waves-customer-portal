const { computeMrrBreakdown, mrrPopulationQuery } = require('./mrr-breakdown');
const { etMonthStart, etDateString } = require('../utils/datetime-et');
const logger = require('./logger');

// The payment-pending annual-prepay ids computeMrrBreakdown unions into its
// population (those rows sit on billing_mode 'per_application' until the
// prepay invoice is PAID, so the monthly-lane predicate alone would drop
// them). The AGGREGATE by-tier query unions the SAME set or the tiers stop
// reconciling to the same snapshot row's total_mrr (Codex #3669 r1 P1).
// The LONGITUDINAL per-customer query (customerRateRows) deliberately does
// NOT — see its comment (Codex #3669 r2 P2). Fail-soft mirror of
// computeMrrBreakdown's own fetch.
async function pendingPrepayIds(conn) {
  const { getPaymentPendingCustomerIds } = require('./annual-prepay-renewals');
  const set = await Promise.resolve()
    .then(() => getPaymentPendingCustomerIds(etDateString(), conn))
    .catch(() => new Set());
  return [...set];
}

// By-tier MRR over the SAME population computeMrrBreakdown uses (active,
// not-deleted, monthly_rate > 0, monthly lane OR payment-pending prepay,
// internal/test accounts excluded — mrrPopulationQuery is shared, not
// re-implemented, so the two can't drift), so the snapshot's tiers reconcile
// to its total AND match the live trend population.
// db is lazy-required so this module (and its tests) load without knex.
// `pendingIds`: pre-fetched pending-prepay ids — recordMrrSnapshot fetches
// ONE set and passes it to both this and computeMrrBreakdown, so a transient
// lookup failure between the two reads can't persist a snapshot whose
// by_tier disagrees with its own total_mrr (Codex #3669 r4). Omitted =
// fetched here (standalone callers).
async function tierBreakdown(conn, pendingIds = null) {
  conn = conn || require('../models/db');
  const rows = await mrrPopulationQuery(conn, pendingIds != null ? pendingIds : await pendingPrepayIds(conn))
    .select('c.waveguard_tier as waveguard_tier', conn.raw('SUM(c.monthly_rate) as mrr'), conn.raw('COUNT(*) as count'))
    .groupBy('c.waveguard_tier');
  return rows.map((r) => ({
    tier: r.waveguard_tier || 'None',
    mrr: parseFloat(r.mrr || 0),
    count: parseInt(r.count || 0, 10),
  }));
}

// Per-customer monthly_rate over the STABLE monthly-lane population (active,
// not-deleted, monthly_rate > 0, monthly lane, internal/test excluded). Feeds
// true point-in-time MRR retention: "what each customer was paying in month X"
// instead of applying today's rate retroactively.
//
// The payment-pending prepay union is deliberately EXCLUDED here (Codex #3669
// r2 P2): it is a transient collections overlay, and these rows are the
// LONGITUDINAL per-customer snapshots the Net MRR bridge diffs month over
// month. Unioning a pending customer in month M and then paying the prepay
// (which stamps billing_mode 'annual_prepay' and removes the id from month
// M+1's population) would make buildBridgeMonths classify a SUCCESSFUL prepay
// collection as churned MRR (mrr-bridge.js prior-only branch). The pending set
// stays aggregate-only: total_mrr / at_risk_mrr / by_tier carry it; the
// per-customer rows therefore sum to the committed monthly-lane population,
// not to total_mrr — by design. db is lazy-required so this module loads
// without knex.
async function customerRateRows(conn) {
  conn = conn || require('../models/db');
  const rows = await mrrPopulationQuery(conn)
    .select('c.id as customer_id', 'c.monthly_rate as monthly_rate', 'c.waveguard_tier as waveguard_tier');
  return rows.map((r) => ({
    customer_id: r.customer_id,
    monthly_rate: parseFloat(r.monthly_rate || 0),
    waveguard_tier: r.waveguard_tier || null,
  }));
}

/**
 * Upsert the CURRENT per-customer monthly rate into customer_mrr_snapshots for
 * `periodMonth`. One row per (period_month, customer_id); merge refreshes the
 * rate/tier so a mid-month change is captured and the month freezes at its last
 * value once it rolls over.
 *
 * Also DROPS this period's rows for customers who have since fallen out of the
 * population — deactivated, soft-deleted, or monthly_rate set to 0 mid-month.
 * The aggregate (mrr_snapshots.total_mrr) is recomputed from the live population
 * each refresh, so without this prune a dropped customer's stale row would
 * linger and the period's per-customer rows would stop reconciling to the
 * aggregate (they sum to its monthly-lane portion — the transient pending-
 * prepay overlay is aggregate-only, see customerRateRows). The cron
 * only ever refreshes the CURRENT month, so a closed month keeps its final
 * population. Returns how many rows were written and removed.
 *
 * @param {string} periodMonth  YYYY-MM-01
 * @param {import('knex')} [conn]
 */
async function recordCustomerMrrSnapshots(periodMonth, conn) {
  conn = conn || require('../models/db');
  // Never rewrite a PRE-BOUNDARY month with the corrected (narrow) lane
  // population (Codex #3669 r6 P1): a deploy landing before the 11:50pm ET
  // month-end capture (scheduler.js) would otherwise prune the closing
  // month's legacy residue rows while the bridge boundary still treats that
  // month as old-definition — the prior→closing diff would report every
  // pruned row as churn. The month keeps its last old-definition rows; its
  // AGGREGATE row is still refreshed (narrow — the documented step-down),
  // so per-customer rows and the aggregate diverge for that one month.
  const { LANE_DEFINITION_BOUNDARY } = require('./mrr-bridge');
  if (String(periodMonth) < LANE_DEFINITION_BOUNDARY) {
    return { period_month: periodMonth, count: 0, removed: 0, skipped: 'lane_definition_boundary' };
  }
  const rows = await customerRateRows(conn);
  // Empty result = no qualifying customers (or the population query yielded none);
  // skip both the insert AND the prune so a transient empty read can't wipe the
  // month. A real all-churned month is vanishingly rare for a live business.
  if (!rows.length) return { period_month: periodMonth, count: 0, removed: 0 };
  const records = rows.map((r) => ({
    period_month: periodMonth,
    customer_id: r.customer_id,
    monthly_rate: r.monthly_rate,
    waveguard_tier: r.waveguard_tier,
    captured_at: new Date(),
  }));
  await conn('customer_mrr_snapshots')
    .insert(records)
    .onConflict(['period_month', 'customer_id'])
    .merge(); // refresh monthly_rate/waveguard_tier/captured_at for the in-progress month
  // Prune rows for customers who left the population since an earlier refresh
  // of this same month, so per-customer rows keep tracking the live lane
  // population mrr_snapshots aggregates over.
  const keepIds = records.map((r) => r.customer_id);
  const removed = await conn('customer_mrr_snapshots')
    .where({ period_month: periodMonth })
    .whereNotIn('customer_id', keepIds)
    .del();
  return { period_month: periodMonth, count: records.length, removed };
}

/**
 * Capture the CURRENT MRR (total / committed / at-risk + by-tier) as the
 * snapshot for `periodMonth` (a YYYY-MM-01 date, default this ET month). Upsert
 * by period_month: a daily cron keeps the in-progress month fresh and freezes
 * each month at its last value once the month rolls over.
 *
 * @param {string} periodMonth  YYYY-MM-01 (default: current ET month start)
 * @param {import('knex')} [conn]
 */
async function recordMrrSnapshot(periodMonth = etMonthStart(), conn) {
  conn = conn || require('../models/db');
  // ONE pending-prepay set for the whole snapshot write — see tierBreakdown.
  const pendingIds = await pendingPrepayIds(conn);
  const breakdown = await computeMrrBreakdown(conn, etDateString(), pendingIds);
  const by_tier = await tierBreakdown(conn, pendingIds);

  await conn('mrr_snapshots')
    .insert({
      period_month: periodMonth,
      total_mrr: breakdown.total,
      committed_mrr: breakdown.committed,
      at_risk_mrr: breakdown.atRisk,
      customer_count: breakdown.totalCount,
      by_tier: JSON.stringify(by_tier),
      captured_at: new Date(),
    })
    .onConflict('period_month')
    .merge(); // refresh total/committed/at_risk/count/by_tier/captured_at; keep created_at

  logger.info(
    `[mrr-snapshot] ${periodMonth}: total=${breakdown.total} committed=${breakdown.committed} atRisk=${breakdown.atRisk} count=${breakdown.totalCount}`,
  );

  // Per-customer rate snapshot (Phase 0 — forward-only data accrual for
  // point-in-time MRR retention). Isolated: a failure here must not regress the
  // live aggregate trend, which is already committed above.
  let customerSnapshot = null;
  try {
    customerSnapshot = await recordCustomerMrrSnapshots(periodMonth, conn);
    logger.info(`[mrr-snapshot] ${periodMonth}: per-customer rows=${customerSnapshot.count}`);
  } catch (err) {
    logger.error(`[mrr-snapshot] per-customer snapshot failed for ${periodMonth}: ${err.message}`);
  }

  return { period_month: periodMonth, ...breakdown, by_tier, customerSnapshot };
}

module.exports = { recordMrrSnapshot, recordCustomerMrrSnapshots, customerRateRows, tierBreakdown, pendingPrepayIds };
