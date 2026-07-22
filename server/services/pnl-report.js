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
 *                  cash) MINUS refund/dispute balance transactions from
 *                  stripe_payout_transactions in the window they occurred.
 *                  The ledger fills via the GLOBAL balance-transaction sync
 *                  (stripe-banking syncBalanceTransactions — Stripe refuses
 *                  per-payout listing for manual payouts); coverage below
 *                  discloses when the sync hasn't yet passed the window end.
 *   labor        — NO imputed labor: the sole technician is the OWNER, and
 *                  an owner/sole-proprietor's own labor is not a deductible
 *                  expense. Real payroll/contract-labor spend flows through
 *                  expense categories like every other paid cost. The
 *                  job-costing helpers (rateAsOf/costLaborByDay) remain
 *                  exported for management surfaces and the informational
 *                  time-tracking CSV.
 *   materials    — expenses in the COGS categories.
 *   opex         — every other expense INCLUDING uncategorized ones (the old
 *                  whereNotIn(name) dropped NULL-category rows entirely — in
 *                  prod that was 137/137 expenses), PLUS synced Stripe
 *                  processing fees as their own category (revenue is gross
 *                  charges; never hand-enter Stripe fees in expenses or
 *                  they'd double-count).
 *   mileage      — mileage_log.deduction_amount in the window.
 *   depreciation — per asset: §179/bonus recognize in full in the in-service
 *                  year; MACRS uses the year-varying half-year schedule
 *                  (Pub 946) x business_use_pct; straight-line uses
 *                  annual_depreciation. All prorated by window days (same
 *                  proration everywhere, including the tax package).
 *
 * VEHICLE (Schedule C line 9) — the P&L computes the ACTUAL-EXPENSES basis
 * ONLY: it deducts every recorded cost and NEVER the standard mileage rate.
 * Standard mileage and actual expenses are mutually exclusive on line 9, and
 * computing the standard-mileage basis would require removing ALL actual
 * vehicle costs — but those are spread across shared categories (auto
 * insurance under Insurance, van upkeep under Repairs & Maintenance, tags
 * under Taxes & Licenses) that can't be isolated from non-vehicle costs
 * without per-line attribution the data model doesn't have. Counting the rate
 * beside them would double-deduct, so the P&L never does.
 *
 * The mileage figure is always EXCLUDED from the total and DISCLOSED
 * (vehicleDeduction.standardMileageComputed) for the operator/CPA to apply
 * manually IN PLACE OF the actual vehicle costs if they elect the standard
 * method. company_financials.vehicle_deduction_method and the barred flag
 * drive that DISCLOSURE only — never the computation:
 *   'actual_expenses' / NULL — actual basis, no extra note.
 *   'standard_mileage'       — actual basis + a note that the P&L reflects
 *                              actual costs and the disclosed mileage must be
 *                              applied manually instead.
 *   MACRS/§179 vehicle held  — a stronger note: standard mileage is barred
 *                              outright (Pub 463), so actual is the only option.
 * Never overstates: the dangerous direction (rate + untracked actual costs) is
 * structurally impossible because the rate is never added here.
 *
 * assemblePnl() is pure (no I/O) and unit-tested; buildPnlReport() runs the
 * queries and feeds it.
 */

const { etParts, etDateString } = require('../utils/datetime-et');

const COGS_CATEGORIES = ['Supplies', 'Materials', 'Cost of Goods Sold', 'Chemicals'];
const VEHICLE_METHODS = ['standard_mileage', 'actual_expenses'];
// Depreciation methods that disqualify a vehicle from the standard mileage
// rate for the rest of its life (Pub 463).
const MILEAGE_BARRING_METHODS = ['MACRS', 'section_179', 'bonus_100'];
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

// MACRS depreciation percentages (200% declining balance, HALF-YEAR
// convention already baked in — that's why year 1 is 20% not 40% for 5-year).
// Keyed by IRS recovery class. Percentages are of the ORIGINAL cost basis and
// sum to 100%. Source: IRS Pub 946, Table A-1 (GDS half-year). Add a class
// here only against that authoritative table.
const MACRS_HALF_YEAR = {
  '3-year': [0.3333, 0.4445, 0.1481, 0.0741],
  '5-year': [0.20, 0.32, 0.192, 0.1152, 0.1152, 0.0576],
  '7-year': [0.1429, 0.2449, 0.1749, 0.1249, 0.0893, 0.0892, 0.0893, 0.0446],
};

// The MACRS deduction for ONE calendar year: basis x the class percentage for
// that recovery year (1-indexed). Returns 0 outside the schedule (before the
// in-service year or after the asset is fully recovered). The half-year
// convention means the in-service year gets the full year-1 percentage
// regardless of the in-service DATE within that year — never day-prorate it.
function macrsYearAmount(irsClass, basis, inServiceYear, calendarYear) {
  const table = MACRS_HALF_YEAR[String(irsClass || '').trim()];
  if (!table || !(basis > 0) || !inServiceYear) return 0;
  const idx = calendarYear - inServiceYear; // 0-indexed recovery year
  if (idx < 0 || idx >= table.length) return 0;
  return basis * table[idx];
}

// Business-use fraction (listed property like vehicles): clamp to [0,1],
// default 100% when unset. Non-vehicle MACRS assets are 100% business use.
function businessUseFraction(v) {
  if (v == null) return 1;
  const pct = parseFloat(v);
  if (!Number.isFinite(pct)) return 1;
  return Math.min(1, Math.max(0, pct / 100));
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
 * (a flat /365 paid 366/365ths of it). Pure. Handles three methods:
 * §179/bonus (whole cost in the in-service year), MACRS (year-varying
 * half-year schedule x business_use_pct — see below), and straight-line
 * (annual_depreciation). Disposal CAPS the window rather than excluding the
 * asset — filtering disposed assets out silently deleted their depreciation
 * from every historical P&L. MACRS specifics: depreciates only the basis
 * REMAINING after any §179/bonus (or the two double-count); FAILS CLOSED
 * (returns 0) for listed property at ≤50% business use, which requires ADS
 * straight-line + possible recapture (Pub 946) — a CPA case, not GDS; and a
 * report window ending before the in-service date contributes nothing.
 * NOT modeled: the MACRS disposal-year half-convention (a CPA adjustment on
 * sale; the sole vehicle is not disposed).
 */
function prorateAssetDepreciation(asset, startDate, endDate) {
  const periodStart = toUTCDay(startDate);
  const periodEnd = toUTCDay(endDate);
  if (!periodStart || !periodEnd) return 0;
  const inService = toUTCDay(asset?.placed_in_service_date) || toUTCDay(asset?.purchase_date);
  const disposed = toUTCDay(asset?.disposal_date);
  let total = 0;

  // Listed property (vehicles) used ≤50% for business is disqualified from BOTH
  // §179 AND GDS declining-balance MACRS — Pub 946 requires ADS straight-line
  // and may trigger recapture. FAIL CLOSED for the whole asset (surface it for
  // CPA/ADS treatment) rather than report a wrong deduction. business_use_pct
  // defaults 100 (unset → 1.0), so only an explicitly-lowered asset trips this.
  const bizUse = businessUseFraction(asset?.business_use_pct);
  if (bizUse <= 0.5) return 0;

  // Immediate expensing (§179 / 100% bonus): the WHOLE deduction is recognized
  // in the placed-in-service year — never day-prorated. (annual NULL, so
  // filtering on the annual field alone silently dropped it from the P&L / CPA
  // package.) The elected amount is the business figure the CPA entered.
  const method = String(asset?.depreciation_method || '');
  const s179Immediate = (method === 'section_179' || method === 'bonus_100' || asset?.section_179_elected)
    ? (parseFloat(asset?.section_179_amount ?? asset?.purchase_cost) || 0) : 0;
  if (s179Immediate > 0 && inService && inService >= periodStart && inService <= periodEnd) {
    total += s179Immediate;
  }

  // MACRS: year-varying declining balance on the BUSINESS basis remaining after
  // §179. Order matters for a partial-use hybrid: business basis = cost ×
  // business-use%, THEN minus §179 (already in the basis, so the schedule
  // isn't scaled again). A flat annual_depreciation can't model the schedule,
  // which is why MACRS assets showed $0.
  if (MACRS_HALF_YEAR[String(asset?.irs_class || '').trim()] && method === 'MACRS') {
    const cost = parseFloat(asset?.purchase_cost || 0) || 0;
    const macrsBasis = Math.max(0, cost * bizUse - s179Immediate);
    const inSvcYear = inService ? inService.getUTCFullYear() : null;
    const disposalYear = disposed ? disposed.getUTCFullYear() : null;
    if (macrsBasis > 0 && inSvcYear && inService) {
      for (let y = periodStart.getUTCFullYear(); y <= periodEnd.getUTCFullYear(); y++) {
        // Disposal year and after: the MACRS half-year DISPOSITION convention
        // (half the year's %, plus recapture) is a CPA adjustment — FAIL CLOSED
        // here; prior years already booked their full amounts. The sole
        // vehicle is not disposed, so this is defensive.
        if (disposalYear != null && y >= disposalYear) continue;
        const yearAmount = macrsYearAmount(asset.irs_class, macrsBasis, inSvcYear, y);
        if (yearAmount <= 0) continue;
        // Attribute across the asset's coverage in year y (in-service date, or
        // Jan 1 for later years, through year-end), prorated by the report
        // window's overlap: a full-year window keeps the whole half-year-
        // convention amount; a window ending before in-service gets nothing.
        const yStart = new Date(Date.UTC(y, 0, 1));
        const yEnd = new Date(Date.UTC(y, 11, 31));
        const covStart = inService > yStart ? inService : yStart;
        if (covStart > yEnd) continue;
        const covDays = (yEnd - covStart) / 86400000 + 1;
        const ovStart = periodStart > covStart ? periodStart : covStart;
        const ovEnd = periodEnd < yEnd ? periodEnd : yEnd;
        if (ovStart > ovEnd) continue;
        const ovDays = (ovEnd - ovStart) / 86400000 + 1;
        total += yearAmount * (ovDays / covDays);
      }
    }
    return total; // MACRS handled — don't also read annual_depreciation
  }

  const annual = parseFloat(asset?.annual_depreciation || 0);
  if (!annual) return total;
  const effStart = inService && inService > periodStart ? inService : periodStart;
  const effEnd = disposed && disposed < periodEnd ? disposed : periodEnd;
  if (effStart > effEnd) return total;
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
  cogsNonDeductible = 0,
  opexRows = [],
  processingFees = 0,
  mileageDeduction = 0,
  depreciationTotal = 0,
  vehicleMethod = null,
  vehicleMileageBarred = false,
} = {}) {
  const revenue = round2(serviceRevenue);
  const other = round2(otherRevenue);
  const labor = round2(laborCost);
  const materials = round2(materialsCost);

  // ── Schedule C line 9 (vehicle): the P&L computes the ACTUAL-EXPENSES basis
  // ONLY — it deducts every recorded cost and NEVER the standard mileage rate.
  // Standard mileage would require removing all actual vehicle costs, but those
  // are spread across shared categories (auto insurance under Insurance, van
  // upkeep under Repairs & Maintenance, tags under Taxes & Licenses) that can't
  // be isolated from non-vehicle costs — so counting the rate beside them would
  // double-deduct. The mileage figure is therefore always EXCLUDED here and
  // DISCLOSED (vehicleDeduction.standardMileageComputed) for the operator/CPA
  // to apply manually IN PLACE OF the actual vehicle costs if they elect the
  // standard method. `method` and the barred flag drive that disclosure only.
  const method = VEHICLE_METHODS.includes(vehicleMethod) ? vehicleMethod : null;
  const rawMileage = round2(Number(mileageDeduction) || 0);
  const countedMileage = 0; // never auto-applied — see note above

  const byCategory = new Map();
  // book-to-tax adjustment (e.g. 50% meals) — seed with the COGS portion.
  let nonDeductibleExpenses = round2(Number(cogsNonDeductible) || 0);
  for (const row of opexRows) {
    const name = row.category || 'Uncategorized';
    const prev = byCategory.get(name) || { name, irsLine: row.irs_line || null, amount: 0 };
    prev.amount = round2(prev.amount + (parseFloat(row.total) || 0));
    byCategory.set(name, prev);
    nonDeductibleExpenses = round2(nonDeductibleExpenses + (parseFloat(row.non_deductible) || 0));
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
  // Full depreciation always flows (actual-expenses basis). Under a standard-
  // mileage election a vehicle's depreciation would be embedded in the rate
  // instead, but since the P&L never applies that rate here, keeping the
  // vehicle's actual depreciation is consistent — the mileage figure the
  // operator would use instead is disclosed below.
  const countedDepreciation = round2(Number(depreciationTotal) || 0);
  const deductionsTotal = round2(countedMileage + countedDepreciation);
  const netIncome = round2(grossProfit - opexTotal - deductionsTotal);

  return {
    revenue: { serviceRevenue: revenue, otherRevenue: other, total: totalRevenue },
    cogs: { labor, materials, total: cogsTotal },
    grossProfit,
    grossMargin: totalRevenue > 0 ? grossProfit / totalRevenue : 0,
    operatingExpenses: { categories: opexCategories, total: opexTotal },
    deductions: {
      mileage: countedMileage,             // always 0 — see note
      depreciation: countedDepreciation,
      total: deductionsTotal,
    },
    // The P&L is on the actual-expenses basis. Always disclose the standard
    // mileage figure that was NOT applied, so it's visible, never silently
    // missing. buildPnlReport attaches a methodConflict note when the operator
    // elected standard mileage (and, more strongly, when a MACRS/§179 vehicle
    // bars it outright).
    vehicleDeduction: {
      method,                       // null = unelected
      elected: method !== null,
      basis: 'actual_expenses',     // the only basis the P&L can compute cleanly
      barred: method === 'standard_mileage' && vehicleMileageBarred,
      countedMileage,               // 0
      standardMileageComputed: rawMileage, // disclosed for manual/CPA use
    },
    netIncome,
    netMargin: totalRevenue > 0 ? netIncome / totalRevenue : 0,
    // Book-to-tax bridge: the P&L above is BOOK (actual spend). Taxable income
    // adds back the non-deductible portion of expenses (e.g. the disallowed
    // 50% of business meals), so it's ≥ book net income. Exposed separately so
    // the accounting figures stay true to actual spend.
    taxAdjustments: {
      nonDeductibleExpenses: round2(nonDeductibleExpenses),
      taxableNetIncome: round2(netIncome + nonDeductibleExpenses),
    },
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
 * Outflow classification is Stripe's canonical reporting_category — never
 * bare `type` ('adjustment' is an umbrella; 'refund' also covers
 * partial-capture reversals, whose receipt already reflects only the
 * captured amount and must not be re-subtracted).
 *   refund            — cash returned for a counted receipt (subtract)
 *   refund_failure    — bounced refund returning to the merchant (positive
 *                       amount; SUM(-amount) nets it back)
 *   dispute           — chargeback withdrawal on open (subtract)
 *   dispute_reversal  — dispute won, funds reinstated (adds back; lost =
 *                       no further row, stays subtracted)
 * Post-settlement ACH bank returns are matched separately by
 * type='payment_reversal' — that value is a balance-transaction TYPE with
 * no reporting_category of its own, so a category-only filter would miss
 * clawed-back ACH funds entirely. Explicitly NOT netted:
 * partial_capture_reversal, charge_failure, fee, payout, and every other
 * category or type.
 *
 * Failed-payment reversals never net, via TWO layers in
 * outflowTransactionsQuery: type='payment_failure_refund' is excluded
 * outright (non-card failure refunds aren't source-linked, so a
 * link-status guard alone can't catch them), and any outflow whose LINKED
 * payments row is status='failed' is excluded — its receipt was never
 * counted on the revenue side, so subtracting it would remove money that
 * was never added.
 */
const OUTFLOW_REPORTING_CATEGORIES = ['refund', 'refund_failure', 'dispute', 'dispute_reversal'];

/**
 * The outflow rows netted against revenue for [startDate, endDate] (ET
 * days). One query definition shared by the P&L netting and the tax
 * package's refunds.csv, so the export always reconciles to the report.
 */
function outflowTransactionsQuery(db, startDate, endDate) {
  return db('stripe_payout_transactions as spt')
    .leftJoin('payments as lp', 'spt.payment_id', 'lp.id')
    .where(function outflowClass() {
      this.whereIn('spt.reporting_category', OUTFLOW_REPORTING_CATEGORIES)
        // Post-settlement ACH bank returns: a TYPE with no canonical
        // reporting_category — see the classification contract above.
        .orWhere('spt.type', 'payment_reversal');
    })
    // A payment_failure_refund reverses a FAILED payment whose receipt was
    // never counted — categorically excluded by TYPE, because non-card
    // failure refunds aren't source-linked (payment_id null) and would slip
    // past the linked-status guard below.
    .whereNot('spt.type', 'payment_failure_refund')
    .where(function receiptWasCounted() {
      this.whereNull('lp.id').orWhereNot('lp.status', 'failed');
    })
    .whereRaw(
      "DATE(spt.created_at_stripe AT TIME ZONE 'America/New_York') BETWEEN ?::date AND ?::date",
      [startDate, endDate],
    );
}

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
    // in the receipt period. KNOWN LIMITATION: those rows carry no durable
    // refund date (refunded_at is never written), so refund-period
    // recognition is impossible without a cash-refund ledger that doesn't
    // exist — receipt-period netting is the only computable treatment and
    // can shift income across periods for a cross-period cash refund.
    // Zero such refund rows exist in prod at ship time.
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
    // Every outflow against counted cash, in the period it occurred — see
    // OUTFLOW_REPORTING_CATEGORIES for the classification contract.
    outflowTransactionsQuery(db, startDate, endDate)
      .select(db.raw("COALESCE(SUM(-spt.amount)::text, '0') as total"))
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
  const [serviceRevenue, matRow, opexRows, feeRow, mileageRow, assets,
    financialsRow, barredVehicles] = await Promise.all([
    paidRevenueForWindow(db, startDate, endDate),
    // The P&L is BOOK accounting — actual spend (expenses.amount) drives opex,
    // net income, and margins. The deductible amount (lower for partial
    // categories like meals 50%) is tracked SEPARATELY as a book-to-tax
    // adjustment (deductions.nonDeductibleExpenses / taxableNetIncome below);
    // folding it into opex would understate expenses and inflate net income.
    db('expenses')
      .leftJoin('expense_categories', 'expenses.category_id', 'expense_categories.id')
      .whereBetween('expenses.expense_date', [startDate, endDate])
      .whereIn('expense_categories.name', COGS_CATEGORIES)
      .select(
        db.raw("COALESCE(SUM(expenses.amount)::text, '0') as total"),
        // COGS carries a non-deductible portion too (an operator can set a
        // partial deductibleAmount on Supplies/Materials/Chemicals) — it must
        // reach the book-to-tax add-back, same clamp as the opex query.
        db.raw("COALESCE(SUM(expenses.amount - LEAST(expenses.amount, GREATEST(0, COALESCE(expenses.tax_deductible_amount, expenses.amount))))::text, '0') as non_deductible"),
      )
      .first()
      .catch(missingTableOnly({ total: '0', non_deductible: '0' })),
    db('expenses')
      .leftJoin('expense_categories', 'expenses.category_id', 'expense_categories.id')
      .whereBetween('expenses.expense_date', [startDate, endDate])
      // Uncategorized (NULL name) rows are opex too — a bare whereNotIn drops
      // them (SQL NOT IN + NULL), which zeroed the whole opex section in prod.
      .where(function cogsOrNull() {
        this.whereNull('expense_categories.name')
          .orWhereNotIn('expense_categories.name', COGS_CATEGORIES);
      })
      .select(
        'expense_categories.name as category',
        'expense_categories.irs_line',
        db.raw('SUM(expenses.amount) as total'),
        // Non-deductible portion of this category (e.g. the disallowed 50% of
        // meals). The deductible amount is CLAMPED to [0, amount] here too, so
        // a bad historical row (deductible > amount, or negative) can't produce
        // a negative add-back that understates taxable income — belt-and-braces
        // with the write-time validation.
        db.raw('SUM(expenses.amount - LEAST(expenses.amount, GREATEST(0, COALESCE(expenses.tax_deductible_amount, expenses.amount)))) as non_deductible'),
      )
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
    // Includes immediate-expensing assets (§179 / bonus — annual NULL):
    // their whole deduction recognizes in the placed-in-service year. ALSO
    // includes MACRS assets (annual NULL) — their year-varying schedule is
    // computed in prorateAssetDepreciation; without this they showed $0.
    db('equipment_register')
      .where(function hasDeduction() {
        this.whereNotNull('annual_depreciation')
          .orWhere('section_179_elected', true)
          .orWhereIn('depreciation_method', ['section_179', 'bonus_100', 'MACRS']);
      })
      .where(function activeOrDisposed() {
        this.where('active', true)
          .orWhere('disposed', true)
          .orWhereNotNull('disposal_date');
      })
      .select(
        'annual_depreciation', 'placed_in_service_date', 'purchase_date', 'disposal_date',
        'depreciation_method', 'section_179_elected', 'section_179_amount', 'purchase_cost',
        // Needed to split VEHICLE depreciation out under a standard-mileage
        // election — the rate already embeds a depreciation component, so
        // deducting a vehicle's MACRS/§179 beside it double-counts.
        'asset_category',
        // MACRS computation inputs: recovery class + listed-property business
        // use (vehicles). business_use_pct defaults 100 in the schema.
        'irs_class', 'business_use_pct',
      )
      .catch(missingTableOnly([])),
    // The vehicle-method election (newest financials row, same accessor every
    // other company_financials consumer uses) and any register vehicle whose
    // depreciation method bars the standard mileage rate.
    //
    // SCOPE — the election is COMPANY-WIDE (one vehicle_deduction_method), and
    // the business operates a single service vehicle. Mileage and vehicle
    // depreciation are therefore aggregated, not split per vehicle: if ANY
    // held vehicle is barred, the standard-mileage election fails closed for
    // the whole company. With one vehicle that is exact; the conservative
    // direction (never over-claiming) is deliberate if a second vehicle is
    // ever added — per-vehicle elections would be the enhancement then, and
    // mileage_log has no FK into equipment_register to attribute miles today.
    // GLOBAL preference (newest row), not period-effective. The election is
    // now INFORMATIONAL — it never changes the P&L computation (always the
    // actual-expenses basis), only the disclosure note — so reading the newest
    // row is correct and, unlike a ≤endDate filter, doesn't silently discard a
    // selection saved (stamped today) while viewing a historical period.
    db('company_financials')
      .orderBy('effective_date', 'desc')
      .select('vehicle_deduction_method')
      .first()
      .catch(missingTableOnly(null)),
    db('equipment_register')
      .where('asset_category', 'vehicle')
      .where(function barred() {
        this.whereIn('depreciation_method', MILEAGE_BARRING_METHODS)
          .orWhere('section_179_elected', true);
      })
      // A vehicle bars the rate for a window it was HELD DURING, by its
      // in-service/disposal INTERVAL — not current state. Current-state gating
      // was wrong both ways: a since-disposed MACRS vehicle must still bar a
      // historical P&L it was held in, and a vehicle placed in service after
      // the window must not bar it. In service by window end AND not disposed
      // before window start = interval overlaps [startDate, endDate]. (NULL
      // in-service/disposal = open-ended, treated as still applicable.)
      .where(function inServiceByWindowEnd() {
        this.whereNull('placed_in_service_date')
          .orWhere('placed_in_service_date', '<=', endDate);
      })
      .where(function notDisposedBeforeWindow() {
        this.whereNull('disposal_date')
          .orWhere('disposal_date', '>=', startDate);
      })
      .select('name', 'depreciation_method', 'section_179_elected')
      .catch(missingTableOnly([])),
  ]);

  const vehicleMethod = VEHICLE_METHODS.includes(financialsRow?.vehicle_deduction_method)
    ? financialsRow.vehicle_deduction_method
    : null;

  const report = assemblePnl({
    serviceRevenue,
    otherRevenue: 0,
    // No imputed labor: the sole technician IS the owner, and an
    // owner/sole-proprietor's own labor is not a deductible expense —
    // costing job minutes at the loaded job-costing rate deducted
    // fictitious payroll. Real payroll/contract-labor spend, when it
    // exists, flows through expense categories (opex) like every other
    // paid cost. costLaborByDay stays exported for job-costing surfaces
    // and the informational time-tracking CSV.
    laborCost: 0,
    materialsCost: parseFloat(matRow?.total || 0),
    cogsNonDeductible: parseFloat(matRow?.non_deductible || 0),
    opexRows,
    processingFees: parseFloat(feeRow?.total || 0),
    mileageDeduction: parseFloat(mileageRow?.total || 0),
    depreciationTotal: prorateDepreciation(assets, startDate, endDate),
    vehicleMethod,
    // A held vehicle on MACRS/§179 is barred from the standard mileage rate
    // (Pub 463). The P&L never applies the rate regardless; this only sharpens
    // the disclosure below.
    vehicleMileageBarred: (barredVehicles || []).length > 0,
  });

  // Disclosure when standard mileage is elected — the P&L is on the actual-
  // expenses basis (the disclosed mileage figure is NOT in the total), because
  // actual vehicle costs can't be isolated from shared categories to compute a
  // clean standard-mileage basis. A held MACRS/§179 vehicle makes it stronger:
  // standard mileage is barred outright (Pub 463).
  if (vehicleMethod === 'standard_mileage') {
    const barred = (barredVehicles || []).length > 0;
    report.vehicleDeduction.methodConflict = {
      reason: barred ? 'depreciation_bars_standard_mileage' : 'standard_mileage_not_auto_computed',
      vehicles: (barredVehicles || []).map((v) => ({
        name: v.name,
        method: v.section_179_elected ? 'section_179' : v.depreciation_method,
      })),
      note: barred
        ? 'Standard mileage is elected, but a held vehicle was depreciated under '
          + 'MACRS/§179 — IRS Pub 463 bars the standard mileage rate for that '
          + 'vehicle for the rest of its life. This P&L deducts ACTUAL vehicle '
          + 'costs; keep the actual-expenses method with your CPA.'
        : 'Standard mileage is elected, but this P&L deducts ACTUAL vehicle '
          + 'costs — the system can\'t separate actual vehicle expenses (auto '
          + 'insurance, van repairs, registration) from shared categories to '
          + 'compute a clean standard-mileage figure. Your standard mileage '
          + 'amount is disclosed separately; apply it with your CPA IN PLACE OF '
          + 'the actual vehicle costs if you use that method.',
    };
  }

  // Coverage disclosure — refunds/disputes/fees come exclusively from the
  // globally synced balance-transaction ledger (syncBalanceTransactions).
  // The window is proven complete only when a successful global sync ran
  // AFTER the window ended: that sync captured every balance transaction
  // created on or before the cutoff, so nothing in-window can still be
  // missing. Anything weaker labels incomplete figures final.
  let lastBalanceSyncAt = null;
  try {
    const syncState = await db('stripe_sync_state')
      .where('sync_type', 'balance_transactions')
      .first();
    if (syncState?.last_sync_at) lastBalanceSyncAt = new Date(syncState.last_sync_at);
  } catch (e) {
    if (e?.code !== '42P01') throw e; /* missing table in dev only */
  }
  // "After the window ended" at ET-day granularity: the sync's ET calendar
  // day must be strictly later than the window's last day, which guarantees
  // the sync ran after every in-window transaction already existed.
  const syncedPastWindow = !!(lastBalanceSyncAt
    && etDateString(lastBalanceSyncAt) > endDate);
  let coverageNote = null;
  if (!lastBalanceSyncAt) {
    coverageNote = 'Refund/dispute/fee ledger has never been synced — outflows and processing fees are NOT reflected in these figures. Run Banking → Sync, then regenerate.';
  } else if (!syncedPastWindow) {
    coverageNote = `Refund/dispute/fee ledger last synced ${etDateString(lastBalanceSyncAt)} (ET) — a sync after ${endDate} is needed before outflow and fee figures for this window are final. Run Banking → Sync, then regenerate.`;
  }
  report.coverage = {
    lastBalanceSyncAt: lastBalanceSyncAt ? lastBalanceSyncAt.toISOString() : null,
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
  macrsYearAmount,
  rateAsOf,
  costLaborByDay,
  dateCellStr,
  missingTableOnly,
  COGS_CATEGORIES,
  VEHICLE_METHODS,
  MILEAGE_BARRING_METHODS,
  DEFAULT_LOADED_LABOR_RATE,
  OUTFLOW_REPORTING_CATEGORIES,
  outflowTransactionsQuery,
};
