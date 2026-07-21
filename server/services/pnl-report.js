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
 *   opex         — every other expense INCLUDING uncategorized ones (the old
 *                  whereNotIn(name) dropped NULL-category rows entirely — in
 *                  prod that was 137/137 expenses), PLUS synced Stripe
 *                  processing fees as their own category (revenue is gross
 *                  charges; never hand-enter Stripe fees in expenses or
 *                  they'd double-count).
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

function daysInYear(y) {
  return ((y % 4 === 0 && y % 100 !== 0) || y % 400 === 0) ? 366 : 365;
}

// Date-ish (string or node-postgres DATE cell) → UTC-midnight Date, so day
// arithmetic below is zone-independent.
function toUTCDay(v) {
  const s = dateCellStr(v);
  return s ? new Date(`${s}T00:00:00Z`) : null;
}

/**
 * ONE asset's depreciation prorated to the window: from
 * placed_in_service_date through disposal_date (when disposed), clamped to
 * the period, sliced per CALENDAR YEAR so each slice divides by that year's
 * actual day count — a full leap year yields exactly the annual amount
 * (a flat /365 paid 366/365ths of it). Pure. Section 179 / bonus assets
 * carry annual_depreciation NULL and contribute nothing. Disposal CAPS the
 * window rather than excluding the asset — filtering disposed assets out
 * silently deleted their depreciation from every historical P&L.
 */
function prorateAssetDepreciation(asset, startDate, endDate) {
  const annual = parseFloat(asset?.annual_depreciation || 0);
  if (!annual) return 0;
  const periodStart = toUTCDay(startDate);
  const periodEnd = toUTCDay(endDate);
  if (!periodStart || !periodEnd) return 0;
  const inService = toUTCDay(asset.placed_in_service_date) || toUTCDay(asset.purchase_date);
  const disposed = toUTCDay(asset.disposal_date);
  const effStart = inService && inService > periodStart ? inService : periodStart;
  const effEnd = disposed && disposed < periodEnd ? disposed : periodEnd;
  if (effStart > effEnd) return 0;
  let total = 0;
  for (let y = effStart.getUTCFullYear(); y <= effEnd.getUTCFullYear(); y++) {
    const yStart = new Date(Date.UTC(y, 0, 1));
    const yEnd = new Date(Date.UTC(y, 11, 31));
    const s = effStart > yStart ? effStart : yStart;
    const e = effEnd < yEnd ? effEnd : yEnd;
    const days = (e - s) / 86400000 + 1;
    if (days > 0) total += annual * (days / daysInYear(y));
  }
  return total;
}

/** Sum of prorateAssetDepreciation over the asset list. Pure. */
function prorateDepreciation(assets, startDate, endDate) {
  let total = 0;
  for (const a of assets || []) total += prorateAssetDepreciation(a, startDate, endDate);
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
  processingFees = 0,
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
  // Merchant processing fees from the synced Stripe ledger — revenue above is
  // gross charges (incl. card surcharges), so without this line netIncome
  // overstates by every synced fee. Rendered as its own opex category. NOTE:
  // if fees are ever ALSO logged manually in `expenses`, that would
  // double-count — the ledger is the source of truth; don't hand-enter them.
  const fees = round2(processingFees);
  if (fees !== 0) {
    byCategory.set('Stripe Processing Fees (synced)', {
      name: 'Stripe Processing Fees (synced)', irsLine: null, amount: fees,
    });
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
/**
 * Stripe balance-transaction types that move refund money AGAINST cash the
 * receipt side counted: 'refund' (card), 'payment_refund' (bank/local
 * methods), and 'refund_failure' — a bounced refund RETURNING funds to the
 * merchant as a positive amount, which SUM(-amount) correctly nets back out.
 * Deliberately NOT 'payment_failure_refund': Stripe creates that when a
 * PENDING ACH/local payment fails — the corresponding payments row is
 * status='failed' and never entered the receipt side, so subtracting the
 * reversal would remove cash that was never counted (double subtraction).
 */
const REFUND_TXN_TYPES = ['refund', 'payment_refund', 'refund_failure'];

/**
 * Dispute/chargeback movements are identified by Stripe's canonical
 * reporting_category — NEVER by type: the dispute withdrawal rides the
 * umbrella type 'adjustment', which also covers unrelated balance activity.
 * 'dispute' is the NEGATIVE withdrawal when a dispute opens; a won dispute
 * posts a POSITIVE 'dispute_reversal' (lost = no further transaction).
 * SUM(-amount) therefore subtracts on open, adds back on win, and stays
 * subtracted on loss — covering deposit chargebacks too (the deposit's
 * receipt stays on the received side; the loss shows here in its period).
 * Note refunds stay TYPE-based (REFUND_TXN_TYPES): 'payment_failure_refund'
 * reports under category 'refund', so a category filter for refunds would
 * re-admit failed-ACH reversals and recreate the double-subtraction bug.
 */
const DISPUTE_REPORTING_CATEGORIES = ['dispute', 'dispute_reversal'];

async function paidRevenueForWindow(db, startDate, endDate) {
  const etWindow = (qb, column) => qb
    .whereRaw(`${column} >= ?::timestamp AT TIME ZONE 'America/New_York'`, [`${startDate}T00:00:00`])
    .whereRaw(`${column} < (?::timestamp + INTERVAL '1 day') AT TIME ZONE 'America/New_York'`, [`${endDate}T00:00:00`]);

  const [ledger, invoiceGaps, refundedGapReceipts, deposits, refunded] = await Promise.all([
    // Genuine receipts only: the full-refund webhook inserts a MARKER row
    // (metadata.source='invoice_refund', payment_date = the REFUND day) for
    // gap invoices so receipt PDFs/emails have something to read — that row
    // is not cash-in on its stamped date and is re-dated below instead.
    // 'disputed' stays a receipt: the cash arrived in this period; the
    // chargeback withdrawal is a dispute balance transaction netted in ITS
    // period (DISPUTE_TXN_TYPES) — excluding disputed rows here would erase
    // the original receipt retroactively.
    // Processor-aware refund accounting: Stripe-ledgered rows (processor
    // 'stripe' with a charge/PI id) stay GROSS — their refunds arrive as
    // balance transactions, netted in the refund's own period below. Rows
    // OUTSIDE Stripe's ledger (legacy imports, cash/check) have no balance
    // transaction ever, so their locally recorded refund_amount nets here,
    // in the receipt period (the only date those rows reliably carry).
    db('payments')
      .whereIn('status', ['paid', 'refunded', 'disputed'])
      .whereRaw("COALESCE(metadata->>'source', '') <> 'invoice_refund'")
      .whereBetween('payment_date', [startDate, endDate])
      .select(db.raw(`COALESCE(SUM(
        CASE WHEN processor = 'stripe' AND (stripe_charge_id IS NOT NULL OR stripe_payment_intent_id IS NOT NULL)
          THEN amount
          ELSE amount - COALESCE(refund_amount, 0)
        END
      )::text, '0') as total`))
      .first()
      .catch(missingTableOnly({ total: '0' })),
    // Paid-Stripe-invoice gap rows (no payments row for the PI) — same shape
    // and credit netting as the dashboard's paidRevenueTotal. The not-exists
    // guard ignores refund markers so a PARTIALLY refunded gap invoice keeps
    // its receipt here (the ledger below subtracts the partial refund).
    etWindow(
      db('invoices as i')
        .where({ 'i.status': 'paid', 'i.processor': 'stripe' })
        .whereNotNull('i.stripe_payment_intent_id')
        .whereNotExists(function gapGuard() {
          this.select(db.raw('1'))
            .from('payments as p')
            .whereRaw('p.stripe_payment_intent_id = i.stripe_payment_intent_id')
            .whereRaw("COALESCE(p.metadata->>'source', '') <> 'invoice_refund'");
        }),
      'i.paid_at',
    )
      .select(db.raw('COALESCE(SUM(GREATEST(i.total - COALESCE(i.credit_applied, 0), 0))::text, \'0\') as total'))
      .first()
      .catch(missingTableOnly({ total: '0' })),
    // FULLY refunded gap invoices: the invoice flips to 'refunded' (and its
    // credit_applied is zeroed), so the gap query above no longer sees the
    // original receipt. The marker's amount IS the cash actually charged —
    // recognize it in the period the invoice was PAID (falling back to the
    // marker's own date for pre-settlement refunds, where the refund ledger
    // nets it to zero in the same window — correct: no net cash moved).
    db('payments as m')
      .whereRaw("m.metadata->>'source' = 'invoice_refund'")
      .leftJoin('invoices as gi', 'gi.stripe_payment_intent_id', 'm.stripe_payment_intent_id')
      .whereRaw(
        "DATE(COALESCE(gi.paid_at AT TIME ZONE 'America/New_York', m.payment_date::timestamp)) BETWEEN ?::date AND ?::date",
        [startDate, endDate],
      )
      .select(db.raw("COALESCE(SUM(m.amount)::text, '0') as total"))
      .first()
      .catch(missingTableOnly({ total: '0' })),
    etWindow(
      db('estimate_deposits').whereNotNull('received_at'),
      'received_at',
    )
      .select(db.raw("COALESCE(SUM(amount + COALESCE(card_surcharge, 0))::text, '0') as total"))
      .first()
      .catch(missingTableOnly({ total: '0' })),
    // Refunds (by specific TYPE) and dispute movements (by canonical
    // reporting_category) — every outflow against counted cash, in the
    // period it occurred.
    db('stripe_payout_transactions')
      .where(function refundsOrDisputes() {
        this.whereIn('type', REFUND_TXN_TYPES)
          .orWhereIn('reporting_category', DISPUTE_REPORTING_CATEGORIES);
      })
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
    + parseFloat(refundedGapReceipts?.total || 0)
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
  const [serviceRevenue, laborRows, rateRows, matRow, opexRows, feeRow, mileageRow, assets] = await Promise.all([
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
    // Synced Stripe fees for the window (ET days). All balance-transaction
    // types: charge fees positive, refund fee-reversals negative — the sum
    // is the net merchant cost. Same source the Banking cash-flow uses.
    db('stripe_payout_transactions')
      .whereRaw(
        "DATE(created_at_stripe AT TIME ZONE 'America/New_York') BETWEEN ?::date AND ?::date",
        [startDate, endDate],
      )
      .select(db.raw("COALESCE(SUM(fee)::text, '0') as total"))
      .first()
      .catch(missingTableOnly({ total: '0' })),
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

  const report = assemblePnl({
    serviceRevenue,
    otherRevenue: 0,
    laborCost,
    materialsCost: parseFloat(matRow?.total || 0),
    opexRows,
    processingFees: parseFloat(feeRow?.total || 0),
    mileageDeduction: parseFloat(mileageRow?.total || 0),
    depreciationTotal: prorateDepreciation(assets, startDate, endDate),
  });

  // Coverage disclosure — refunds/disputes/fees come exclusively from the
  // synced payout-transaction ledger, which lags until each payout is paid
  // AND synced. Completeness is proven, not inferred from the newest
  // transaction date (one fresh payout can leap past endDate while older
  // ones sit in the backfill backlog): the window is closed only when
  // (a) no paid payout still needs its transaction (re)sync, (b) no payout
  // overlapping the window is still unsettled (its transactions don't exist
  // in the ledger yet), and (c) the ledger has rows reaching the window end.
  const [ledgerHead, backlogRow, unsettledRow] = await Promise.all([
    db('stripe_payout_transactions')
      .select(db.raw("TO_CHAR(MAX(created_at_stripe) AT TIME ZONE 'America/New_York', 'YYYY-MM-DD') as through"))
      .first()
      .catch(missingTableOnly({ through: null })),
    // Same predicate as syncPayouts' self-healing pass.
    db('stripe_payouts as sp')
      .where('sp.status', 'paid')
      .where(function needsResync() {
        this.whereNull('sp.transaction_count')
          .orWhere('sp.transaction_count', 0)
          .orWhereExists(function preCategoryRows() {
            this.select(db.raw('1'))
              .from('stripe_payout_transactions as t')
              .whereRaw('t.payout_id = sp.id')
              .whereNull('t.reporting_category');
          });
      })
      .count('* as n')
      .first()
      .catch(missingTableOnly({ n: 0 })),
    // Pending/in-transit payouts created on-or-before the window end carry
    // transactions the ledger can't have yet.
    db('stripe_payouts')
      .whereNotIn('status', ['paid', 'canceled', 'failed'])
      .whereRaw(
        "DATE(created_at_stripe AT TIME ZONE 'America/New_York') <= ?::date",
        [endDate],
      )
      .count('* as n')
      .first()
      .catch(missingTableOnly({ n: 0 })),
  ]);
  const outflowLedgerThrough = ledgerHead?.through || null;
  const backlogCount = parseInt(backlogRow?.n || 0, 10);
  const unsettledCount = parseInt(unsettledRow?.n || 0, 10);
  let coverageNote = null;
  if (!outflowLedgerThrough) {
    coverageNote = 'Refund/dispute/fee ledger has never been synced — outflows and processing fees are NOT reflected in these figures. Run Banking → Sync, then regenerate.';
  } else if (backlogCount > 0) {
    coverageNote = `${backlogCount} paid payout(s) still await transaction sync — outflow and fee figures are incomplete. Run Banking → Sync (repeat until it reports no backfill), then regenerate.`;
  } else if (unsettledCount > 0) {
    coverageNote = `${unsettledCount} payout(s) in this window are still settling — their refunds/disputes/fees are not in the ledger yet. Figures firm up once they pay out and sync.`;
  } else if (outflowLedgerThrough < endDate) {
    coverageNote = `Refund/dispute/fee ledger is synced through ${outflowLedgerThrough} — outflows and processing fees after that date are not yet reflected. Run Banking → Sync, then regenerate for final figures.`;
  }
  report.coverage = {
    outflowLedgerThrough,
    backlogCount,
    unsettledCount,
    complete: !coverageNote,
    note: coverageNote,
  };
  return report;
}

module.exports = {
  buildPnlReport,
  paidRevenueForWindow,
  assemblePnl,
  getPeriodRange,
  prorateDepreciation,
  prorateAssetDepreciation,
  rateAsOf,
  costLaborByDay,
  dateCellStr,
  missingTableOnly,
  COGS_CATEGORIES,
  DEFAULT_LOADED_LABOR_RATE,
  REFUND_TXN_TYPES,
  DISPUTE_REPORTING_CATEGORIES,
};
