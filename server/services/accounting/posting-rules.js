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
  if (!key) return SYSTEM_CODES.REV_OTHER;
  if (SERVICE_LINE_REVENUE_CODE[key]) return SERVICE_LINE_REVENUE_CODE[key];
  if (/\bcommercial\b|\bbusiness\b|\bhoa\b|\bproperty\s+m(?:ana)?g(?:emen)?t\b/.test(key)) {
    return SYSTEM_CODES.REV_COMMERCIAL_PEST;
  }
  if (/\btermite\b|\bwdo\b|\btrench|\bbait\s*station|\brodent\b|\bexclusion\b|\btrapping\b|\bproject\b|\bwildlife\b|\binsulation\b/.test(key)) {
    return SYSTEM_CODES.REV_TERMITE_PROJECTS;
  }
  if (/\blawn\b|\bturf\b|\bshrub\b|\btree\b|\bpalm\b|\bornamental\b|\bfertiliz|\bweed\b|\bchinch\b/.test(key)) {
    return SYSTEM_CODES.REV_LAWN_TREE_SHRUB;
  }
  if (/\bpest\b|\bmosquito\b|\bant\b|\broach\b|\bflea\b|\btick\b|\bspider\b|\bwasp\b|\bwaveguard\b|\bquarterly\b|\bbi-?monthly\b|\bgeneral\b/.test(key)) {
    return SYSTEM_CODES.REV_RESIDENTIAL_PEST;
  }
  return SYSTEM_CODES.REV_OTHER;
}

function posInt(value, field) {
  const n = Math.trunc(Number(value));
  if (!Number.isSafeInteger(n) || n < 0) {
    throw new AccountingError(400, `${field} must be a non-negative integer in cents`);
  }
  return n;
}

/**
 * 1. Customer Invoice Issued (Accrual Revenue + FL Sales Tax Payable + Deposit/Credit Release).
 *    - Standard invoice:         DR 1100 A/R / CR 4xxx Revenue + CR 2100 FL Sales Tax Payable
 *    - Applied estimate deposit: DR 1100 A/R (remaining due) + DR 2300 Unearned Revenue (deposit)
 *                                / CR 4xxx full pre-tax Revenue + CR 2100 FL Sales Tax Payable
 *    - Applied account credit:   DR 2350 Customer Credits reduces A/R billed
 *    - Annual prepay invoice:    DR 1100 A/R / CR 2300 Unearned Revenue + CR 2100 FL Sales Tax Payable
 */
function buildInvoiceEntry({
  invoiceId,
  invoiceNumber = null,
  issueDate,
  subtotalCents,
  taxCents = 0,
  appliedDepositCents = 0,
  appliedCreditCents = 0,
  serviceLine = 'pest',
  isCommercial = false,
  isAnnualPrepay = false,
  customerId = null,
}) {
  const sub = posInt(subtotalCents, 'subtotalCents');
  const tax = posInt(taxCents, 'taxCents');
  const deposit = posInt(appliedDepositCents, 'appliedDepositCents');
  const credit = posInt(appliedCreditCents, 'appliedCreditCents');
  const total = sub + tax;
  if (total <= 0) throw new AccountingError(400, 'Invoice total must be greater than $0');
  if (deposit + credit > total) {
    throw new AccountingError(400, 'Applied deposit and customer credit cannot exceed invoice total');
  }

  const invoiceRef = String(invoiceId);
  const arCents = total - deposit - credit;
  const lines = [];
  if (arCents > 0) {
    lines.push({
      accountCode: SYSTEM_CODES.ACCOUNTS_RECEIVABLE,
      debitCents: arCents,
      creditCents: 0,
      customerId,
      serviceLine,
      invoiceRef,
    });
  }
  if (deposit > 0) {
    lines.push({
      accountCode: SYSTEM_CODES.UNEARNED_REVENUE,
      debitCents: deposit,
      creditCents: 0,
      customerId,
      serviceLine,
      invoiceRef,
      memo: 'Apply estimate deposit credit',
    });
  }
  if (credit > 0) {
    lines.push({
      accountCode: SYSTEM_CODES.CUSTOMER_CREDITS,
      debitCents: credit,
      creditCents: 0,
      customerId,
      serviceLine,
      invoiceRef,
      memo: 'Apply customer account credit',
    });
  }
  if (sub > 0) {
    lines.push({
      accountCode: isAnnualPrepay ? SYSTEM_CODES.UNEARNED_REVENUE : revenueAccountCodeFor(serviceLine, isCommercial),
      debitCents: 0,
      creditCents: sub,
      customerId,
      serviceLine,
      invoiceRef,
    });
  }
  if (tax > 0) {
    lines.push({
      accountCode: SYSTEM_CODES.SALES_TAX_PAYABLE,
      debitCents: 0,
      creditCents: tax,
      customerId,
      serviceLine,
      invoiceRef,
    });
  }

  return {
    entryDate: issueDate,
    entryType: 'operational',
    basisScope: 'accrual_only',
    sourceType: 'invoice',
    sourceId: invoiceRef,
    idempotencyKey: `invoice:${invoiceId}`,
    reference: invoiceNumber || invoiceRef,
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
  idempotencyKey = null,
  recognitionDate,
  amountCents,
  serviceLine = 'pest',
  isCommercial = false,
  customerId = null,
  scheduledServiceId = null,
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
    idempotencyKey: idempotencyKey || `unearned-rec:${sourceId}:${recognitionDate}`,
    memo: memo || `Recognize earned service revenue (${serviceLine})`,
    lines: [
      { accountCode: SYSTEM_CODES.UNEARNED_REVENUE, debitCents: amt, creditCents: 0, customerId, serviceLine, scheduledServiceId },
      { accountCode: revenueAccountCodeFor(serviceLine, isCommercial), debitCents: 0, creditCents: amt, customerId, serviceLine, scheduledServiceId },
    ],
  };
}

function cashAccountForPaymentMethod(methodKey) {
  if (methodKey === 'zelle' || methodKey === 'ach_direct') return SYSTEM_CODES.CHECKING_PRIMARY;
  if (methodKey === 'check' || methodKey === 'cash') return SYSTEM_CODES.UNDEPOSITED_FUNDS;
  return SYSTEM_CODES.STRIPE_CLEARING;
}

function buildPaymentLines({ cashAccount, creditAccount, net, fee, principal, surcharge, arAllocations, meta }) {
  const lines = [
    { accountCode: cashAccount, debitCents: net, creditCents: 0, ...meta },
  ];
  if (fee > 0) {
    lines.push({ accountCode: SYSTEM_CODES.COGS_MERCHANT_FEES, debitCents: fee, creditCents: 0, ...meta });
  }
  if (Array.isArray(arAllocations) && arAllocations.length > 0) {
    let allocSum = 0;
    for (const a of arAllocations) {
      const amt = posInt(a.amountCents, 'arAllocations[].amountCents');
      if (amt <= 0) continue;
      allocSum += amt;
      lines.push({
        accountCode: creditAccount,
        debitCents: 0,
        creditCents: amt,
        customerId: a.customerId ?? meta.customerId,
        serviceLine: a.serviceLine ?? meta.serviceLine,
        invoiceRef: a.invoiceId ? String(a.invoiceId) : null,
      });
    }
    if (allocSum !== principal) {
      throw new AccountingError(400, 'arAllocations total must equal payment principal');
    }
  } else {
    lines.push({ accountCode: creditAccount, debitCents: 0, creditCents: principal, ...meta });
  }
  if (surcharge > 0) {
    lines.push({
      accountCode: SYSTEM_CODES.REV_CARD_SURCHARGE,
      debitCents: 0,
      creditCents: surcharge,
      ...meta,
      memo: 'Card surcharge recovery',
    });
  }
  return lines;
}

/**
 * 3. Customer Payment Captured (Stripe, Zelle, Check, Cash, or Estimate Deposit).
 *    - Stripe capture: DR 1050 Stripe Clearing (net) + DR 5400 Merchant Fees (fee)
 *                      / CR 1100 A/R (invoice principal) + CR 4085 Card Surcharge Recovery (surcharge)
 *    - Payer Statement settlement: splits CR 1100 A/R across arAllocations[] per settled invoice.
 *    - Zelle/Check/Cash: DR 1010 Checking (or 1060 Undeposited Funds) / CR 1100 A/R
 *    - Estimate Deposit (unbilled): credits 2300 Unearned Revenue for face value + 4085 for surcharge.
 */
function buildPaymentEntry(input) {
  const gross = posInt(input.grossCents, 'grossCents');
  const fee = posInt(input.feeCents ?? 0, 'feeCents');
  const surcharge = posInt(input.surchargeCents ?? 0, 'surchargeCents');
  if (gross <= 0) throw new AccountingError(400, 'Payment grossCents must be > 0');
  if (fee >= gross) throw new AccountingError(400, 'Processing fee cannot equal or exceed gross payment');
  if (surcharge >= gross) throw new AccountingError(400, 'Card surcharge cannot equal or exceed gross payment');

  const methodKey = String(input.method || 'stripe').toLowerCase();
  const isDeposit = Boolean(input.isDeposit);
  const lines = buildPaymentLines({
    cashAccount: cashAccountForPaymentMethod(methodKey),
    creditAccount: isDeposit ? SYSTEM_CODES.UNEARNED_REVENUE : SYSTEM_CODES.ACCOUNTS_RECEIVABLE,
    net: gross - fee,
    fee,
    principal: gross - surcharge,
    surcharge,
    arAllocations: input.arAllocations || null,
    meta: {
      customerId: input.customerId ?? null,
      serviceLine: input.serviceLine ?? null,
      invoiceRef: input.invoiceId ? String(input.invoiceId) : null,
    },
  });

  const paymentId = String(input.paymentId);
  return {
    entryDate: input.paymentDate,
    entryType: 'operational',
    basisScope: 'both',
    sourceType: 'payment',
    sourceId: paymentId,
    idempotencyKey: input.idempotencyKey || `payment:${paymentId}`,
    reference: input.reference || paymentId,
    memo: input.memo || `${isDeposit ? 'Customer deposit' : 'Customer payment'} via ${methodKey}`,
    lines,
  };
}

/**
 * 3b. Stripe Processing Fee / Fee Reversal from stripe_payout_transactions.
 *     - Positive fee: DR 5400 Merchant Processing & Bank Fees / CR 1050 Stripe Clearing
 *     - Negative fee (fee credit): DR 1050 Stripe Clearing / CR 5400 Merchant Fees
 *     Clears exact Stripe processing fees out of 1050 Stripe Clearing so payouts net to $0.00.
 */
function buildStripeFeeEntry({
  txnId,
  feeDate,
  feeCents,
  customerId = null,
  invoiceId = null,
  reference = null,
  memo = null,
}) {
  const fee = Math.trunc(Number(feeCents));
  if (!Number.isSafeInteger(fee) || fee === 0) {
    throw new AccountingError(400, 'feeCents must be a non-zero integer in cents');
  }
  const absFee = Math.abs(fee);
  const invoiceRef = invoiceId ? String(invoiceId) : null;
  const lines = fee > 0
    ? [
      { accountCode: SYSTEM_CODES.COGS_MERCHANT_FEES, debitCents: absFee, creditCents: 0, customerId, invoiceRef },
      { accountCode: SYSTEM_CODES.STRIPE_CLEARING, debitCents: 0, creditCents: absFee, customerId, invoiceRef },
    ]
    : [
      { accountCode: SYSTEM_CODES.STRIPE_CLEARING, debitCents: absFee, creditCents: 0, customerId, invoiceRef },
      { accountCode: SYSTEM_CODES.COGS_MERCHANT_FEES, debitCents: 0, creditCents: absFee, customerId, invoiceRef },
    ];

  return {
    entryDate: feeDate,
    entryType: 'operational',
    basisScope: 'both',
    sourceType: 'stripe_fee',
    sourceId: String(txnId),
    idempotencyKey: `stripe-fee:${txnId}`,
    reference: reference || String(txnId),
    memo: memo || (fee > 0 ? `Stripe processing fee (${txnId})` : `Stripe fee reversal (${txnId})`),
    lines,
  };
}

function buildRefundSplitLines({ sub, unearned, tax, total, cashAccount, isReversal, meta }) {
  const earned = sub - unearned;
  const lines = [];
  if (isReversal) {
    lines.push({ accountCode: cashAccount, debitCents: total, creditCents: 0, ...meta });
  }
  if (unearned > 0) {
    lines.push({
      accountCode: SYSTEM_CODES.UNEARNED_REVENUE,
      debitCents: isReversal ? 0 : unearned,
      creditCents: isReversal ? unearned : 0,
      ...meta,
    });
  }
  if (earned > 0) {
    lines.push({
      accountCode: SYSTEM_CODES.REV_REFUNDS_ALLOWANCES,
      debitCents: isReversal ? 0 : earned,
      creditCents: isReversal ? earned : 0,
      ...meta,
    });
  }
  if (tax > 0) {
    lines.push({
      accountCode: SYSTEM_CODES.SALES_TAX_PAYABLE,
      debitCents: isReversal ? 0 : tax,
      creditCents: isReversal ? tax : 0,
      ...meta,
    });
  }
  if (!isReversal) {
    lines.push({ accountCode: cashAccount, debitCents: 0, creditCents: total, ...meta });
  }
  return lines;
}

function pushRefundPartLines(lines, { unearned, earned, tax, isReversal, meta }) {
  const addLine = (accountCode, amt) => {
    if (amt <= 0) return;
    lines.push({
      accountCode,
      debitCents: isReversal ? 0 : amt,
      creditCents: isReversal ? amt : 0,
      ...meta,
    });
  };
  addLine(SYSTEM_CODES.UNEARNED_REVENUE, unearned);
  addLine(SYSTEM_CODES.REV_REFUNDS_ALLOWANCES, earned);
  addLine(SYSTEM_CODES.SALES_TAX_PAYABLE, tax);
}

function buildRefundAllocationLines({ allocations, cashAccount, isReversal, fallbackMeta }) {
  const lines = [];
  let total = 0;
  for (let i = 0; i < allocations.length; i += 1) {
    const a = allocations[i];
    const sub = posInt(a.subtotalCents ?? 0, `allocations[${i}].subtotalCents`);
    const unearned = posInt(a.unearnedCents ?? 0, `allocations[${i}].unearnedCents`);
    const tax = posInt(a.taxCents ?? 0, `allocations[${i}].taxCents`);
    if (unearned > sub) throw new AccountingError(400, `allocations[${i}].unearnedCents cannot exceed subtotalCents`);
    const partTotal = sub + tax;
    if (partTotal <= 0) continue;
    total += partTotal;
    const meta = {
      customerId: a.customerId ?? fallbackMeta.customerId ?? null,
      serviceLine: a.serviceLine ?? fallbackMeta.serviceLine ?? null,
      invoiceRef: a.invoiceId ? String(a.invoiceId) : (fallbackMeta.invoiceRef || null),
    };
    pushRefundPartLines(lines, { unearned, earned: sub - unearned, tax, isReversal, meta });
  }
  if (total <= 0) throw new AccountingError(400, 'Refund allocation total must be > 0');
  const cashLine = {
    accountCode: cashAccount,
    debitCents: isReversal ? total : 0,
    creditCents: isReversal ? 0 : total,
    ...fallbackMeta,
  };
  return isReversal ? [cashLine, ...lines] : [...lines, cashLine];
}

function buildRefundLinesFromInput({ subtotalCents, unearnedCents, taxCents, allocations, cashAccount, isReversal, meta }) {
  if (Array.isArray(allocations) && allocations.length > 0) {
    return buildRefundAllocationLines({ allocations, cashAccount, isReversal, fallbackMeta: meta });
  }
  const sub = posInt(subtotalCents, 'subtotalCents');
  const unearned = posInt(unearnedCents, 'unearnedCents');
  const tax = posInt(taxCents, 'taxCents');
  if (unearned > sub) throw new AccountingError(400, 'unearnedCents cannot exceed subtotalCents');
  const total = sub + tax;
  if (total <= 0) throw new AccountingError(400, isReversal ? 'Refund reversal total must be > 0' : 'Refund total must be > 0');
  return buildRefundSplitLines({ sub, unearned, tax, total, cashAccount, isReversal, meta });
}

/**
 * 4. Customer Refund (reverses pass-through FL sales tax and releases 2300 Unearned Revenue
 *    for annual-prepay refunds before hitting 4090 Refunds & Allowances).
 */
function buildRefundEntry({
  refundId,
  refundDate,
  subtotalCents = 0,
  unearnedCents = 0,
  taxCents = 0,
  allocations = null,
  method = 'stripe',
  customerId = null,
  serviceLine = null,
  invoiceId = null,
  reference = null,
  idempotencyKey = null,
  reason = 'Customer refund',
}) {
  const cashAccount = String(method || 'stripe').toLowerCase() === 'stripe'
    ? SYSTEM_CODES.STRIPE_CLEARING
    : SYSTEM_CODES.CHECKING_PRIMARY;
  const meta = { customerId, serviceLine, invoiceRef: invoiceId ? String(invoiceId) : null };
  const lines = buildRefundLinesFromInput({
    subtotalCents, unearnedCents, taxCents, allocations, cashAccount, isReversal: false, meta,
  });

  return {
    entryDate: refundDate,
    entryType: 'operational',
    basisScope: 'both',
    sourceType: 'refund',
    sourceId: String(refundId),
    idempotencyKey: idempotencyKey || `refund:${refundId}`,
    reference: reference || String(refundId),
    memo: reason,
    lines,
  };
}

/**
 * 4b. Bounced Refund Reinstatement (funds returned to Stripe Clearing; restores 2300/4090/2100).
 */
function buildRefundReversalEntry({
  txnId,
  reversalDate,
  subtotalCents = 0,
  unearnedCents = 0,
  taxCents = 0,
  allocations = null,
  method = 'stripe',
  customerId = null,
  serviceLine = null,
  invoiceId = null,
  reference = null,
  idempotencyKey = null,
  reason = 'Refund reversed',
}) {
  const cashAccount = String(method || 'stripe').toLowerCase() === 'stripe'
    ? SYSTEM_CODES.STRIPE_CLEARING
    : SYSTEM_CODES.CHECKING_PRIMARY;
  const meta = { customerId, serviceLine, invoiceRef: invoiceId ? String(invoiceId) : null };
  const lines = buildRefundLinesFromInput({
    subtotalCents, unearnedCents, taxCents, allocations, cashAccount, isReversal: true, meta,
  });

  return {
    entryDate: reversalDate,
    entryType: 'operational',
    basisScope: 'both',
    sourceType: 'refund_reversal',
    sourceId: String(txnId),
    idempotencyKey: idempotencyKey || `refund-reversal:${txnId}`,
    reference: reference || String(txnId),
    memo: reason,
    lines,
  };
}

/**
 * 4e. Standalone Customer Account Credit Issuance / Clawback (from customer_credit_ledger).
 *     - Referral grant (+):    DR 6200 Advertising & Marketing / CR 2350 Customer Credits
 *     - Promo/manual grant (+): DR 4090 Refunds, Discounts & Allowances / CR 2350 Customer Credits
 *     - Standalone clawback (-): exact mirror (DR 2350 / CR counterpart)
 *     Uses basisScope 'accrual_only' because non-cash credit grants affect accrual earnings
 *     while cash-basis P&L reflects actual cash collected.
 */
function buildCustomerCreditLines({ isGrant, abs, unearned, remainder, tax, counterpart, meta }) {
  const pushSide = (lines, accountCode, amount, isDebit) => {
    if (amount <= 0) return;
    lines.push({
      accountCode,
      debitCents: isDebit ? amount : 0,
      creditCents: isDebit ? 0 : amount,
      ...meta,
    });
  };
  const lines = [];
  if (!isGrant) pushSide(lines, SYSTEM_CODES.CUSTOMER_CREDITS, abs, true);
  pushSide(lines, SYSTEM_CODES.UNEARNED_REVENUE, unearned, isGrant);
  pushSide(lines, counterpart, remainder, isGrant);
  pushSide(lines, SYSTEM_CODES.SALES_TAX_PAYABLE, tax, isGrant);
  if (isGrant) pushSide(lines, SYSTEM_CODES.CUSTOMER_CREDITS, abs, false);
  return lines;
}

function buildCustomerCreditEntry({
  ledgerId,
  entryDate,
  signedDeltaCents,
  creditSource = 'manual',
  taxCents = 0,
  unearnedCents = 0,
  invoiceId = null,
  serviceLine = null,
  customerId = null,
  memo = null,
}) {
  const delta = Math.trunc(Number(signedDeltaCents));
  if (!Number.isSafeInteger(delta) || delta === 0) {
    throw new AccountingError(400, 'signedDeltaCents must be a non-zero integer in cents');
  }
  const abs = Math.abs(delta);
  const tax = posInt(taxCents, 'taxCents');
  const unearned = posInt(unearnedCents, 'unearnedCents');
  if (tax + unearned > abs) {
    throw new AccountingError(400, 'taxCents + unearnedCents cannot exceed credit amount');
  }
  const src = String(creditSource || 'manual').trim().toLowerCase();
  const counterpart = src === 'referral'
    ? SYSTEM_CODES.OPEX_ADVERTISING
    : SYSTEM_CODES.REV_REFUNDS_ALLOWANCES;
  const meta = {
    customerId,
    serviceLine,
    invoiceRef: invoiceId ? String(invoiceId) : null,
  };
  return {
    entryDate,
    entryType: 'adjusting',
    basisScope: 'accrual_only',
    sourceType: 'customer_credit',
    sourceId: String(ledgerId),
    idempotencyKey: `customer-credit:${ledgerId}`,
    reference: String(ledgerId),
    memo: memo || (delta > 0 ? `Customer credit issued (${src})` : `Customer credit reversed (${src})`),
    lines: buildCustomerCreditLines({
      isGrant: delta > 0, abs, unearned, remainder: abs - tax - unearned, tax, counterpart, meta,
    }),
  };
}

/**
 * 4f. Estimate Deposit Credit Restored on Full Invoice Refund.
 *     When a fully refunded invoice had consumed an estimate deposit, returnAppliedCreditOnRefund()
 *     restores that deposit back to available credit while keeping the original deposit_credit line
 *     items on the invoice. Posts an accrual-only adjusting entry that reverses earned revenue
 *     (and any deposit-funded sales tax uncovered by billed cash principal) and restores 2300.
 */
function buildDepositRestoreOnRefundEntry({
  invoiceId,
  invoiceNumber = null,
  restoreDate,
  allowanceCents = 0,
  taxCents = 0,
  customerId = null,
  serviceLine = null,
  memo = null,
}) {
  const allowance = posInt(allowanceCents, 'allowanceCents');
  const tax = posInt(taxCents, 'taxCents');
  const total = allowance + tax;
  if (total <= 0) throw new AccountingError(400, 'Restored deposit total must be > 0');

  const invoiceRef = String(invoiceId);
  const meta = { customerId, serviceLine, invoiceRef };
  const lines = [];
  if (allowance > 0) {
    lines.push({ accountCode: SYSTEM_CODES.REV_REFUNDS_ALLOWANCES, debitCents: allowance, creditCents: 0, ...meta });
  }
  if (tax > 0) {
    lines.push({ accountCode: SYSTEM_CODES.SALES_TAX_PAYABLE, debitCents: tax, creditCents: 0, ...meta });
  }
  lines.push({ accountCode: SYSTEM_CODES.UNEARNED_REVENUE, debitCents: 0, creditCents: total, ...meta });

  return {
    entryDate: restoreDate,
    entryType: 'adjusting',
    basisScope: 'accrual_only',
    sourceType: 'refund_deposit_restore',
    sourceId: invoiceRef,
    idempotencyKey: `refund-deposit-restore:${invoiceId}`,
    reference: invoiceNumber || invoiceRef,
    memo: memo || `Estimate deposit restored on refunded invoice ${invoiceNumber || invoiceId}`,
    lines,
  };
}

/**
 * 4c. Refund of an unused customer deposit (reverses 2300 Unearned Revenue + 4085 Surcharge
 *     instead of 4090 Refunds & Allowances, so accrual revenue is unaffected).
 */
function buildDepositRefundEntry({
  txnId,
  refundDate,
  principalCents,
  surchargeCents = 0,
  method = 'stripe',
  customerId = null,
  reference = null,
  idempotencyKey = null,
  reason = 'Customer deposit refund',
}) {
  const principal = posInt(principalCents, 'principalCents');
  const surcharge = posInt(surchargeCents, 'surchargeCents');
  const total = principal + surcharge;
  if (total <= 0) throw new AccountingError(400, 'Deposit refund total must be > 0');

  const cashAccount = String(method || 'stripe').toLowerCase() === 'stripe'
    ? SYSTEM_CODES.STRIPE_CLEARING
    : SYSTEM_CODES.CHECKING_PRIMARY;
  const lines = [];
  if (principal > 0) {
    lines.push({ accountCode: SYSTEM_CODES.UNEARNED_REVENUE, debitCents: principal, creditCents: 0, customerId });
  }
  if (surcharge > 0) {
    lines.push({ accountCode: SYSTEM_CODES.REV_CARD_SURCHARGE, debitCents: surcharge, creditCents: 0, customerId });
  }
  lines.push({ accountCode: cashAccount, debitCents: 0, creditCents: total, customerId });

  return {
    entryDate: refundDate,
    entryType: 'operational',
    basisScope: 'both',
    sourceType: 'deposit_refund',
    sourceId: String(txnId),
    idempotencyKey: idempotencyKey || `deposit-refund:${txnId}`,
    reference: reference || String(txnId),
    memo: reason,
    lines,
  };
}

/**
 * 4d. Bounced deposit refund / reinstatement (funds returned to Stripe Clearing).
 */
function buildDepositRefundReversalEntry({
  txnId,
  reversalDate,
  principalCents,
  surchargeCents = 0,
  method = 'stripe',
  customerId = null,
  reference = null,
  idempotencyKey = null,
  reason = 'Deposit refund reversed',
}) {
  const principal = posInt(principalCents, 'principalCents');
  const surcharge = posInt(surchargeCents, 'surchargeCents');
  const total = principal + surcharge;
  if (total <= 0) throw new AccountingError(400, 'Deposit refund reversal total must be > 0');

  const cashAccount = String(method || 'stripe').toLowerCase() === 'stripe'
    ? SYSTEM_CODES.STRIPE_CLEARING
    : SYSTEM_CODES.CHECKING_PRIMARY;
  const lines = [
    { accountCode: cashAccount, debitCents: total, creditCents: 0, customerId },
  ];
  if (principal > 0) {
    lines.push({ accountCode: SYSTEM_CODES.UNEARNED_REVENUE, debitCents: 0, creditCents: principal, customerId });
  }
  if (surcharge > 0) {
    lines.push({ accountCode: SYSTEM_CODES.REV_CARD_SURCHARGE, debitCents: 0, creditCents: surcharge, customerId });
  }

  return {
    entryDate: reversalDate,
    entryType: 'operational',
    basisScope: 'both',
    sourceType: 'deposit_refund_reversal',
    sourceId: String(txnId),
    idempotencyKey: idempotencyKey || `deposit-refund-reversal:${txnId}`,
    reference: reference || String(txnId),
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
  paymentMethod = null,
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
      paymentMethod: s.paymentMethod || paymentMethod,
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
    paymentMethod,
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
  idempotencyKey = null,
  paymentDate,
  amountCents,
  periodLabel = '',
  bankAccountId = null,
  bankAccountCode = SYSTEM_CODES.CHECKING_PRIMARY,
  bankTransactionId = null,
}) {
  const amt = posInt(amountCents, 'amountCents');
  if (amt <= 0) throw new AccountingError(400, 'Sales tax remittance must be > 0');
  return {
    entryDate: paymentDate,
    entryType: 'operational',
    basisScope: 'both',
    sourceType: 'sales_tax_remittance',
    sourceId: String(sourceId),
    idempotencyKey: idempotencyKey || `sales-tax-remit:${sourceId}`,
    reference: periodLabel || String(sourceId),
    memo: `FL DOR DR-15 sales tax remittance${periodLabel ? ` (${periodLabel})` : ''}`,
    lines: [
      { accountCode: SYSTEM_CODES.SALES_TAX_PAYABLE, debitCents: amt, creditCents: 0 },
      { accountId: bankAccountId || null, accountCode: bankAccountId ? null : bankAccountCode, debitCents: 0, creditCents: amt, bankTransactionId },
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
    basisScope: 'accrual_only',
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
  idempotencyKey = null,
  settlementDate,
  kind, // 'net_pay' | 'tax_remit' | 'benefits_remit'
  amountCents,
  bankAccountId = null,
  bankAccountCode = SYSTEM_CODES.CHECKING_PAYROLL,
  bankTransactionId = null,
  serviceLine = null,
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
    idempotencyKey: idempotencyKey || `payroll-settle:${kind}:${sourceId}`,
    memo: memo || `Payroll ${kind.replace('_', ' ')} settlement`,
    lines: [
      { accountCode: liabilityCode, debitCents: amt, creditCents: 0, serviceLine },
      { accountId: bankAccountId || null, accountCode: bankAccountId ? null : bankAccountCode, debitCents: 0, creditCents: amt, bankTransactionId },
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

function buildDisputeReceivableLines({ principalCents, invoiceId, arAllocations, customerId, serviceLine, isReinstatement }) {
  const validAllocs = Array.isArray(arAllocations)
    ? arAllocations.filter((a) => a && Number(a.amountCents) > 0)
    : [];
  const memo = isReinstatement ? 'Dispute won — re-apply to invoice A/R' : 'Dispute — restore invoice A/R';
  if (!validAllocs.length) {
    return [{
      accountCode: SYSTEM_CODES.ACCOUNTS_RECEIVABLE,
      debitCents: isReinstatement ? 0 : principalCents,
      creditCents: isReinstatement ? principalCents : 0,
      customerId,
      invoiceRef: invoiceId ? String(invoiceId) : null,
      serviceLine,
      paymentMethod: 'stripe',
      memo,
    }];
  }

  let allocSum = 0;
  const lines = validAllocs.map((a) => {
    const amt = posInt(a.amountCents, 'arAllocations[].amountCents');
    allocSum += amt;
    return {
      accountCode: SYSTEM_CODES.ACCOUNTS_RECEIVABLE,
      debitCents: isReinstatement ? 0 : amt,
      creditCents: isReinstatement ? amt : 0,
      customerId: a.customerId || customerId || null,
      invoiceRef: a.invoiceId ? String(a.invoiceId) : null,
      serviceLine: a.serviceLine || serviceLine || null,
      paymentMethod: 'stripe',
      memo,
    };
  });
  if (allocSum !== principalCents) {
    throw new AccountingError(400, `arAllocations sum (${allocSum}c) must equal principal (${principalCents}c)`);
  }
  return lines;
}

function buildDisputeAllocationLines({ grossCents, surchargeCents, invoiceId, arAllocations, customerId, serviceLine, isReinstatement }) {
  const principalCents = grossCents - surchargeCents;
  const invRef = invoiceId ? String(invoiceId) : null;
  const clearingLine = {
    accountCode: SYSTEM_CODES.STRIPE_CLEARING,
    debitCents: isReinstatement ? grossCents : 0,
    creditCents: isReinstatement ? 0 : grossCents,
    customerId,
    invoiceRef: invRef,
    serviceLine,
    paymentMethod: 'stripe',
    memo: isReinstatement ? 'Dispute won — funds reinstated to Stripe' : 'Dispute chargeback withdrawn by Stripe',
  };
  const arLines = buildDisputeReceivableLines({
    principalCents, invoiceId, arAllocations, customerId, serviceLine, isReinstatement,
  });
  const surchargeLines = surchargeCents > 0
    ? [{
      accountCode: SYSTEM_CODES.REV_CARD_SURCHARGE,
      debitCents: isReinstatement ? 0 : surchargeCents,
      creditCents: isReinstatement ? surchargeCents : 0,
      customerId,
      invoiceRef: invRef,
      paymentMethod: 'stripe',
      memo: isReinstatement ? 'Card surcharge reinstated on won dispute' : 'Card surcharge reversed on dispute',
    }]
    : [];
  return isReinstatement
    ? [clearingLine, ...arLines, ...surchargeLines]
    : [...arLines, ...surchargeLines, clearingLine];
}

/**
 * 5c. Stripe Dispute Withdrawal (Collectible Receivable Reopened).
 *     DR 1100 A/R (principal, allocated across statement children if applicable)
 *     DR 4085 Card Surcharge (if collected on disputed charge)
 *     CR 1050 Stripe Clearing (gross disputed funds)
 */
function buildDisputeWithdrawalEntry({
  txnId,
  idempotencyKey = null,
  disputeDate,
  grossCents,
  surchargeCents = 0,
  customerId = null,
  invoiceId = null,
  arAllocations = null,
  serviceLine = null,
  reference = null,
  reason = null,
}) {
  const gross = posInt(grossCents, 'grossCents');
  const sur = posInt(surchargeCents, 'surchargeCents');
  if (gross <= 0) throw new AccountingError(400, 'Dispute withdrawal grossCents must be positive');
  if (sur >= gross) throw new AccountingError(400, 'surchargeCents must be less than grossCents');

  return {
    entryDate: disputeDate,
    entryType: 'operational',
    basisScope: 'both',
    sourceType: 'dispute',
    sourceId: String(txnId),
    idempotencyKey: idempotencyKey || `dispute:spt:${txnId}`,
    reference: reference || String(txnId),
    memo: reason ? `Stripe dispute — ${reason}` : 'Stripe dispute — A/R restored for collection',
    lines: buildDisputeAllocationLines({
      grossCents: gross, surchargeCents: sur, invoiceId, arAllocations, customerId, serviceLine, isReinstatement: false,
    }),
  };
}

/**
 * 5d. Stripe Dispute Reinstatement (Dispute Won — Mirror of Withdrawal).
 *     DR 1050 Stripe Clearing (gross reinstated funds)
 *     CR 1100 A/R (principal)
 *     CR 4085 Card Surcharge (if present)
 */
function buildDisputeReinstatementEntry({
  txnId,
  idempotencyKey = null,
  reversalDate,
  grossCents,
  surchargeCents = 0,
  customerId = null,
  invoiceId = null,
  arAllocations = null,
  serviceLine = null,
  reference = null,
  reason = null,
}) {
  const gross = posInt(grossCents, 'grossCents');
  const sur = posInt(surchargeCents, 'surchargeCents');
  if (gross <= 0) throw new AccountingError(400, 'Dispute reinstatement grossCents must be positive');
  if (sur >= gross) throw new AccountingError(400, 'surchargeCents must be less than grossCents');

  return {
    entryDate: reversalDate,
    entryType: 'operational',
    basisScope: 'both',
    sourceType: 'dispute_reversal',
    sourceId: String(txnId),
    idempotencyKey: idempotencyKey || `dispute-reversal:spt:${txnId}`,
    reference: reference || String(txnId),
    memo: reason ? `Stripe dispute won — ${reason}` : 'Stripe dispute won — funds reinstated',
    lines: buildDisputeAllocationLines({
      grossCents: gross, surchargeCents: sur, invoiceId, arAllocations, customerId, serviceLine, isReinstatement: true,
    }),
  };
}

function parseOpeningBalanceCents(item, label) {
  const rawVal = item?.balanceCents ?? item?.balance_cents;
  const missing = rawVal == null || typeof rawVal === 'boolean' || (typeof rawVal === 'string' && rawVal.trim() === '');
  if (missing) {
    throw new AccountingError(400, `Opening balance item (${label}) requires an integer balanceCents`);
  }
  const raw = Number(rawVal);
  if (!Number.isSafeInteger(raw)) {
    throw new AccountingError(400, `Opening balance item (${label}) balanceCents must be a safe integer in cents`);
  }
  return raw;
}

function buildOpeningBalanceLine(item) {
  const label = item?.accountCode || item?.accountId || 'unknown';
  const raw = parseOpeningBalanceCents(item, label);
  if (raw === 0) return null;
  const normalBalance = item.normalBalance ?? item.normal_balance;
  if (normalBalance !== 'debit' && normalBalance !== 'credit') {
    throw new AccountingError(400, `Opening balance item (${label}) requires explicit normalBalance ("debit" or "credit")`);
  }
  const isDebit = normalBalance === 'debit';
  const debitCents = (isDebit && raw > 0) || (!isDebit && raw < 0) ? Math.abs(raw) : 0;
  const creditCents = debitCents === 0 ? Math.abs(raw) : 0;
  return {
    accountId: item.accountId || null,
    accountCode: item.accountId ? null : item.accountCode,
    debitCents,
    creditCents,
    memo: 'Opening balance',
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
    const line = buildOpeningBalanceLine(item);
    if (!line) continue;
    netDebits += line.debitCents;
    netCredits += line.creditCents;
    lines.push(line);
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
  buildStripeFeeEntry,
  buildRefundEntry,
  buildRefundReversalEntry,
  buildDepositRefundEntry,
  buildDepositRefundReversalEntry,
  buildDepositRestoreOnRefundEntry,
  buildDisputeWithdrawalEntry,
  buildDisputeReinstatementEntry,
  buildCustomerCreditEntry,
  buildStripePayoutEntry,
  buildExpenseEntry,
  buildTransferEntry,
  buildSalesTaxRemittanceEntry,
  buildPayrollRunEntry,
  buildPayrollSettlementEntry,
  buildDepreciationEntry,
  buildOpeningBalanceEntry,
};
