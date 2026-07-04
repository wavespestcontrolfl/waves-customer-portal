/**
 * Net-MRR bridge — decompose each month's MRR movement into WHY:
 *
 *   start (prior month) → +new → +reactivated → +expansion
 *                       → −contraction → −churned → end (this month)
 *
 * Exact months diff consecutive `customer_mrr_snapshots` months (per-customer
 * point-in-time rates, daily upsert + month-end freeze — see mrr-snapshot.js):
 *   - in this month only:  conversion (CONVERSION_DATE_SQL) in-month ⇒ NEW,
 *     otherwise REACTIVATED (a returning former customer)
 *   - in prior month only: CHURNED (at their prior-month rate)
 *   - in both:             rate delta ⇒ EXPANSION (+) or CONTRACTION (−)
 *   Every customer lands in exactly one bucket, so start + Σbuckets = end to
 *   the cent — the bridge is additive by construction.
 *
 * Snapshots are forward-only (first capture 2026-06). Months without BOTH
 * their own and the prior month's snapshot DEGRADE, don't hide: a two-sided
 * approximation from the customers table (conversion month ⇒ new, exit month
 * ⇒ churned — churned_at, else pipeline_stage_changed_at for churned/dormant,
 * else deleted_at; same convention as the retention cohort) valued at CURRENT
 * rates, flagged `degraded: true` so the UI can hatch it and footnote why.
 *
 * The in-progress current month is flagged (`inProgress`) — its end value
 * moves daily until the month-end freeze.
 *
 * Pure core (buildBridgeMonths) + a thin DB wrapper (computeMrrBridge).
 */

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const ymOf = (monthKey) => String(monthKey).slice(0, 7); // 'YYYY-MM-01' → 'YYYY-MM'

const MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function monthLabelOf(monthKey) {
  const ym = ymOf(monthKey);
  return `${MONTH_ABBR[Number(ym.slice(5, 7)) - 1]} ’${ym.slice(2, 4)}`;
}

/**
 * buildBridgeMonths — pure.
 * @param {string[]} monthKeys ascending 'YYYY-MM-01' keys to report
 * @param {Map<string, Map<string, number>>} snapshotsByMonth monthKey → (customerId → rate)
 * @param {Map<string, string>} conversionMonthById customerId → 'YYYY-MM' (ET conversion month)
 * @param {Map<string, {newMrr:number,newCount:number,churnedMrr:number,churnedCount:number}>} degradedByMonth
 *   customers-table approximation for months that can't diff snapshots
 * @param {string} currentMonthKey 'YYYY-MM-01' of the in-progress ET month
 */
function buildBridgeMonths({
  monthKeys = [],
  snapshotsByMonth = new Map(),
  conversionMonthById = new Map(),
  degradedByMonth = new Map(),
  currentMonthKey = null,
} = {}) {
  return monthKeys.map((key, i) => {
    const prevKey = i > 0 ? monthKeys[i - 1] : prevMonthKey(key);
    const curr = snapshotsByMonth.get(key);
    const prev = snapshotsByMonth.get(prevKey);
    const inProgress = key === currentMonthKey;

    if (!curr || !prev) {
      // Degrade, don't hide: two-sided customers-table approximation.
      const d = degradedByMonth.get(key) || { newMrr: 0, newCount: 0, churnedMrr: 0, churnedCount: 0 };
      return {
        month: key,
        label: monthLabelOf(key),
        degraded: true,
        inProgress,
        startMrr: null,
        endMrr: null,
        net: round2(d.newMrr - d.churnedMrr),
        new: { mrr: round2(d.newMrr), count: d.newCount },
        reactivated: { mrr: 0, count: 0 },
        expansion: { mrr: 0, count: 0 },
        contraction: { mrr: 0, count: 0 },
        churned: { mrr: round2(d.churnedMrr), count: d.churnedCount },
      };
    }

    const ym = ymOf(key);
    let startMrr = 0;
    let endMrr = 0;
    const buckets = {
      new: { mrr: 0, count: 0 },
      reactivated: { mrr: 0, count: 0 },
      expansion: { mrr: 0, count: 0 },
      contraction: { mrr: 0, count: 0 },
      churned: { mrr: 0, count: 0 },
    };

    for (const [id, rate] of curr) {
      endMrr += rate;
      if (!prev.has(id)) {
        const b = conversionMonthById.get(id) === ym ? buckets.new : buckets.reactivated;
        b.mrr += rate;
        b.count += 1;
      }
    }
    for (const [id, prevRate] of prev) {
      startMrr += prevRate;
      const currRate = curr.get(id);
      if (currRate == null) {
        buckets.churned.mrr += prevRate;
        buckets.churned.count += 1;
      } else if (currRate > prevRate) {
        buckets.expansion.mrr += currRate - prevRate;
        buckets.expansion.count += 1;
      } else if (currRate < prevRate) {
        buckets.contraction.mrr += prevRate - currRate;
        buckets.contraction.count += 1;
      }
    }

    return {
      month: key,
      label: monthLabelOf(key),
      degraded: false,
      inProgress,
      startMrr: round2(startMrr),
      endMrr: round2(endMrr),
      net: round2(endMrr - startMrr),
      new: { mrr: round2(buckets.new.mrr), count: buckets.new.count },
      reactivated: { mrr: round2(buckets.reactivated.mrr), count: buckets.reactivated.count },
      expansion: { mrr: round2(buckets.expansion.mrr), count: buckets.expansion.count },
      contraction: { mrr: round2(buckets.contraction.mrr), count: buckets.contraction.count },
      churned: { mrr: round2(buckets.churned.mrr), count: buckets.churned.count },
    };
  });
}

// 'YYYY-MM-01' → prior month's 'YYYY-MM-01' (pure string math, no Date — a
// UTC-parsed Date would drift the calendar day in ET).
function prevMonthKey(monthKey) {
  const y = Number(monthKey.slice(0, 4));
  const m = Number(monthKey.slice(5, 7));
  const idx = y * 12 + (m - 1) - 1;
  return `${String(Math.floor(idx / 12)).padStart(4, '0')}-${String((idx % 12) + 1).padStart(2, '0')}-01`;
}

// Normalize a period_month cell to 'YYYY-MM-01'. node-postgres parses DATE
// columns into local-midnight Date objects — LOCAL getters give the stored
// calendar date; toISOString would be off by the TZ offset.
function periodKeyOf(v) {
  if (typeof v === 'string') return v.slice(0, 10);
  const d = new Date(v);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// Replace the in-progress month's snapshot rows with LIVE customer rates.
// The morning upsert goes stale the moment a customer is added, churned, or
// repriced, and the other current-month surfaces (getMrrTrend, the Net MRR
// tile) compute live — without this overlay the bridge's end/net could
// disagree with the tile until the next cron. An empty live read keeps the
// snapshot rows (mirrors the cron's transient-empty guard). Pure.
function overlayLiveCurrentMonth(snapshotsByMonth, currentMonthKey, liveRows) {
  if (!Array.isArray(liveRows) || !liveRows.length) return snapshotsByMonth;
  const map = new Map();
  for (const r of liveRows) map.set(r.customer_id, Number(r.monthly_rate) || 0);
  snapshotsByMonth.set(currentMonthKey, map);
  return snapshotsByMonth;
}

/**
 * computeMrrBridge({ months, conn }) — assemble inputs and run the pure core.
 * `months` = how many trailing ET months to report (clamped 2–12).
 */
async function computeMrrBridge({ months = 6, conn } = {}) {
  const db = conn || require('../models/db');
  const { etMonthStart, etDateString } = require('../utils/datetime-et');
  const { CONVERSION_DATE_SQL, CUSTOMER_STAGES } = require('./customer-stages');
  const { INTERNAL_TEST_CUSTOMERS } = require('./internal-test-customers');

  const n = Math.max(2, Math.min(12, parseInt(months, 10) || 6));
  const currentMonthKey = etMonthStart();
  const monthKeys = [];
  for (let k = n - 1; k >= 0; k--) monthKeys.push(etMonthStart(new Date(), -k));
  const fetchKeys = [prevMonthKey(monthKeys[0]), ...monthKeys];

  // Snapshot rows for the window (+ the month before the first, for its diff).
  const snapshotsByMonth = new Map();
  let snapshotStart = null; // earliest snapshot month present at all
  try {
    const rows = await db('customer_mrr_snapshots')
      .whereIn('period_month', fetchKeys)
      .select('period_month', 'customer_id', 'monthly_rate');
    for (const r of rows) {
      const key = periodKeyOf(r.period_month);
      if (!snapshotsByMonth.has(key)) snapshotsByMonth.set(key, new Map());
      snapshotsByMonth.get(key).set(r.customer_id, parseFloat(r.monthly_rate) || 0);
    }
    const [first] = await db('customer_mrr_snapshots').min({ m: 'period_month' });
    snapshotStart = first?.m ? periodKeyOf(first.m) : null;
  } catch { /* table absent (pre-migration env) — every month degrades */ }

  // In-progress month: recompute from live rates via the SAME population query
  // the snapshot cron writes from (customerRateRows — active, not-deleted,
  // rate > 0, internal excluded), so today's adds/churns/reprices show now
  // instead of after the next 6:05am upsert. Falls back to the snapshot rows.
  try {
    const { customerRateRows } = require('./mrr-snapshot');
    overlayLiveCurrentMonth(snapshotsByMonth, currentMonthKey, await customerRateRows(db));
  } catch { /* live read failed — keep the (possibly stale) snapshot rows */ }

  // Conversion months for customers ENTERING a diffable month (new vs
  // reactivated split). One query over just those ids.
  const enteredIds = new Set();
  for (let i = 0; i < monthKeys.length; i++) {
    const key = monthKeys[i];
    const prev = snapshotsByMonth.get(i > 0 ? monthKeys[i - 1] : prevMonthKey(key));
    const curr = snapshotsByMonth.get(key);
    if (!prev || !curr) continue;
    for (const id of curr.keys()) if (!prev.has(id)) enteredIds.add(id);
  }
  const conversionMonthById = new Map();
  if (enteredIds.size) {
    const rows = await db('customers')
      .whereIn('id', [...enteredIds])
      .select('id', db.raw(`to_char(${CONVERSION_DATE_SQL}, 'YYYY-MM') as conv_month`));
    for (const r of rows) conversionMonthById.set(r.id, r.conv_month);
  }

  // Customers-table approximation for months that can't diff snapshots.
  // Same population + exit convention as the retention cohort: converted
  // customers only (customer stages + churned/dormant), internal excluded;
  // exit month = churned_at, else stage-change month when the stage move IS
  // the exit, else deleted month. Valued at CURRENT rates — that's the
  // documented approximation, not an error.
  const degradedKeys = monthKeys.filter((key, i) => {
    const prev = snapshotsByMonth.get(i > 0 ? monthKeys[i - 1] : prevMonthKey(key));
    return !snapshotsByMonth.get(key) || !prev;
  });
  const degradedByMonth = new Map();
  if (degradedKeys.length) {
    const rangeStart = degradedKeys[0];
    try {
      const qb = db('customers')
        .whereIn('pipeline_stage', [...CUSTOMER_STAGES, 'churned', 'dormant'])
        .where('monthly_rate', '>', 0);
      if (INTERNAL_TEST_CUSTOMERS.length) {
        qb.whereNotIn(
          db.raw("LOWER(COALESCE(first_name, '') || ' ' || COALESCE(last_name, ''))"),
          INTERNAL_TEST_CUSTOMERS,
        );
      }
      const rows = await qb.select(
        'monthly_rate',
        'active',
        'deleted_at',
        'pipeline_stage',
        db.raw(`to_char(${CONVERSION_DATE_SQL}, 'YYYY-MM') as conv_month`),
        db.raw("to_char(churned_at, 'YYYY-MM') as churned_month"),
        db.raw("to_char((pipeline_stage_changed_at AT TIME ZONE 'America/New_York')::date, 'YYYY-MM') as stage_changed_month"),
        db.raw("to_char((deleted_at AT TIME ZONE 'America/New_York')::date, 'YYYY-MM') as deleted_month"),
      );
      const degradedSet = new Set(degradedKeys.map(ymOf));
      const entry = (key) => {
        if (!degradedByMonth.has(key)) {
          degradedByMonth.set(key, { newMrr: 0, newCount: 0, churnedMrr: 0, churnedCount: 0 });
        }
        return degradedByMonth.get(key);
      };
      for (const r of rows) {
        const rate = parseFloat(r.monthly_rate) || 0;
        if (r.conv_month && degradedSet.has(r.conv_month)) {
          const e = entry(`${r.conv_month}-01`);
          e.newMrr += rate;
          e.newCount += 1;
        }
        const live = r.active && !r.deleted_at && CUSTOMER_STAGES.includes(r.pipeline_stage);
        if (!live) {
          const exitMonth = r.churned_month
            || (['churned', 'dormant'].includes(r.pipeline_stage) ? r.stage_changed_month : null)
            || r.deleted_month;
          if (exitMonth && degradedSet.has(exitMonth)) {
            const e = entry(`${exitMonth}-01`);
            e.churnedMrr += rate;
            e.churnedCount += 1;
          }
        }
      }
      void rangeStart; // population is small; no date bound needed beyond the month filter
    } catch { /* customers-shape mismatch — degraded months render as zeros */ }
  }

  const bridgeMonths = buildBridgeMonths({
    monthKeys,
    snapshotsByMonth,
    conversionMonthById,
    degradedByMonth,
    currentMonthKey,
  });

  return {
    months: bridgeMonths,
    snapshotStart, // 'YYYY-MM-01' of the first per-customer snapshot ever taken
    today: etDateString(),
  };
}

module.exports = { buildBridgeMonths, computeMrrBridge, overlayLiveCurrentMonth, prevMonthKey, periodKeyOf, monthLabelOf };
