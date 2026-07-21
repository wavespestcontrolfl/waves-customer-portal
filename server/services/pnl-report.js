/**
 * P&L Report Builder — the single source of truth for the management P&L.
 *
 * Serves GET /api/admin/tax/pnl, GET /api/admin/tax/export/pnl, and the
 * tax-package ZIP so the on-screen P&L and every exported P&L are the SAME
 * numbers. Before this module, each of the three computed its own P&L and
 * all three disagreed — and the on-screen one was all zeros in production
 * because its queries referenced columns/tables that don't exist
 * (payments.type, payments.status='completed', revenue_daily,
 * time_entry_daily_summary.total_cost). 2026-07-20 financial-reporting audit.
 *
 * Data sources (verified against the live schema):
 *   revenue      — payments WHERE status='paid', windowed on payment_date
 *                  (a DATE stamped in ET at insert; NULL-free on paid rows).
 *                  Fully refunded payments flip to status='refunded' and drop
 *                  out of every period retroactively; partial refunds keep
 *                  status='paid' at the original amount. Cash-basis limitation,
 *                  documented rather than hidden.
 *   labor        — time_entry_daily_summary.total_job_minutes × the loaded
 *                  labor rate from company_financials (the same rate per-visit
 *                  job costing uses; the summary table stores minutes, not
 *                  cost). Job minutes only — drive/admin/break time is not
 *                  COGS labor, matching job-costing.js's entry_type='job'
 *                  scoping.
 *   materials    — expenses in the COGS categories.
 *   opex         — every other expense INCLUDING uncategorized ones. The old
 *                  whereNotIn(name) dropped NULL-category rows entirely (SQL
 *                  NOT IN + NULL), which in prod was 137/137 expenses.
 *   mileage      — mileage_log.deduction_amount in the window.
 *   depreciation — per-asset annual_depreciation prorated by days in service
 *                  within the window (same proration everywhere, including the
 *                  tax package, which previously summed full-year amounts).
 *
 * assemblePnl() is pure (no I/O) and unit-tested; buildPnlReport() runs the
 * queries and feeds it.
 */

const { etParts, etDateString } = require('../utils/datetime-et');

const COGS_CATEGORIES = ['Supplies', 'Materials', 'Cost of Goods Sold', 'Chemicals'];
const DEFAULT_LOADED_LABOR_RATE = 35; // matches job-costing.js fallback

const pad2 = (n) => String(n).padStart(2, '0');
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

/**
 * Resolve a named period to ET calendar date strings. Ported verbatim from the
 * /pnl route so /pnl and /export/pnl resolve identical windows (the export's
 * old inline fallback ignored `period` and always exported YTD).
 * Returns { startDate, endDate } or null when a custom period is incomplete.
 */
function getPeriodRange(period, { start_date, end_date } = {}, now = new Date()) {
  const et = etParts(now);
  let startDate;
  let endDate;
  switch (period) {
    case 'monthly':
    case 'mtd':
      startDate = `${et.year}-${pad2(et.month)}-01`;
      endDate = etDateString(now);
      break;
    case 'last_month': {
      const lmMonth = et.month === 1 ? 12 : et.month - 1;
      const lmYear = et.month === 1 ? et.year - 1 : et.year;
      startDate = `${lmYear}-${pad2(lmMonth)}-01`;
      const lmEnd = new Date(Date.UTC(et.year, et.month - 1, 0, 12, 0, 0));
      const lmEndP = etParts(lmEnd);
      endDate = `${lmEndP.year}-${pad2(lmEndP.month)}-${pad2(lmEndP.day)}`;
      break;
    }
    case 'quarterly': {
      const qMonth = Math.floor((et.month - 1) / 3) * 3 + 1;
      startDate = `${et.year}-${pad2(qMonth)}-01`;
      endDate = etDateString(now);
      break;
    }
    case 'ytd':
      startDate = `${et.year}-01-01`;
      endDate = etDateString(now);
      break;
    case 'annual':
    case 'last_year':
      startDate = `${et.year - 1}-01-01`;
      endDate = `${et.year - 1}-12-31`;
      break;
    case 'custom':
      startDate = start_date;
      endDate = end_date;
      break;
    default:
      startDate = `${et.year}-${pad2(et.month)}-01`;
      endDate = etDateString(now);
  }
  if (!startDate || !endDate) return null;
  return { startDate, endDate };
}

/**
 * Per-asset depreciation prorated to the window, respecting
 * placed_in_service_date. Pure. Section 179 / bonus assets carry
 * annual_depreciation NULL (their deduction was taken at purchase) and
 * contribute nothing here.
 */
function prorateDepreciation(assets, startDate, endDate) {
  const periodStart = new Date(startDate);
  const periodEnd = new Date(endDate);
  let total = 0;
  for (const a of assets || []) {
    const annual = parseFloat(a.annual_depreciation || 0);
    if (!annual) continue;
    const inService = a.placed_in_service_date
      ? new Date(a.placed_in_service_date)
      : (a.purchase_date ? new Date(a.purchase_date) : null);
    const effStart = inService && inService > periodStart ? inService : periodStart;
    if (effStart > periodEnd) continue;
    const effDays = (periodEnd - effStart) / 86400000 + 1;
    total += annual * (Math.max(0, effDays) / 365);
  }
  return round2(total);
}

/**
 * Pure assembly of the P&L response shape from pre-queried inputs.
 * opexRows: [{ category, irs_line, total }] where category may be null
 * (uncategorized — grouped under 'Uncategorized', never dropped).
 */
function assemblePnl({
  serviceRevenue = 0,
  otherRevenue = 0,
  laborMinutes = 0,
  loadedLaborRate = DEFAULT_LOADED_LABOR_RATE,
  materialsCost = 0,
  opexRows = [],
  mileageDeduction = 0,
  depreciationTotal = 0,
} = {}) {
  const revenue = round2(serviceRevenue);
  const other = round2(otherRevenue);
  const laborCost = round2((Number(laborMinutes) || 0) / 60 * (Number(loadedLaborRate) || DEFAULT_LOADED_LABOR_RATE));
  const materials = round2(materialsCost);

  const byCategory = new Map();
  for (const row of opexRows) {
    const name = row.category || 'Uncategorized';
    const prev = byCategory.get(name) || { name, irsLine: row.irs_line || null, amount: 0 };
    prev.amount = round2(prev.amount + (parseFloat(row.total) || 0));
    byCategory.set(name, prev);
  }
  const opexCategories = Array.from(byCategory.values()).sort((a, b) => b.amount - a.amount);
  const opexTotal = round2(opexCategories.reduce((s, c) => s + c.amount, 0));

  const totalRevenue = round2(revenue + other);
  const cogsTotal = round2(laborCost + materials);
  const grossProfit = round2(totalRevenue - cogsTotal);
  const deductionsTotal = round2((Number(mileageDeduction) || 0) + (Number(depreciationTotal) || 0));
  const netIncome = round2(grossProfit - opexTotal - deductionsTotal);

  return {
    revenue: { serviceRevenue: revenue, otherRevenue: other, total: totalRevenue },
    cogs: { labor: laborCost, materials, total: cogsTotal },
    grossProfit,
    grossMargin: totalRevenue > 0 ? grossProfit / totalRevenue : 0,
    operatingExpenses: { categories: opexCategories, total: opexTotal },
    deductions: {
      mileage: round2(mileageDeduction),
      depreciation: round2(depreciationTotal),
      total: deductionsTotal,
    },
    netIncome,
    netMargin: totalRevenue > 0 ? netIncome / totalRevenue : 0,
  };
}

/**
 * Degrade to a fallback ONLY when the source table doesn't exist (Postgres
 * 42P01 undefined_table — dev environments behind on migrations). Every other
 * failure (connection, permission, bad column, syntax) PROPAGATES: the old
 * blanket catches turned exactly those errors into a plausible all-zero
 * report for months, which is the failure mode this module exists to kill.
 */
function missingTableOnly(fallback) {
  return (err) => {
    if (err && err.code === '42P01') return fallback;
    throw err;
  };
}

/**
 * Run the P&L queries for [startDate, endDate] (inclusive ET calendar dates)
 * and assemble the report. Every source column verified against the live
 * schema 2026-07-20. Individual sources still degrade to zero on a missing
 * TABLE (dev environments), but every other error propagates to the caller.
 */
async function buildPnlReport(db, startDate, endDate) {
  const [revRow, laborRow, financialsRow, matRow, opexRows, mileageRow, assets] = await Promise.all([
    db('payments')
      .where('status', 'paid')
      .whereBetween('payment_date', [startDate, endDate])
      .select(db.raw("COALESCE(SUM(amount)::text, '0') as total"))
      .first()
      .catch(missingTableOnly({ total: '0' })),
    db('time_entry_daily_summary')
      .whereBetween('work_date', [startDate, endDate])
      .select(db.raw("COALESCE(SUM(total_job_minutes)::text, '0') as minutes"))
      .first()
      .catch(missingTableOnly({ minutes: '0' })),
    db('company_financials')
      .orderBy('effective_date', 'desc')
      .first()
      .catch(missingTableOnly(null)),
    db('expenses')
      .leftJoin('expense_categories', 'expenses.category_id', 'expense_categories.id')
      .whereBetween('expenses.expense_date', [startDate, endDate])
      .whereIn('expense_categories.name', COGS_CATEGORIES)
      .select(db.raw("COALESCE(SUM(expenses.amount)::text, '0') as total"))
      .first()
      .catch(missingTableOnly({ total: '0' })),
    db('expenses')
      .leftJoin('expense_categories', 'expenses.category_id', 'expense_categories.id')
      .whereBetween('expenses.expense_date', [startDate, endDate])
      // Uncategorized (NULL name) rows are opex too — a bare whereNotIn drops
      // them (SQL NOT IN + NULL), which zeroed the whole opex section in prod.
      .where(function cogsOrNull() {
        this.whereNull('expense_categories.name')
          .orWhereNotIn('expense_categories.name', COGS_CATEGORIES);
      })
      .select('expense_categories.name as category', 'expense_categories.irs_line')
      .sum('expenses.amount as total')
      .groupBy('expense_categories.name', 'expense_categories.irs_line')
      .catch(missingTableOnly([])),
    db('mileage_log')
      .whereBetween('trip_date', [startDate, endDate])
      .select(db.raw("COALESCE(SUM(deduction_amount)::text, '0') as total"))
      .first()
      .catch(missingTableOnly({ total: '0' })),
    db('equipment_register')
      .where('active', true)
      .where(function notDisposed() { this.whereNull('disposed').orWhere('disposed', false); })
      .whereNotNull('annual_depreciation')
      .select('annual_depreciation', 'placed_in_service_date', 'purchase_date')
      .catch(missingTableOnly([])),
  ]);

  return assemblePnl({
    serviceRevenue: parseFloat(revRow?.total || 0),
    otherRevenue: 0,
    laborMinutes: parseFloat(laborRow?.minutes || 0),
    loadedLaborRate: Number(financialsRow?.loaded_labor_rate) || DEFAULT_LOADED_LABOR_RATE,
    materialsCost: parseFloat(matRow?.total || 0),
    opexRows,
    mileageDeduction: parseFloat(mileageRow?.total || 0),
    depreciationTotal: prorateDepreciation(assets, startDate, endDate),
  });
}

module.exports = {
  buildPnlReport,
  assemblePnl,
  getPeriodRange,
  prorateDepreciation,
  missingTableOnly,
  COGS_CATEGORIES,
  DEFAULT_LOADED_LABOR_RATE,
};
