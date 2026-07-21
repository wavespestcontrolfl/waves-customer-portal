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
 *   revenue      — all recorded cash inflows for the window (payments
 *                  ledger + paid-Stripe-invoice gap rows + estimate-deposit
 *                  cash) MINUS per-refund balance transactions from
 *                  stripe_payout_transactions in the window they occurred.
 *                  See paidRevenueForWindow for the full basis and the
 *                  refund-ledger sync-coverage caveat. Disputes/chargebacks
 *                  are not yet ledgered and are out of scope here.
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
 * NOTE — standard-mileage vs actual vehicle expenses: both currently flow
 * through (mileage as a deduction, any "Vehicle Expenses" category as opex).
 * The IRS method election is an owner/CPA decision, parked with Adam; until
 * it's made, every prod trip carries a $0 deduction (unclassified), so no
 * double-count is live. When the mileage-classification lane ships, wire the
 * elected method here and exclude the other side.
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
 * Per-asset depreciation prorated to the window: from
 * placed_in_service_date through disposal_date (when disposed), clamped to
 * the period. Pure. Section 179 / bonus assets carry annual_depreciation
 * NULL (their deduction was taken at purchase) and contribute nothing here.
 * Disposal CAPS the window rather than excluding the asset — filtering
 * disposed assets out (the old behavior) silently deleted their
 * depreciation from every historical P&L the moment they were disposed.
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
    const disposed = a.disposal_date ? new Date(a.disposal_date) : null;
    const effStart = inService && inService > periodStart ? inService : periodStart;
    const effEnd = disposed && disposed < periodEnd ? disposed : periodEnd;
    if (effStart > effEnd) continue;
    const effDays = (effEnd - effStart) / 86400000 + 1;
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
  laborCost = 0,
  materialsCost = 0,
  opexRows = [],
  mileageDeduction = 0,
  depreciationTotal = 0,
} = {}) {
  const revenue = round2(serviceRevenue);
  const other = round2(otherRevenue);
  const labor = round2(laborCost);
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
  const cogsTotal = round2(labor + materials);
  const grossProfit = round2(totalRevenue - cogsTotal);
  const deductionsTotal = round2((Number(mileageDeduction) || 0) + (Number(depreciationTotal) || 0));
  const netIncome = round2(grossProfit - opexTotal - deductionsTotal);

  return {
    revenue: { serviceRevenue: revenue, otherRevenue: other, total: totalRevenue },
    cogs: { labor, materials, total: cogsTotal },
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
/**
 * Cash received in the window minus cash refunded in the window.
 *
 * Received — every cash inflow the portal records, so the refund side below
 * can never subtract money that was never counted:
 *   1. payments rows (payment_date, an ET-stamped DATE), at FULL amount and
 *      including rows later flipped to status='refunded' — the cash really
 *      arrived in that period; a status='paid'-only filter made
 *      fully-refunded payments vanish retroactively from their month.
 *   2. Paid-Stripe-invoice GAP rows — invoices paid via Stripe whose
 *      stripe_payment_intent_id has no matching payments row. Same query
 *      shape and credit_applied netting as the dashboard's
 *      paidRevenueTotal (admin-dashboard.js), so the two surfaces agree.
 *   3. Estimate-deposit cash (estimate_deposits.received_at) — deposits
 *      deliberately have NO payments row (estimate-deposits.js); cash in
 *      is face amount + card surcharge.
 * - Refunded: per-refund balance transactions from
 *   stripe_payout_transactions (type='refund'), each with its own Stripe
 *   occurrence timestamp bucketed to an ET calendar day. This is the only
 *   durable PER-REFUND ledger in the DB: payments.refund_amount is a
 *   cumulative stamp (one number can't allocate multiple partial refunds
 *   across periods) and payments.refunded_at is never written by the
 *   Stripe refund paths. It covers deposit refunds too — consistent,
 *   because deposit receipts are on the received side. Refund amounts are
 *   negative in balance transactions, hence SUM(-amount).
 *   Coverage caveat: rows exist once the payout containing the refund has
 *   been synced (POST /api/admin/banking/sync); an unsynced tail lags until
 *   the next sync, exactly like the Banking fees/payout views built on the
 *   same table.
 * Exported so /revenue/reconcile reports the same revenue basis.
 */
async function paidRevenueForWindow(db, startDate, endDate) {
  const etWindow = (qb, column) => qb
    .whereRaw(`${column} >= ?::timestamp AT TIME ZONE 'America/New_York'`, [`${startDate}T00:00:00`])
    .whereRaw(`${column} < (?::timestamp + INTERVAL '1 day') AT TIME ZONE 'America/New_York'`, [`${endDate}T00:00:00`]);

  const [ledger, invoiceGaps, deposits, refunded] = await Promise.all([
    db('payments')
      .whereIn('status', ['paid', 'refunded'])
      .whereBetween('payment_date', [startDate, endDate])
      .select(db.raw("COALESCE(SUM(amount)::text, '0') as total"))
      .first()
      .catch(missingTableOnly({ total: '0' })),
    etWindow(
      db('invoices as i')
        .where({ 'i.status': 'paid', 'i.processor': 'stripe' })
        .whereNotNull('i.stripe_payment_intent_id')
        .whereNotExists(function gapGuard() {
          this.select(db.raw('1'))
            .from('payments as p')
            .whereRaw('p.stripe_payment_intent_id = i.stripe_payment_intent_id');
        }),
      'i.paid_at',
    )
      .select(db.raw('COALESCE(SUM(GREATEST(i.total - COALESCE(i.credit_applied, 0), 0))::text, \'0\') as total'))
      .first()
      .catch(missingTableOnly({ total: '0' })),
    etWindow(
      db('estimate_deposits').whereNotNull('received_at'),
      'received_at',
    )
      .select(db.raw("COALESCE(SUM(amount + COALESCE(card_surcharge, 0))::text, '0') as total"))
      .first()
      .catch(missingTableOnly({ total: '0' })),
    db('stripe_payout_transactions')
      .where('type', 'refund')
      .whereRaw(
        "DATE(created_at_stripe AT TIME ZONE 'America/New_York') BETWEEN ?::date AND ?::date",
        [startDate, endDate],
      )
      .select(db.raw("COALESCE(SUM(-amount)::text, '0') as total"))
      .first()
      .catch(missingTableOnly({ total: '0' })),
  ]);

  return round2(
    parseFloat(ledger?.total || 0)
    + parseFloat(invoiceGaps?.total || 0)
    + parseFloat(deposits?.total || 0)
    - parseFloat(refunded?.total || 0),
  );
}

/**
 * DATE cell → 'YYYY-MM-DD' via LOCAL getters. node-postgres parses DATE
 * columns to local-midnight Date objects, so etDateString/toISOString would
 * shift them a day depending on the server zone (same trap and fix as
 * admin-revenue.js effectiveDateStr). Strings pass through by prefix.
 */
function dateCellStr(v) {
  if (v == null) return '';
  if (typeof v === 'string') return v.slice(0, 10);
  const d = new Date(v);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * Rate effective on a given ET calendar day: the newest company_financials
 * row whose effective_date is on/before that day. rateRows must be sorted
 * ascending by effective_date. Pure.
 */
function rateAsOf(rateRows, dateStr) {
  let rate = DEFAULT_LOADED_LABOR_RATE;
  for (const r of rateRows || []) {
    const eff = dateCellStr(r.effective_date);
    if (eff && eff <= dateStr) {
      const v = Number(r.loaded_labor_rate);
      if (Number.isFinite(v) && v > 0) rate = v;
    } else if (eff) break;
  }
  return rate;
}

/**
 * Cost daily job minutes at the rate effective ON EACH DAY. Applying one
 * rate to a whole window retroactively re-priced historical work every time
 * the loaded rate changed. Pure.
 */
function costLaborByDay(summaryRows, rateRows) {
  let minutes = 0;
  let cost = 0;
  for (const row of summaryRows || []) {
    const day = dateCellStr(row.work_date);
    const mins = parseFloat(row.total_job_minutes) || 0;
    minutes += mins;
    cost += (mins / 60) * rateAsOf(rateRows, day);
  }
  return { laborMinutes: minutes, laborCost: round2(cost) };
}

async function buildPnlReport(db, startDate, endDate) {
  const [serviceRevenue, laborRows, rateRows, matRow, opexRows, mileageRow, assets] = await Promise.all([
    paidRevenueForWindow(db, startDate, endDate),
    db('time_entry_daily_summary')
      .whereBetween('work_date', [startDate, endDate])
      .select('work_date', 'total_job_minutes')
      .catch(missingTableOnly([])),
    // Full effective-dated rate history up to the period end — each day's
    // labor is costed at the rate in force that day (see costLaborByDay).
    db('company_financials')
      .where('effective_date', '<=', endDate)
      .orderBy('effective_date', 'asc')
      .select('effective_date', 'loaded_labor_rate')
      .catch(missingTableOnly([])),
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
    // Active assets, PLUS disposed ones — disposal caps the proration window
    // (see prorateDepreciation) instead of deleting the asset's history.
    // Rows merely deactivated (active=false, never disposed — archived /
    // non-business) stay excluded, matching every other tax surface.
    db('equipment_register')
      .whereNotNull('annual_depreciation')
      .where(function activeOrDisposed() {
        this.where('active', true)
          .orWhere('disposed', true)
          .orWhereNotNull('disposal_date');
      })
      .select('annual_depreciation', 'placed_in_service_date', 'purchase_date', 'disposal_date')
      .catch(missingTableOnly([])),
  ]);

  const { laborCost } = costLaborByDay(laborRows, rateRows);

  return assemblePnl({
    serviceRevenue,
    otherRevenue: 0,
    laborCost,
    materialsCost: parseFloat(matRow?.total || 0),
    opexRows,
    mileageDeduction: parseFloat(mileageRow?.total || 0),
    depreciationTotal: prorateDepreciation(assets, startDate, endDate),
  });
}

module.exports = {
  buildPnlReport,
  paidRevenueForWindow,
  assemblePnl,
  getPeriodRange,
  prorateDepreciation,
  rateAsOf,
  costLaborByDay,
  dateCellStr,
  missingTableOnly,
  COGS_CATEGORIES,
  DEFAULT_LOADED_LABOR_RATE,
};
