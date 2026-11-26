/**
 * Office cost per stop, and the stored monthly financial snapshot (owner approved 2026-11-25).
 *
 *   office_cost          = ledger expenses in OFFICE_CATEGORIES for the month
 *                          + the owner office-time allowance (hours x rate, company_financials)
 *   paid_stops           = completed service_records in the month that are not callbacks
 *   office_cost_per_stop = office_cost / paid_stops (null when there are no paid stops)
 *
 * The buyer-view columns (owner field time, book gross margin, SDE, owner-paid profit, recurring and prepaid money) come
 * from monthly-snapshot-buyer-columns.js.
 *
 * Reads reuse pnl-report.js (the P&L report for the cash-basis revenue and net income, the
 * pay-run category exclusion) and the dashboard gross-margin tile's formula
 * (SUM(gross_profit) / SUM(revenue) over costed visits), so the stored numbers match the
 * screens they sit beside. Nothing here sends, charges or changes a customer record.
 */

const { etMonthStart, etDateString, parseETDateTime } = require('../utils/datetime-et');
const { dateOnlyString } = require('../utils/date-only');
const { pnlPayRunWagesLive } = require('../config/feature-gates');
const { buildPnlReport } = require('./pnl-report');
const { leaveOutPayRunCategory } = require('./pay-run-books');
const { timeAllowance, buyerColumns } = require('./monthly-snapshot-buyer-columns');
const logger = require('./logger');

// Office categories, by expense_categories.name. Insurance, vehicle, ads, card fees,
// interest, taxes, supplies and depreciation are left out on purpose: field or non-office
// costs. Card fees are not an expenses-ledger category at all (they come from the synced
// Stripe ledger), so they cannot leak in here.
const OFFICE_CATEGORIES = [
  'Legal & Professional',
  'Office Expenses',
  'Utilities',
  'Software & Technology',
  'Home Office',
];

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

// GATE_PNL_PAY_RUN_WAGES, read at call time like pnl-report.js does: a suite that mocks
// feature-gates without the reader keeps the gate-off behavior.
const payRunWagesOn = () => typeof pnlPayRunWagesLive === 'function' && pnlPayRunWagesLive();

/** 'YYYY-MM' or 'YYYY-MM-DD' -> { month: 'YYYY-MM-01', startDate, endDate } (calendar dates, no time zone). */
function monthWindow(month) {
  const match = /^(\d{4})-(\d{2})/.exec(String(month || ''));
  if (!match || Number(match[2]) < 1 || Number(match[2]) > 12) {
    throw new Error(`monthWindow: "${month}" is not a YYYY-MM month`);
  }
  const [, y, m] = match;
  const lastDay = new Date(Date.UTC(Number(y), Number(m), 0)).getUTCDate();
  return {
    month: `${y}-${m}-01`,
    startDate: `${y}-${m}-01`,
    endDate: `${y}-${m}-${String(lastDay).padStart(2, '0')}`,
  };
}

/** The ET calendar month `offset` months from `now` ('YYYY-MM-01'); -1 = last month. */
function monthOffset(now, offset) {
  return etMonthStart(now, offset);
}

/**
 * Owner office-time allowance for a month: hours x hourly rate, in dollars (timeAllowance: integer hundredths of an hour
 * x cents, rounded once). Null or 0 on either input = not counted (0).
 */
function ownerAllowance(financials) {
  return timeAllowance(financials && financials.owner_office_hours_per_month, financials && financials.owner_office_hourly_rate);
}

/** office_cost / paid_stops, or null when there are no stops. */
function officeCostPerStop(officeCost, paidStops) {
  const stops = num(paidStops);
  if (stops <= 0) return null;
  return round2(num(officeCost) / stops);
}

/** Ledger expenses in the office categories for [startDate, endDate]; the pay-run category stays out when its gate is on. */
async function officeLedgerCost(db, startDate, endDate) {
  const query = db('expenses')
    .leftJoin('expense_categories', 'expenses.category_id', 'expense_categories.id')
    .whereBetween('expenses.expense_date', [startDate, endDate])
    .whereIn('expense_categories.name', OFFICE_CATEGORIES);
  const row = await (payRunWagesOn() ? leaveOutPayRunCategory(query) : query)
    .select(db.raw("COALESCE(SUM(expenses.amount)::text, '0') as total"))
    .first();
  return round2(row && row.total);
}

/**
 * Paid stops: physical stops with completed work that earns money. A service_records row counts when
 *  - its status is completed and neither it nor its scheduled visit is flagged is_callback (re-services and free
 *    returns; services/re-service.js, the 20260618000002 backfill),
 *  - its scheduled visit is not an included follow-up (followup_included), and
 *  - job-costing booked revenue above $0 on it. job-costing.js deriveRevenueFromOwnSources is the one place that
 *    decides what a visit earns (prepay share, recorded amount, price, linked invoice, dues; $0 for always-free
 *    types, included follow-ups, a stamped zero or a visit marked intentionally free), so its stored result is
 *    read, not restated. A paid annual-prepay visit carries its prepay share and stays in. A visit job-costing has
 *    not costed (NULL revenue) is left out, the same as in the gross-margin tile.
 * A grouped visit (scheduled_services.visit_id, one parent service_visits row per physical stop) counts once
 * however many of its services were done; a record with no group counts on its own.
 */
async function paidStopsForWindow(db, startDate, endDate) {
  const row = await db('service_records as sr')
    .leftJoin('scheduled_services as ss', 'ss.id', 'sr.scheduled_service_id')
    .whereBetween('sr.service_date', [startDate, endDate])
    .where('sr.status', 'completed')
    .where('sr.revenue', '>', 0)
    .where(function recordNotCallback() {
      this.whereNull('sr.is_callback').orWhere('sr.is_callback', false);
    })
    .where(function visitNotCallback() {
      this.whereNull('ss.is_callback').orWhere('ss.is_callback', false);
    })
    .where(function visitNotIncludedFollowup() {
      this.whereNull('ss.followup_included').orWhere('ss.followup_included', false);
    })
    .select(db.raw('COUNT(DISTINCT COALESCE(ss.visit_id::text, sr.id::text)) as n'))
    .first();
  return Number(row && row.n) || 0;
}

/**
 * Completed-job revenue and gross margin, same window shape and formula as the dashboard
 * gross-margin tile (admin-dashboard.js core-kpis): every visit with a revenue figure,
 * margin = 100 x SUM(gross_profit) / SUM(revenue), $0-revenue costed visits included.
 */
async function jobRevenueForWindow(db, startDate, endDate) {
  const row = await db('service_records')
    .whereBetween('service_date', [startDate, endDate])
    .whereNotNull('revenue')
    .select(
      db.raw('COALESCE(SUM(revenue), 0)::text as revenue'),
      db.raw('100.0 * SUM(gross_profit) / NULLIF(SUM(revenue), 0) as weighted_margin'),
    )
    .first();
  const margin = row && row.weighted_margin != null ? Number(row.weighted_margin) : null;
  return {
    revenue: round2(row && row.revenue),
    grossMarginPct: Number.isFinite(margin) ? round2(margin) : null,
  };
}

/**
 * The company_financials row in effect on `onDate` (the newest row with effective_date on or before it), or null
 * when none had started yet. A month's owner allowance is read as of the month's last day, so a figure the owner
 * enters later never changes a month it did not apply to, and a re-write of an older month gives the same answer.
 */
async function financialsEffectiveOn(db, onDate) {
  return (await db('company_financials')
    .where('effective_date', '<=', onDate)
    .orderBy('effective_date', 'desc')
    .first()) || null;
}

/** Everything one month's snapshot row holds. Pure reads; writes nothing. */
async function computeMonthSnapshot(month, db = require('../models/db')) {
  const { month: monthStart, startDate, endDate } = monthWindow(month);
  const [ledger, stops, jobs, financials, pnl] = await Promise.all([
    officeLedgerCost(db, startDate, endDate),
    paidStopsForWindow(db, startDate, endDate),
    jobRevenueForWindow(db, startDate, endDate),
    financialsEffectiveOn(db, endDate),
    buildPnlReport(db, startDate, endDate),
  ]);
  const allowance = ownerAllowance(financials);
  const officeCost = round2(ledger + allowance);
  const cashRevenue = round2(pnl.revenue.total);
  const buyer = await buyerColumns(db, { startDate, endDate, financials, pnl, officeAllowance: allowance, cashRevenue });
  return {
    month: monthStart,
    completed_job_revenue: jobs.revenue,
    cash_revenue: cashRevenue,
    gross_margin_pct: jobs.grossMarginPct,
    office_cost: officeCost,
    owner_allowance: allowance,
    paid_stops: stops,
    office_cost_per_stop: officeCostPerStop(officeCost, stops),
    net_income: round2(pnl.netIncome),
    net_margin_pct: cashRevenue > 0 ? round2(num(pnl.netMargin) * 100) : null,
    // buildPnlReport's coverage verdict: the balance ledger synced past month end, so the refunds, disputes and
    // card fees inside cash revenue and net income are final.
    pnl_complete: !!(pnl.coverage && pnl.coverage.complete),
    ...buyer,
  };
}

// REPEATABLE READ: every read of one snapshot (the ledger, visits, settings and buildPnlReport's Stripe amounts
// and sync watermark) sees one database state. Under the default READ COMMITTED a Stripe sync that finished between
// buildPnlReport's reads could leave pre-sync amounts stored beside a watermark that says the ledger is complete.
const SNAPSHOT_ISOLATION = { isolationLevel: 'repeatable read' };

/** Compute and store one month on `trx` (already a snapshot transaction): one row per month, a re-run replaces it. */
async function writeMonthSnapshot(month, trx, computedAt) {
  const snapshot = await computeMonthSnapshot(month, trx);
  await trx('monthly_financial_snapshots')
    .insert({ ...snapshot, computed_at: computedAt })
    .onConflict('month')
    .merge();
  return snapshot;
}

// Postgres refuses a REPEATABLE READ transaction that conflicts with one that committed after its snapshot began
// (SQLSTATE 40001, serialization_failure; a concurrent upsert of the same row is the usual case, e.g. the cron and
// a backfill run at once). Nothing is kept from the failed attempt, so the WHOLE read and write is repeated on a
// fresh snapshot, a bounded number of times, then the error goes to the caller.
const SERIALIZATION_FAILURE = '40001';
const SNAPSHOT_ATTEMPTS = 3;

async function inSnapshotTransaction(db, work) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await db.transaction(work, SNAPSHOT_ISOLATION);
    } catch (err) {
      if (!err || err.code !== SERIALIZATION_FAILURE || attempt >= SNAPSHOT_ATTEMPTS) throw err;
      logger.warn(`[monthly-financial-snapshot] serialization failure, retrying (attempt ${attempt + 1} of ${SNAPSHOT_ATTEMPTS})`);
    }
  }
}

/** Compute and store one month in its own REPEATABLE READ transaction. Returns the stored values. */
async function upsertMonthSnapshot(month, db = require('../models/db'), computedAt = new Date()) {
  return inSnapshotTransaction(db, (trx) => writeMonthSnapshot(month, trx, computedAt));
}

/**
 * Does the pair still need this month's run? True when EITHER month's row is missing, was written before this
 * month's run window opened (the 2nd, 00:00 ET: a backfill or an older run), or says its P&L figures were not
 * complete (the balance ledger had not synced past month end). Both months are judged: a one-month backfill can
 * make last month look fresh while the month before is missing or stale.
 */
async function pairNeedsRun(db, months, now) {
  const rows = await db('monthly_financial_snapshots').whereIn('month', months).select('month', 'computed_at', 'pnl_complete');
  if (rows.length < months.length) return true;
  const runOpened = parseETDateTime(`${etMonthStart(now).slice(0, 8)}02T00:00`);
  return rows.some((row) => row.pnl_complete === false || !row.computed_at || new Date(row.computed_at) < runOpened);
}

/**
 * The monthly job body. On the 2nd it writes last month and re-writes the month before it (late ledger entries),
 * both in ONE REPEATABLE READ transaction (retried whole on a serialization failure): if either write fails neither row changes, so the pair stays missing (or
 * stale) and a catch-up run on days 3 to 7 does the whole pair again. With catchUp it does nothing unless
 * pairNeedsRun.
 */
async function runMonthlyFinancialSnapshots({ now = new Date(), catchUp = false, db = require('../models/db') } = {}) {
  const months = [monthOffset(now, -1), monthOffset(now, -2)];
  if (catchUp && !(await pairNeedsRun(db, months, now))) return { skipped: 'already_written', months: [] };
  const written = await inSnapshotTransaction(db, async (trx) => {
    const done = [];
    for (const month of months) {
      await writeMonthSnapshot(month, trx, now);
      done.push(month);
    }
    return done;
  });
  logger.info(`[monthly-financial-snapshot] wrote ${written.join(', ')}`);
  return { skipped: null, months: written };
}

const decimalOrNull = (v) => (v == null ? null : Number(v));

function shapeRow(r) {
  return {
    month: dateOnlyString(r.month),
    completedJobRevenue: num(r.completed_job_revenue),
    cashRevenue: num(r.cash_revenue),
    grossMarginPct: decimalOrNull(r.gross_margin_pct),
    officeCost: num(r.office_cost),
    ownerAllowance: num(r.owner_allowance),
    paidStops: Number(r.paid_stops) || 0,
    officeCostPerStop: decimalOrNull(r.office_cost_per_stop),
    netIncome: num(r.net_income),
    netMarginPct: decimalOrNull(r.net_margin_pct),
    pnlComplete: r.pnl_complete == null ? null : !!r.pnl_complete,
  };
}

/** Headline: the last three stored months, sum of office cost / sum of stops (null when no stops). */
function trailingThreeMonths(rows) {
  const last3 = rows.slice(-3);
  const officeCost = round2(last3.reduce((s, r) => s + r.officeCost, 0));
  const paidStops = last3.reduce((s, r) => s + r.paidStops, 0);
  return {
    months: last3.map((r) => r.month),
    officeCost,
    paidStops,
    officeCostPerStop: officeCostPerStop(officeCost, paidStops),
  };
}

/**
 * Whether the owner's own office time is inside the trailing months' office cost, read from each stored row's
 * owner_allowance (what that month actually used), never from today's settings: 'all', 'some' or 'none'.
 */
function ownerTimeStatus(trailingRows) {
  const withAllowance = trailingRows.filter((r) => r.ownerAllowance > 0).length;
  let status = 'some';
  if (withAllowance === 0) status = 'none';
  else if (withAllowance === trailingRows.length) status = 'all';
  return { status, monthsWithAllowance: withAllowance, months: trailingRows.length };
}

/** The dashboard card's payload: the last `months` stored rows, oldest first, plus the headline and the owner-time and P&L-coverage notes. */
async function getOfficeCostPerStopSeries({ months = 12, db = require('../models/db') } = {}) {
  const limit = Math.max(1, Math.min(36, parseInt(months, 10) || 12));
  const rows = (await db('monthly_financial_snapshots').orderBy('month', 'desc').limit(limit))
    .map(shapeRow)
    .reverse();
  const trailingRows = rows.slice(-3);
  return {
    months: rows,
    trailing: trailingThreeMonths(rows),
    ownerOfficeTime: ownerTimeStatus(trailingRows),
    // Months whose cash revenue and net income were stored before the balance ledger synced past month end.
    // Office cost and paid stops do not depend on that ledger.
    pnlIncompleteMonths: trailingRows.filter((r) => r.pnlComplete === false).map((r) => r.month),
    officeCategories: OFFICE_CATEGORIES,
    asOf: etDateString(),
  };
}

module.exports = {
  OFFICE_CATEGORIES,
  monthWindow,
  monthOffset,
  ownerAllowance,
  officeCostPerStop,
  officeLedgerCost,
  paidStopsForWindow,
  jobRevenueForWindow,
  computeMonthSnapshot,
  upsertMonthSnapshot,
  runMonthlyFinancialSnapshots,
  trailingThreeMonths,
  getOfficeCostPerStopSeries,
};
