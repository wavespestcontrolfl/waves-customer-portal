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
  dateCellText,
  dollarsToCents,
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

function addSignedRevenue(sumsMap, accountId, signedCents) {
  if (!accountId || !signedCents) return;
  const prev = sumsMap.get(accountId) || { debitCents: 0, creditCents: 0 };
  if (signedCents > 0) {
    sumsMap.set(accountId, { debitCents: prev.debitCents, creditCents: prev.creditCents + signedCents });
  } else {
    sumsMap.set(accountId, { debitCents: prev.debitCents + Math.abs(signedCents), creditCents: prev.creditCents });
  }
}

/**
 * Pure: allocate a signed A/R or Unearned-Revenue receipt (positive for payment,
 * negative for payment reversal) into pre-tax service revenue accounts, excluding
 * any Florida sales tax embedded in the linked invoice (including partial payments).
 */
function allocateCashReceiptToRevenue(signedReceiptCents, invoiceProfile, fallbackServiceLine, revIdByCode) {
  const { revenueAccountCodeFor } = require('./posting-rules');
  const signed = Math.trunc(Number(signedReceiptCents) || 0);
  if (signed === 0) return [];

  const sign = signed >= 0 ? 1 : -1;
  const absReceipt = Math.abs(signed);
  const fallbackCode = revenueAccountCodeFor(fallbackServiceLine, fallbackServiceLine === 'commercial');
  const fallbackRevId = revIdByCode.get(fallbackCode) || revIdByCode.get(SYSTEM_CODES.REV_OTHER) || null;

  if (!invoiceProfile || !(invoiceProfile.arDebitedCents > 0)) {
    return fallbackRevId ? [{ accountId: fallbackRevId, signedCents: signed }] : [];
  }

  const denom = invoiceProfile.arDebitedCents;
  const arTax = Math.min(Math.max(0, invoiceProfile.taxCents || 0), denom);
  const arRevenue = Math.max(0, denom - arTax);
  const revenuePortion = Math.round((absReceipt * arRevenue) / denom);
  if (revenuePortion <= 0) return [];

  const splits = (invoiceProfile.revenueSplits || []).filter((s) => s.accountId && s.amountCents > 0);
  if (!splits.length) {
    return fallbackRevId ? [{ accountId: fallbackRevId, signedCents: sign * revenuePortion }] : [];
  }
  if (splits.length === 1) {
    return [{ accountId: splits[0].accountId, signedCents: sign * revenuePortion }];
  }

  const splitTotal = splits.reduce((sum, s) => sum + s.amountCents, 0);
  const out = [];
  let allocated = 0;
  for (let i = 0; i < splits.length; i += 1) {
    const part = i === splits.length - 1
      ? revenuePortion - allocated
      : Math.round((revenuePortion * splits[i].amountCents) / splitTotal);
    allocated += part;
    if (part > 0) out.push({ accountId: splits[i].accountId, signedCents: sign * part });
  }
  return out;
}

async function loadInvoiceProfilesForCashBasis(conn, invoiceRefs, revIdByCode) {
  const profiles = new Map();
  if (!invoiceRefs.length) return profiles;

  const glLines = await conn('gl_journal_lines as l')
    .join('gl_journal_entries as e', 'e.id', 'l.entry_id')
    .join('gl_accounts as a', 'a.id', 'l.account_id')
    .where('e.status', 'posted')
    .where('e.source_type', 'invoice')
    .whereIn('e.source_id', invoiceRefs)
    .select('e.source_id', 'a.id as account_id', 'a.code', 'a.account_type', 'l.debit_cents', 'l.credit_cents');

  for (const r of glLines) {
    const key = String(r.source_id);
    const prof = profiles.get(key) || { arDebitedCents: 0, taxCents: 0, revenueSplits: [] };
    if (r.code === SYSTEM_CODES.ACCOUNTS_RECEIVABLE) prof.arDebitedCents += Number(r.debit_cents);
    if (r.code === SYSTEM_CODES.SALES_TAX_PAYABLE) prof.taxCents += Number(r.credit_cents);
    if (r.account_type === 'revenue' && Number(r.credit_cents) > 0) {
      prof.revenueSplits.push({ accountId: r.account_id, amountCents: Number(r.credit_cents) });
    }
    profiles.set(key, prof);
  }

  // Fallback for payments referencing pre-cutover invoices not yet posted as GL invoice JEs.
  const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const missingUuids = invoiceRefs.filter((ref) => !profiles.has(ref) && uuidRe.test(ref));
  if (missingUuids.length && (await conn.schema.hasTable('invoices'))) {
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
  return profiles;
}

/**
 * Cash-basis revenue helper: on cash basis, revenue is recognized when payments settle
 * (clearing 1100 A/R or 2300 Unearned Revenue), EXCLUDING collected Florida sales tax
 * via the linked invoice's service/tax split (including partial payments), and including
 * signed payment reversals on their reversal posting date.
 */
async function queryCashBasisSums(conn, { from, to }) {
  const baseSums = await queryAccountSums(conn, { from, to, basis: 'cash' });

  const activityRows = await conn('gl_journal_lines as l')
    .join('gl_journal_entries as e', 'e.id', 'l.entry_id')
    .leftJoin('gl_journal_entries as orig', 'orig.id', 'e.reverses_entry_id')
    .join('gl_accounts as a', 'a.id', 'l.account_id')
    .where('e.status', 'posted')
    .where('e.entry_date', '>=', from)
    .where('e.entry_date', '<=', to)
    .whereIn('a.code', [SYSTEM_CODES.ACCOUNTS_RECEIVABLE, SYSTEM_CODES.UNEARNED_REVENUE])
    .where((q) => {
      q.where('e.source_type', 'payment')
        .orWhere((rev) => rev.where('e.source_type', 'reversal').where('orig.source_type', 'payment'));
    })
    .select(
      'l.invoice_ref',
      'l.service_line',
      'a.code as account_code',
      'l.debit_cents',
      'l.credit_cents',
    );

  if (!activityRows.length) return baseSums;

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
  const invoiceProfiles = await loadInvoiceProfilesForCashBasis(conn, invoiceRefs, revIdByCode);

  for (const row of activityRows) {
    const signedCents = Number(row.credit_cents) - Number(row.debit_cents);
    if (signedCents === 0) continue;
    const profile = row.account_code === SYSTEM_CODES.ACCOUNTS_RECEIVABLE && row.invoice_ref
      ? invoiceProfiles.get(String(row.invoice_ref))
      : null;
    const allocations = allocateCashReceiptToRevenue(signedCents, profile, row.service_line, revIdByCode);
    for (const alloc of allocations) {
      addSignedRevenue(baseSums, alloc.accountId, alloc.signedCents);
    }
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

/**
 * 1099-NEC Vendor Payment Summary driven by gl_vendors + gl_journal_lines.
 * Uses $600 threshold through 2025 and $2,000 threshold from 2026 onward (P.L. 119-21).
 * Also surfaces any unlinked Contract Labor (5500) lines missing a vendor_id so
 * filing readiness never silently omits contractor spend.
 */
async function get1099VendorSummary({ year = null, conn = db } = {}) {
  const targetYear = parseInt(year, 10) || etParts(new Date()).year;
  if (targetYear < 2020 || targetYear > 2100) throw new AccountingError(400, 'Invalid tax year');
  const thresholdCents = targetYear >= 2026 ? 200000 : 60000;
  const from = `${targetYear}-01-01`;
  const to = `${targetYear}-12-31`;

  const [rows, unlinkedRows] = await Promise.all([
    conn('gl_journal_lines as l')
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
        conn.raw('v.w9_received_at::text as w9_received_at'),
        'v.tin_last4',
        conn.raw('COALESCE(SUM(l.debit_cents - l.credit_cents), 0)::bigint as total_paid_cents'),
        conn.raw('COUNT(DISTINCT e.id)::int as payment_count'),
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
        'e.memo',
        'l.debit_cents',
        'l.credit_cents',
      ),
  ]);

  const vendors = rows
    .map((r) => {
      const paid = Number(r.total_paid_cents);
      const w9Date = dateCellText(r.w9_received_at);
      return {
        id: r.id,
        display_name: r.display_name,
        legal_name: r.legal_name,
        entity_type: r.entity_type,
        w9_on_file: Boolean(w9Date),
        tin_last4: r.tin_last4 || null,
        payment_count: Number(r.payment_count),
        total_paid_cents: paid,
        filing_required: paid >= thresholdCents,
        missing_w9: paid >= thresholdCents && !w9Date,
      };
    })
    .sort((a, b) => b.total_paid_cents - a.total_paid_cents);

  const unlinkedContractorEntries = (unlinkedRows || []).map((u) => ({
    entry_id: u.entry_id,
    entry_number: Number(u.entry_number),
    entry_date: dateCellText(u.entry_date),
    memo: u.memo,
    amount_cents: Number(u.debit_cents) - Number(u.credit_cents),
  })).filter((u) => u.amount_cents !== 0);

  const missingW9Count = vendors.filter((v) => v.missing_w9).length;
  const unlinkedCents = unlinkedContractorEntries.reduce((s, u) => s + u.amount_cents, 0);

  return {
    year: targetYear,
    threshold_cents: thresholdCents,
    vendors,
    filing_required_count: vendors.filter((v) => v.filing_required).length,
    missing_w9_count: missingW9Count,
    unlinked_contractor_count: unlinkedContractorEntries.length,
    unlinked_contractor_cents: unlinkedCents,
    unlinked_contractor_entries: unlinkedContractorEntries,
    ready_for_filing: missingW9Count === 0 && unlinkedContractorEntries.length === 0,
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
  allocateCashReceiptToRevenue,
  summarizeSalesTaxLines,
  getTrialBalance,
  getProfitAndLoss,
  getBalanceSheet,
  getCashFlowStatement,
  getSalesTaxLiabilitySummary,
  get1099VendorSummary,
  getAccountingOverview,
};
