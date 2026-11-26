/**
 * Office cost per stop, and the stored monthly financial snapshot (owner approved 2026-11-25).
 *
 *   office_cost          = ledger expenses in OFFICE_CATEGORIES for the month
 *                          + the owner office-time allowance (hours x rate, company_financials)
 *   paid_stops           = completed service_records in the month that are not callbacks
 *   office_cost_per_stop = office_cost / paid_stops (null when there are no paid stops)
 *
 * Reads reuse pnl-report.js (the P&L report for the cash-basis revenue and net income, the
 * pay-run category exclusion) and the dashboard gross-margin tile's formula
 * (SUM(gross_profit) / SUM(revenue) over costed visits), so the stored numbers match the
 * screens they sit beside. Nothing here sends, charges or changes a customer record.
 */

const { etMonthStart, etDateString } = require('../utils/datetime-et');
const { dateOnlyString } = require('../utils/date-only');
const { pnlPayRunWagesLive } = require('../config/feature-gates');
const { buildPnlReport } = require('./pnl-report');
const { leaveOutPayRunCategory } = require('./pay-run-books');
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

/** Owner office-time allowance for a month: hours x hourly rate. Null or 0 on either input = not counted (0). */
function ownerAllowance(financials) {
  const hours = num(financials && financials.owner_office_hours_per_month);
  const rate = num(financials && financials.owner_office_hourly_rate);
  if (hours <= 0 || rate <= 0) return 0;
  return round2(hours * rate);
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
 * Completed visits that earn their own pay: service_records rows with status completed,
 * not flagged is_callback (re-services and free returns carry that flag; see
 * services/re-service.js and the 20260618000002 backfill).
 */
async function paidStopsForWindow(db, startDate, endDate) {
  const row = await db('service_records')
    .whereBetween('service_date', [startDate, endDate])
    .where('status', 'completed')
    .where(function notCallback() {
      this.whereNull('is_callback').orWhere('is_callback', false);
    })
    .count({ n: '*' })
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

/** The newest company_financials row, the same accessor every other settings reader uses. */
async function latestFinancials(db) {
  return (await db('company_financials').orderBy('effective_date', 'desc').first()) || null;
}

/** Everything one month's snapshot row holds. Pure reads; writes nothing. */
async function computeMonthSnapshot(month, db = require('../models/db')) {
  const { month: monthStart, startDate, endDate } = monthWindow(month);
  const [ledger, stops, jobs, financials, pnl] = await Promise.all([
    officeLedgerCost(db, startDate, endDate),
    paidStopsForWindow(db, startDate, endDate),
    jobRevenueForWindow(db, startDate, endDate),
    latestFinancials(db),
    buildPnlReport(db, startDate, endDate),
  ]);
  const allowance = ownerAllowance(financials);
  const officeCost = round2(ledger + allowance);
  const cashRevenue = round2(pnl.revenue.total);
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
  };
}

/** Compute and store one month (one row per month: a re-run replaces it). Returns the stored values. */
async function upsertMonthSnapshot(month, db = require('../models/db')) {
  const snapshot = await computeMonthSnapshot(month, db);
  await db('monthly_financial_snapshots')
    .insert({ ...snapshot, computed_at: new Date() })
    .onConflict('month')
    .merge();
  return snapshot;
}

/**
 * The monthly job body. On the 2nd it writes last month and re-writes the month before it
 * (late ledger entries). With catchUp it first checks that last month's row exists and does
 * nothing when it does, so a lost tick on the 2nd is made up on days 3 to 7 without a
 * second write.
 */
async function runMonthlyFinancialSnapshots({ now = new Date(), catchUp = false, db = require('../models/db') } = {}) {
  const last = monthOffset(now, -1);
  const beforeLast = monthOffset(now, -2);
  if (catchUp) {
    const existing = await db('monthly_financial_snapshots').where({ month: last }).first('id');
    if (existing) return { skipped: 'already_written', months: [] };
  }
  const written = [];
  for (const month of [last, beforeLast]) {
    await upsertMonthSnapshot(month, db);
    written.push(month);
  }
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

/** The dashboard card's payload: the last `months` stored rows, oldest first, plus the headline and the owner-time note. */
async function getOfficeCostPerStopSeries({ months = 12, db = require('../models/db') } = {}) {
  const limit = Math.max(1, Math.min(36, parseInt(months, 10) || 12));
  const rows = (await db('monthly_financial_snapshots').orderBy('month', 'desc').limit(limit))
    .map(shapeRow)
    .reverse();
  const financials = await latestFinancials(db);
  return {
    months: rows,
    trailing: trailingThreeMonths(rows),
    ownerOfficeTime: {
      counted: ownerAllowance(financials) > 0,
      hoursPerMonth: decimalOrNull(financials && financials.owner_office_hours_per_month),
      hourlyRate: decimalOrNull(financials && financials.owner_office_hourly_rate),
    },
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
