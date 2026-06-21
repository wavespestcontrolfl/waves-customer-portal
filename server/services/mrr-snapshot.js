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
  return { period_month: periodMonth, ...breakdown, by_tier };
}

module.exports = { recordMrrSnapshot, tierBreakdown };
