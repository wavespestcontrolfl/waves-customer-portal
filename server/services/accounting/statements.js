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
const { paymentChannel } = require('../tax-worksheets');
const {
  SYSTEM_CODES,
  BALANCE_SHEET_TYPES,
  INCOME_STATEMENT_TYPES,
  findMissingSystemAccountCodes,
  naturalBalanceCents,
  sectionSignedBalanceCents,
  dateCellText,
  dollarsToCents,
} = require('./coa-seed');
const { AccountingError, assertValidDate } = require('./ledger');

const EXCLUDED_1099_CHANNELS = new Set(['card', 'debit_card', 'platform']);

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

async function queryAccountSums(conn, { from = null, to = null, basis = 'accrual', excludeClosing = false } = {}) {
  let q = conn('gl_journal_lines as l')
    .join('gl_journal_entries as e', 'e.id', 'l.entry_id')
    .where('e.status', 'posted');

  if (excludeClosing) {
    q = q
      .leftJoin('gl_journal_entries as close_orig', 'close_orig.id', 'e.reverses_entry_id')
      .where('e.entry_type', '<>', 'closing')
      .where((sub) => {
        sub.whereNull('close_orig.id').orWhere('close_orig.entry_type', '<>', 'closing');
      });
  }

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

function addSignedRevenue(sumsMap, accountId, signedCents) {
  if (!accountId || !signedCents) return;
  const prev = sumsMap.get(accountId) || { debitCents: 0, creditCents: 0 };
  if (signedCents > 0) {
    sumsMap.set(accountId, { debitCents: prev.debitCents, creditCents: prev.creditCents + signedCents });
  } else {
    sumsMap.set(accountId, { debitCents: prev.debitCents + Math.abs(signedCents), creditCents: prev.creditCents });
  }
}

function allocateTotalByProfile(signedTotalCents, invoiceProfile, fallbackRevId) {
  const result = new Map();
  const signed = Math.trunc(Number(signedTotalCents) || 0);
  if (signed === 0) return result;
  const sign = signed >= 0 ? 1 : -1;
  const absTotal = Math.abs(signed);

  if (!invoiceProfile || !(invoiceProfile.arDebitedCents > 0)) {
    if (fallbackRevId) result.set(fallbackRevId, signed);
    return result;
  }

  const denom = invoiceProfile.arDebitedCents;
  const arTax = Math.min(Math.max(0, invoiceProfile.taxCents || 0), denom);
  const arRevenue = Math.max(0, denom - arTax);
  const revenuePortion = Math.round((absTotal * arRevenue) / denom);
  if (revenuePortion <= 0) return result;

  const splits = (invoiceProfile.revenueSplits || []).filter((s) => s.accountId && s.amountCents > 0);
  if (!splits.length) {
    if (fallbackRevId) result.set(fallbackRevId, sign * revenuePortion);
    return result;
  }
  if (splits.length === 1) {
    result.set(splits[0].accountId, sign * revenuePortion);
    return result;
  }

  const splitTotal = splits.reduce((sum, s) => sum + s.amountCents, 0);
  let allocated = 0;
  for (let i = 0; i < splits.length; i += 1) {
    const part = i === splits.length - 1
      ? revenuePortion - allocated
      : Math.round((revenuePortion * splits[i].amountCents) / splitTotal);
    allocated += part;
    if (part > 0) result.set(splits[i].accountId, sign * part);
  }
  return result;
}

/**
 * Pure: allocate a signed A/R or Unearned-Revenue receipt incrementally from cumulative
 * receipts so multiple partial payments across odd-cent invoices sum to the exact
 * pre-tax invoice revenue with zero rounding drift, and reversals undo exact prior cents.
 */
function allocateCumulativeCashReceipt(priorCumCents, signedReceiptCents, invoiceProfile, fallbackServiceLine, revIdByCode) {
  const { revenueAccountCodeFor } = require('./posting-rules');
  const prior = Math.trunc(Number(priorCumCents) || 0);
  const delta = Math.trunc(Number(signedReceiptCents) || 0);
  if (delta === 0) return [];

  const fallbackCode = revenueAccountCodeFor(fallbackServiceLine, fallbackServiceLine === 'commercial');
  const fallbackRevId = revIdByCode.get(fallbackCode) || revIdByCode.get(SYSTEM_CODES.REV_OTHER) || null;
  const before = allocateTotalByProfile(prior, invoiceProfile, fallbackRevId);
  const after = allocateTotalByProfile(prior + delta, invoiceProfile, fallbackRevId);

  const keys = new Set([...before.keys(), ...after.keys()]);
  const out = [];
  for (const accountId of keys) {
    const diff = (after.get(accountId) || 0) - (before.get(accountId) || 0);
    if (diff !== 0) out.push({ accountId, signedCents: diff });
  }
  return out;
}

function allocateCashReceiptToRevenue(signedReceiptCents, invoiceProfile, fallbackServiceLine, revIdByCode) {
  return allocateCumulativeCashReceipt(0, signedReceiptCents, invoiceProfile, fallbackServiceLine, revIdByCode);
}

async function loadFallbackInvoiceProfiles(conn, missingUuids, revIdByCode, profiles) {
  if (!missingUuids.length || !(await conn.schema.hasTable('invoices'))) return;
  const { revenueAccountCodeFor } = require('./posting-rules');
  const invRows = await conn('invoices as i')
    .leftJoin('customers as c', 'c.id', 'i.customer_id')
    .whereIn('i.id', missingUuids)
    .select('i.id', 'i.total', 'i.tax_amount', 'i.credit_applied', 'i.service_type', 'c.property_type');
  for (const inv of invRows) {
    const totalCents = Math.max(0, (dollarsToCents(inv.total) || 0) - (dollarsToCents(inv.credit_applied) || 0));
    const taxCents = Math.max(0, dollarsToCents(inv.tax_amount) || 0);
    const isCommercial = ['commercial', 'business'].includes(String(inv.property_type || '').toLowerCase());
    const revCode = revenueAccountCodeFor(inv.service_type || 'pest', isCommercial);
    const revId = revIdByCode.get(revCode) || revIdByCode.get(SYSTEM_CODES.REV_OTHER);
    profiles.set(String(inv.id), {
      arDebitedCents: totalCents,
      taxCents,
      revenueSplits: revId && totalCents > taxCents ? [{ accountId: revId, amountCents: totalCents - taxCents }] : [],
    });
  }
}

/**
 * Pure: compute an invoice's A/R, FL sales tax, and revenue split profile using ONLY
 * invoice GL entries (and reversals of invoice entries) posted on or before `asOfDate`.
 * Keeps later invoice edits/adjustments from mutating historical locked cash-basis reports.
 */
function buildInvoiceProfileAsOf(invoiceLines, asOfDate) {
  if (!Array.isArray(invoiceLines) || !invoiceLines.length) return null;
  let arNet = 0;
  let taxNet = 0;
  const revByAccount = new Map();
  let matchedAny = false;

  for (const r of invoiceLines) {
    const entryDay = dateCellText(r.entry_date);
    if (asOfDate && entryDay && entryDay > asOfDate) continue;
    matchedAny = true;
    const dr = Number(r.debit_cents);
    const cr = Number(r.credit_cents);
    if (r.code === SYSTEM_CODES.ACCOUNTS_RECEIVABLE) arNet += (dr - cr);
    if (r.code === SYSTEM_CODES.SALES_TAX_PAYABLE) taxNet += (cr - dr);
    if (r.account_type === 'revenue') {
      revByAccount.set(r.account_id, (revByAccount.get(r.account_id) || 0) + (cr - dr));
    }
  }
  if (!matchedAny) return null;

  const revenueSplits = [];
  for (const [accountId, amountCents] of revByAccount.entries()) {
    if (amountCents > 0) revenueSplits.push({ accountId, amountCents });
  }
  return {
    arDebitedCents: Math.max(0, arNet),
    taxCents: Math.max(0, taxNet),
    revenueSplits,
  };
}

async function loadInvoiceHistoryForCashBasis(conn, invoiceRefs, revIdByCode, maxReceiptDate = null) {
  const linesByInvoice = new Map();
  const fallbackProfiles = new Map();
  if (!invoiceRefs.length) return { linesByInvoice, fallbackProfiles };

  let q = conn('gl_journal_lines as l')
    .join('gl_journal_entries as e', 'e.id', 'l.entry_id')
    .leftJoin('gl_journal_entries as orig', 'orig.id', 'e.reverses_entry_id')
    .join('gl_accounts as a', 'a.id', 'l.account_id')
    .where('e.status', 'posted')
    .where((sub) => {
      sub.where((inv) => inv.where('e.source_type', 'invoice').whereIn('e.source_id', invoiceRefs))
        .orWhere((rev) => rev.where('e.source_type', 'reversal')
          .where('orig.source_type', 'invoice')
          .whereIn('orig.source_id', invoiceRefs));
    });
  if (maxReceiptDate) q = q.where('e.entry_date', '<=', maxReceiptDate);

  const glLines = await q.select(
    conn.raw("COALESCE(CASE WHEN e.source_type = 'reversal' THEN orig.source_id ELSE e.source_id END, e.source_id) as inv_source_id"),
    conn.raw('e.entry_date::text as entry_date'),
    'a.id as account_id',
    'a.code',
    'a.account_type',
    'l.debit_cents',
    'l.credit_cents',
  );

  for (const r of glLines) {
    const key = String(r.inv_source_id);
    const list = linesByInvoice.get(key) || [];
    list.push(r);
    linesByInvoice.set(key, list);
  }

  const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const missingUuids = invoiceRefs.filter((ref) => !linesByInvoice.has(ref) && uuidRe.test(ref));
  await loadFallbackInvoiceProfiles(conn, missingUuids, revIdByCode, fallbackProfiles);
  return { linesByInvoice, fallbackProfiles };
}

function cashBasisReceiptWhere(q) {
  q.whereIn('e.source_type', ['payment', 'deposit_refund', 'deposit_refund_reversal', 'dispute', 'dispute_reversal'])
    .orWhere((rev) => rev.where('e.source_type', 'reversal')
      .whereIn('orig.source_type', ['payment', 'deposit_refund', 'deposit_refund_reversal', 'dispute', 'dispute_reversal']))
    .orWhere((prepayRef) => prepayRef.where('a.code', SYSTEM_CODES.UNEARNED_REVENUE)
      .where((src) => src.whereIn('e.source_type', ['refund', 'refund_reversal'])
        .orWhere((r) => r.where('e.source_type', 'reversal').whereIn('orig.source_type', ['refund', 'refund_reversal']))));
}

const PAYROLL_LIABILITY_CODES = [
  SYSTEM_CODES.NET_PAY_CLEARING,
  SYSTEM_CODES.PAYROLL_TAX_LIABILITIES,
  SYSTEM_CODES.PAYROLL_BENEFITS_PAYABLE,
];

function addSignedExpense(sumsMap, accountId, signedCents) {
  if (!accountId || !signedCents) return;
  const prev = sumsMap.get(accountId) || { debitCents: 0, creditCents: 0 };
  if (signedCents > 0) {
    sumsMap.set(accountId, { debitCents: prev.debitCents + signedCents, creditCents: prev.creditCents });
  } else {
    sumsMap.set(accountId, { debitCents: prev.debitCents, creditCents: prev.creditCents + Math.abs(signedCents) });
  }
}

/**
 * Pure: compute cumulative accrued payroll composition from payroll_run entries (and
 * reversals) posted on or before `asOfDate` so cash-basis payroll disbursements map
 * back to exact wage, employer payroll-tax, SIMPLE IRA, and HSA expense accounts.
 */
function buildPayrollProfileAsOf(payrollLines, asOfDate) {
  if (!Array.isArray(payrollLines) || !payrollLines.length) return null;
  const netByCode = new Map();
  let matchedAny = false;
  for (const r of payrollLines) {
    const entryDay = dateCellText(r.entry_date);
    if (asOfDate && entryDay && entryDay > asOfDate) continue;
    matchedAny = true;
    const netDr = Number(r.debit_cents) - Number(r.credit_cents);
    netByCode.set(r.code, (netByCode.get(r.code) || 0) + netDr);
  }
  if (!matchedAny) return null;

  const dr = (code) => Math.max(0, netByCode.get(code) || 0);
  const cr = (code) => Math.max(0, -(netByCode.get(code) || 0));
  return {
    fieldGrossCents: dr(SYSTEM_CODES.COGS_FIELD_WAGES),
    adminGrossCents: dr(SYSTEM_CODES.OPEX_OFFICE_WAGES),
    fieldErTaxCents: dr(SYSTEM_CODES.COGS_FIELD_PAYROLL_TAX),
    adminErTaxCents: dr(SYSTEM_CODES.OPEX_OFFICE_PAYROLL_TAX),
    erSimpleCents: dr(SYSTEM_CODES.OPEX_RETIREMENT_SIMPLE),
    erHsaCents: dr(SYSTEM_CODES.OPEX_EMPLOYEE_BENEFITS),
    netPayLiabilityCents: cr(SYSTEM_CODES.NET_PAY_CLEARING),
    taxLiabilityCents: cr(SYSTEM_CODES.PAYROLL_TAX_LIABILITIES),
    benefitsLiabilityCents: cr(SYSTEM_CODES.PAYROLL_BENEFITS_PAYABLE),
  };
}

function splitEmployeeWithholdingAcrossWages(withholdingCents, profile) {
  if (withholdingCents <= 0) return [];
  const fieldGross = profile?.fieldGrossCents || 0;
  const adminGross = profile?.adminGrossCents || 0;
  const totalGross = fieldGross + adminGross;
  if (totalGross <= 0) return [{ accountCode: SYSTEM_CODES.COGS_FIELD_WAGES, weight: withholdingCents }];
  const fieldPart = Math.round((withholdingCents * fieldGross) / totalGross);
  const adminPart = withholdingCents - fieldPart;
  const out = [];
  if (fieldPart > 0) out.push({ accountCode: SYSTEM_CODES.COGS_FIELD_WAGES, weight: fieldPart });
  if (adminPart > 0) out.push({ accountCode: SYSTEM_CODES.OPEX_OFFICE_WAGES, weight: adminPart });
  return out;
}

function payrollExpenseWeightsForLiability(liabilityCode, profile, serviceLine) {
  if (liabilityCode === SYSTEM_CODES.NET_PAY_CLEARING) {
    if (serviceLine === 'admin') return [{ accountCode: SYSTEM_CODES.OPEX_OFFICE_WAGES, weight: 1 }];
    if (serviceLine === 'field') return [{ accountCode: SYSTEM_CODES.COGS_FIELD_WAGES, weight: 1 }];
    const out = [];
    if (profile?.fieldGrossCents > 0) out.push({ accountCode: SYSTEM_CODES.COGS_FIELD_WAGES, weight: profile.fieldGrossCents });
    if (profile?.adminGrossCents > 0) out.push({ accountCode: SYSTEM_CODES.OPEX_OFFICE_WAGES, weight: profile.adminGrossCents });
    return out.length ? out : [{ accountCode: SYSTEM_CODES.COGS_FIELD_WAGES, weight: 1 }];
  }

  if (liabilityCode === SYSTEM_CODES.PAYROLL_TAX_LIABILITIES) {
    if (!profile || profile.taxLiabilityCents <= 0) {
      return [{ accountCode: SYSTEM_CODES.COGS_FIELD_PAYROLL_TAX, weight: 1 }];
    }
    const empTax = Math.max(0, profile.taxLiabilityCents - profile.fieldErTaxCents - profile.adminErTaxCents);
    const out = [...splitEmployeeWithholdingAcrossWages(empTax, profile)];
    if (profile.fieldErTaxCents > 0) out.push({ accountCode: SYSTEM_CODES.COGS_FIELD_PAYROLL_TAX, weight: profile.fieldErTaxCents });
    if (profile.adminErTaxCents > 0) out.push({ accountCode: SYSTEM_CODES.OPEX_OFFICE_PAYROLL_TAX, weight: profile.adminErTaxCents });
    return out.length ? out : [{ accountCode: SYSTEM_CODES.COGS_FIELD_PAYROLL_TAX, weight: 1 }];
  }

  if (!profile || profile.benefitsLiabilityCents <= 0) {
    return [{ accountCode: SYSTEM_CODES.OPEX_EMPLOYEE_BENEFITS, weight: 1 }];
  }
  const empSimple = Math.max(0, profile.benefitsLiabilityCents - profile.erSimpleCents - profile.erHsaCents);
  const out = [...splitEmployeeWithholdingAcrossWages(empSimple, profile)];
  if (profile.erSimpleCents > 0) out.push({ accountCode: SYSTEM_CODES.OPEX_RETIREMENT_SIMPLE, weight: profile.erSimpleCents });
  if (profile.erHsaCents > 0) out.push({ accountCode: SYSTEM_CODES.OPEX_EMPLOYEE_BENEFITS, weight: profile.erHsaCents });
  return out.length ? out : [{ accountCode: SYSTEM_CODES.OPEX_EMPLOYEE_BENEFITS, weight: 1 }];
}

function allocateTotalByExpenseWeights(signedTotalCents, weights, expIdByCode) {
  const result = new Map();
  const signed = Math.trunc(Number(signedTotalCents) || 0);
  if (signed === 0) return result;
  const sign = signed >= 0 ? 1 : -1;
  const absTotal = Math.abs(signed);
  const resolved = (weights || [])
    .map((w) => ({ accountId: expIdByCode.get(w.accountCode), weight: w.weight }))
    .filter((w) => w.accountId && w.weight > 0);
  if (!resolved.length) return result;

  const weightSum = resolved.reduce((s, w) => s + w.weight, 0);
  let allocated = 0;
  for (let i = 0; i < resolved.length; i += 1) {
    const part = i === resolved.length - 1
      ? absTotal - allocated
      : Math.round((absTotal * resolved[i].weight) / weightSum);
    allocated += part;
    if (part > 0) result.set(resolved[i].accountId, (result.get(resolved[i].accountId) || 0) + sign * part);
  }
  return result;
}

/**
 * Pure: allocate a signed payroll disbursement (or reversal) against 2290/2200/2210
 * into cash-basis payroll COGS/OpEx deductions cumulatively with zero rounding drift.
 */
function allocateCumulativePayrollSettlement(priorCumCents, signedDisbursementCents, liabilityCode, profile, serviceLine, expIdByCode) {
  const prior = Math.trunc(Number(priorCumCents) || 0);
  const delta = Math.trunc(Number(signedDisbursementCents) || 0);
  if (delta === 0) return [];
  const weights = payrollExpenseWeightsForLiability(liabilityCode, profile, serviceLine);
  const before = allocateTotalByExpenseWeights(prior, weights, expIdByCode);
  const after = allocateTotalByExpenseWeights(prior + delta, weights, expIdByCode);
  const keys = new Set([...before.keys(), ...after.keys()]);
  const out = [];
  for (const accountId of keys) {
    const diff = (after.get(accountId) || 0) - (before.get(accountId) || 0);
    if (diff !== 0) out.push({ accountId, signedCents: diff });
  }
  return out;
}

function cashBasisPayrollSettlementWhere(q) {
  q.where('e.source_type', 'payroll_remittance')
    .orWhere((rev) => rev.where('e.source_type', 'reversal').where('orig.source_type', 'payroll_remittance'));
}

async function applyCashBasisPayrollDisbursements(conn, { from, to }, baseSums) {
  const rows = await conn('gl_journal_lines as l')
    .join('gl_journal_entries as e', 'e.id', 'l.entry_id')
    .leftJoin('gl_journal_entries as orig', 'orig.id', 'e.reverses_entry_id')
    .join('gl_accounts as a', 'a.id', 'l.account_id')
    .where('e.status', 'posted')
    .where('e.entry_date', '>=', from)
    .where('e.entry_date', '<=', to)
    .whereIn('a.code', PAYROLL_LIABILITY_CODES)
    .where(cashBasisPayrollSettlementWhere)
    .orderBy('e.entry_date', 'asc')
    .orderBy('e.entry_number', 'asc')
    .orderBy('l.line_order', 'asc')
    .select(
      conn.raw('e.entry_date::text as entry_date'),
      'a.code as account_code',
      'l.service_line',
      'l.debit_cents',
      'l.credit_cents',
    );
  if (!rows.length) return;

  const [expAccounts, payrollLines, priorRows] = await Promise.all([
    conn('gl_accounts').whereIn('account_type', ['cogs', 'expense']).select('id', 'code'),
    conn('gl_journal_lines as l')
      .join('gl_journal_entries as e', 'e.id', 'l.entry_id')
      .leftJoin('gl_journal_entries as orig', 'orig.id', 'e.reverses_entry_id')
      .join('gl_accounts as a', 'a.id', 'l.account_id')
      .where('e.status', 'posted')
      .where('e.entry_date', '<=', to)
      .where((sub) => {
        sub.where('e.source_type', 'payroll_run')
          .orWhere((rev) => rev.where('e.source_type', 'reversal').where('orig.source_type', 'payroll_run'));
      })
      .select(conn.raw('e.entry_date::text as entry_date'), 'a.code', 'l.debit_cents', 'l.credit_cents'),
    conn('gl_journal_lines as l')
      .join('gl_journal_entries as e', 'e.id', 'l.entry_id')
      .leftJoin('gl_journal_entries as orig', 'orig.id', 'e.reverses_entry_id')
      .join('gl_accounts as a', 'a.id', 'l.account_id')
      .where('e.status', 'posted')
      .where('e.entry_date', '<', from)
      .whereIn('a.code', PAYROLL_LIABILITY_CODES)
      .where(cashBasisPayrollSettlementWhere)
      .groupBy('a.code')
      .select('a.code', conn.raw('COALESCE(SUM(l.debit_cents - l.credit_cents), 0)::bigint as net_cents')),
  ]);

  const expIdByCode = new Map(expAccounts.map((a) => [a.code, a.id]));
  const cumByCode = new Map(priorRows.map((r) => [r.code, Number(r.net_cents)]));
  const profileCache = new Map();

  for (const row of rows) {
    const signedCents = Number(row.debit_cents) - Number(row.credit_cents);
    if (signedCents === 0) continue;
    const settleDay = dateCellText(row.entry_date);
    if (!profileCache.has(settleDay)) {
      profileCache.set(settleDay, buildPayrollProfileAsOf(payrollLines, settleDay));
    }
    const profile = profileCache.get(settleDay);
    const priorCum = cumByCode.get(row.account_code) || 0;
    const allocs = allocateCumulativePayrollSettlement(
      priorCum, signedCents, row.account_code, profile, row.service_line, expIdByCode,
    );
    cumByCode.set(row.account_code, priorCum + signedCents);
    for (const alloc of allocs) {
      addSignedExpense(baseSums, alloc.accountId, alloc.signedCents);
    }
  }
}

/**
 * Cash-basis helper: on cash basis, revenue is recognized when payments settle
 * (clearing 1100 A/R or 2300 Unearned Revenue), EXCLUDING collected Florida sales tax
 * via date-effective cumulative invoice revenue/tax allocation, and payroll expenses
 * are recognized when 2290/2200/2210 liabilities are actually disbursed.
 */
async function queryCashBasisSums(conn, { from, to }) {
  const baseSums = await queryAccountSums(conn, { from, to, basis: 'cash', excludeClosing: true });

  const activityRows = await conn('gl_journal_lines as l')
    .join('gl_journal_entries as e', 'e.id', 'l.entry_id')
    .leftJoin('gl_journal_entries as orig', 'orig.id', 'e.reverses_entry_id')
    .join('gl_accounts as a', 'a.id', 'l.account_id')
    .where('e.status', 'posted')
    .where('e.entry_date', '>=', from)
    .where('e.entry_date', '<=', to)
    .whereIn('a.code', [SYSTEM_CODES.ACCOUNTS_RECEIVABLE, SYSTEM_CODES.UNEARNED_REVENUE])
    .where(cashBasisReceiptWhere)
    .orderBy('e.entry_date', 'asc')
    .orderBy('e.entry_number', 'asc')
    .orderBy('l.line_order', 'asc')
    .select(
      conn.raw('e.entry_date::text as entry_date'),
      'l.invoice_ref',
      'l.service_line',
      'a.code as account_code',
      'l.debit_cents',
      'l.credit_cents',
    );

  if (activityRows.length) {
    const revAccounts = await conn('gl_accounts')
      .where('account_type', 'revenue')
      .select('id', 'code');
    const revIdByCode = new Map(revAccounts.map((r) => [r.code, r.id]));

    const invoiceRefs = [
      ...new Set(
        activityRows
          .filter((r) => r.account_code === SYSTEM_CODES.ACCOUNTS_RECEIVABLE && r.invoice_ref)
          .map((r) => String(r.invoice_ref)),
      ),
    ];

    const [{ linesByInvoice, fallbackProfiles }, priorReceiptRows] = await Promise.all([
      loadInvoiceHistoryForCashBasis(conn, invoiceRefs, revIdByCode, to),
      invoiceRefs.length
        ? conn('gl_journal_lines as l')
          .join('gl_journal_entries as e', 'e.id', 'l.entry_id')
          .leftJoin('gl_journal_entries as orig', 'orig.id', 'e.reverses_entry_id')
          .join('gl_accounts as a', 'a.id', 'l.account_id')
          .where('e.status', 'posted')
          .where('e.entry_date', '<', from)
          .where('a.code', SYSTEM_CODES.ACCOUNTS_RECEIVABLE)
          .whereIn('l.invoice_ref', invoiceRefs)
          .where(cashBasisReceiptWhere)
          .groupBy('l.invoice_ref')
          .select('l.invoice_ref', conn.raw('COALESCE(SUM(l.credit_cents - l.debit_cents), 0)::bigint as net_cents'))
        : Promise.resolve([]),
    ]);

    const cumByInvoice = new Map(priorReceiptRows.map((r) => [String(r.invoice_ref), Number(r.net_cents)]));

    for (const row of activityRows) {
      const signedCents = Number(row.credit_cents) - Number(row.debit_cents);
      if (signedCents === 0) continue;
      const invKey = row.account_code === SYSTEM_CODES.ACCOUNTS_RECEIVABLE && row.invoice_ref
        ? String(row.invoice_ref)
        : null;
      const receiptDay = dateCellText(row.entry_date);
      const profile = invKey
        ? (buildInvoiceProfileAsOf(linesByInvoice.get(invKey), receiptDay) || fallbackProfiles.get(invKey) || null)
        : null;
      const priorCum = invKey ? (cumByInvoice.get(invKey) || 0) : 0;
      const allocations = allocateCumulativeCashReceipt(priorCum, signedCents, profile, row.service_line, revIdByCode);
      if (invKey) cumByInvoice.set(invKey, priorCum + signedCents);
      for (const alloc of allocations) {
        addSignedRevenue(baseSums, alloc.accountId, alloc.signedCents);
      }
    }
  }

  await applyCashBasisPayrollDisbursements(conn, { from, to }, baseSums);
  return baseSums;
}

async function loadAccountsOrdered(conn) {
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
    : await queryAccountSums(conn, { from: start, to: end, basis: 'accrual', excludeClosing: true });

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
    queryAccountSums(conn, { from: start, to: end, basis: 'accrual', excludeClosing: true }),
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

function isSalesTaxRemittanceSource(sourceType, idempotencyKey) {
  return sourceType === 'sales_tax_remittance' || String(idempotencyKey || '').startsWith('sales-tax-remit:');
}

function isSalesTaxRefundSource(sourceType) {
  return sourceType === 'refund' || sourceType === 'refund_reversal';
}

/**
 * Pure: classify Account 2100 FL Sales Tax Payable activity into tax accrued,
 * tax reversed on refunds, and explicit FL DOR remittances. Reversal JEs are
 * classified according to the original entry they reverse — a reversed taxable
 * invoice reduces tax_accrued_cents and is NEVER miscounted as a FL DOR payment.
 */
function summarizeSalesTaxLines(openingPayableCents, periodRows) {
  let taxAccruedCents = 0;
  let taxRefundedCents = 0;
  let taxRemittedCents = 0;

  for (const r of periodRows || []) {
    const dr = Math.trunc(Number(r.debit_cents) || 0);
    const cr = Math.trunc(Number(r.credit_cents) || 0);
    const isReversal = r.source_type === 'reversal';
    const effSource = isReversal ? (r.reversed_source_type || 'invoice') : r.source_type;
    const effKey = isReversal ? r.reversed_idempotency_key : r.idempotency_key;

    if (isSalesTaxRemittanceSource(effSource, effKey)) {
      taxRemittedCents += (dr - cr);
    } else if (isSalesTaxRefundSource(effSource)) {
      taxRefundedCents += (dr - cr);
    } else {
      taxAccruedCents += (cr - dr);
    }
  }

  const netPeriodLiabilityCents = taxAccruedCents - taxRefundedCents;
  const endingPayableCents = openingPayableCents + netPeriodLiabilityCents - taxRemittedCents;
  return {
    opening_payable_cents: openingPayableCents,
    tax_accrued_cents: taxAccruedCents,
    tax_reversed_on_refunds_cents: taxRefundedCents,
    net_tax_due_for_period_cents: netPeriodLiabilityCents,
    tax_remitted_cents: taxRemittedCents,
    ending_payable_cents: endingPayableCents,
  };
}

/**
 * True Accrual Florida Sales Tax Liability (DR-15) directly from GL Account 2100.
 */
async function getSalesTaxLiabilitySummary({ from = null, to = null, conn = db } = {}) {
  const today = etDateString(new Date());
  const start = assertValidDate(from || `${today.slice(0, 7)}-01`, 'from');
  const end = assertValidDate(to || today, 'to');

  const taxAccount = await conn('gl_accounts').where({ code: SYSTEM_CODES.SALES_TAX_PAYABLE }).first();
  if (!taxAccount) throw new AccountingError(500, 'Sales Tax Payable account (2100) missing — run database migrations');

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
      .leftJoin('gl_journal_entries as orig', 'orig.id', 'e.reverses_entry_id')
      .where('l.account_id', taxAccount.id)
      .where('e.status', 'posted')
      .whereBetween('e.entry_date', [start, end])
      .orderBy('e.entry_date', 'asc')
      .orderBy('e.entry_number', 'asc')
      .select(
        conn.raw('e.entry_date::text as entry_date'),
        'e.entry_number',
        'e.source_type',
        'e.idempotency_key',
        'orig.source_type as reversed_source_type',
        'orig.idempotency_key as reversed_idempotency_key',
        'e.memo',
        'l.debit_cents',
        'l.credit_cents',
      ),
  ]);

  const openingPayableCents = naturalBalanceCents(taxAccount, openingRow?.debit_cents, openingRow?.credit_cents);
  const summary = summarizeSalesTaxLines(openingPayableCents, periodRows);

  return {
    from: start,
    to: end,
    basis: 'accrual',
    ...summary,
    entries: periodRows.map((r) => ({
      entry_date: dateCellText(r.entry_date),
      entry_number: Number(r.entry_number),
      source_type: r.source_type,
      reversed_source_type: r.reversed_source_type || null,
      memo: r.memo,
      debit_cents: Number(r.debit_cents),
      credit_cents: Number(r.credit_cents),
    })),
  };
}

function isExcluded1099Payment(row) {
  if (row.paid_by_credit_card) return true;
  const rawMethod = String(row.payment_method || '').trim().toLowerCase();
  const normalizedMethod = (rawMethod === 'credit' || rawMethod === 'credit_card') ? 'card' : rawMethod;
  const text = [row.line_memo, row.entry_memo, row.display_name].filter(Boolean).join(' ');
  const channel = paymentChannel(normalizedMethod, text);
  return EXCLUDED_1099_CHANNELS.has(channel);
}

/**
 * Pure: aggregate 1099-NEC vendor lines while excluding card, debit-card, and
 * third-party platform (Upwork/Fiverr) payments per tax-worksheets.js rules
 * (reported by card networks/platforms on Form 1099-K).
 */
function summarize1099VendorLines(vendorLines, unlinkedLines, thresholdCents) {
  const byVendor = new Map();
  let excluded1099kCount = 0;
  let excluded1099kCents = 0;

  for (const r of vendorLines || []) {
    const netCents = Number(r.debit_cents) - Number(r.credit_cents);
    if (netCents === 0) continue;

    const w9Date = dateCellText(r.w9_received_at);
    const rec = byVendor.get(r.vendor_id) || {
      id: r.vendor_id,
      display_name: r.display_name,
      legal_name: r.legal_name,
      entity_type: r.entity_type,
      w9_on_file: Boolean(w9Date),
      tin_last4: r.tin_last4 || null,
      entryIds: new Set(),
      total_paid_cents: 0,
      excluded_1099k_cents: 0,
    };

    if (isExcluded1099Payment(r)) {
      rec.excluded_1099k_cents += netCents;
      excluded1099kCount += 1;
      excluded1099kCents += netCents;
    } else {
      rec.total_paid_cents += netCents;
      rec.entryIds.add(r.entry_id);
    }
    byVendor.set(r.vendor_id, rec);
  }

  const vendors = [...byVendor.values()]
    .filter((v) => v.total_paid_cents > 0 || v.excluded_1099k_cents > 0)
    .map((v) => ({
      id: v.id,
      display_name: v.display_name,
      legal_name: v.legal_name,
      entity_type: v.entity_type,
      w9_on_file: v.w9_on_file,
      tin_last4: v.tin_last4,
      payment_count: v.entryIds.size,
      total_paid_cents: v.total_paid_cents,
      excluded_1099k_cents: v.excluded_1099k_cents,
      filing_required: v.total_paid_cents >= thresholdCents,
      missing_w9: v.total_paid_cents >= thresholdCents && !v.w9_on_file,
    }))
    .sort((a, b) => b.total_paid_cents - a.total_paid_cents);

  const unlinkedContractorEntries = (unlinkedLines || [])
    .filter((u) => !isExcluded1099Payment(u))
    .map((u) => ({
      entry_id: u.entry_id,
      entry_number: Number(u.entry_number),
      entry_date: dateCellText(u.entry_date),
      memo: u.entry_memo,
      amount_cents: Number(u.debit_cents) - Number(u.credit_cents),
    }))
    .filter((u) => u.amount_cents !== 0);

  const missingW9Count = vendors.filter((v) => v.missing_w9).length;
  return {
    vendors,
    filing_required_count: vendors.filter((v) => v.filing_required).length,
    missing_w9_count: missingW9Count,
    excluded_1099k_count: excluded1099kCount,
    excluded_1099k_cents: excluded1099kCents,
    unlinked_contractor_count: unlinkedContractorEntries.length,
    unlinked_contractor_cents: unlinkedContractorEntries.reduce((s, u) => s + u.amount_cents, 0),
    unlinked_contractor_entries: unlinkedContractorEntries,
    ready_for_filing: missingW9Count === 0 && unlinkedContractorEntries.length === 0,
  };
}

/**
 * 1099-NEC Vendor Payment Summary driven by gl_vendors + gl_journal_lines.
 * Uses $600 threshold through 2025 and $2,000 threshold from 2026 onward (P.L. 119-21).
 * Excludes card, debit-card, and platform (1099-K) payments per tax-worksheets.js rules,
 * and surfaces unlinked non-card Contract Labor (5500) lines missing a vendor_id.
 */
async function get1099VendorSummary({ year = null, conn = db } = {}) {
  const targetYear = parseInt(year, 10) || etParts(new Date()).year;
  if (targetYear < 2020 || targetYear > 2100) throw new AccountingError(400, 'Invalid tax year');
  const thresholdCents = targetYear >= 2026 ? 200000 : 60000;
  const from = `${targetYear}-01-01`;
  const to = `${targetYear}-12-31`;
  const creditCardExistsRaw = conn.raw(
    "EXISTS (SELECT 1 FROM gl_journal_lines cl JOIN gl_accounts ca ON ca.id = cl.account_id WHERE cl.entry_id = e.id AND cl.credit_cents > 0 AND ca.sub_type = 'credit_card') as paid_by_credit_card",
  );

  const [vendorLines, unlinkedLines] = await Promise.all([
    conn('gl_journal_lines as l')
      .join('gl_journal_entries as e', 'e.id', 'l.entry_id')
      .join('gl_accounts as a', 'a.id', 'l.account_id')
      .join('gl_vendors as v', 'v.id', 'l.vendor_id')
      .where('e.status', 'posted')
      .whereBetween('e.entry_date', [from, to])
      .whereIn('a.account_type', ['cogs', 'expense'])
      .where('v.is_1099_eligible', true)
      .select(
        'e.id as entry_id',
        'e.memo as entry_memo',
        'l.memo as line_memo',
        'l.payment_method',
        'l.debit_cents',
        'l.credit_cents',
        'v.id as vendor_id',
        'v.display_name',
        'v.legal_name',
        'v.entity_type',
        conn.raw('v.w9_received_at::text as w9_received_at'),
        'v.tin_last4',
        creditCardExistsRaw,
      ),
    conn('gl_journal_lines as l')
      .join('gl_journal_entries as e', 'e.id', 'l.entry_id')
      .join('gl_accounts as a', 'a.id', 'l.account_id')
      .where('e.status', 'posted')
      .whereBetween('e.entry_date', [from, to])
      .whereNull('l.vendor_id')
      .where((q) => q.where('a.code', SYSTEM_CODES.COGS_SUBCONTRACTORS).orWhere('a.sub_type', 'subcontractors'))
      .orderBy('e.entry_date', 'asc')
      .select(
        'e.id as entry_id',
        'e.entry_number',
        conn.raw('e.entry_date::text as entry_date'),
        'e.memo as entry_memo',
        'l.memo as line_memo',
        'l.payment_method',
        'l.debit_cents',
        'l.credit_cents',
        creditCardExistsRaw,
      ),
  ]);

  return {
    year: targetYear,
    threshold_cents: thresholdCents,
    ...summarize1099VendorLines(vendorLines, unlinkedLines, thresholdCents),
  };
}

/**
 * Pure: aggregate Executive Overview KPI totals across all accounts matching canonical
 * balance-sheet subtypes (so custom checking, savings, credit card, A/R, or payroll
 * liability accounts are always included alongside seeded system accounts).
 */
function summarizeBalanceSheetKpis(balanceSheet) {
  const currentAssets = balanceSheet?.sections?.current_assets || [];
  const currentLiabilities = balanceSheet?.sections?.current_liabilities || [];
  const sumSubTypes = (items, subTypes) => items
    .filter((i) => subTypes.has(i.sub_type))
    .reduce((s, i) => s + (i.amount_cents || 0), 0);

  return {
    cash_total_cents: sumSubTypes(currentAssets, CASH_SUB_TYPES),
    stripe_clearing_cents: sumSubTypes(currentAssets, new Set(['stripe_clearing'])),
    accounts_receivable_cents: sumSubTypes(currentAssets, new Set(['ar'])),
    credit_cards_cents: sumSubTypes(currentLiabilities, new Set(['credit_card'])),
    sales_tax_payable_cents: sumSubTypes(currentLiabilities, new Set(['sales_tax_payable'])),
    unearned_revenue_cents: sumSubTypes(currentLiabilities, new Set(['unearned_revenue'])),
    payroll_liabilities_cents: sumSubTypes(currentLiabilities, new Set(['payroll_liability', 'net_pay_clearing'])),
  };
}

/**
 * Executive Accounting Overview KPIs — single source of truth from GL.
 */
async function getAccountingOverview({ conn = db } = {}) {
  const today = etDateString(new Date());
  const monthStart = `${today.slice(0, 7)}-01`;
  const yearStart = `${today.slice(0, 4)}-01-01`;

  const [trialBalance, balanceSheet, pnlMtd, pnlYtd, periods, entryCountRow, missingSystemAccounts] = await Promise.all([
    getTrialBalance({ asOf: today, conn }),
    getBalanceSheet({ asOf: today, conn }),
    getProfitAndLoss({ from: monthStart, to: today, basis: 'accrual', conn }),
    getProfitAndLoss({ from: yearStart, to: today, basis: 'accrual', conn }),
    conn('gl_periods').orderBy('period_month', 'desc').limit(12).select('*'),
    conn('gl_journal_entries').where({ status: 'posted' }).count('* as count').first(),
    findMissingSystemAccountCodes(conn),
  ]);

  const kpis = summarizeBalanceSheetKpis(balanceSheet);
  const lockedMonths = periods.filter((p) => p.status === 'locked').map((p) => p.period_month);

  return {
    as_of: today,
    posted_entries: Number(entryCountRow?.count || 0),
    trial_balance_ok: trialBalance.balanced,
    balance_sheet_ok: balanceSheet.totals.balanced,
    ...kpis,
    mtd: pnlMtd.totals,
    ytd: pnlYtd.totals,
    locked_through: lockedMonths[0] || null,
    missing_system_accounts: missingSystemAccounts,
  };
}

module.exports = {
  computeTrialBalance,
  computeProfitAndLoss,
  computeBalanceSheet,
  computeCashFlowStatement,
  allocateCashReceiptToRevenue,
  allocateCumulativeCashReceipt,
  buildInvoiceProfileAsOf,
  buildPayrollProfileAsOf,
  allocateCumulativePayrollSettlement,
  summarizeSalesTaxLines,
  summarize1099VendorLines,
  summarizeBalanceSheetKpis,
  getTrialBalance,
  getProfitAndLoss,
  getBalanceSheet,
  getCashFlowStatement,
  getSalesTaxLiabilitySummary,
  get1099VendorSummary,
  getAccountingOverview,
};
