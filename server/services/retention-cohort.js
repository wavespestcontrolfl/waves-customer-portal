/**
 * Pure cohort retention series builder for /admin/dashboard/retention-cohort.
 *
 * Each member: { churnIdx, rateAt(monthIdx) -> number }.
 *  - churnIdx: absolute month index the member departed (Infinity if still live).
 *  - rateAt(monthIdx): the member's MRR for that absolute month — resolved by the
 *    caller from customer_mrr_snapshots (true point-in-time), falling back to the
 *    member's current monthly_rate for months that haven't accrued a snapshot yet.
 *
 * Returns:
 *  - retention[]    headcount retention: % of the cohort still live (≤ 100).
 *  - retentionMrr[] NET revenue retention: surviving members' MRR AT month m ÷ the
 *    cohort's MRR at signup. Because it uses each survivor's rate AT month m (not a
 *    flat current rate), EXPANSION can push this ABOVE 100% — i.e. true NRR. null
 *    when the cohort had no MRR at signup.
 *
 * Month 0 is the signup month: 100% by definition (the base).
 */

function round1(n) { return Math.round((Number(n) || 0) * 10) / 10; }

/**
 * A member's MRR for a given month, point-in-time.
 *  - If the month HAS snapshot data (snapshottedMonths has it): use the customer's
 *    snapshot rate, or 0 if they have no row — recordCustomerMrrSnapshots only
 *    writes active customers with monthly_rate > 0, so a missing row means the
 *    customer was $0 / paused that month, NOT "unknown". Falling back to today's
 *    rate there would re-apply current price retroactively.
 *  - If the month has NO snapshot at all (pre-accrual history): fall back to the
 *    member's current monthly_rate — best available, degrades gracefully.
 * Pure.
 */
function pointInTimeRate(rateByCustomer, snapshottedMonths, customerId, currentRate, ym) {
  if (snapshottedMonths.has(ym)) {
    const byMonth = rateByCustomer.get(customerId);
    const v = byMonth && byMonth.get(ym);
    return v != null ? v : 0;
  }
  return Number(currentRate) || 0;
}

function buildCohortSeries(members, cohortIdx, elapsed) {
  const size = members.length;
  // Cohort base = every member's MRR in their signup month (point-in-time).
  const baseMrr = members.reduce((s, m) => s + (Number(m.rateAt(cohortIdx)) || 0), 0);

  const retention = [];
  const retentionMrr = [];
  for (let m = 0; m <= elapsed; m += 1) {
    if (size === 0) { retention.push(null); retentionMrr.push(null); continue; }
    if (m === 0) {
      retention.push(100);
      retentionMrr.push(baseMrr > 0 ? 100 : null);
      continue;
    }
    // Live through the END of month (cohortIdx + m): still live, or churned later.
    const k = cohortIdx + m;
    const alive = members.filter((mem) => mem.churnIdx > k);
    retention.push(round1((alive.length / size) * 100));
    if (baseMrr > 0) {
      // Survivors' MRR AT month k (expansion counts) ÷ base → net revenue retention.
      const aliveMrr = alive.reduce((s, mem) => s + (Number(mem.rateAt(k)) || 0), 0);
      retentionMrr.push(round1((aliveMrr / baseMrr) * 100));
    } else {
      retentionMrr.push(null);
    }
  }
  return { baseMrr, retention, retentionMrr };
}

/**
 * Build a member's rateAt(monthIdx), keeping each cohort on ONE rate basis:
 *  - If the cohort's base (signup) month is NOT snapshotted (e.g. it predates the
 *    forward-only snapshots), the whole cohort stays on the current-rate basis —
 *    never a current-rate base divided into snapshot offsets, which would invent
 *    expansion/contraction and rewrite historical NRR.
 *  - Otherwise per-month point-in-time via pointInTimeRate (snapshot where present;
 *    current rate for months with no snapshot — notably the in-progress month,
 *    which the caller excludes from snapshottedMonths since its 6:05am snapshot is
 *    stale for same-day conversions/changes).
 * Pure (ymOf injected).
 */
function makeRateAt({ rateByCustomer, snapshottedMonths, ymOf, cohortYm, customerId, currentRate }) {
  if (!snapshottedMonths.has(cohortYm)) {
    const flat = Number(currentRate) || 0;
    return () => flat;
  }
  return (monthIdx) => pointInTimeRate(rateByCustomer, snapshottedMonths, customerId, currentRate, ymOf(monthIdx));
}

module.exports = { buildCohortSeries, pointInTimeRate, makeRateAt };
