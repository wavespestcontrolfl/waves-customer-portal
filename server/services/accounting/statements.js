/**
 * Canonical Financial Statements Engine — Trial Balance, Profit & Loss (Accrual & Cash),
 * Balance Sheet, Statement of Cash Flows (Indirect Method), FL Sales Tax Liability,
 * 1099-NEC Vendor Summary, and Executive Overview.
 *
 * Every financial metric flows from ONE double-entry General Ledger (gl_journal_lines),
 * ending the 6-conflicting-revenue-definitions problem.
 */

const db = require('../../models/db');
const { etDateString, etParts } = require('../../utils/datetime-et');
const {
  SYSTEM_CODES,
  BALANCE_SHEET_TYPES,
  INCOME_STATEMENT_TYPES,
  ensureSystemAccounts,
  naturalBalanceCents,
  sectionSignedBalanceCents,
} = require('./coa-seed');
const { AccountingError, assertValidDate } = require('./ledger');

const CASH_SUB_TYPES = new Set(['checking', 'savings', 'stripe_clearing', 'undeposited_funds']);
const CURRENT_ASSET_SUB_TYPES = new Set(['checking', 'savings', 'stripe_clearing', 'undeposited_funds', 'ar', 'prepaid', 'inventory']);
const CURRENT_LIABILITY_SUB_TYPES = new Set(['credit_card', 'sales_tax_payable', 'payroll_liability', 'net_pay_clearing', 'unearned_revenue', 'customer_credits', 'ap']);

function sumMapFromRows(rows) {
  const map = new Map();
  for (const r of rows || []) {
    map.set(r.account_id, {
      debitCents: Math.trunc(Number(r.debit_cents) || 0),
      creditCents: Math.trunc(Number(r.credit_cents) || 0),
    });
  }
  return map;
}

function accountRowSummary(acct, sums) {
  const dr = sums ? sums.debitCents : 0;
  const cr = sums ? sums.creditCents : 0;
  return {
    id: acct.id,
    code: acct.code,
    name: acct.name,
    account_type: acct.account_type,
    sub_type: acct.sub_type,
    normal_balance: acct.normal_balance,
    schedule_c_line: acct.schedule_c_line || null,
    deductible_pct: acct.deductible_pct ?? 100,
    debit_cents: dr,
    credit_cents: cr,
    balance_cents: naturalBalanceCents(acct, dr, cr),
    section_cents: sectionSignedBalanceCents(acct, dr, cr),
  };
}

/**
 * Pure: Trial Balance as of a cutoff date.
 * Verifies SUM(debit_balance) === SUM(credit_balance) to the penny.
 */
function computeTrialBalance(accounts, sumsByAccount, { asOf = null } = {}) {
  const rows = [];
  let totalDebitCents = 0;
  let totalCreditCents = 0;

  for (const acct of accounts) {
    const s = sumsByAccount.get(acct.id);
    const dr = s ? s.debitCents : 0;
    const cr = s ? s.creditCents : 0;
    const net = dr - cr;
    if (dr === 0 && cr === 0) continue;

    const debitBalanceCents = net > 0 ? net : 0;
    const creditBalanceCents = net < 0 ? Math.abs(net) : 0;
    totalDebitCents += debitBalanceCents;
    totalCreditCents += creditBalanceCents;

    rows.push({
      id: acct.id,
      code: acct.code,
      name: acct.name,
      account_type: acct.account_type,
      sub_type: acct.sub_type,
      period_debit_cents: dr,
      period_credit_cents: cr,
      debit_balance_cents: debitBalanceCents,
      credit_balance_cents: creditBalanceCents,
    });
  }

  const outOfBalanceCents = totalDebitCents - totalCreditCents;
  return {
    as_of: asOf,
    rows,
    total_debit_cents: totalDebitCents,
    total_credit_cents: totalCreditCents,
    out_of_balance_cents: outOfBalanceCents,
    balanced: outOfBalanceCents === 0,
  };
}

/**
 * Pure: Profit & Loss (Income Statement) over [from, to].
 * Computes Revenue, COGS, Gross Profit/Margin, Operating Expenses (with tax-deductible split),
 * EBITDA (before Interest, Taxes, Depreciation), and Net Income.
 */
function computeProfitAndLoss(accounts, sumsByAccount, { from, to, basis = 'accrual' } = {}) {
  const revenue = [];
  const cogs = [];
  const expenses = [];
  let totalRevenueCents = 0;
  let totalCogsCents = 0;
  let totalExpensesCents = 0;
  let totalDeductibleExpensesCents = 0;
  let interestCents = 0;
  let depreciationCents = 0;

  for (const acct of accounts) {
    if (!INCOME_STATEMENT_TYPES.has(acct.account_type)) continue;
    const row = accountRowSummary(acct, sumsByAccount.get(acct.id));
    if (row.debit_cents === 0 && row.credit_cents === 0) continue;

    const amountCents = row.section_cents;
    const deductibleCents = Math.round((amountCents * row.deductible_pct) / 100);
    const entry = {
      id: row.id,
      code: row.code,
      name: row.name,
      sub_type: row.sub_type,
      schedule_c_line: row.schedule_c_line,
      deductible_pct: row.deductible_pct,
      amount_cents: amountCents,
      deductible_cents: deductibleCents,
    };

    if (acct.account_type === 'revenue') {
      revenue.push(entry);
      totalRevenueCents += amountCents;
    } else if (acct.account_type === 'cogs') {
      cogs.push(entry);
      totalCogsCents += amountCents;
    } else {
      expenses.push(entry);
      totalExpensesCents += amountCents;
      totalDeductibleExpensesCents += deductibleCents;
      if (acct.sub_type === 'interest_expense') interestCents += amountCents;
      if (acct.sub_type === 'depreciation_expense') depreciationCents += amountCents;
    }
  }

  const grossProfitCents = totalRevenueCents - totalCogsCents;
  const grossMarginPct = totalRevenueCents > 0
    ? Number(((grossProfitCents / totalRevenueCents) * 100).toFixed(2))
    : 0;
  const netIncomeCents = grossProfitCents - totalExpensesCents;
  const ebitdaCents = netIncomeCents + interestCents + depreciationCents;
  const netMarginPct = totalRevenueCents > 0
    ? Number(((netIncomeCents / totalRevenueCents) * 100).toFixed(2))
    : 0;

  return {
    from,
    to,
    basis,
    sections: { revenue, cogs, expenses },
    totals: {
      revenue_cents: totalRevenueCents,
      cogs_cents: totalCogsCents,
      gross_profit_cents: grossProfitCents,
      gross_margin_pct: grossMarginPct,
      operating_expenses_cents: totalExpensesCents,
      deductible_expenses_cents: totalDeductibleExpensesCents,
      interest_cents: interestCents,
      depreciation_cents: depreciationCents,
      ebitda_cents: ebitdaCents,
      net_income_cents: netIncomeCents,
      net_margin_pct: netMarginPct,
    },
  };
}

/**
 * Pure: Balance Sheet as of a cutoff date.
 * Automatically folds cumulative P&L Net Income into Equity so the accounting equation
 * Assets === Liabilities + Equity holds to the exact penny at all times.
 */
function computeBalanceSheet(accounts, sumsByAccount, { asOf } = {}) {
  const currentAssets = [];
  const fixedAssets = [];
  const otherAssets = [];
  const currentLiabilities = [];
  const longTermLiabilities = [];
  const equity = [];

  let totalAssetsCents = 0;
  let totalLiabilitiesCents = 0;
  let totalRecordedEquityCents = 0;
  let cumulativeNetIncomeCents = 0;

  for (const acct of accounts) {
    const row = accountRowSummary(acct, sumsByAccount.get(acct.id));
    if (INCOME_STATEMENT_TYPES.has(acct.account_type)) {
      if (acct.account_type === 'revenue') cumulativeNetIncomeCents += row.section_cents;
      else cumulativeNetIncomeCents -= row.section_cents;
      continue;
    }
    if (!BALANCE_SHEET_TYPES.has(acct.account_type)) continue;
    if (row.debit_cents === 0 && row.credit_cents === 0) continue;

    const item = {
      id: row.id,
      code: row.code,
      name: row.name,
      sub_type: row.sub_type,
      amount_cents: row.section_cents,
    };

    if (acct.account_type === 'asset') {
      totalAssetsCents += row.section_cents;
      if (CURRENT_ASSET_SUB_TYPES.has(acct.sub_type)) currentAssets.push(item);
      else if (acct.sub_type === 'fixed_asset' || acct.sub_type === 'accum_depreciation') fixedAssets.push(item);
      else otherAssets.push(item);
    } else if (acct.account_type === 'liability') {
      totalLiabilitiesCents += row.section_cents;
      if (CURRENT_LIABILITY_SUB_TYPES.has(acct.sub_type)) currentLiabilities.push(item);
      else longTermLiabilities.push(item);
    } else {
      totalRecordedEquityCents += row.section_cents;
      equity.push(item);
    }
  }

  const totalEquityCents = totalRecordedEquityCents + cumulativeNetIncomeCents;
  const totalLiabilitiesAndEquityCents = totalLiabilitiesCents + totalEquityCents;
  const discrepancyCents = totalAssetsCents - totalLiabilitiesAndEquityCents;

  return {
    as_of: asOf,
    sections: {
      current_assets: currentAssets,
      fixed_assets: fixedAssets,
      other_assets: otherAssets,
      current_liabilities: currentLiabilities,
      long_term_liabilities: longTermLiabilities,
      equity,
    },
    totals: {
      current_assets_cents: currentAssets.reduce((s, r) => s + r.amount_cents, 0),
      fixed_assets_net_cents: fixedAssets.reduce((s, r) => s + r.amount_cents, 0),
      total_assets_cents: totalAssetsCents,
      current_liabilities_cents: currentLiabilities.reduce((s, r) => s + r.amount_cents, 0),
      long_term_liabilities_cents: longTermLiabilities.reduce((s, r) => s + r.amount_cents, 0),
      total_liabilities_cents: totalLiabilitiesCents,
      recorded_equity_cents: totalRecordedEquityCents,
      net_income_cents: cumulativeNetIncomeCents,
      total_equity_cents: totalEquityCents,
      liabilities_and_equity_cents: totalLiabilitiesAndEquityCents,
      discrepancy_cents: discrepancyCents,
      balanced: discrepancyCents === 0,
    },
  };
}

/**
 * Pure: Indirect Statement of Cash Flows over [from, to].
 * Reconciles Net Income -> Operating -> Investing -> Financing -> Ending Cash.
 */
function computeCashFlowStatement(accounts, periodSums, openingSums, { from, to } = {}) {
  const pnl = computeProfitAndLoss(accounts, periodSums, { from, to, basis: 'accrual' });
  const netIncomeCents = pnl.totals.net_income_cents;

  let beginningCashCents = 0;
  let periodCashChangeCents = 0;
  let nonCashDepreciationCents = 0;
  const workingCapital = [];
  const investing = [];
  const financing = [];

  for (const acct of accounts) {
    const pSum = periodSums.get(acct.id);
    const oSum = openingSums.get(acct.id);
    const delta = pSum ? sectionSignedBalanceCents(acct, pSum.debitCents, pSum.creditCents) : 0;
    const opening = oSum ? sectionSignedBalanceCents(acct, oSum.debitCents, oSum.creditCents) : 0;

    if (acct.account_type === 'asset' && CASH_SUB_TYPES.has(acct.sub_type)) {
      beginningCashCents += opening;
      periodCashChangeCents += delta;
      continue;
    }
    if (delta === 0) continue;

    if (acct.account_type === 'asset' && acct.sub_type === 'accum_depreciation') {
      // Accum depr is contra-asset (credit normal); section_cents is negative when depreciation increases.
      nonCashDepreciationCents += -delta;
    } else if (acct.account_type === 'asset' && acct.sub_type === 'fixed_asset') {
      investing.push({ code: acct.code, name: acct.name, amount_cents: -delta });
    } else if (acct.account_type === 'asset') {
      // Asset increase uses cash; asset decrease releases cash.
      workingCapital.push({ code: acct.code, name: `Change in ${acct.name}`, amount_cents: -delta });
    } else if (acct.account_type === 'liability' && acct.sub_type === 'loan_payable') {
      financing.push({ code: acct.code, name: acct.name, amount_cents: delta });
    } else if (acct.account_type === 'liability') {
      // Liability increase provides cash; liability decrease uses cash.
      workingCapital.push({ code: acct.code, name: `Change in ${acct.name}`, amount_cents: delta });
    } else if (acct.account_type === 'equity') {
      financing.push({ code: acct.code, name: acct.name, amount_cents: delta });
    }
  }

  const operatingCashCents = netIncomeCents + nonCashDepreciationCents
    + workingCapital.reduce((s, r) => s + r.amount_cents, 0);
  const investingCashCents = investing.reduce((s, r) => s + r.amount_cents, 0);
  const financingCashCents = financing.reduce((s, r) => s + r.amount_cents, 0);
  const computedNetChangeCents = operatingCashCents + investingCashCents + financingCashCents;
  const endingCashCents = beginningCashCents + periodCashChangeCents;

  return {
    from,
    to,
    operating: {
      net_income_cents: netIncomeCents,
      depreciation_addback_cents: nonCashDepreciationCents,
      working_capital: workingCapital,
      total_cents: operatingCashCents,
    },
    investing: {
      items: investing,
      total_cents: investingCashCents,
    },
    financing: {
      items: financing,
      total_cents: financingCashCents,
    },
    summary: {
      net_cash_change_cents: computedNetChangeCents,
      beginning_cash_cents: beginningCashCents,
      ending_cash_cents: endingCashCents,
      discrepancy_cents: computedNetChangeCents - periodCashChangeCents,
      reconciles_to_cash: computedNetChangeCents === periodCashChangeCents,
    },
  };
}

// ── Database Query Helpers ───────────────────────────────────────────────────

async function queryAccountSums(conn, { from = null, to = null, basis = 'accrual' } = {}) {
  let q = conn('gl_journal_lines as l')
    .join('gl_journal_entries as e', 'e.id', 'l.entry_id')
    .where('e.status', 'posted');

  if (from) q = q.where('e.entry_date', '>=', from);
  if (to) q = q.where('e.entry_date', '<=', to);

  if (basis === 'accrual') {
    q = q.whereIn('e.basis_scope', ['both', 'accrual_only']);
  } else if (basis === 'cash') {
    q = q.whereIn('e.basis_scope', ['both', 'cash_only']);
  }

  const rows = await q
    .groupBy('l.account_id')
    .select(
      'l.account_id',
      conn.raw('COALESCE(SUM(l.debit_cents), 0)::bigint as debit_cents'),
      conn.raw('COALESCE(SUM(l.credit_cents), 0)::bigint as credit_cents'),
    );
  return sumMapFromRows(rows);
}

/**
 * Cash-basis revenue helper: on cash basis, revenue is recognized when payments settle
 * (clearing 1100 A/R or 2300 Unearned Revenue). This maps payment credits to revenue
 * while keeping all cash-settled expenses and fees from gl_journal_lines.
 */
async function queryCashBasisSums(conn, { from, to }) {
  const baseSums = await queryAccountSums(conn, { from, to, basis: 'cash' });

  // Pull payments settled in [from, to] to attribute cash receipts to service revenue accounts.
  const paymentCredits = await conn('gl_journal_lines as l')
    .join('gl_journal_entries as e', 'e.id', 'l.entry_id')
    .join('gl_accounts as a', 'a.id', 'l.account_id')
    .where('e.status', 'posted')
    .where('e.source_type', 'payment')
    .where('e.entry_date', '>=', from)
    .where('e.entry_date', '<=', to)
    .whereIn('a.code', [SYSTEM_CODES.ACCOUNTS_RECEIVABLE, SYSTEM_CODES.UNEARNED_REVENUE])
    .where('l.credit_cents', '>', 0)
    .groupBy('l.service_line')
    .select('l.service_line', conn.raw('COALESCE(SUM(l.credit_cents), 0)::bigint as credit_cents'));

  if (!paymentCredits.length) return baseSums;

  const revAccounts = await conn('gl_accounts')
    .where('account_type', 'revenue')
    .select('id', 'code');
  const revIdByCode = new Map(revAccounts.map((r) => [r.code, r.id]));
  const { revenueAccountCodeFor } = require('./posting-rules');

  for (const row of paymentCredits) {
    const code = revenueAccountCodeFor(row.service_line, row.service_line === 'commercial');
    const revId = revIdByCode.get(code) || revIdByCode.get(SYSTEM_CODES.REV_OTHER);
    if (!revId) continue;
    const prev = baseSums.get(revId) || { debitCents: 0, creditCents: 0 };
    baseSums.set(revId, {
      debitCents: prev.debitCents,
      creditCents: prev.creditCents + Math.trunc(Number(row.credit_cents) || 0),
    });
  }

  return baseSums;
}

async function loadAccountsOrdered(conn) {
  await ensureSystemAccounts(conn);
  return conn('gl_accounts').orderBy('sort_order', 'asc').orderBy('code', 'asc').select('*');
}

async function getTrialBalance({ asOf = null, conn = db } = {}) {
  const cutoff = assertValidDate(asOf || etDateString(new Date()), 'asOf');
  const accounts = await loadAccountsOrdered(conn);
  const sums = await queryAccountSums(conn, { to: cutoff, basis: 'accrual' });
  return computeTrialBalance(accounts, sums, { asOf: cutoff });
}

async function getProfitAndLoss({ from = null, to = null, basis = 'accrual', conn = db } = {}) {
  const today = etDateString(new Date());
  const start = assertValidDate(from || `${today.slice(0, 4)}-01-01`, 'from');
  const end = assertValidDate(to || today, 'to');
  if (start > end) throw new AccountingError(400, 'from date cannot be after to date');
  const cleanBasis = basis === 'cash' ? 'cash' : 'accrual';

  const accounts = await loadAccountsOrdered(conn);
  const sums = cleanBasis === 'cash'
    ? await queryCashBasisSums(conn, { from: start, to: end })
    : await queryAccountSums(conn, { from: start, to: end, basis: 'accrual' });

  return computeProfitAndLoss(accounts, sums, { from: start, to: end, basis: cleanBasis });
}

async function getBalanceSheet({ asOf = null, conn = db } = {}) {
  const cutoff = assertValidDate(asOf || etDateString(new Date()), 'asOf');
  const accounts = await loadAccountsOrdered(conn);
  const sums = await queryAccountSums(conn, { to: cutoff, basis: 'accrual' });
  return computeBalanceSheet(accounts, sums, { asOf: cutoff });
}

async function getCashFlowStatement({ from = null, to = null, conn = db } = {}) {
  const today = etDateString(new Date());
  const start = assertValidDate(from || `${today.slice(0, 4)}-01-01`, 'from');
  const end = assertValidDate(to || today, 'to');
  if (start > end) throw new AccountingError(400, 'from date cannot be after to date');

  const accounts = await loadAccountsOrdered(conn);
  const [periodSums, openingSums] = await Promise.all([
    queryAccountSums(conn, { from: start, to: end, basis: 'accrual' }),
    conn('gl_journal_lines as l')
      .join('gl_journal_entries as e', 'e.id', 'l.entry_id')
      .where('e.status', 'posted')
      .where('e.entry_date', '<', start)
      .whereIn('e.basis_scope', ['both', 'accrual_only'])
      .groupBy('l.account_id')
      .select(
        'l.account_id',
        conn.raw('COALESCE(SUM(l.debit_cents), 0)::bigint as debit_cents'),
        conn.raw('COALESCE(SUM(l.credit_cents), 0)::bigint as credit_cents'),
      )
      .then(sumMapFromRows),
  ]);

  return computeCashFlowStatement(accounts, periodSums, openingSums, { from: start, to: end });
}

/**
 * True Accrual Florida Sales Tax Liability (DR-15) directly from GL Account 2100.
 */
async function getSalesTaxLiabilitySummary({ from = null, to = null, conn = db } = {}) {
  const today = etDateString(new Date());
  const start = assertValidDate(from || `${today.slice(0, 7)}-01`, 'from');
  const end = assertValidDate(to || today, 'to');
  await ensureSystemAccounts(conn);

  const taxAccount = await conn('gl_accounts').where({ code: SYSTEM_CODES.SALES_TAX_PAYABLE }).first();
  if (!taxAccount) throw new AccountingError(500, 'Sales Tax Payable account (2100) missing');

  const [openingRow, periodRows] = await Promise.all([
    conn('gl_journal_lines as l')
      .join('gl_journal_entries as e', 'e.id', 'l.entry_id')
      .where('l.account_id', taxAccount.id)
      .where('e.status', 'posted')
      .where('e.entry_date', '<', start)
      .first(
        conn.raw('COALESCE(SUM(l.debit_cents), 0)::bigint as debit_cents'),
        conn.raw('COALESCE(SUM(l.credit_cents), 0)::bigint as credit_cents'),
      ),
    conn('gl_journal_lines as l')
      .join('gl_journal_entries as e', 'e.id', 'l.entry_id')
      .where('l.account_id', taxAccount.id)
      .where('e.status', 'posted')
      .whereBetween('e.entry_date', [start, end])
      .orderBy('e.entry_date', 'asc')
      .select('e.entry_date', 'e.entry_number', 'e.source_type', 'e.memo', 'l.debit_cents', 'l.credit_cents'),
  ]);

  const openingPayableCents = naturalBalanceCents(taxAccount, openingRow?.debit_cents, openingRow?.credit_cents);
  let taxAccruedCents = 0;
  let taxRefundedCents = 0;
  let taxRemittedCents = 0;

  for (const r of periodRows) {
    const dr = Number(r.debit_cents);
    const cr = Number(r.credit_cents);
    if (cr > 0) taxAccruedCents += cr;
    if (dr > 0) {
      if (r.source_type === 'refund') taxRefundedCents += dr;
      else taxRemittedCents += dr;
    }
  }

  const netPeriodLiabilityCents = taxAccruedCents - taxRefundedCents;
  const endingPayableCents = openingPayableCents + netPeriodLiabilityCents - taxRemittedCents;

  return {
    from: start,
    to: end,
    basis: 'accrual',
    opening_payable_cents: openingPayableCents,
    tax_accrued_cents: taxAccruedCents,
    tax_reversed_on_refunds_cents: taxRefundedCents,
    net_tax_due_for_period_cents: netPeriodLiabilityCents,
    tax_remitted_cents: taxRemittedCents,
    ending_payable_cents: endingPayableCents,
    entries: periodRows.map((r) => ({
      entry_date: String(r.entry_date).slice(0, 10),
      entry_number: Number(r.entry_number),
      source_type: r.source_type,
      memo: r.memo,
      debit_cents: Number(r.debit_cents),
      credit_cents: Number(r.credit_cents),
    })),
  };
}

/**
 * 1099-NEC Vendor Payment Summary driven by gl_vendors + gl_journal_lines.
 * Uses $600 threshold through 2025 and $2,000 threshold from 2026 onward (P.L. 119-21).
 */
async function get1099VendorSummary({ year = null, conn = db } = {}) {
  const targetYear = parseInt(year, 10) || etParts(new Date()).year;
  if (targetYear < 2020 || targetYear > 2100) throw new AccountingError(400, 'Invalid tax year');
  const thresholdCents = targetYear >= 2026 ? 200000 : 60000;
  const from = `${targetYear}-01-01`;
  const to = `${targetYear}-12-31`;

  const rows = await conn('gl_journal_lines as l')
    .join('gl_journal_entries as e', 'e.id', 'l.entry_id')
    .join('gl_accounts as a', 'a.id', 'l.account_id')
    .join('gl_vendors as v', 'v.id', 'l.vendor_id')
    .where('e.status', 'posted')
    .whereBetween('e.entry_date', [from, to])
    .whereIn('a.account_type', ['cogs', 'expense'])
    .where('v.is_1099_eligible', true)
    .groupBy('v.id')
    .select(
      'v.id',
      'v.display_name',
      'v.legal_name',
      'v.entity_type',
      'v.w9_received_at',
      'v.tin_last4',
      conn.raw('COALESCE(SUM(l.debit_cents - l.credit_cents), 0)::bigint as total_paid_cents'),
      conn.raw('COUNT(DISTINCT e.id)::int as payment_count'),
    );

  const vendors = rows
    .map((r) => {
      const paid = Number(r.total_paid_cents);
      return {
        id: r.id,
        display_name: r.display_name,
        legal_name: r.legal_name,
        entity_type: r.entity_type,
        w9_on_file: Boolean(r.w9_received_at),
        tin_last4: r.tin_last4 || null,
        payment_count: Number(r.payment_count),
        total_paid_cents: paid,
        filing_required: paid >= thresholdCents,
        missing_w9: paid >= thresholdCents && !r.w9_received_at,
      };
    })
    .sort((a, b) => b.total_paid_cents - a.total_paid_cents);

  return {
    year: targetYear,
    threshold_cents: thresholdCents,
    vendors,
    filing_required_count: vendors.filter((v) => v.filing_required).length,
    missing_w9_count: vendors.filter((v) => v.missing_w9).length,
  };
}

/**
 * Executive Accounting Overview KPIs — single source of truth from GL.
 */
async function getAccountingOverview({ conn = db } = {}) {
  const today = etDateString(new Date());
  const monthStart = `${today.slice(0, 7)}-01`;
  const yearStart = `${today.slice(0, 4)}-01-01`;

  const [trialBalance, balanceSheet, pnlMtd, pnlYtd, periods, entryCountRow] = await Promise.all([
    getTrialBalance({ asOf: today, conn }),
    getBalanceSheet({ asOf: today, conn }),
    getProfitAndLoss({ from: monthStart, to: today, basis: 'accrual', conn }),
    getProfitAndLoss({ from: yearStart, to: today, basis: 'accrual', conn }),
    conn('gl_periods').orderBy('period_month', 'desc').limit(12).select('*'),
    conn('gl_journal_entries').where({ status: 'posted' }).count('* as count').first(),
  ]);

  const byCode = new Map();
  for (const list of [
    balanceSheet.sections.current_assets,
    balanceSheet.sections.fixed_assets,
    balanceSheet.sections.current_liabilities,
    balanceSheet.sections.long_term_liabilities,
  ]) {
    for (const item of list) byCode.set(item.code, item.amount_cents);
  }

  const totalCashCents = [
    SYSTEM_CODES.CHECKING_PRIMARY,
    SYSTEM_CODES.CHECKING_PAYROLL,
    SYSTEM_CODES.SAVINGS_RESERVE,
    SYSTEM_CODES.STRIPE_CLEARING,
    SYSTEM_CODES.UNDEPOSITED_FUNDS,
  ].reduce((s, code) => s + (byCode.get(code) || 0), 0);

  const lockedMonths = periods.filter((p) => p.status === 'locked').map((p) => p.period_month);

  return {
    as_of: today,
    posted_entries: Number(entryCountRow?.count || 0),
    trial_balance_ok: trialBalance.balanced,
    balance_sheet_ok: balanceSheet.totals.balanced,
    cash_total_cents: totalCashCents,
    stripe_clearing_cents: byCode.get(SYSTEM_CODES.STRIPE_CLEARING) || 0,
    accounts_receivable_cents: byCode.get(SYSTEM_CODES.ACCOUNTS_RECEIVABLE) || 0,
    credit_cards_cents: byCode.get(SYSTEM_CODES.CREDIT_CARD_PRIMARY) || 0,
    sales_tax_payable_cents: byCode.get(SYSTEM_CODES.SALES_TAX_PAYABLE) || 0,
    unearned_revenue_cents: byCode.get(SYSTEM_CODES.UNEARNED_REVENUE) || 0,
    payroll_liabilities_cents: (byCode.get(SYSTEM_CODES.PAYROLL_TAX_LIABILITIES) || 0)
      + (byCode.get(SYSTEM_CODES.PAYROLL_BENEFITS_PAYABLE) || 0)
      + (byCode.get(SYSTEM_CODES.NET_PAY_CLEARING) || 0),
    mtd: pnlMtd.totals,
    ytd: pnlYtd.totals,
    locked_through: lockedMonths[0] || null,
  };
}

module.exports = {
  computeTrialBalance,
  computeProfitAndLoss,
  computeBalanceSheet,
  computeCashFlowStatement,
  getTrialBalance,
  getProfitAndLoss,
  getBalanceSheet,
  getCashFlowStatement,
  getSalesTaxLiabilitySummary,
  get1099VendorSummary,
  getAccountingOverview,
};
