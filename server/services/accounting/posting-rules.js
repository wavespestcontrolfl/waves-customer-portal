/**
 * Pure, deterministic subledger-to-GL journal entry builders.
 *
 * Every money event in Waves Pest Control translates into an exact, balanced,
 * integer-cent double-entry journal payload ready for ledger.postJournalEntry().
 * Zero database calls live here so every accounting rule is 100% unit-testable.
 */

const { SYSTEM_CODES } = require('./coa-seed');
const { AccountingError } = require('./ledger');

const SERVICE_LINE_REVENUE_CODE = {
  pest: SYSTEM_CODES.REV_RESIDENTIAL_PEST,
  mosquito: SYSTEM_CODES.REV_RESIDENTIAL_PEST,
  commercial: SYSTEM_CODES.REV_COMMERCIAL_PEST,
  lawn: SYSTEM_CODES.REV_LAWN_TREE_SHRUB,
  tree_shrub: SYSTEM_CODES.REV_LAWN_TREE_SHRUB,
  termite: SYSTEM_CODES.REV_TERMITE_PROJECTS,
  rodent: SYSTEM_CODES.REV_TERMITE_PROJECTS,
  project: SYSTEM_CODES.REV_TERMITE_PROJECTS,
};

function revenueAccountCodeFor(serviceLine, isCommercial = false) {
  if (isCommercial) return SYSTEM_CODES.REV_COMMERCIAL_PEST;
  const key = String(serviceLine || '').trim().toLowerCase();
  return SERVICE_LINE_REVENUE_CODE[key] || SYSTEM_CODES.REV_OTHER;
}

function posInt(value, field) {
  const n = Math.trunc(Number(value));
  if (!Number.isSafeInteger(n) || n < 0) {
    throw new AccountingError(400, `${field} must be a non-negative integer in cents`);
  }
  return n;
}

/**
 * 1. Customer Invoice Issued (Accrual Revenue + FL Sales Tax Payable).
 *    - Standard service invoice: DR 1100 A/R / CR 4xxx Revenue + CR 2100 FL Sales Tax Payable
 *    - Annual prepay invoice:    DR 1100 A/R / CR 2300 Unearned Revenue + CR 2100 FL Sales Tax Payable
 */
function buildInvoiceEntry({
  invoiceId,
  invoiceNumber = null,
  issueDate,
  subtotalCents,
  taxCents = 0,
  serviceLine = 'pest',
  isCommercial = false,
  isAnnualPrepay = false,
  customerId = null,
}) {
  const sub = posInt(subtotalCents, 'subtotalCents');
  const tax = posInt(taxCents, 'taxCents');
  const total = sub + tax;
  if (total <= 0) throw new AccountingError(400, 'Invoice total must be greater than $0');

  const lines = [
    { accountCode: SYSTEM_CODES.ACCOUNTS_RECEIVABLE, debitCents: total, creditCents: 0, customerId, serviceLine },
  ];
  if (sub > 0) {
    lines.push({
      accountCode: isAnnualPrepay ? SYSTEM_CODES.UNEARNED_REVENUE : revenueAccountCodeFor(serviceLine, isCommercial),
      debitCents: 0,
      creditCents: sub,
      customerId,
      serviceLine,
    });
  }
  if (tax > 0) {
    lines.push({
      accountCode: SYSTEM_CODES.SALES_TAX_PAYABLE,
      debitCents: 0,
      creditCents: tax,
      customerId,
      serviceLine,
    });
  }

  return {
    entryDate: issueDate,
    entryType: 'operational',
    basisScope: 'accrual_only',
    sourceType: 'invoice',
    sourceId: String(invoiceId),
    idempotencyKey: `invoice:${invoiceId}`,
    reference: invoiceNumber || String(invoiceId),
    memo: `${isAnnualPrepay ? 'Annual prepay invoice' : 'Invoice'} ${invoiceNumber || invoiceId}`,
    lines,
  };
}

/**
 * 2. Monthly/Visit Recognition of Unearned Revenue (Annual Prepays / Deposits).
 *    DR 2300 Unearned Revenue / CR 4xxx Service Revenue
 */
function buildUnearnedRecognitionEntry({
  sourceId,
  recognitionDate,
  amountCents,
  serviceLine = 'pest',
  isCommercial = false,
  customerId = null,
  memo = null,
}) {
  const amt = posInt(amountCents, 'amountCents');
  if (amt <= 0) throw new AccountingError(400, 'Recognition amount must be > 0');
  return {
    entryDate: recognitionDate,
    entryType: 'adjusting',
    basisScope: 'accrual_only',
    sourceType: 'unearned_recognition',
    sourceId: String(sourceId),
    idempotencyKey: `unearned-rec:${sourceId}:${recognitionDate}`,
    memo: memo || `Recognize earned service revenue (${serviceLine})`,
    lines: [
      { accountCode: SYSTEM_CODES.UNEARNED_REVENUE, debitCents: amt, creditCents: 0, customerId, serviceLine },
      { accountCode: revenueAccountCodeFor(serviceLine, isCommercial), debitCents: 0, creditCents: amt, customerId, serviceLine },
    ],
  };
}

/**
 * 3. Customer Payment Captured (Stripe, Zelle, Check, Cash, or Estimate Deposit).
 *    - Stripe capture: DR 1050 Stripe Clearing (net) + DR 5400 Merchant Fees (fee) / CR 1100 A/R (gross)
 *    - Zelle/Check/Cash: DR 1010 Checking (or 1060 Undeposited Funds) / CR 1100 A/R
 *    - Estimate Deposit (unbilled): credits 2300 Unearned Revenue instead of A/R.
 *    - Cash-basis companion line isn't needed when reports read payment-settled rows;
 *      standard payment posts with basisScope: 'both' (balance sheet cash + A/R clearing + real fee).
 */
function buildPaymentEntry({
  paymentId,
  paymentDate,
  grossCents,
  feeCents = 0,
  method = 'stripe',
  isDeposit = false,
  customerId = null,
  serviceLine = null,
  reference = null,
}) {
  const gross = posInt(grossCents, 'grossCents');
  const fee = posInt(feeCents, 'feeCents');
  if (gross <= 0) throw new AccountingError(400, 'Payment grossCents must be > 0');
  if (fee >= gross) throw new AccountingError(400, 'Processing fee cannot equal or exceed gross payment');

  const net = gross - fee;
  const methodKey = String(method || 'stripe').toLowerCase();
  let cashAccount = SYSTEM_CODES.STRIPE_CLEARING;
  if (methodKey === 'zelle' || methodKey === 'ach_direct') cashAccount = SYSTEM_CODES.CHECKING_PRIMARY;
  else if (methodKey === 'check' || methodKey === 'cash') cashAccount = SYSTEM_CODES.UNDEPOSITED_FUNDS;

  const creditAccount = isDeposit ? SYSTEM_CODES.UNEARNED_REVENUE : SYSTEM_CODES.ACCOUNTS_RECEIVABLE;
  const lines = [
    { accountCode: cashAccount, debitCents: net, creditCents: 0, customerId, serviceLine },
  ];
  if (fee > 0) {
    lines.push({ accountCode: SYSTEM_CODES.COGS_MERCHANT_FEES, debitCents: fee, creditCents: 0, customerId, serviceLine });
  }
  lines.push({ accountCode: creditAccount, debitCents: 0, creditCents: gross, customerId, serviceLine });

  return {
    entryDate: paymentDate,
    entryType: 'operational',
    basisScope: 'both',
    sourceType: 'payment',
    sourceId: String(paymentId),
    idempotencyKey: `payment:${paymentId}`,
    reference: reference || String(paymentId),
    memo: `${isDeposit ? 'Customer deposit' : 'Customer payment'} via ${methodKey}`,
    lines,
  };
}

/**
 * 4. Customer Refund / Dispute Reversal (properly reverses pass-through FL sales tax too).
 *    DR 4090 Refunds & Allowances (net of tax) + DR 2100 FL Sales Tax Payable (tax portion)
 *    / CR 1050 Stripe Clearing (or 1010 Checking)
 */
function buildRefundEntry({
  refundId,
  refundDate,
  subtotalCents,
  taxCents = 0,
  method = 'stripe',
  customerId = null,
  serviceLine = null,
  reference = null,
  reason = 'Customer refund',
}) {
  const sub = posInt(subtotalCents, 'subtotalCents');
  const tax = posInt(taxCents, 'taxCents');
  const total = sub + tax;
  if (total <= 0) throw new AccountingError(400, 'Refund total must be > 0');

  const cashAccount = String(method || 'stripe').toLowerCase() === 'stripe'
    ? SYSTEM_CODES.STRIPE_CLEARING
    : SYSTEM_CODES.CHECKING_PRIMARY;

  const lines = [];
  if (sub > 0) {
    lines.push({ accountCode: SYSTEM_CODES.REV_REFUNDS_ALLOWANCES, debitCents: sub, creditCents: 0, customerId, serviceLine });
  }
  if (tax > 0) {
    lines.push({ accountCode: SYSTEM_CODES.SALES_TAX_PAYABLE, debitCents: tax, creditCents: 0, customerId, serviceLine });
  }
  lines.push({ accountCode: cashAccount, debitCents: 0, creditCents: total, customerId, serviceLine });

  return {
    entryDate: refundDate,
    entryType: 'operational',
    basisScope: 'both',
    sourceType: 'refund',
    sourceId: String(refundId),
    idempotencyKey: `refund:${refundId}`,
    reference: reference || String(refundId),
    memo: reason,
    lines,
  };
}

/**
 * 5. Stripe Payout Settled to Operating Bank Account.
 *    DR 1010 Checking / CR 1050 Stripe Clearing (zero P&L impact — pure balance-sheet settlement).
 */
function buildStripePayoutEntry({
  payoutId,
  arrivalDate,
  amountCents,
  bankAccountCode = SYSTEM_CODES.CHECKING_PRIMARY,
  bankTransactionId = null,
  reference = null,
}) {
  const amt = posInt(amountCents, 'amountCents');
  if (amt <= 0) throw new AccountingError(400, 'Payout amount must be > 0');

  return {
    entryDate: arrivalDate,
    entryType: 'transfer',
    basisScope: 'both',
    sourceType: 'stripe_payout',
    sourceId: String(payoutId),
    idempotencyKey: `stripe-payout:${payoutId}`,
    reference: reference || String(payoutId),
    memo: `Stripe payout settled to bank (${reference || payoutId})`,
    lines: [
      { accountCode: bankAccountCode, debitCents: amt, creditCents: 0, bankTransactionId },
      { accountCode: SYSTEM_CODES.STRIPE_CLEARING, debitCents: 0, creditCents: amt },
    ],
  };
}

/**
 * 6. Expense / Split Purchase / Shared Bill / Loan Payment.
 *    Supports arbitrary split lines (e.g. loan principal to 2500 + interest to 6610 Line 16b,
 *    or shared bill business-% to expense + personal-% to 3100 Owner Draws).
 */
function buildExpenseEntry({
  sourceType = 'expense',
  sourceId,
  entryDate,
  paymentAccountCode = SYSTEM_CODES.CHECKING_PRIMARY,
  paymentAccountId = null,
  splits,
  vendorId = null,
  bankTransactionId = null,
  memo,
  reference = null,
}) {
  if (!Array.isArray(splits) || splits.length === 0) {
    throw new AccountingError(400, 'At least one expense split line is required');
  }
  let total = 0;
  const debitLines = splits.map((s, idx) => {
    const amt = posInt(s.amountCents, `splits[${idx}].amountCents`);
    if (amt <= 0) throw new AccountingError(400, `splits[${idx}].amountCents must be > 0`);
    total += amt;
    return {
      accountId: s.accountId || null,
      accountCode: s.accountId ? null : (s.accountCode || SYSTEM_CODES.OPEX_UNCATEGORIZED),
      debitCents: amt,
      creditCents: 0,
      vendorId: s.vendorId || vendorId,
      serviceLine: s.serviceLine || null,
      scheduledServiceId: s.scheduledServiceId || null,
      memo: s.memo || null,
    };
  });

  const creditLine = {
    accountId: paymentAccountId || null,
    accountCode: paymentAccountId ? null : paymentAccountCode,
    debitCents: 0,
    creditCents: total,
    vendorId,
    bankTransactionId,
  };

  return {
    entryDate,
    entryType: 'operational',
    basisScope: 'both',
    sourceType,
    sourceId: String(sourceId),
    idempotencyKey: `${sourceType}:${sourceId}`,
    reference: reference || String(sourceId),
    memo: memo || 'Business expense',
    lines: [...debitLines, creditLine],
  };
}

/**
 * 7. Internal Bank Transfer or Credit Card Payment (zero P&L impact!).
 *    - Bank -> Mercury: DR 1020 Mercury / CR 1010 Checking
 *    - Checking -> Credit Card payment: DR 2000 Credit Card / CR 1010 Checking
 */
function buildTransferEntry({
  sourceId,
  entryDate,
  amountCents,
  fromAccountId = null,
  fromAccountCode = SYSTEM_CODES.CHECKING_PRIMARY,
  toAccountId = null,
  toAccountCode = SYSTEM_CODES.CREDIT_CARD_PRIMARY,
  bankTransactionId = null,
  memo = 'Internal account transfer',
  reference = null,
}) {
  const amt = posInt(amountCents, 'amountCents');
  if (amt <= 0) throw new AccountingError(400, 'Transfer amount must be > 0');
  if ((fromAccountId && toAccountId && fromAccountId === toAccountId)
    || (!fromAccountId && !toAccountId && fromAccountCode === toAccountCode)) {
    throw new AccountingError(400, 'Transfer source and destination accounts must differ');
  }

  return {
    entryDate,
    entryType: 'transfer',
    basisScope: 'both',
    sourceType: 'bank_transaction',
    sourceId: String(sourceId),
    idempotencyKey: `transfer:${sourceId}`,
    reference: reference || null,
    memo,
    lines: [
      { accountId: toAccountId, accountCode: toAccountId ? null : toAccountCode, debitCents: amt, creditCents: 0 },
      { accountId: fromAccountId, accountCode: fromAccountId ? null : fromAccountCode, debitCents: 0, creditCents: amt, bankTransactionId },
    ],
  };
}

/**
 * 8. Florida DOR Sales Tax Remittance (DR-15).
 *    DR 2100 FL Sales Tax Payable / CR 1010 Checking.
 *    NEVER hits Schedule C Line 23 — eliminates the sales-tax double-deduction trap.
 */
function buildSalesTaxRemittanceEntry({
  sourceId,
  paymentDate,
  amountCents,
  periodLabel = '',
  bankAccountCode = SYSTEM_CODES.CHECKING_PRIMARY,
  bankTransactionId = null,
}) {
  const amt = posInt(amountCents, 'amountCents');
  if (amt <= 0) throw new AccountingError(400, 'Sales tax remittance must be > 0');
  return {
    entryDate: paymentDate,
    entryType: 'operational',
    basisScope: 'both',
    sourceType: 'bank_transaction',
    sourceId: String(sourceId),
    idempotencyKey: `sales-tax-remit:${sourceId}`,
    reference: periodLabel || String(sourceId),
    memo: `FL DOR DR-15 sales tax remittance${periodLabel ? ` (${periodLabel})` : ''}`,
    lines: [
      { accountCode: SYSTEM_CODES.SALES_TAX_PAYABLE, debitCents: amt, creditCents: 0 },
      { accountCode: bankAccountCode, debitCents: 0, creditCents: amt, bankTransactionId },
    ],
  };
}

/**
 * 9. W-2 Payroll Run Finalized.
 *    Properly separates Field Tech Wages/Taxes (COGS 5100/5110) from Office/Admin Wages/Taxes (OpEx 6100/6110),
 *    books employer SIMPLE IRA (6130, Line 19) and HSA (6120, Line 14), and accrues liabilities to 2200/2210/2290.
 */
function buildPayrollRunEntry(input = {}) {
  const fieldGross = posInt(input.fieldGrossCents ?? 0, 'fieldGrossCents');
  const adminGross = posInt(input.adminGrossCents ?? 0, 'adminGrossCents');
  const fieldErTax = posInt(input.fieldEmployerTaxCents ?? 0, 'fieldEmployerTaxCents');
  const adminErTax = posInt(input.adminEmployerTaxCents ?? 0, 'adminEmployerTaxCents');
  const empTax = posInt(input.employeeTaxWithheldCents ?? 0, 'employeeTaxWithheldCents');
  const empSimple = posInt(input.employeeSimpleDeferralCents ?? 0, 'employeeSimpleDeferralCents');
  const erSimple = posInt(input.employerSimpleCents ?? 0, 'employerSimpleCents');
  const erHsa = posInt(input.employerHsaCents ?? 0, 'employerHsaCents');
  const netPay = posInt(input.netPayCents ?? 0, 'netPayCents');

  const debitPairs = [
    [SYSTEM_CODES.COGS_FIELD_WAGES, fieldGross],
    [SYSTEM_CODES.OPEX_OFFICE_WAGES, adminGross],
    [SYSTEM_CODES.COGS_FIELD_PAYROLL_TAX, fieldErTax],
    [SYSTEM_CODES.OPEX_OFFICE_PAYROLL_TAX, adminErTax],
    [SYSTEM_CODES.OPEX_RETIREMENT_SIMPLE, erSimple],
    [SYSTEM_CODES.OPEX_EMPLOYEE_BENEFITS, erHsa],
  ];
  const creditPairs = [
    [SYSTEM_CODES.NET_PAY_CLEARING, netPay],
    [SYSTEM_CODES.PAYROLL_TAX_LIABILITIES, empTax + fieldErTax + adminErTax],
    [SYSTEM_CODES.PAYROLL_BENEFITS_PAYABLE, empSimple + erSimple + erHsa],
  ];

  const lines = [
    ...debitPairs.filter(([, amt]) => amt > 0).map(([accountCode, debitCents]) => ({ accountCode, debitCents, creditCents: 0 })),
    ...creditPairs.filter(([, amt]) => amt > 0).map(([accountCode, creditCents]) => ({ accountCode, debitCents: 0, creditCents })),
  ];
  const weekLabel = input.weekLabel || '';

  return {
    entryDate: input.payDate,
    entryType: 'operational',
    basisScope: 'both',
    sourceType: 'payroll_run',
    sourceId: String(input.runId),
    idempotencyKey: `payroll-run:${input.runId}`,
    reference: weekLabel || String(input.runId),
    memo: `Payroll run${weekLabel ? ` (${weekLabel})` : ''}`,
    lines,
  };
}

/**
 * 10. Payroll Settlement (Mercury Net Pay ACH, EFTPS 941/940, FL RT-6, Schwab SIMPLE/HSA).
 */
function buildPayrollSettlementEntry({
  sourceId,
  settlementDate,
  kind, // 'net_pay' | 'tax_remit' | 'benefits_remit'
  amountCents,
  bankAccountCode = SYSTEM_CODES.CHECKING_PAYROLL,
  bankTransactionId = null,
  memo = null,
}) {
  const amt = posInt(amountCents, 'amountCents');
  if (amt <= 0) throw new AccountingError(400, 'Settlement amount must be > 0');

  const liabilityByKind = {
    net_pay: SYSTEM_CODES.NET_PAY_CLEARING,
    tax_remit: SYSTEM_CODES.PAYROLL_TAX_LIABILITIES,
    benefits_remit: SYSTEM_CODES.PAYROLL_BENEFITS_PAYABLE,
  };
  const liabilityCode = liabilityByKind[kind];
  if (!liabilityCode) throw new AccountingError(400, `Unknown payroll settlement kind: ${kind}`);

  return {
    entryDate: settlementDate,
    entryType: 'operational',
    basisScope: 'both',
    sourceType: 'payroll_remittance',
    sourceId: String(sourceId),
    idempotencyKey: `payroll-settle:${kind}:${sourceId}`,
    memo: memo || `Payroll ${kind.replace('_', ' ')} settlement`,
    lines: [
      { accountCode: liabilityCode, debitCents: amt, creditCents: 0 },
      { accountCode: bankAccountCode, debitCents: 0, creditCents: amt, bankTransactionId },
    ],
  };
}

/**
 * 11. Period Depreciation Entry (Non-Cash).
 *     DR 6700 Depreciation Expense / CR 1590 Accumulated Depreciation
 */
function buildDepreciationEntry({ sourceId, entryDate, amountCents, assetName = '' }) {
  const amt = posInt(amountCents, 'amountCents');
  if (amt <= 0) throw new AccountingError(400, 'Depreciation amount must be > 0');
  return {
    entryDate,
    entryType: 'depreciation',
    basisScope: 'both',
    sourceType: 'equipment_depreciation',
    sourceId: String(sourceId),
    idempotencyKey: `depreciation:${sourceId}:${entryDate}`,
    memo: `Depreciation${assetName ? ` — ${assetName}` : ''}`,
    lines: [
      { accountCode: SYSTEM_CODES.OPEX_DEPRECIATION, debitCents: amt, creditCents: 0 },
      { accountCode: SYSTEM_CODES.ACCUM_DEPRECIATION, debitCents: 0, creditCents: amt },
    ],
  };
}

/**
 * 12. Cutover Opening Balance Entry.
 *     Takes account opening balances ({ accountCode, balanceCents, normalBalance }) and
 *     automatically plugs the net difference to 3000 Owner Opening Balance Equity.
 */
function buildOpeningBalanceEntry({ asOfDate, items, memo = null }) {
  if (!Array.isArray(items) || items.length === 0) {
    throw new AccountingError(400, 'At least one opening balance item is required');
  }
  const lines = [];
  let netDebits = 0;
  let netCredits = 0;

  for (const item of items) {
    const raw = Math.trunc(Number(item.balanceCents) || 0);
    if (raw === 0) continue;
    const isDebit = item.normalBalance === 'debit';
    const debitCents = (isDebit && raw > 0) || (!isDebit && raw < 0) ? Math.abs(raw) : 0;
    const creditCents = debitCents === 0 ? Math.abs(raw) : 0;
    netDebits += debitCents;
    netCredits += creditCents;
    lines.push({
      accountId: item.accountId || null,
      accountCode: item.accountId ? null : item.accountCode,
      debitCents,
      creditCents,
      memo: 'Opening balance',
    });
  }

  const plug = netDebits - netCredits;
  if (plug !== 0) {
    lines.push({
      accountCode: SYSTEM_CODES.OWNER_EQUITY,
      debitCents: plug < 0 ? Math.abs(plug) : 0,
      creditCents: plug > 0 ? plug : 0,
      memo: 'Opening Balance Equity plug',
    });
  }

  return {
    entryDate: asOfDate,
    entryType: 'opening_balance',
    basisScope: 'both',
    sourceType: 'opening_balance',
    sourceId: asOfDate,
    idempotencyKey: `opening-balance:${asOfDate}`,
    memo: memo || `Opening balances as of ${asOfDate}`,
    lines,
  };
}

module.exports = {
  revenueAccountCodeFor,
  buildInvoiceEntry,
  buildUnearnedRecognitionEntry,
  buildPaymentEntry,
  buildRefundEntry,
  buildStripePayoutEntry,
  buildExpenseEntry,
  buildTransferEntry,
  buildSalesTaxRemittanceEntry,
  buildPayrollRunEntry,
  buildPayrollSettlementEntry,
  buildDepreciationEntry,
  buildOpeningBalanceEntry,
};
