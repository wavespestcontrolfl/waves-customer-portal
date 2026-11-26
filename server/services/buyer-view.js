/**
 * Buyer view: the six numbers a buyer of the business asks about, read for GET /api/admin/dashboard/buyer-view.
 * Read-only: sends nothing, charges nothing, writes nothing.
 *
 * Five of the six come from the stored monthly snapshots (monthly-financial-snapshot.js and its buyer columns, written on
 * the 2nd of each month) over the newest 12 stored months. A month whose column is NULL (a row stored before the column
 * existed, or a figure that could not be worked out) is left out of that metric's sums and counted in monthsCounted, so
 * a partial figure says it is partial. "Plan revenue kept" is a live query. Each metric carries its basis in plain words.
 */
const { etDateString, addETDays } = require('../utils/datetime-et');
const { dateOnlyString } = require('../utils/date-only');
const { monthOffset, monthWindow } = require('./monthly-financial-snapshot');
const { excludeInternalTestCustomers } = require('./mrr-breakdown');
const { ownerForSnapshot, ownerFieldMinutes, PLAN_START_SQL, PLAN_VISIT_SQL } = require('./monthly-snapshot-buyer-columns');

const WINDOW_MONTHS = 12;
const HOURS_WEEKS = 12;

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};
const round1 = (n) => Math.round(n * 10) / 10;
const round2 = (n) => Math.round(n * 100) / 100;
const ratio = (top, bottom) => (bottom > 0 ? top / bottom : null);
const pctOf = (top, bottom) => {
  const r = ratio(top, bottom);
  return r == null ? null : round1(r * 100);
};
// Month arithmetic on numbers only: 'YYYY-MM-DD' -> year x 12 + month index.
const monthIndexOf = (month) => Number(String(month).slice(0, 4)) * 12 + Number(String(month).slice(5, 7)) - 1;

/** Sum of `column` over the rows that have it (non-null), and how many rows that was. */
function sumColumn(rows, column) {
  let total = 0;
  let months = 0;
  for (const row of rows) {
    if (row[column] == null) continue;
    total += num(row[column]);
    months += 1;
  }
  return { total, months };
}

/** A stored percent averaged over the months that have it, weighted by that month's dollar column (sum of pct x dollars / sum of dollars). */
function weightedPercent(rows, pctColumn, weightColumn) {
  let weighted = 0;
  let weight = 0;
  let months = 0;
  for (const row of rows) {
    if (row[pctColumn] == null) continue;
    weighted += (num(row[pctColumn]) * num(row[weightColumn])) / 100;
    weight += num(row[weightColumn]);
    months += 1;
  }
  return { pct: pctOf(weighted, weight), months };
}

/** The newest 12 stored months (the window) and the 12 before them (prior), oldest first, picked by month number. */
function splitWindows(rows) {
  if (!rows.length) return { window: [], prior: [] };
  const latest = Math.max(...rows.map((r) => monthIndexOf(r.month)));
  const inRange = (row, from, to) => monthIndexOf(row.month) >= from && monthIndexOf(row.month) <= to;
  const sorted = [...rows].sort((a, b) => monthIndexOf(a.month) - monthIndexOf(b.month));
  return {
    window: sorted.filter((r) => inRange(r, latest - (WINDOW_MONTHS - 1), latest)),
    prior: sorted.filter((r) => inRange(r, latest - (2 * WINDOW_MONTHS - 1), latest - WINDOW_MONTHS)),
  };
}

function revenueMetric({ window, prior }) {
  const now = sumColumn(window, 'cash_revenue');
  const before = sumColumn(prior, 'cash_revenue');
  const complete = now.months === WINDOW_MONTHS && before.months === WINDOW_MONTHS;
  return {
    value: round2(now.total),
    priorValue: round2(before.total),
    growthPct: complete && before.total > 0 ? round1((now.total / before.total - 1) * 100) : null,
    monthsCounted: now.months,
    priorMonthsCounted: before.months,
    basis: 'Cash revenue from the books (P&L): money received less refunds and sales tax, summed over the newest 12 stored months. '
      + 'Growth compares them with the 12 months before, and is blank unless both runs are 12 full months.',
  };
}

function recurringMetric({ window }) {
  const recurring = sumColumn(window, 'recurring_revenue');
  const mature = sumColumn(window, 'recurring_mature_revenue');
  const total = sumColumn(window.filter((r) => r.recurring_revenue != null), 'completed_job_revenue');
  return {
    share: pctOf(recurring.total, total.total),
    matureShareOfRecurring: pctOf(mature.total, recurring.total),
    matureShareOfRevenue: pctOf(mature.total, total.total),
    recurringRevenue: round2(recurring.total),
    monthsCounted: recurring.months,
    basis: 'Visit revenue from plan customers over all completed-visit revenue, same 12 months. A visit is plan revenue when it belongs '
      + 'to a recurring series or an annual-prepay term, or when the customer held a real WaveGuard tier and had started and not yet '
      + 'churned on the visit date (test accounts left out). "Mature" = plans at least 12 months old at the start of the month. Visit revenue is job-costing\'s '
      + 'figure for each visit (annual-prepay visits at their prepay share), not cash.',
  };
}

function grossMarginMetric({ window }) {
  // Book margin is total book gross profit (dollars) over total cash revenue of the same months, so a month with no or
  // negative revenue still carries its profit or loss and never drops out of the year.
  const profit = sumColumn(window, 'book_gross_profit');
  const revenue = sumColumn(window.filter((r) => r.book_gross_profit != null), 'cash_revenue');
  const perJob = weightedPercent(window, 'gross_margin_pct', 'completed_job_revenue');
  return {
    bookPct: pctOf(profit.total, revenue.total),
    bookGrossProfit: round2(profit.total),
    bookMonthsCounted: profit.months,
    perJobAtStandardPct: perJob.pct,
    perJobMonthsCounted: perJob.months,
    basis: 'From the books: cash revenue less cost-of-goods expenses (supplies, materials, chemicals), less pay-run wages when the '
      + 'P&L counts them, less the owner\'s field wage; total over the months, divided by their total revenue. Per job, at standard '
      + 'minutes: completed-visit revenue less job costs where on-site time is the standard 25 minutes for pest and 20 for lawn '
      + 'plus drive (the dashboard tile\'s formula).',
  };
}

function ownerProfitMetric({ window }) {
  const profit = sumColumn(window.filter((r) => r.owner_paid_profit != null), 'owner_paid_profit');
  const revenue = sumColumn(window.filter((r) => r.owner_paid_profit != null), 'cash_revenue');
  const sde = sumColumn(window, 'sde');
  const officeMonths = window.filter((r) => num(r.owner_allowance) > 0).length;
  const fieldMonths = window.filter((r) => num(r.owner_field_allowance) > 0).length;
  return {
    marginPct: pctOf(profit.total, revenue.total),
    ownerPaidProfit: round2(profit.total),
    sde: round2(sde.total),
    monthsCounted: profit.months,
    sdeMonthsCounted: sde.months,
    ownerPay: { officeMonths, fieldMonths, months: window.length },
    basis: 'EBITDA (P&L net income with depreciation and interest added back) less the owner\'s own time: office hours x office rate '
      + 'and field hours x field wage. The books hold no pay for the owner. SDE is the same EBITDA before any owner pay.',
  };
}

function officeCostMetric({ window }) {
  const cost = sumColumn(window, 'office_cost');
  const stops = sumColumn(window, 'paid_stops');
  const revenue = sumColumn(window, 'cash_revenue');
  return {
    perStop: stops.total > 0 ? round2(cost.total / stops.total) : null,
    pctOfRevenue: pctOf(cost.total, revenue.total),
    officeCost: round2(cost.total),
    paidStops: stops.total,
    monthsCounted: cost.months,
    basis: 'Office cost (ledger office categories plus the owner\'s office time) summed over the 12 months, over paid stops '
      + '(sum over sum, not an average of months), and over cash revenue.',
  };
}

/** Plan-revenue-kept windows from today: the 12 closed months, and the 12 before them, as { start, end } calendar dates. */
function keptWindows(now) {
  return {
    current: { start: monthOffset(now, -12), end: monthWindow(monthOffset(now, -1)).endDate },
    then: { start: monthOffset(now, -24), end: monthWindow(monthOffset(now, -13)).endDate },
  };
}

/**
 * Plan revenue kept: customers who were on a plan in the earlier 12 closed months (a visit that was plan revenue on its own
 * date, PLAN_VISIT_SQL, so a customer whose tier was cleared when they left still counts) and had been customers since before
 * that window; what each paid in the earlier 12 months (visit revenue), against what each pays in the latest 12 closed months,
 * capped at the earlier amount, so a price rise or an add-on never offsets a loss. A customer who left pays 0.
 * Pays: sum of capped / sum of earlier.
 */
async function planRevenueKept(db, now) {
  const { current, then } = keptWindows(now);
  const inEarlier = 'sr.service_date BETWEEN ?::date AND ?::date';
  const per = db('service_records as sr')
    .join('customers as c', 'c.id', 'sr.customer_id')
    .leftJoin('scheduled_services as ss', 'ss.id', 'sr.scheduled_service_id')
    .whereBetween('sr.service_date', [then.start, current.end])
    .whereNotNull('sr.revenue')
    .whereRaw(`${PLAN_START_SQL} <= ?::date`, [then.start])
    .modify(excludeInternalTestCustomers(db))
    .groupBy('sr.customer_id')
    .select(
      'sr.customer_id',
      db.raw(`SUM(sr.revenue) FILTER (WHERE ${inEarlier}) AS then_revenue`, [then.start, then.end]),
      db.raw('SUM(sr.revenue) FILTER (WHERE sr.service_date BETWEEN ?::date AND ?::date) AS now_revenue', [current.start, current.end]),
      db.raw(`BOOL_OR(${PLAN_VISIT_SQL} AND ${inEarlier}) AS plan_then`, [then.start, then.end]),
    );
  const row = await db.from(per.as('per'))
    .where('per.plan_then', true)
    .where('per.then_revenue', '>', 0)
    .select(
      db.raw('COUNT(*)::int AS customers'),
      db.raw('COALESCE(SUM(per.then_revenue), 0)::text AS then_total'),
      db.raw('COALESCE(SUM(LEAST(GREATEST(COALESCE(per.now_revenue, 0), 0), per.then_revenue)), 0)::text AS kept_total'),
    )
    .first();
  const thenTotal = num(row && row.then_total);
  return {
    pct: pctOf(num(row && row.kept_total), thenTotal),
    customers: num(row && row.customers),
    thenRevenue: round2(thenTotal),
    keptRevenue: round2(row && row.kept_total),
    windows: { earlier: then, latest: current },
    basis: 'Customers who were on a plan in the 12 months ending '
      + `${then.end} and customers for at least a year before that: what each paid then, against what each paid in the 12 months ending `
      + `${current.end}, never counting more than the earlier amount. Visit revenue per customer; a customer who left counts as 0 now. `
      + 'Blank until there are plan customers that old.',
  };
}

/** The owner's field hours a week over the last 12 weeks (standard minutes), or null when the owner is not resolvable. */
async function ownerHoursPerWeek(db, now) {
  const owner = await ownerForSnapshot(db);
  if (!owner) return { value: null, available: false };
  const end = etDateString(now);
  const start = etDateString(addETDays(now, -(HOURS_WEEKS * 7 - 1)));
  const { minutes } = await ownerFieldMinutes(db, owner.id, start, end);
  return { value: round1(minutes / 60 / HOURS_WEEKS), available: true, window: { start, end } };
}

/** Each metric runs alone: a failure is { error } for that one tile, never a failed response. */
async function settled(label, logger, work) {
  try {
    return await work();
  } catch (err) {
    logger.error(`[buyer-view] ${label} failed: ${err.message}`);
    return { error: 'unavailable' };
  }
}

async function getBuyerView({ db = require('../models/db'), now = new Date(), logger = require('./logger') } = {}) {
  const rows = (await db('monthly_financial_snapshots').orderBy('month', 'desc').limit(2 * WINDOW_MONTHS))
    .map((r) => ({ ...r, month: dateOnlyString(r.month) }));
  const windows = splitWindows(rows);
  const [kept, hours] = await Promise.all([
    settled('plan revenue kept', logger, () => planRevenueKept(db, now)),
    settled('owner hours', logger, () => ownerHoursPerWeek(db, now)),
  ]);
  const latest = windows.window[windows.window.length - 1] || null;
  return {
    asOf: etDateString(now),
    months: { count: windows.window.length, from: windows.window[0] ? windows.window[0].month : null, to: latest ? latest.month : null },
    revenue: revenueMetric(windows),
    recurring: recurringMetric(windows),
    planRevenueKept: kept,
    grossMargin: grossMarginMetric(windows),
    ownerProfit: ownerProfitMetric(windows),
    officeCost: officeCostMetric(windows),
    ownerFieldHoursPerWeek: hours,
    prepaidOwed: latest && latest.prepaid_owed != null ? { value: round2(latest.prepaid_owed), month: latest.month } : null,
    pnlIncompleteMonths: windows.window.filter((r) => r.pnl_complete === false).map((r) => r.month),
  };
}

module.exports = {
  getBuyerView,
  planRevenueKept,
  ownerHoursPerWeek,
  splitWindows,
  sumColumn,
  weightedPercent,
  revenueMetric,
  recurringMetric,
  grossMarginMetric,
  ownerProfitMetric,
  officeCostMetric,
  keptWindows,
};
