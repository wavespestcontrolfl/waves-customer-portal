const { computeMrrBreakdown } = require('./mrr-breakdown');
const { etMonthStart, etDateString } = require('../utils/datetime-et');
const { INTERNAL_TEST_CUSTOMERS } = require('./internal-test-customers');
const logger = require('./logger');

// By-tier MRR over the SAME population computeMrrBreakdown uses (active,
// not-deleted, monthly_rate > 0, internal/test accounts excluded), so the
// snapshot's tiers reconcile to its total AND match the live trend population.
// db is lazy-required so this module (and its tests) load without knex.
async function tierBreakdown(conn) {
  conn = conn || require('../models/db');
  const rows = await conn('customers as c')
    .where('c.active', true)
    .whereNull('c.deleted_at')
    .where('c.monthly_rate', '>', 0)
    .modify((qb) => {
      if (INTERNAL_TEST_CUSTOMERS.length) {
        qb.whereNotIn(
          conn.raw("LOWER(COALESCE(c.first_name, '') || ' ' || COALESCE(c.last_name, ''))"),
          INTERNAL_TEST_CUSTOMERS,
        );
      }
    })
    .select('c.waveguard_tier as waveguard_tier', conn.raw('SUM(c.monthly_rate) as mrr'), conn.raw('COUNT(*) as count'))
    .groupBy('c.waveguard_tier');
  return rows.map((r) => ({
    tier: r.waveguard_tier || 'None',
    mrr: parseFloat(r.mrr || 0),
    count: parseInt(r.count || 0, 10),
  }));
}

// Per-customer monthly_rate over the SAME population the aggregate snapshot uses
// (active, not-deleted, monthly_rate > 0, internal/test excluded), so a month's
// per-customer rows sum to that month's total_mrr. Feeds true point-in-time MRR
// retention: "what each customer was paying in month X" instead of applying
// today's rate retroactively. db is lazy-required so this module loads without knex.
async function customerRateRows(conn) {
  conn = conn || require('../models/db');
  const rows = await conn('customers as c')
    .where('c.active', true)
    .whereNull('c.deleted_at')
    .where('c.monthly_rate', '>', 0)
    .modify((qb) => {
      if (INTERNAL_TEST_CUSTOMERS.length) {
        qb.whereNotIn(
          conn.raw("LOWER(COALESCE(c.first_name, '') || ' ' || COALESCE(c.last_name, ''))"),
          INTERNAL_TEST_CUSTOMERS,
        );
      }
    })
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
 * each refresh, so without this prune a dropped customer's stale row would linger
 * and the period's per-customer rows would stop summing to total_mrr. The cron
 * only ever refreshes the CURRENT month, so a closed month keeps its final
 * population. Returns how many rows were written and removed.
 *
 * @param {string} periodMonth  YYYY-MM-01
 * @param {import('knex')} [conn]
 */
async function recordCustomerMrrSnapshots(periodMonth, conn) {
  conn = conn || require('../models/db');
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
  // Prune rows for customers who left the population since an earlier refresh of
  // this same month, so per-customer rows reconcile to mrr_snapshots.total_mrr.
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
  const breakdown = await computeMrrBreakdown(conn, etDateString());
  const by_tier = await tierBreakdown(conn);

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

module.exports = { recordMrrSnapshot, recordCustomerMrrSnapshots, customerRateRows, tierBreakdown };
